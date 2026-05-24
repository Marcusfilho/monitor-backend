/**
 * cmdtService.ts
 * Serviço CMDT (liberação de serial preso em veículo placeholder) — extraído do monolito html5InstallWorker_v8.js
 *
 * Responsabilidades:
 *  - Verificar se um serial está vinculado a um veículo CMDT (placeholder de bancada)
 *  - Fazer DEACTIVATE_VEHICLE_HIST para liberar o serial antes do INSTALL
 *  - NÃO bloquear o fluxo se o serial estiver em veículo real (apenas reporta)
 *
 * Retornos possíveis de checkAndFreeSerial:
 *   { freed: true,  vid_freed: N, plate_freed: "CMDT xxx" } → era CMDT, foi liberado
 *   { freed: false, blocked: false }                         → serial livre ou não encontrado
 *   { freed: false, blocked: true,
 *     vid_blocked: N, plate_blocked: "XYZ" }                 → serial em veículo real, não mexe
 *   { freed: false, error: "..." }                           → falha ao verificar (não bloqueia)
 *
 * Depende de: html5Session (sessão/cookie), não depende de vhclsService diretamente
 *   (faz seus próprios requests VHCLS para inspecionar campos específicos)
 */

import * as fs from "fs";
import { ensureHtml5Session, readJarCookie, ensureCookieDefaults, Html5SessionConfig } from "./html5Session";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type CmdtFreeResult =
  | { freed: true;  vid_freed: number; plate_freed: string }
  | { freed: false; blocked: false; error?: string }
  | { freed: false; blocked: true;  vid_blocked: number; plate_blocked: string }
  | { freed: false; blocked?: false; error: string; vid_freed?: number; plate?: string };

interface VhclsLookupResult {
  vid         : number | null;
  licenseNmbr : string | null;
  innerId?    : string;
  sessionError?: boolean;
  error?      : string;
}

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

function safeSnippet(text: string, n = 260): string {
  return String(text || "").slice(0, n).replace(/\s+/g, " ");
}

/** Normaliza serial ignorando zeros à esquerda */
function normInnerId(v: unknown): string {
  const s = String(v || "").replace(/^0+/, "");
  return s || "0";
}

function innerIdMatch(a: unknown, b: unknown): boolean {
  return normInnerId(a) === normInnerId(b);
}

// ---------------------------------------------------------------------------
// HTTP helper (AppEngine POST — cópia local, sem depender do mwsService)
// ---------------------------------------------------------------------------

async function appenginePost(
  cfg    : Html5SessionConfig,
  action : string,
  fields : Record<string, string>,
  tag    : string
): Promise<{ status: number; text: string; loginNeg: boolean }> {
  await ensureHtml5Session(cfg, tag).catch(() => {});

  const cookieHeader = ensureCookieDefaults(readJarCookie(cfg.cookieJarPath));

  const params = new URLSearchParams();
  params.set("action", action);
  for (const [k, v] of Object.entries(fields)) params.set(k, String(v ?? ""));

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), cfg.httpTimeoutMs);
  try {
    const res = await fetch(cfg.actionUrl, {
      method : "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "accept"      : "*/*",
        "origin"      : "https://html5.traffilog.com",
        "referer"     : "https://html5.traffilog.com/appv2/index.htm",
        "user-agent"  : "monitor-backend-html5-worker/rw",
        "cookie"      : cookieHeader,
      },
      body  : params.toString(),
      signal: controller.signal,
    });
    const text     = await res.text().catch(() => "");
    const loginNeg = /login\s*=\s*"-1"/i.test(text) || /<!DOCTYPE\s+html/i.test(text);
    console.log(`[cmdtService] [${tag}] action=${action} http=${res.status} len=${text.length} loginNeg=${loginNeg ? 1 : 0}`);
    return { status: res.status, text, loginNeg };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Lookup VHCLS por campo específico
// ---------------------------------------------------------------------------

async function vhclsLookup(
  cfg        : Html5SessionConfig,
  fieldName  : "INNER_ID" | "LICENSE_NMBR",
  fieldValue : string,
  serial     : string,
  tag        : string
): Promise<VhclsLookupResult> {
  try {
    const fields: Record<string, string> = {
      VERSION_ID  : "2",
      REFRESH_FLG : "1",
      LICENSE_NMBR: "",
      CLIENT_DESCR: "",
      OWNER_DESCR : "",
      DIAL_NMBR   : "",
      INNER_ID    : "",
    };
    fields[fieldName] = String(fieldValue).trim();

    const r = await appenginePost(cfg, "VHCLS", fields, `${tag}_${fieldName}`);
    const txt = String(r.text || "");

    console.log(`[cmdtService] [${tag}] VHCLS field=${fieldName} val=${fieldValue} http=${r.status} len=${txt.length} loginNeg=${r.loginNeg ? 1 : 0} head=${safeSnippet(txt, 160)}`);

    if (r.loginNeg || /Action:\s*VHCLS\s+error/i.test(txt)) {
      return { vid: null, licenseNmbr: null, sessionError: true };
    }

    const dataTags = txt.match(/<DATA\b[^>]*\/>/gi) || [];

    for (const tag_ of dataTags) {
      const mVid   = tag_.match(/\bVEHICLE_ID\s*=\s*["']?(\d+)["']?/i);
      const mLic   = tag_.match(/\bLICENSE_NMBR\s*=\s*["']([^"']*)["']/i);
      const mInner = tag_.match(/\bINNER_ID\s*=\s*["']([^"']*)["']/i);

      if (!mVid?.[1]) continue;

      const vid         = Number(mVid[1]);
      const licenseNmbr = mLic   ? String(mLic[1]).trim()   : "";
      const innerId     = mInner ? String(mInner[1]).trim() : "";

      const matchesSerial =
        innerIdMatch(innerId, serial) ||
        String(innerId).toLowerCase()     === serial.toLowerCase() ||
        String(licenseNmbr).toLowerCase() === serial.toLowerCase();

      if (vid > 0 && matchesSerial) {
        console.log(`[cmdtService] [${tag}] found via ${fieldName}: vid=${vid} LICENSE_NMBR="${licenseNmbr}" INNER_ID="${innerId}"`);
        return { vid, licenseNmbr, innerId };
      }
    }

    // fallback: único resultado ao buscar por INNER_ID
    if (fieldName === "INNER_ID" && dataTags.length === 1) {
      const tag_   = dataTags[0];
      const mVid   = tag_.match(/\bVEHICLE_ID\s*=\s*["']?(\d+)["']?/i);
      const mLic   = tag_.match(/\bLICENSE_NMBR\s*=\s*["']([^"']*)["']/i);
      const mInner = tag_.match(/\bINNER_ID\s*=\s*["']([^"']*)["']/i);
      if (mVid?.[1]) {
        const vid         = Number(mVid[1]);
        const licenseNmbr = mLic   ? String(mLic[1]).trim()   : "";
        const innerId     = mInner ? String(mInner[1]).trim() : "";
        if (vid > 0) {
          console.log(`[cmdtService] [${tag}] fallback single-tag via ${fieldName}: vid=${vid} LICENSE_NMBR="${licenseNmbr}" INNER_ID="${innerId}"`);
          return { vid, licenseNmbr, innerId };
        }
      }
    }

    return { vid: null, licenseNmbr: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[cmdtService] [${tag}] vhclsLookup error field=${fieldName}: ${msg}`);
    return { vid: null, licenseNmbr: null, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Classificação do veículo encontrado
// ---------------------------------------------------------------------------

type VehicleStatus = "cmdt" | "free" | "blocked";

function classifyVehicle(
  vid         : number,
  licenseNmbr : string | null,
  serial      : string,
  tag         : string
): { status: VehicleStatus; vid: number; licenseNmbr: string } | null {
  if (!vid) return null;

  const lic = String(licenseNmbr || "").trim();

  // LICENSE_NMBR é o próprio serial → bancada (tratada como CMDT)
  if (lic.toLowerCase() === serial.toLowerCase()) {
    console.log(`[cmdtService] [${tag}] serial=${serial} vid=${vid} -> bancada (LICENSE_NMBR==serial), will DEACTIVATE`);
    return { status: "cmdt", vid, licenseNmbr: lic };
  }

  // LICENSE_NMBR contém "CMDT" → placeholder de cobrança
  if (/CMDT/i.test(lic)) {
    console.log(`[cmdtService] [${tag}] serial=${serial} vid=${vid} LICENSE_NMBR="${lic}" -> CMDT placeholder, will DEACTIVATE`);
    return { status: "cmdt", vid, licenseNmbr: lic };
  }

  // LICENSE_NMBR vazia → serial sem placa vinculada, considerado livre
  if (!lic) {
    console.log(`[cmdtService] [${tag}] serial=${serial} vid=${vid} LICENSE_NMBR="" -> no plate, serial FREE`);
    return { status: "free", vid, licenseNmbr: lic };
  }

  // Outra placa → veículo real, não mexe
  console.log(`[cmdtService] [${tag}] serial=${serial} vid=${vid} LICENSE_NMBR="${lic}" -> REAL vehicle, BLOCKED`);
  return { status: "blocked", vid, licenseNmbr: lic };
}

// ---------------------------------------------------------------------------
// DEACTIVATE_VEHICLE_HIST
// ---------------------------------------------------------------------------

async function deactivateCmdt(
  cfg         : Html5SessionConfig,
  vid         : number,
  licenseNmbr : string,
  jobId       : string | number,
  installerName: string,
  tag         : string
): Promise<{ ok: boolean; error?: string }> {
  try {
    console.log(`[cmdtService] [${tag}] DEACTIVATE vid=${vid} plate="${licenseNmbr}"`);

    const de = await appenginePost(cfg, "DEACTIVATE_VEHICLE_HIST", {
      VERSION_ID    : "2",
      VEHICLE_ID    : String(vid),
      LICENSE_NMBR  : String(licenseNmbr || ""),
      INSTALLER_NAME: installerName || "installer",
      COMMENTS      : "auto-deactivate CMDT placeholder to free serial",
      REASON_CODE   : "5501",
      DELIVER_CODE  : "5511",
    }, "CMDT_DEACTIVATE");

    const deText = String(de.text || "");

    // dump para diagnóstico
    try { fs.writeFileSync(`/tmp/cmdt_deactivate_resp_${jobId}.txt`, deText, "utf8"); } catch { /* ignora */ }

    const isActionError =
      /<TEXT>\s*Action:\s*DEACTIVATE_VEHICLE_HIST\s*error/i.test(deText) ||
      /DEACTIVATE_VEHICLE_HIST\s*error/i.test(deText) ||
      /<ERROR\b/i.test(deText);

    if (isActionError) {
      console.log(`[cmdtService] [${tag}] DEACTIVATE action_error vid=${vid}: ${safeSnippet(deText, 160)}`);
      return { ok: false, error: "deactivate_action_error" };
    }

    console.log(`[cmdtService] [${tag}] DEACTIVATE OK vid=${vid} http=${de.status} loginNeg=${de.loginNeg ? 1 : 0}`);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[cmdtService] [${tag}] DEACTIVATE exception vid=${vid}: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Ponto de entrada público
// ---------------------------------------------------------------------------

/**
 * Verifica se o serial está preso em veículo CMDT e, se sim, faz DEACTIVATE para liberá-lo.
 * Deve ser chamado antes do INSTALL, logo após resolver o VEHICLE_ID.
 *
 * @param installerName  Nome do instalador (para o campo INSTALLER_NAME do DEACTIVATE)
 */
export async function checkAndFreeSerial(
  cfg          : Html5SessionConfig,
  newSerial    : string,
  jobId        : string | number,
  installerName: string = "installer"
): Promise<CmdtFreeResult> {
  const TAG = "CMDT_FREE_V2";
  try {
    if (!newSerial) return { freed: false, blocked: false };

    const serial = String(newSerial).trim();
    console.log(`[cmdtService] [${TAG}] checking serial=${serial} job=${jobId}`);

    // 1) Tenta encontrar via INNER_ID
    let found = await vhclsLookup(cfg, "INNER_ID", serial, serial, TAG);

    // sessão expirada → relogin + retry
    if (found.sessionError) {
      console.log(`[cmdtService] [${TAG}] session error on INNER_ID lookup, retrying after relogin`);
      await ensureHtml5Session(cfg, TAG).catch(() => {});
      found = await vhclsLookup(cfg, "INNER_ID", serial, serial, TAG);
    }

    // 2) Se não achou via INNER_ID, tenta via LICENSE_NMBR
    if (!found.vid) {
      console.log(`[cmdtService] [${TAG}] not found via INNER_ID, trying LICENSE_NMBR`);
      found = await vhclsLookup(cfg, "LICENSE_NMBR", serial, serial, TAG);
    }

    // 3) Não achou em nenhum → serial livre (ou inexistente)
    if (!found.vid) {
      console.log(`[cmdtService] [${TAG}] serial=${serial} not found -> serial free or does not exist`);
      return { freed: false, blocked: false };
    }

    // 4) Classifica
    const classification = classifyVehicle(found.vid, found.licenseNmbr, serial, TAG);
    if (!classification) return { freed: false, blocked: false };

    if (classification.status === "free") {
      return { freed: false, blocked: false };
    }

    if (classification.status === "blocked") {
      return { freed: false, blocked: true, vid_blocked: found.vid!, plate_blocked: found.licenseNmbr! };
    }

    // 5) É CMDT → faz DEACTIVATE
    const deResult = await deactivateCmdt(cfg, found.vid!, found.licenseNmbr!, jobId, installerName, TAG);

    if (!deResult.ok) {
      return { freed: false, error: deResult.error ?? "deactivate_failed", vid_freed: found.vid!, plate: found.licenseNmbr! };
    }

    return { freed: true, vid_freed: found.vid!, plate_freed: found.licenseNmbr! };

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[cmdtService] [${TAG}] unexpected error: ${msg}`);
    return { freed: false, error: msg };
  }
}
