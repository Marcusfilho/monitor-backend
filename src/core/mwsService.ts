/**
 * mwsService.ts
 * Serviço MWS (SAVE_VHCL_ACTIVATION_NEW) — extraído do monolito html5InstallWorker_v8.js
 *
 * Responsabilidades:
 *  - Carregar baseline de ativação via GET_VHCL_ACTIVATION_DATA_NEW (ACT_LOAD)
 *  - Parsear form HTML + attrs XML do baseline
 *  - Enriquecer payload de SAVE com os dados do baseline
 *  - Executar SAVE_VHCL_ACTIVATION_NEW
 *  - Verificar (postcheck) se o serial foi aplicado
 *
 * NÃO contém lógica de job, VHCLS, CMDT ou workers.
 * Depende de: html5Session (para ensureHtml5Session + cookie)
 */

import * as fs from "fs";
import { ensureHtml5Session, readJarCookie, ensureCookieDefaults, Html5SessionConfig } from "./html5Session";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type MwsFields = Record<string, string>;

export interface MwsBaselineResult {
  fields  : MwsFields;   // campos extraídos do form HTML + attrs XML
  rawText : string;      // resposta bruta do ACT_LOAD (para dump/debug)
}

export interface MwsSaveResult {
  status   : number;
  text     : string;
  hasError : boolean;
}

export interface MwsPostcheckResult {
  dial     : string;     // DIAL_NUMBER atual no sistema após SAVE
  applied  : boolean;    // true se dial === newSerial
  rawText  : string;
}

// ---------------------------------------------------------------------------
// Utilitários de parse
// ---------------------------------------------------------------------------

/** Extrai attrs de <DATA DATASOURCE="GET_VHCL_ACTIVATION_DATA_NEW" .../> */
export function mwsExtractActivationAttrs(xmlText: string): MwsFields {
  try {
    if (!xmlText || typeof xmlText !== "string") return {};
    const m = xmlText.match(/<DATA\s+[^>]*DATASOURCE="GET_VHCL_ACTIVATION_DATA_NEW"[^>]*\/>/i);
    if (!m) return {};
    const tag   = m[0];
    const attrs: MwsFields = {};
    const reAttr = /\b([A-Za-z0-9_]+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = reAttr.exec(tag))) attrs[am[1]] = am[2];
    return attrs;
  } catch { return {}; }
}

/** Lê XML de baseline de arquivos temporários gerados em execuções anteriores */
export function mwsReadBaselineXml(jobId: string | number): string {
  const candidates = [
    `/tmp/mws_act_load_resp_${jobId}.txt`,
    `/tmp/mws_postcheck_form_${jobId}.html`,
    `/tmp/mws_postcheck_resp_${jobId}.txt`,
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const t = fs.readFileSync(p, "utf8");
        if (t && t.includes("GET_VHCL_ACTIVATION_DATA_NEW")) return t;
      }
    } catch { /* continua */ }
  }
  return "";
}

/** Detecta erro na resposta do SAVE_VHCL_ACTIVATION_NEW */
export function mwsSaveResponseHasError(text: string): boolean {
  try {
    if (!text) return false;
    if (/Action:\s*SAVE_VHCL_ACTIVATION_NEW\s*error\./i.test(text)) return true;
    if (/<ERROR\b/i.test(text)) return true;
    return false;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Parser de form HTML (input / select / textarea)
// ---------------------------------------------------------------------------

function decodeHtml(v: string): string {
  return String(v || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function getAttr(tag: string, key: string): string {
  const re = new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

export function parseFormFields(html: string): MwsFields {
  const out: MwsFields = {};
  const t = String(html || "");

  // inputs
  const inRe = /<input\b[^>]*>/ig;
  let m: RegExpExecArray | null;
  while ((m = inRe.exec(t))) {
    const tag = m[0];
    const nm  = getAttr(tag, "name");
    if (!nm) continue;
    if (/\bdisabled\b/i.test(tag)) continue;
    const typ = getAttr(tag, "type").toLowerCase();
    if (["submit","button","image","reset","file"].includes(typ)) continue;
    if (typ === "checkbox" || typ === "radio") {
      if (!/\bchecked\b/i.test(tag)) continue;
      out[nm] = decodeHtml(getAttr(tag, "value") || "on");
      continue;
    }
    out[nm] = decodeHtml(getAttr(tag, "value") || "");
  }

  // selects
  const selRe = /<select\b[^>]*\bname\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/select>/ig;
  let sm: RegExpExecArray | null;
  while ((sm = selRe.exec(t))) {
    const nm   = sm[1];
    if (!nm) continue;
    const body = sm[2] || "";
    let opt = (body.match(/<option\b[^>]*\bselected\b[^>]*>/i) || [])[0]
           || (body.match(/<option\b[^>]*>/i) || [])[0];
    if (!opt) { out[nm] = ""; continue; }
    const mv  = opt.match(/\bvalue\s*=\s*["']([^"']*)["']/i);
    let val   = mv ? mv[1] : "";
    if (!val) {
      const mt = body.match(/<option\b[^>]*\bselected\b[^>]*>([\s\S]*?)<\/option>/i)
              || body.match(/<option\b[^>]*>([\s\S]*?)<\/option>/i);
      val = mt ? String(mt[1] || "").replace(/<[^>]+>/g, "").trim() : "";
    }
    out[nm] = decodeHtml(val);
  }

  // textareas
  const taRe = /<textarea\b[^>]*\bname\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/textarea>/ig;
  let tm: RegExpExecArray | null;
  while ((tm = taRe.exec(t))) {
    const nm = tm[1];
    if (!nm) continue;
    out[nm] = decodeHtml(String(tm[2] || "").replace(/\r\n/g, "\n").trim());
  }

  return out;
}

// ---------------------------------------------------------------------------
// Enriquecimento do payload com dados do baseline
// ---------------------------------------------------------------------------

/**
 * Mescla dados do baseline XML no savePayload.
 * Campos críticos (ASSET_TYPE, FIELD_IDS, FIELD_VALUE, GROUP_ID) sempre sobrescritos.
 * Campos do caller explicitamente definidos são preservados.
 */
export function mwsEnrichSavePayloadFromBaseline(
  jobId          : string | number,
  savePayload    : MwsFields,
  baselineXmlText: string = ""
): MwsFields {
  try {
    let payload = { ...savePayload };
    const needs = !payload.ASSET_TYPE || !payload.FIELD_IDS || !payload.FIELD_VALUE || !payload.GROUP_ID;
    if (!needs) return payload;

    let xml = baselineXmlText;
    if (!xml || !xml.includes("GET_VHCL_ACTIVATION_DATA_NEW")) xml = mwsReadBaselineXml(jobId);

    const base = mwsExtractActivationAttrs(xml);

    // preserva o que o caller definiu explicitamente
    const keep: Partial<MwsFields> = {
      VERSION_ID  : payload.VERSION_ID,
      VEHICLE_ID  : payload.VEHICLE_ID,
      LICENSE_NMBR: payload.LICENSE_NMBR,
      DIAL_NUMBER : payload.DIAL_NUMBER,
      INNER_ID    : payload.INNER_ID,
      CLIENT_ID   : payload.CLIENT_ID,
      ASSET_TYPE  : payload.ASSET_TYPE,
    };

    payload = { ...base, ...payload };

    for (const [k, v] of Object.entries(keep)) {
      if (v !== undefined && v !== null) payload[k] = v;
    }

    if (!payload.VERSION_ID) payload.VERSION_ID = "2";
    return payload;
  } catch {
    return savePayload;
  }
}

// ---------------------------------------------------------------------------
// HTTP helper (AppEngine POST)
// ---------------------------------------------------------------------------

async function appenginePost(
  cfg    : Html5SessionConfig,
  action : string,
  fields : MwsFields,
  tag    : string
): Promise<{ status: number; text: string; loginNeg: boolean }> {
  // garante sessão antes de cada request
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
    const text    = await res.text().catch(() => "");
    const loginNeg = /login\s*=\s*"-1"/i.test(text) || /<!DOCTYPE\s+html/i.test(text);
    console.log(`[mwsService] [${tag}] action=${action} http=${res.status} len=${text.length} loginNeg=${loginNeg ? 1 : 0}`);
    return { status: res.status, text, loginNeg };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Helpers de data
// ---------------------------------------------------------------------------

function fmtDDMMYYYY(d: Date): string {
  const dd   = String(d.getDate()).padStart(2, "0");
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ---------------------------------------------------------------------------
// Operações públicas
// ---------------------------------------------------------------------------

/**
 * Carrega o baseline de ativação do veículo (GET_VHCL_ACTIVATION_DATA_NEW).
 * Faz parse do form HTML + merge dos attrs XML.
 */
export async function mwsLoadBaseline(
  cfg      : Html5SessionConfig,
  vehicleId: string | number,
  jobId    : string | number
): Promise<MwsBaselineResult> {
  const lo = await appenginePost(
    cfg,
    "GET_VHCL_ACTIVATION_DATA_NEW",
    { VERSION_ID: "2", VEHICLE_ID: String(vehicleId) },
    "MWS_ACT_LOAD"
  );

  if (lo.loginNeg) throw new Error("mws_activation_load_loginneg");

  // dump raw (opcional — para diagnóstico)
  try { fs.writeFileSync(`/tmp/mws_act_load_resp_${jobId}.txt`, lo.text || "", "utf8"); } catch { /* ignora */ }

  // parse form HTML
  const fields = parseFormFields(lo.text);

  // merge attrs XML (campos críticos sobrescritos)
  try {
    const xmlAttrs = mwsExtractActivationAttrs(lo.text);
    if (xmlAttrs && Object.keys(xmlAttrs).length) {
      const CRITICAL = new Set(["ASSET_TYPE","FIELD_IDS","FIELD_VALUE","GROUP_ID"]);
      for (const [k, v] of Object.entries(xmlAttrs)) {
        const val = v == null ? "" : String(v);
        if (CRITICAL.has(k)) {
          fields[k] = val;
        } else if (fields[k] === undefined || fields[k] === null || String(fields[k]).trim() === "") {
          fields[k] = val;
        }
      }
    }
  } catch { /* não bloqueia */ }

  return { fields, rawText: lo.text };
}


/**
 * Executa DEACTIVATE_VEHICLE_HIST para o vehicle_id informado.
 * Retorna { ok, http, head } — não lança exceção em action_error.
 */
export async function mwsDeactivate(
  cfg      : Html5SessionConfig,
  vehicleId: string | number,
  plate    : string,
  jobId    : string | number,
  opts     : { installerName?: string; comments?: string } = {}
): Promise<{ ok: boolean; http: number; head: string }> {
  const de = await appenginePost(
    cfg,
    "DEACTIVATE_VEHICLE_HIST",
    {
      VERSION_ID    : "2",
      VEHICLE_ID    : String(vehicleId),
      LICENSE_NMBR  : String(plate || ""),
      INSTALLER_NAME: String(opts.installerName || "installer"),
      COMMENTS      : String(opts.comments || "swap"),
      REASON_CODE   : "5501",
      DELIVER_CODE  : "5511",
    },
    "MWS_DEACTIVATE"
  );
  try { fs.writeFileSync(`/tmp/mws_deactivate_resp_${jobId}.txt`, de.text || "", "utf8"); } catch { /* ignora */ }
  const deText = String(de.text || "");
  const isActionError =
    /<TEXT>\s*Action:\s*DEACTIVATE_VEHICLE_HIST\s*error/i.test(deText) ||
    /DEACTIVATE_VEHICLE_HIST\s*error/i.test(deText) ||
    /<ERROR\b/i.test(deText);
  if (de.loginNeg) throw new Error("mws_deactivate_loginneg");
  const head = deText.slice(0, 220);
  console.log(`[mwsService] [MWS_DEACTIVATE] vehicleId=${vehicleId} http=${de.status} actionError=${isActionError ? 1 : 0}`);
  return { ok: !isActionError, http: de.status, head };
}

/**
 * Executa o SAVE_VHCL_ACTIVATION_NEW com o serial novo.
 * Aplica defaults de data/mileage e limpa campos nulos.
 */
export async function mwsSave(
  cfg      : Html5SessionConfig,
  jobId    : string | number,
  vehicleId: string | number,
  plate    : string,
  newSerial: string,
  baseline : MwsBaselineResult,
  opts     : { stripFields?: boolean } = {}
): Promise<MwsSaveResult> {
  const base: MwsFields = { ...baseline.fields };

  // IDs obrigatórios
  base.VERSION_ID  = String(base.VERSION_ID || "2");
  base.VEHICLE_ID  = String(vehicleId);
  base.LICENSE_NMBR = String(base.LICENSE_NMBR || plate || "");
  // FIX_CLIENT_ID_V1: CLIENT_ID do baseline pode ser o cliente antigo (antes da CHANGE_COMPANY).
  // Se o caller definiu CLIENT_ID explicitamente no baseline.fields, usa ele — caso contrário preserva.
  // O installWorker passa fakeBaseline com fields vindos do buildInstallFields que já tem o CLIENT_ID correto.
  if (baseline.fields.CLIENT_ID) base.CLIENT_ID = String(baseline.fields.CLIENT_ID);

  // serial novo
  base.DIAL_NUMBER = newSerial;
  base.INNER_ID    = newSerial;
  if (base.UNIT        !== undefined) base.UNIT        = newSerial;
  if (base.UNIT_NUMBER !== undefined) base.UNIT_NUMBER = newSerial;
  if (base.UNIT_SN     !== undefined) base.UNIT_SN     = newSerial;
  if (base.INNERID     !== undefined) base.INNERID     = newSerial;

  // defaults de data/mileage
  try {
    const today = fmtDDMMYYYY(new Date());
    if (!base.INSTALLATION_DATE)  base.INSTALLATION_DATE  = today;
    if (!base.WARRANTY_START_DATE) base.WARRANTY_START_DATE = base.INSTALLATION_DATE;
    if (!base.MILAGE_SOURCE_ID)   base.MILAGE_SOURCE_ID   = "5067";
    if (!base.WARRANTY_PERIOD_ID) base.WARRANTY_PERIOD_ID  = "1";
  } catch { /* não bloqueia */ }

  // strip opcional
  if (opts.stripFields) {
    delete base.FIELD_IDS;
    delete base.FIELD_VALUE;
  }

  // limpa "undefined"/"null" literais
  for (const k of Object.keys(base)) {
    const ss = String(base[k] ?? "").trim().toLowerCase();
    if (ss === "undefined" || ss === "null") base[k] = "";
  }

  // remove action/ACTION (não deve ir no body junto com a action do POST)
  delete base.action;
  delete base.ACTION;

  // enriquece com baseline XML (ASSET_TYPE/FIELD_IDS/FIELD_VALUE/GROUP_ID)
  const enriched = mwsEnrichSavePayloadFromBaseline(jobId, base, baseline.rawText);

  // dump para diagnóstico
  try {
    const must = ["VERSION_ID","VEHICLE_ID","LICENSE_NMBR","DIAL_NUMBER","INNER_ID","INSTALLATION_DATE","MILAGE_SOURCE_ID","WARRANTY_PERIOD_ID"];
    const missing = must.filter(k => !enriched[k] || String(enriched[k]).trim() === "");
    const meta = { ts: Date.now(), job_id: jobId, plate, vehicle_id: vehicleId, serial_new: newSerial, keyCount: Object.keys(enriched).length, missing };
    fs.writeFileSync(`/tmp/mws_save_${jobId}.json`, JSON.stringify({ meta, payload: enriched }, null, 2), "utf8");
    console.log(`[mwsService] MWS_SAVE_CAPTURE keys=${meta.keyCount} missing=${missing.join(",") || "-"}`);
  } catch { /* não bloqueia */ }

  const sv = await appenginePost(cfg, "SAVE_VHCL_ACTIVATION_NEW", enriched, "MWS_SAVE");

  // dump resposta
  try { fs.writeFileSync(`/tmp/mws_save_resp_${jobId}.txt`, sv.text || "", "utf8"); } catch { /* ignora */ }

  const hasError = mwsSaveResponseHasError(sv.text);

  return { status: sv.status, text: sv.text, hasError };
}

/**
 * Verifica se o serial foi aplicado (GET_VHCL_ACTIVATION_DATA_NEW pós-SAVE).
 * Compara DIAL_NUMBER retornado com newSerial.
 */
export async function mwsPostcheck(
  cfg      : Html5SessionConfig,
  vehicleId: string | number,
  newSerial: string,
  jobId    : string | number
): Promise<MwsPostcheckResult> {
  const pc = await appenginePost(
    cfg,
    "GET_VHCL_ACTIVATION_DATA_NEW",
    { VERSION_ID: "2", VEHICLE_ID: String(vehicleId) },
    "MWS_POSTCHECK"
  );

  try { fs.writeFileSync(`/tmp/mws_postcheck_resp_${jobId}.txt`, pc.text || "", "utf8"); } catch { /* ignora */ }

  let dial = "";
  try {
    const attrs = mwsExtractActivationAttrs(pc.text) || {};
    dial = String(attrs.DIAL_NUMBER || attrs.INNER_ID || attrs.DIALNUMBER || "").trim();
  } catch { /* ignora */ }

  const applied = dial.trim() === String(newSerial || "").trim();

  if (!applied) {
    // dump para diagnóstico
    try { fs.writeFileSync(`/tmp/mws_postcheck_form_${jobId}.html`, pc.text, "utf8"); } catch { /* ignora */ }
  }

  return { dial, applied, rawText: pc.text };
}

/**
 * Fluxo MWS completo: ACT_LOAD → SAVE → postcheck.
 * Lança erro se SAVE falhar ou serial não for aplicado.
 *
 * @returns dial confirmado após SAVE
 */
export async function mwsSwapSerial(
  cfg      : Html5SessionConfig,
  jobId    : string | number,
  vehicleId: string | number,
  plate    : string,
  newSerial: string,
  opts     : { stripFields?: boolean } = {}
): Promise<string> {
  // 1. Carrega baseline
  const baseline = await mwsLoadBaseline(cfg, vehicleId, jobId);

  // 2. SAVE
  const saveResult = await mwsSave(cfg, jobId, vehicleId, plate, newSerial, baseline, opts);
  if (saveResult.hasError) {
    throw new Error(`mws_save_action_error: http=${saveResult.status}`);
  }

  // 3. Postcheck
  const pc = await mwsPostcheck(cfg, vehicleId, newSerial, jobId);
  if (!pc.applied) {
    throw new Error(`mws_save_not_applied: dial=${pc.dial || "<empty>"}`);
  }

  return pc.dial;
}
