/**
 * vhclsService.ts
 * Serviço VHCLS (resolução de VEHICLE_ID por placa/serial) — extraído do monolito html5InstallWorker_v8.js
 *
 * Responsabilidades:
 *  - Resolver VEHICLE_ID a partir de placa ou serial via action=VHCLS
 *  - Garantir sessão HTML5 antes de cada request (delega para html5Session)
 *  - Retry com relogin automático em caso de session expired (login=-1)
 *
 * NÃO contém lógica de job, MWS, CMDT, AppEngine ou workers.
 */

import * as fs from "fs";
import { ensureHtml5Session, readJarCookie, ensureCookieDefaults, Html5SessionConfig } from "./html5Session";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface VhclsContext {
  cookieJarPath?: string;
  jobId?: string | number;
  log?: (msg: string) => void;
  __vhcls_last?: Record<string, unknown>;
}

export interface VhclsPayload {
  vehicle_id?  : number | string;
  VEHICLE_ID?  : number | string;
  vehicleId?   : number | string;
  service?     : string;
  servico?     : string;
  serviceType? : string;
  plate?       : string;
  placa?       : string;
  license?     : string;
  licensePlate?: string;
  plate_real?  : string;
  plateReal?   : string;
  license_real?: string;
  licenseReal? : string;
  serial?      : string;
  serie?       : string;
  innerId?     : string;
  inner_id?    : string;
  INNER_ID?    : string;
  SERIAL?      : string;
  lookup_license?     : string;
  lookupLicense?      : string;
  lookupLicenseNmbr?  : string;
  [key: string]: unknown;
}

export interface VhclsResolveResult {
  plate       : string;
  status      : number;
  len         : number;
  loginNeg    : boolean;
  vehicleId   : number | null;
  innerId     : string | null;
  licensePlate: string | null;
  clientId    : string | null;
  clientDescr : string | null;
  jarFlags    : string;
  head        : string;
}

// ---------------------------------------------------------------------------
// Utilitários internos
// ---------------------------------------------------------------------------

function vhclsLog(ctx: VhclsContext | null | undefined, msg: string): void {
  try {
    if (ctx && typeof ctx.log === "function") ctx.log(msg);
    else console.log(msg);
  } catch {
    console.log(msg);
  }
}

/** Normaliza placa/serial para comparação (maiúsculas, só alfanumérico + _ -) */
export function normLicenseKey(v: unknown): string {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

/** Normaliza serial ignorando zeros à esquerda */
function normInnerId(v: unknown): string {
  const s = String(v || "").replace(/^0+/, "");
  return s || "0";
}

function innerIdMatch(a: unknown, b: unknown): boolean {
  return normInnerId(a) === normInnerId(b);
}

function extractAttr(tag: string, name: string): string {
  const re = new RegExp(`${name}="([^"]*)"`, "i");
  const m = re.exec(tag);
  return m ? m[1] : "";
}

function safeSnippet(text: string, n = 260): string {
  return String(text || "").slice(0, n).replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Parse da resposta XML do VHCLS
// ---------------------------------------------------------------------------

interface VhclsParseResult {
  vehicleId   : number | null;
  innerId     : string | null;
  licensePlate: string | null;
  clientId    : string | null;
  clientDescr : string | null;
  err: "unauthorized_or_vhcls_error" | "not_found" | null;
}

function parseVehicleIdFromVhclsXml(xml: string, licenseKey: string): VhclsParseResult {
  const lk = normLicenseKey(licenseKey);

  if (/login\s*=\s*"-1"/i.test(xml) || /Action:\s*VHCLS\s+error/i.test(xml)) {
    return { vehicleId: null, innerId: null, licensePlate: null, clientId: null, clientDescr: null, err: "unauthorized_or_vhcls_error" };
  }

  const dataTags = xml.match(/<DATA\b[^>]*\/>/gi) || [];

  for (const tag of dataTags) {
    const licRaw     = extractAttr(tag, "LICENSE_NMBR");
    const lic        = normLicenseKey(licRaw);
    const innerId    = extractAttr(tag, "INNER_ID");
    const vid        = extractAttr(tag, "VEHICLE_ID");
    const clientId   = extractAttr(tag, "CLIENT_ID")   || null;
    const clientDescr = extractAttr(tag, "CLIENT_DESCR") || null;

    const licMatch   = !!(lic && vid && lic === lk);
    const innerMatch = !!(innerId && vid && innerIdMatch(innerId, lk));

    if (licMatch || innerMatch) {
      const n = Number(vid);
      return { vehicleId: n > 0 ? n : null, innerId: innerId || null, licensePlate: licRaw || null, clientId, clientDescr, err: null };
    }
  }

  // resultado único sem match de placa — aceita o único registro
  if (dataTags.length === 1) {
    const licRaw      = extractAttr(dataTags[0], "LICENSE_NMBR");
    const vid         = extractAttr(dataTags[0], "VEHICLE_ID");
    const innerId     = extractAttr(dataTags[0], "INNER_ID");
    const clientId    = extractAttr(dataTags[0], "CLIENT_ID")    || null;
    const clientDescr = extractAttr(dataTags[0], "CLIENT_DESCR") || null;
    const n = Number(vid);
    if (n > 0) return { vehicleId: n, innerId: innerId || null, licensePlate: licRaw || null, clientId, clientDescr, err: null };
  }

  return { vehicleId: null, innerId: null, licensePlate: null, clientId: null, clientDescr: null, err: "not_found" };
}

// ---------------------------------------------------------------------------
// HTTP helper (request VHCLS)
// ---------------------------------------------------------------------------

async function postVhcls(
  actionUrl   : string,
  baseUrl     : string,
  cookieHeader: string,
  licenseKey  : string,
  timeoutMs   : number,
  byInnerId   : boolean = false
): Promise<{ status: number; text: string }> {
  const body = new URLSearchParams({
    action      : "VHCLS",
    VERSION_ID  : "2",
    REFRESH_FLG : "1",
    LICENSE_NMBR: byInnerId ? "" : licenseKey,
    CLIENT_DESCR: "",
    OWNER_DESCR : "",
    DIAL_NMBR   : "",
    INNER_ID    : byInnerId ? licenseKey : "",
  }).toString();

  const origin = baseUrl || "https://html5.traffilog.com";

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(actionUrl, {
      method : "POST",
      headers: {
        "content-type"     : "application/x-www-form-urlencoded; charset=UTF-8",
        "accept"           : "text/html, */*; q=0.01",
        "origin"           : origin,
        "referer"          : `${origin}/`,
        "user-agent"       : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "x-requested-with": "XMLHttpRequest",
        "cookie"           : cookieHeader,
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    return { status: res.status, text };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Resolução direta por licenseKey (com retry + relogin)
// ---------------------------------------------------------------------------

async function resolveVehicleIdDirect(
  cfg       : Html5SessionConfig,
  ctx       : VhclsContext | null | undefined,
  licenseKey: string
): Promise<{ vid: number; innerId: string | null; clientId: string | null; clientDescr: string | null } | null> {
  const lk = normLicenseKey(licenseKey);
  if (!lk) return null;

  // garante sessão antes do primeiro request
  await ensureHtml5Session(cfg, "VHCLS_DIRECT_PRE").catch(() => {});

  for (let attempt = 1; attempt <= 2; attempt++) {
    const cookieHeader = ensureCookieDefaults(readJarCookie(cfg.cookieJarPath));

    const { status, text } = await postVhcls(
      cfg.actionUrl,
      process.env.HTML5_BASE_URL || "",
      cookieHeader,
      lk,
      cfg.httpTimeoutMs
    );

    // snapshot de debug (opcional)
    try {
      const jobId = ctx && (ctx.jobId);
      if (jobId) {
        const fp = `/tmp/vhcls_raw_${String(jobId)}_${Date.now()}_a${attempt}.xml`;
        fs.writeFileSync(fp, text, "utf8");
      }
    } catch { /* ignora */ }

    // snapshot pro ctx
    try {
      if (ctx) ctx.__vhcls_last = { licenseKey: lk, status, len: text.length, head: safeSnippet(text, 280) };
    } catch { /* ignora */ }

    const parsed = parseVehicleIdFromVhclsXml(text, lk);

    if (!parsed.err && parsed.vehicleId) return { vid: parsed.vehicleId, innerId: parsed.innerId ?? null, clientId: parsed.clientId ?? null, clientDescr: parsed.clientDescr ?? null };

    // session expired → força relogin e tenta mais 1x
    if (parsed.err === "unauthorized_or_vhcls_error" && attempt === 1) {
      try {
        // invalida sessão no jar para forçar relogin completo
        const { readJarCookie: _unused, ...rest } = await import("./html5Session");
        // usa fs diretamente: lê, remove ASP + TFL, reescreve
        const raw = fs.existsSync(cfg.cookieJarPath)
          ? fs.readFileSync(cfg.cookieJarPath, "utf8")
          : "{}";
        let m: Record<string, string> = {};
        try { m = JSON.parse(raw); } catch { /* ignora */ }
        delete m["TFL_SESSION"];
        delete m["ASP.NET_SessionId"];
        const tmp = `${cfg.cookieJarPath}.tmp.${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(m), "utf8");
        fs.renameSync(tmp, cfg.cookieJarPath);
      } catch { /* não bloqueia */ }

      console.log(`[vhclsService] ${lk}: session expired → relogin → retry`);
      await ensureHtml5Session(cfg, "VHCLS_DIRECT_RETRY").catch(() => {});
      continue;
    }

    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// ensureVehicleId — ponto de entrada principal
// ---------------------------------------------------------------------------

/**
 * Tenta resolver VEHICLE_ID no payload se ainda não estiver preenchido.
 * Muta `payload` com vehicle_id / VEHICLE_ID / vehicleId quando resolve.
 *
 * Estratégia de tentativas:
 *  - INSTALL:   lookup_license → serial → plate_real → plate
 *  - OUTROS:    plate_real → plate → serial (fallback)
 *
 * @returns VEHICLE_ID resolvido ou null
 */
export async function ensureVehicleId(
  cfg    : Html5SessionConfig,
  ctx    : VhclsContext | null | undefined,
  payload: VhclsPayload
): Promise<number | null> {
  if (!payload) return null;

  // já tem → retorna imediatamente
  const cur = Number(payload.vehicle_id || payload.VEHICLE_ID || payload.vehicleId || 0);
  if (cur > 0) {
    payload.vehicle_id = cur;
    payload.VEHICLE_ID = cur;
    payload.vehicleId  = cur;
    return cur;
  }

  const service   = String(payload.service || payload.servico || payload.serviceType || "").trim().toUpperCase();
  const plateRaw  = String(payload.plate        || payload.placa       || payload.license      || payload.licensePlate || "");
  const plateReal = String(payload.plate_real   || payload.plateReal   || payload.license_real || payload.licenseReal  || "");
  const serialRaw = String(payload.serial       || payload.serie       || payload.innerId      || payload.inner_id     || payload.INNER_ID || payload.SERIAL || "");
  const lookupRaw = String(payload.lookup_license || payload.lookupLicense || payload.lookupLicenseNmbr || "");

  const tries: string[] = [];
  const pushTry = (v: string) => { const k = normLicenseKey(v); if (k) tries.push(k); };

  if (service === "INSTALL") {
    pushTry(lookupRaw);
    pushTry(serialRaw);
    pushTry(plateReal);
    pushTry(plateRaw);
  } else {
    pushTry(plateReal);
    pushTry(plateRaw);
    pushTry(serialRaw);
  }

  // dedupe mantendo ordem
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const t of tries) { if (!seen.has(t)) { seen.add(t); uniq.push(t); } }

  if (!uniq.length) return null;

  for (const licenseKey of uniq) {
    const resolved = await resolveVehicleIdDirect(cfg, ctx, licenseKey);
    if (resolved) {
      const { vid, innerId, clientId, clientDescr } = resolved;
      payload.vehicle_id = vid;
      payload.VEHICLE_ID = vid;
      payload.vehicleId  = vid;
      if (innerId && !payload.inner_id && !payload.INNER_ID && !payload.serial) {
        payload.inner_id = innerId;
        payload.INNER_ID = innerId;
      }
      if (clientId && !payload.client_id && !payload.CLIENT_ID) {
        payload.client_id = clientId;
        payload.CLIENT_ID = clientId;
      }
      if (clientDescr && !payload.client_descr && !payload.CLIENT_DESCR) {
        payload.client_descr = clientDescr;
        payload.CLIENT_DESCR = clientDescr;
      }
      vhclsLog(ctx, `[vhclsService] resolved: license=${licenseKey} → VEHICLE_ID=${vid} INNER_ID=${innerId ?? "n/a"} CLIENT_ID=${clientId ?? "n/a"} CLIENT_DESCR=${clientDescr ?? "n/a"}`);
      return vid;
    }
  }

  vhclsLog(ctx, `[vhclsService] not found: tried=${uniq.join(",")}`);
  return null;
}

// ---------------------------------------------------------------------------
// resolveByPlate — wrapper simples para uso fora do contexto de job
// ---------------------------------------------------------------------------

/**
 * Resolve VEHICLE_ID a partir de uma placa, sem mutar payload.
 * Útil para lookups pontuais (ex: snapshot de UNINSTALL).
 */
export async function resolveByPlate(
  cfg       : Html5SessionConfig,
  plate     : string,
  tag       = "VHCLS",
  jobId     = "",
  byInnerId = false
): Promise<VhclsResolveResult> {
  const lk = normLicenseKey(plate);

  // garante cookie
  let cookieLen = 0;
  try {
    const ck = ensureCookieDefaults(readJarCookie(cfg.cookieJarPath));
    cookieLen = ck.length;
  } catch { /* ignora */ }

  if (!cookieLen) {
    console.log(`[vhclsService] [${tag}] cookieLen=0 → ensureHtml5Session`);
    await ensureHtml5Session(cfg, `${tag}_COOKIE0`).catch(() => {});
    try {
      const ck2 = ensureCookieDefaults(readJarCookie(cfg.cookieJarPath));
      cookieLen = ck2.length;
    } catch { /* ignora */ }
  }

  console.log(`[vhclsService] [${tag}] job=${jobId} plate=${lk} cookieLen=${cookieLen}`);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const cookieHeader = ensureCookieDefaults(readJarCookie(cfg.cookieJarPath));
    const { status, text } = await postVhcls(
      cfg.actionUrl,
      process.env.HTML5_BASE_URL || "",
      cookieHeader,
      lk,
      cfg.httpTimeoutMs,
      byInnerId
    ).catch(() => ({ status: 0, text: "" }));

    const parsed   = parseVehicleIdFromVhclsXml(text, lk);
    const loginNeg = /login\s*=\s*"-1"/i.test(text);
    const head     = safeSnippet(text, 220);
    const headSafe = /ASP\.NET_SessionId=|TFL_SESSION=|AWSALB=/i.test(head)
      ? "<cookie_header_redacted>"
      : head;

    console.log(`[vhclsService] [${tag}] attempt=${attempt} http=${status} len=${text.length} loginNeg=${loginNeg ? 1 : 0} head=${headSafe}`);

    // session expirada na primeira tentativa → relogin + retry
    if (parsed.err === "unauthorized_or_vhcls_error" && attempt === 1) {
      try {
        const raw = fs.existsSync(cfg.cookieJarPath) ? fs.readFileSync(cfg.cookieJarPath, "utf8") : "{}";
        let m: Record<string, string> = {};
        try { m = JSON.parse(raw); } catch { /* ignora */ }
        delete m["TFL_SESSION"];
        delete m["ASP.NET_SessionId"];
        const tmp = `${cfg.cookieJarPath}.tmp.${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(m), "utf8");
        fs.renameSync(tmp, cfg.cookieJarPath);
      } catch { /* não bloqueia */ }
      console.log(`[vhclsService] [${tag}] session expirada → relogin → retry`);
      await ensureHtml5Session(cfg, `${tag}_RETRY`).catch(() => {});
      continue;
    }

    return {
      plate       : lk,
      status,
      len         : text.length,
      loginNeg,
      vehicleId   : parsed.vehicleId,
      innerId     : parsed.innerId      ?? null,
      licensePlate: parsed.licensePlate ?? null,
      clientId    : parsed.clientId     ?? null,
      clientDescr : parsed.clientDescr  ?? null,
      jarFlags    : "",
      head        : headSafe,
    };
  }

  return {
    plate: lk, status: 0, len: 0, loginNeg: false,
    vehicleId: null, innerId: null, licensePlate: null, clientId: null, clientDescr: null,
    jarFlags: "", head: "",
  };
}
