"use strict";
/**
 * monitor-can-snapshot-worker (REAL)
 * - Consome jobs do tipo monitor_can_snapshot
 * - Coleta snapshot real do Vehicle Monitor via WebSocket
 * - Completa job com result.ok/result.status + result.meta.summary + result.meta.snapshots[]
 *
 * Requer envs (no systemd EnvironmentFile):
 * - JOB_SERVER_BASE_URL (Render/base do backend)
 * - WORKER_KEY
 * - TRAFFILOG_API_BASE_URL (terminando em /1/json)  [ou TRAFFILOG_LOGIN_URL]
 * - WS_LOGIN_NAME / WS_PASSWORD
 *
 * Opcional:
 * - SESSION_TOKEN_PATH (default /tmp/.session_token)
 * - MONITOR_SESSION_TOKEN_TTL_MS (default 6h)
 * - VM_WINDOW_MS (default 8000)
 * - VM_WAIT_AFTER_CMD_MS (default 1000)
 * - VM_WS_OPEN_TIMEOUT_MS (default 15000)
 * - VM_DEFAULT_CYCLES (default 3)
 * - VM_DEFAULT_INTERVAL_MS (default 12000)
 * - VM_MAX_CYCLES (default 8)
 * - VM_URL_ENCODE (default 1)
 */

const fs = require("fs");
const path = require("path");
const __DBG_DIR = "/home/questar/monitor-backend/tmp";
try { fs.mkdirSync(__DBG_DIR, { recursive: true }); } catch(_e) {}
try { fs.writeFileSync(`${__DBG_DIR}/can_worker_boot.txt`, new Date().toISOString()); } catch(_e) {}
const crypto = require("crypto");
const { collectVehicleMonitorSnapshot, summarizeCanFromModuleState } = require("../services/vehicleMonitorSnapshotService");

const WORKER_ID = process.env.WORKER_ID || "can_snapshot";
const BASE = (process.env.JOB_SERVER_BASE_URL || process.env.BASE_URL || process.env.BACKEND_BASE_URL || "").replace(/\/$/, "");
const KEY  = (process.env.WORKER_KEY || "").trim();

// OPTC_PROGRESS_SEND_V1
const CAN_SUMMARY_MAX_PARAMS = Number(process.env.CAN_SUMMARY_MAX_PARAMS || "220");
const CAN_SUMMARY_MAX_MS = Number(process.env.CAN_SUMMARY_MAX_MS || "80");

const MONITOR_WS_ORIGIN = String(process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com");
const MONITOR_SESSION_TOKEN_PATH = (process.env.SESSION_TOKEN_PATH || process.env.MONITOR_SESSION_TOKEN_PATH || "/tmp/.session_token");
const MONITOR_SESSION_TOKEN_TTL_MS = Number(process.env.MONITOR_SESSION_TOKEN_TTL_MS || "21600000"); // 6h

const TRAFFILOG_API_BASE_URL = (process.env.TRAFFILOG_API_BASE_URL || process.env.TRAFFILOG_API_URL || process.env.MONITOR_API_BASE_URL || "").trim();
const TRAFFILOG_LOGIN_URL = (process.env.TRAFFILOG_LOGIN_URL || "").trim();
const WS_LOGIN_NAME = (process.env.WS_LOGIN_NAME || process.env.MONITOR_LOGIN_NAME || "").trim();
const WS_PASSWORD   = (process.env.WS_PASSWORD   || process.env.MONITOR_PASSWORD   || "").trim();

const VM_WINDOW_MS = Number(process.env.VM_WINDOW_MS || "8000");
const VM_WAIT_AFTER_CMD_MS = Number(process.env.VM_WAIT_AFTER_CMD_MS || "1000");
const VM_WS_OPEN_TIMEOUT_MS = Number(process.env.VM_WS_OPEN_TIMEOUT_MS || "15000");
const MAX_CYCLES = Number(process.env.VM_MAX_CYCLES || "8");
const DEFAULT_CYCLES = Number(process.env.VM_DEFAULT_CYCLES || "3");
const DEFAULT_INTERVAL_MS = Number(process.env.VM_DEFAULT_INTERVAL_MS || "12000");
const EARLY_STOP_MIN_TOTAL = Number(process.env.VM_EARLY_STOP_MIN_TOTAL || "6");
const EARLY_STOP_MIN_WITH = Number(process.env.VM_EARLY_STOP_MIN_WITH || "6");
const ZERO_PARAMS_SLEEP_MS = Number(process.env.VM_ZERO_PARAMS_SLEEP_MS || "4000");
const URL_ENCODE = (process.env.VM_URL_ENCODE || "1") !== "0";

// === OPT C: Complete com 1 snapshot resumido (evita HTTP 413) ===
function __cs_displayValue(p){
  const v = p && (p.value ?? p.val ?? p.current_value ?? p.currentValue ?? p.raw_value ?? p.rawValue);
  return (v === null || v === undefined) ? "" : String(v);
}

function __cs_summarizeSnapshot(snap){
  if (!snap || typeof snap !== "object") return null;

  const params = Array.isArray(snap.parameters) ? snap.parameters
              : Array.isArray(snap.params) ? snap.params
              : [];

  const ms = Array.isArray(snap.moduleState) ? snap.moduleState
           : Array.isArray(snap.module_state) ? snap.module_state
           : [];

  const header = (snap.header && typeof snap.header === "object") ? { ...snap.header } : null;
  const paramsWithValue = params.filter(p => __cs_displayValue(p).trim() !== "").length;

  const pickedParams = params
    .filter(p => __cs_displayValue(p).trim() !== "")
    .slice(0, CAN_SUMMARY_MAX_PARAMS)
    .map(p => ({
      id: p.id ?? p.param_id ?? p.paramId ?? null,
      name: p.name ?? null,
      param_type: p.param_type ?? p.type ?? null,
      value: p.value ?? null,
      raw_value: p.raw_value ?? p.rawValue ?? null,
      last_update: p.last_update ?? p.lastUpdate ?? null,
      source: p.source ?? null,
      duplicate_unit: p.duplicate_unit ?? p.duplicateUnit ?? null,
    }));

  const pickedMs = ms.slice(0, 80).map(r => ({
    id: r.id ?? r.module_id ?? r.moduleId ?? null,
    module: r.module ?? null,
    sub: r.sub ?? null,
    name: r.name ?? r.module_name ?? r.moduleName ?? null,
    active: r.active ?? null,
    ok: r.ok ?? r.is_ok ?? r.isOk ?? null,
    was_ok: r.was_ok ?? r.wasOk ?? null,
    error: r.error ?? null,
    message: r.message ?? r.msg ?? r.error_descr ?? null,
  }));

  let moduleKey = 0;
  try {
    moduleKey = Number((summarizeCanFromModuleState(ms) || {}).keyCount || 0) || 0;
  } catch(_e) {}

  const out = {
    captured_at: snap.captured_at || new Date().toISOString(),
    meta: { summary_v: 2, ...(snap.meta && typeof snap.meta === "object" ? { windowMs: snap.meta.windowMs } : {}) },
    counts: {
      params_total: params.length,
      params_with_value: paramsWithValue,
      module_total: ms.length,
      module_state_key: moduleKey,
    },
    parameters: pickedParams,
    moduleState: pickedMs,
  };

  if (header) out.header = header;
  if (snap.rawCounts && typeof snap.rawCounts === "object") out.rawCounts = snap.rawCounts;
  if (snap.debug && typeof snap.debug === "object") out.debug = snap.debug;

  return out;
}

function __cs_pickBestSummary(curr, cand){
  if (!cand) return curr;
  if (!curr) return cand;
  const a = (curr.counts && curr.counts.params_with_value) || 0;
  const b = (cand.counts && cand.counts.params_with_value) || 0;
  if (b > a) return cand;
  const am = (curr.counts && curr.counts.params_total) || 0;
  const bm = (cand.counts && cand.counts.params_total) || 0;
  if (bm > am) return cand;
  return curr;
}

function __cs_shrinkResultForComplete(result){
  if (!result || typeof result !== "object") return result;

  const meta = (result && result.meta && typeof result.meta === "object") ? result.meta : null;

  const snaps =
    Array.isArray(result.snapshots) ? result.snapshots :
    Array.isArray(result.can_snapshots) ? result.can_snapshots :
    Array.isArray(result.canSnapshots) ? result.canSnapshots :
    (meta && Array.isArray(meta.snapshots)) ? meta.snapshots :
    (meta && Array.isArray(meta.can_snapshots)) ? meta.can_snapshots :
    (meta && Array.isArray(meta.canSnapshots)) ? meta.canSnapshots :
    [];

  let best = null;
  for (const s of snaps){
    const summary = __cs_summarizeSnapshot(s);
    best = __cs_pickBestSummary(best, summary);
  }

  if (!best){
    const direct =
      (result.snapshot && typeof result.snapshot === "object") ? result.snapshot :
      (meta && meta.snapshot && typeof meta.snapshot === "object") ? meta.snapshot :
      null;
    if (direct) best = __cs_summarizeSnapshot(direct) || direct;
  }

  const out = {
    ok: result.ok !== false,
    reason: result.reason || result.error || null,
    installation_id: result.installation_id || result.installationId || (meta && meta.summary && (meta.summary.installationId || meta.summary.installation_id)) || null,
    vehicle_id: result.vehicle_id || result.vehicleId || (meta && meta.summary && (meta.summary.vehicleId || meta.summary.vehicle_id)) || null,
    snapshot: best,
    snapshots: best ? [best] : [],
    meta: { summary: (meta && meta.summary) ? meta.summary : null, snapshots: best ? [best] : [] }
  };

  try { out._result_bytes = JSON.stringify(out).length; } catch(_){}
  return out;
}
// === /OPT C ===


function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// === OPT C (fix 413): complete sempre pequeno + body_bytes ===
function __cs_trimStr(x, maxLen){
  const s = (x===null || x===undefined) ? "" : String(x);
  return s.length > maxLen ? (s.slice(0, maxLen) + "…") : s;
}
function __cs_displayValue(p){
  const v = p && (p.value ?? p.val ?? p.current_value ?? p.currentValue ?? p.raw_value ?? p.rawValue);
  return (v === null || v === undefined) ? "" : String(v);
}
function __cs_summarizeSnapshot(snap){
  if (!snap || typeof snap !== "object") return null;

  const params = Array.isArray(snap.parameters) ? snap.parameters
              : Array.isArray(snap.params) ? snap.params
              : [];
  const ms = Array.isArray(snap.moduleState) ? snap.moduleState
           : Array.isArray(snap.module_state) ? snap.module_state
           : [];

  const paramsWithValue = params.filter(p => __cs_displayValue(p).trim() !== "").length;

  // IMPORTANT: manter bem pequeno (evitar 413)
  const pickedParams = params
    .filter(p => __cs_displayValue(p).trim() !== "")
    .slice(0, CAN_SUMMARY_MAX_PARAMS)
    .map(p => ({
      id: p.id ?? p.param_id ?? p.paramId ?? null,
      name: __cs_trimStr(p.name ?? "", 80) || null,
      param_type: __cs_trimStr(p.param_type ?? p.type ?? "", 40) || null,
      value: __cs_trimStr(p.value ?? "", 80) || null,
      raw_value: __cs_trimStr(p.raw_value ?? p.rawValue ?? "", 160) || null,
      last_update: __cs_trimStr(p.last_update ?? p.lastUpdate ?? "", 40) || null,
      source: __cs_trimStr(p.source ?? "", 30) || null,
    }));

  const pickedMs = ms.slice(0, CAN_SUMMARY_MAX_MS).map(r => ({
    id: r.id ?? r.module_id ?? r.moduleId ?? null,
    name: __cs_trimStr(r.name ?? r.module_name ?? r.moduleName ?? "", 60) || null,
    active: r.active ?? null,
    ok: r.ok ?? r.is_ok ?? r.isOk ?? null,
    was_ok: r.was_ok ?? r.wasOk ?? null,
    message: __cs_trimStr(r.message ?? r.msg ?? "", 120) || null,
  }));

  return {
    captured_at: new Date().toISOString(),
    counts: {
      params_total: params.length,
      params_with_value: paramsWithValue,
      module_total: ms.length,
    },
    parameters: pickedParams,
    moduleState: pickedMs,
  };
}


function __cs_pickSnapshotCandidate(result){
  const r = result || {};
  const last = (arr) => (Array.isArray(arr) && arr.length) ? arr[arr.length-1] : null;

  const meta =
    (r && r.meta) ||
    (r && r.result && r.result.meta) ||
    (r && r.data && r.data.meta) ||
    null;

  const metaSnaps =
    (meta && Array.isArray(meta.snapshots) ? meta.snapshots : null) ||
    (meta && Array.isArray(meta.can_snapshot) ? meta.can_snapshot : null) ||
    (meta && Array.isArray(meta.canSnapshots) ? meta.canSnapshots : null) ||
    null;

  const metaBest =
    (meta && (meta.best || meta.snapshot || meta.can_snapshot_latest || meta.canSnapshotLatest)) ||
    null;

  const cand = [
    metaBest,
    (metaSnaps && metaSnaps[0]) || null,

    r.best, r.bestSnapshot, r.best_snapshot,
    r.snapshot, r.lastSnapshot, r.last_snapshot,
    r.can_snapshot_latest, r.canSnapshotLatest,

    last(r.snapshots), last(r.can_snapshot), last(r.canSnapshot),
    (r.can && last(r.can.snapshots)),
    (r.result && (r.result.snapshot || r.result.best || r.result.bestSnapshot || r.result.best_snapshot ||
      last(r.result.snapshots) || last(r.result.can_snapshot) || last(r.result.canSnapshot) ||
      (r.result.can && last(r.result.can.snapshots)))),
    (r.data && (r.data.snapshot || r.data.best || r.data.bestSnapshot || r.data.best_snapshot ||
      last(r.data.snapshots) || last(r.data.can_snapshot) || last(r.data.canSnapshot) ||
      (r.data.can && last(r.data.can.snapshots)))),
  ];

  for (const c of cand){
    if (!c) continue;
    if (Array.isArray(c.parameters) || Array.isArray(c.moduleState) || c.counts) return c;
  }
  return null;
}


function __cs_buildSmallResult(result){
  const meta = (result && result.meta) ? result.meta : null;
  const metaSnaps = (meta && Array.isArray(meta.snapshots)) ? meta.snapshots : null;

  let best = null;
  if (metaSnaps && metaSnaps.length){
    for (const s of metaSnaps){
      const summary = __cs_summarizeSnapshot(s);
      best = __cs_pickBestSummary(best, summary);
    }
  }

  const cand = best || __cs_pickSnapshotCandidate(result);
  const isSummary = !!(cand && cand.counts && Array.isArray(cand.parameters));
  const snap = cand ? (isSummary ? cand : (__cs_summarizeSnapshot(cand) || cand)) : null;

  return {
    ok: (result && result.ok === false) ? false : true,
    reason: (result && (result.reason || result.error)) || null,
    installation_id: (result && (result.installation_id || result.installationId)) || null,
    vehicle_id: (result && (result.vehicle_id || result.vehicleId)) || null,
    snapshot: snap,
    snapshots: snap ? [snap] : [],
  };
}



function __cs_completeBody(result){
  const payloadResult = __cs_buildSmallResult(result);
  const snap = payloadResult.snapshot || ((payloadResult.snapshots && payloadResult.snapshots[0]) || null);

  const payload = {
    status: "completed",
    workerId: WORKER_ID,
    result: payloadResult,

    // aliases para o backend/probe (1 item apenas)
    can_snapshot_latest: snap,
    can_snapshot: snap ? [snap] : [],
    meta: { kind: "can_snapshot_summary_v1", counts: (snap && snap.counts) ? snap.counts : null },
  };

  let body = JSON.stringify(payload);
  console.log("[INFO] complete body_bytes=", body.length, "hasSnap=", !!snap, "counts=", (snap && snap.counts) ? snap.counts : null);

  if (body.length > 90000 && snap){
    // fallback ultra-compacto
    const p2 = Object.assign({}, snap);
    if (Array.isArray(p2.parameters)) p2.parameters = p2.parameters.slice(0,5);
    if (Array.isArray(p2.moduleState)) p2.moduleState = p2.moduleState.slice(0,5);
    payload.can_snapshot_latest = p2;
    payload.can_snapshot = [p2];
    payload.result.snapshot = p2;
    payload.result.snapshots = [p2];
    body = JSON.stringify(payload);
    console.log("[WARN] complete body_bytes (fallback)=", body.length);
  }
  return body;
}

// === /OPT C (fix 413) ===


async function fetchJsonOrText(url, opts){
  const r = await fetch(url, opts);
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { r, text: t, json: j };
}

// OPTC_PROGRESS_SEND_V1: envia snapshot parcial ao backend durante o job
async function postProgress(jobId, percent, snapshot, detail){
  try{
    if(!BASE || !KEY) return;
    const url = `${BASE}/api/jobs/${encodeURIComponent(String(jobId))}/progress`;
    const p = Math.max(0, Math.min(100, Math.round(Number(percent)||0)));
    const payload = { percent: p, stage: "monitor_can_snapshot", detail: detail || null, snapshot: snapshot || null, workerId: WORKER_ID };
    const body = JSON.stringify(payload);
    await fetch(url, { method:"POST", headers:{ "x-worker-key": KEY, "content-type":"application/json", "accept":"application/json" }, body });
  } catch(e){
    const msg = String(e && (e.message||e) || "");
    console.log("[WARN] progress falhou", jobId, msg.slice(0,200));
  }
}


function clampInt(v, lo, hi, def){
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const i = Math.floor(n);
  return Math.max(lo, Math.min(hi, i));
}

function makeGuidLike(){
  const b = crypto.randomBytes(16).toString("hex").toUpperCase();
  // 32 hex -> 8-4-4-4-12
  return `${b.slice(0,8)}-${b.slice(8,12)}-${b.slice(12,16)}-${b.slice(16,20)}-${b.slice(20,32)}`;
}

function readTokenIfFresh(){
  try{
    const st = fs.statSync(MONITOR_SESSION_TOKEN_PATH);
    const age = Date.now() - st.mtimeMs;
    if (age > MONITOR_SESSION_TOKEN_TTL_MS) return null;
    const tok = String(fs.readFileSync(MONITOR_SESSION_TOKEN_PATH, "utf8") || "").trim();
    if (tok.length < 20) return null;
    return tok;
  }catch(_){
    return null;
  }
}

async function userLoginAndGetToken(){
  if(!WS_LOGIN_NAME || !WS_PASSWORD){
    throw new Error("[can] faltam envs: WS_LOGIN_NAME / WS_PASSWORD");
  }
  const base = (TRAFFILOG_LOGIN_URL || TRAFFILOG_API_BASE_URL).replace(/\/+$/g, "");
  if(!base){
    throw new Error("[can] falta env: TRAFFILOG_API_BASE_URL (…/1/json) ou TRAFFILOG_LOGIN_URL");
  }
  const loginPayload = {
    action: { name: "user_login", parameters: { login_name: WS_LOGIN_NAME, password: WS_PASSWORD } }
  };

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 20000);

  let respText = "";
  try{
    const r = await fetch(base, {
      method: "POST",
      headers: { "content-type":"application/json", "accept":"application/json" },
      body: JSON.stringify(loginPayload),
      signal: ac.signal,
    });
    respText = await r.text();
    let j = null;
    try { j = JSON.parse(respText); } catch {}
    const tok =
      j?.response?.properties?.session_token ||
      j?.response?.properties?.data?.[0]?.session_token;

    if(!tok || String(tok).trim().length < 20){
      throw new Error("[can] user_login não retornou session_token (verifique TRAFFILOG_* e credenciais)");
    }
    return String(tok).trim();
  } finally {
    clearTimeout(to);
  }
}

async function ensureLocalSessionToken(){
  const cached = readTokenIfFresh();
  if(cached) return cached;
  const tok = await userLoginAndGetToken();
  try { fs.writeFileSync(MONITOR_SESSION_TOKEN_PATH, tok + "\n", { mode: 0o600 }); } catch(_){}
  return tok;
}

async function openMonitorWs(sessionToken, timeoutMs){
  const wsMod = require("ws");
  const WebSocketCtor = wsMod?.default || wsMod;
  const guid = String(process.env.MONITOR_WS_GUID || "").trim();
  if(!guid) throw new Error("[can] falta env: MONITOR_WS_GUID (guid do Monitor WS)");
  const url = `wss://websocket.traffilog.com:8182/${guid}/${sessionToken}/json?defragment=1`;

  return await new Promise((resolve, reject) => {
    const ws = new WebSocketCtor(url, { headers: { Origin: MONITOR_WS_ORIGIN } });
    const t = setTimeout(() => {
      try { ws.close(); } catch(_){}
      reject(new Error(`[can] WS timeout open (${timeoutMs}ms) — verifique VPN/DNS/rota p/ websocket.traffilog.com:8182`));
    }, timeoutMs);

    ws.on("open", () => { clearTimeout(t); resolve(ws); });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

// === CAN_ACQ_ENRICH_V1 (override final) ===
function __cs_summarizeSnapshot(snap){
  if (!snap || typeof snap !== "object") return null;
  const params = Array.isArray(snap.parameters) ? snap.parameters : [];
  const ms = Array.isArray(snap.moduleState) ? snap.moduleState : [];
  const idsKeep = new Set(["8","9","15","19","20"]);

  const pickedMs = ms.filter(function(r){
    const id = String((r && (r.id || r.module_id || r.moduleId)) || "").trim();
    return idsKeep.has(id);
  }).map(function(r){
    return {
      id: (r && (r.id || r.module_id || r.moduleId) != null) ? String(r.id || r.module_id || r.moduleId) : null,
      name: (r && (r.name || r.module_name || r.moduleName)) ? String(r.name || r.module_name || r.moduleName) : null,
      module_name: (r && (r.module_name || r.moduleName || r.name)) ? String(r.module_name || r.moduleName || r.name) : null,
      module: (r && r.module) ? String(r.module) : null,
      sub: (r && (r.sub || r.sub_module_name || r.subModuleName)) ? String(r.sub || r.sub_module_name || r.subModuleName) : null,
      active: !!(r && r.active),
      ok: !!(r && r.ok),
      was_ok: !!(r && r.was_ok),
      error: !!(r && r.error),
      error_descr: (r && r.error_descr != null) ? String(r.error_descr) : null,
      last_update_date: (r && (r.last_update_date || r.last_update || r.lastUpdate) != null) ? String(r.last_update_date || r.last_update || r.lastUpdate) : null,
    };
  });

  var hdr = (snap.header && typeof snap.header === "object") ? snap.header : null;
  var hdrLite = hdr ? {
    vehicle_id: hdr.vehicle_id || null,
    inner_id: hdr.inner_id || hdr.serial || null,
    serial: hdr.serial || hdr.inner_id || null,
    license_nmbr: hdr.license_nmbr || hdr.license_number || null,
    license_number: hdr.license_number || hdr.license_nmbr || null,
    driver_code: hdr.driver_code || null,
    communication: hdr.communication || hdr.server_time || null,
    server_time: hdr.server_time || hdr.communication || null,
    gps: hdr.gps || null,
    progress: hdr.progress || hdr.configuration_progress || null,
    configuration_status: hdr.configuration_status || null,
    configuration_type: hdr.configuration_type || null,
    configuration_progress: hdr.configuration_progress || hdr.progress || null,
    configuration_error: hdr.configuration_error || null,
    configuration_retries: hdr.configuration_retries || null,
    vcl_manufacturer: hdr.vcl_manufacturer || hdr.manufacturer || null,
    manufacturer: hdr.manufacturer || hdr.vcl_manufacturer || null,
    vcl_model: hdr.vcl_model || hdr.model || null,
    model: hdr.model || hdr.vcl_model || null,
    vcl_client_description: hdr.vcl_client_description || hdr.client || null,
    client: hdr.client || hdr.vcl_client_description || null,
    speed: hdr.speed != null ? hdr.speed : null,
    fuel: hdr.fuel != null ? hdr.fuel : null,
    mileage: hdr.mileage != null ? hdr.mileage : null,
    engine_hours: hdr.engine_hours != null ? hdr.engine_hours : null,
    unit_type: hdr.unit_type || null,
    unit_version: hdr.unit_version || null,
    imei: hdr.imei || null,
    sim_number: hdr.sim_number || null,
    number_of_schemes: hdr.number_of_schemes != null ? hdr.number_of_schemes : null,
    number_of_parameters: hdr.number_of_parameters != null ? hdr.number_of_parameters : null,
  } : null;

  var pWithRaw = 0, pWithName = 0, pWithTime = 0;
  for (var i=0;i<params.length;i++){
    var p = params[i] || {};
    var raw = p.raw_value != null ? String(p.raw_value).trim() : "";
    var nm = p.name != null ? String(p.name).trim() : "";
    var tm = (p.orig_time || p.last_update || p.last_update_date || p.lastUpdate || null);
    if (raw) pWithRaw++;
    if (nm) pWithName++;
    if (tm != null && String(tm).trim()) pWithTime++;
  }

  return {
    captured_at: snap.capturedAt || snap.captured_at || new Date().toISOString(),
    vehicle_id: snap.vehicleId || (hdrLite && hdrLite.vehicle_id) || null,
    header: hdrLite,
    counts: {
      params_total: params.length,
      parameters_total: params.length,
      params_with_value: pWithRaw,
      parameters_with_value: pWithRaw,
      params_with_name: pWithName,
      parameters_with_name: pWithName,
      params_with_time: pWithTime,
      parameters_with_time: pWithTime,
      module_state_total: ms.length,
      module_state_key: pickedMs.length,
      raw_events: (snap.rawCounts || snap.raw_counts || null) || null,
    },
    parameters: params.slice(0, 220).map(function(p){
      return {
        id: p && p.id != null ? String(p.id) : null,
        name: p && p.name != null ? String(p.name) : null,
        raw_value: p && p.raw_value != null ? String(p.raw_value) : null,
        value: (p && p.value != null) ? String(p.value) : null,
        source: p && p.source != null ? String(p.source) : null,
        orig_time: p && p.orig_time != null ? String(p.orig_time) : null,
        last_update: (p && (p.last_update || p.last_update_date || p.lastUpdate) != null)
          ? String(p.last_update || p.last_update_date || p.lastUpdate)
          : ((p && p.orig_time != null) ? String(p.orig_time) : null),
        inner_id: p && p.inner_id != null ? String(p.inner_id) : null,
      };
    }),
    moduleState: pickedMs,
  };
}

function __cs_pickBestSummary(){
  var snaps = Array.prototype.slice.call(arguments || []);
  if (snaps.length === 1 && Array.isArray(snaps[0])) snaps = snaps[0];
  var arr = Array.isArray(snaps) ? snaps.filter(Boolean) : [];
  if (!arr.length) return null;

  var best = null, bestScore = -1;
  for (var i=0;i<arr.length;i++){
    var cur = (__cs_summarizeSnapshot(arr[i]) || arr[i]);
    if (!cur) continue;

    var c = cur.counts || {};
    var h = cur.header || {};
    var hasHdr = !!(h && (h.communication || h.server_time || h.license_nmbr || h.license_number || h.inner_id || h.serial || h.client || h.model || h.manufacturer || h.progress));
    var msKey = Number(c.module_state_key || 0) || 0;
    var pTot = Number(c.params_total || c.parameters_total || 0) || 0;
    var pRaw = Number(c.params_with_value || c.parameters_with_value || 0) || 0;
    var pNm  = Number(c.params_with_name || c.parameters_with_name || 0) || 0;
    var pTm  = Number(c.params_with_time || c.parameters_with_time || 0) || 0;

    var score = (hasHdr ? 100000 : 0) + (msKey * 5000) + (pRaw * 50) + (pTm * 10) + (pNm * 2) + pTot;

    if (score > bestScore || (score === bestScore && i > 0)) {
      bestScore = score;
      best = cur;
    }
  }
  return best;
}

async function takeSnapshotOnce(sessionToken, vehicleId){
  const ws = await openMonitorWs(sessionToken, VM_WS_OPEN_TIMEOUT_MS);
  try{
    const snap = await collectVehicleMonitorSnapshot({
      ws,
      sessionToken,
      vehicleId,
      windowMs: VM_WINDOW_MS,
      waitAfterCmdMs: VM_WAIT_AFTER_CMD_MS,
      urlEncode: URL_ENCODE,
    });
    // adiciona contexto (sem quebrar UI)
    snap.vehicleId = vehicleId;
    snap.can = summarizeCanFromModuleState(snap.moduleState || []);
    return snap;
  } finally {
    try { ws.close(); } catch(_){}
  }
}

async function pollOnce(){
  if(!BASE || !KEY){
    console.log("[ERRO] falta JOB_SERVER_BASE_URL ou WORKER_KEY no env (systemd EnvironmentFile).");
    await sleep(5000);
    return;
  }

  const nextUrl = `${BASE}/api/jobs/next?type=monitor_can_snapshot&worker=${encodeURIComponent(WORKER_ID)}`;
  const { r, json, text } = await fetchJsonOrText(nextUrl, {
    method: "GET",
    headers: { "x-worker-key": KEY, "accept": "application/json" },
  });

  if(r.status === 204){
    await sleep(2000);
    return;
  }
  if(!r.ok){
    console.log("[WARN] jobs/next HTTP", r.status, (text || "").slice(0, 200));
    await sleep(5000);
    return;
  }

  let raw = json;
  // fallback: alguns responses vêm com BOM/bytes nulos e o JSON.parse falha
  if (!raw && typeof text === "string" && text.trim()) {
    const t = text.replace(/^\uFEFF/, "").replace(/\u0000/g, "").trim();
    try { raw = JSON.parse(t); } catch (_) {}
  }

  const job = (raw && typeof raw === 'object' && raw.job && typeof raw.job === 'object') ? raw.job : raw;

  const jobId = job?.id || job?.job_id;
  if(!jobId){
    console.log("[WARN] jobs/next retornou formato inesperado:", (text || "").slice(0, 200));
    await sleep(3000);
    return;
  }

  const p = job.payload || {};
  const installationId = p.installationId || p.installation_id || p.installation || null;
  const vehicleId = Number(p.vehicleId || p.vehicle_id || p.VEHICLE_ID || 0);

  const cycles = clampInt(p.cycles, 1, MAX_CYCLES, DEFAULT_CYCLES);
  const intervalMs = clampInt(p.interval_ms, 2000, 60000, DEFAULT_INTERVAL_MS);
  const earlyStopMinTotal = clampInt(p.early_stop_min_total, 0, 999999, EARLY_STOP_MIN_TOTAL);
  const earlyStopMinWith = clampInt(p.early_stop_min_with, 0, 999999, EARLY_STOP_MIN_WITH);

  console.log("[INFO] job", jobId, "vehicleId=", vehicleId, "cycles=", cycles, "intervalMs=", intervalMs, "earlyStopTotal=", earlyStopMinTotal, "earlyStopWith=", earlyStopMinWith);

  const errors = [];
  const snapshots = []; // vamos manter NEWEST FIRST (engine faz incoming.concat(prev))

  let sessionToken = String(p.sessionToken || p.session_token || "").trim();
  try{
    if(!sessionToken) sessionToken = await ensureLocalSessionToken();
  }catch(e){
    errors.push(String(e?.message || e));
  }

  if(!vehicleId){
    errors.push("[can] payload.vehicleId ausente");
  }

  if(sessionToken && vehicleId){
          // OPTC_PROGRESS_SEND_V1 trackers
      let __bestSummary = null;
      let __bestWith = 0;
      
for(let i=0;i<cycles;i++){
      let __cycleWith = 0;
      let __cycleWindowMs = 0;
      try{
        const snap = await takeSnapshotOnce(sessionToken, vehicleId);
      __lastSnap = snap;
        snapshots.unshift(snap); // newest first
        try {
          const __dumpDir = path.join(process.cwd(), "tmp", "can_debug");
          fs.mkdirSync(__dumpDir, { recursive: true });
          const __dumpFile = path.join(__dumpDir, "can_cycle_" + String(jobId) + "_c" + String(i+1) + ".json");
          fs.writeFileSync(__dumpFile, JSON.stringify(snap, null, 2));
        } catch(_e_dump) {}
        console.log("[INFO] snapshot ok", jobId, "params=", Array.isArray(snap.parameters)?snap.parameters.length:0);
        try { console.log("[INFO] cycle-summary", jobId, "c=", (i+1), (__sum && __sum.counts) || null, (__sum && __sum.rawCounts) ? __sum.rawCounts : null); } catch(_e) {}
        // early-stop: usa counts (inclui raw_value) via summarizeSnapshot
        let __sum = null;
        try{ __sum = __cs_summarizeSnapshot(snap) || null; }catch(_e){}
        const __c = (__sum && __sum.counts) ? __sum.counts : null;
        const __total = Number((__c && __c.params_total) || (Array.isArray(snap.parameters)?snap.parameters.length:0) || 0);
        const __with = Number((__c && __c.params_with_value) || 0);
        __cycleWith = __with;
        __cycleWindowMs = Number((snap && snap.meta && snap.meta.windowMs) || 0) || 0;
        const hitWith = (earlyStopMinWith > 0) ? (__with >= earlyStopMinWith) : false;
        const hitTotal = (earlyStopMinTotal > 0) ? (__total >= earlyStopMinTotal) : false;
        const __hdr = (__sum && __sum.header) ? __sum.header : null;
        const __hasHdr = !!(__hdr && (__hdr.communication || __hdr.server_time || __hdr.license_nmbr || __hdr.license_number || __hdr.inner_id || __hdr.serial || __hdr.client || __hdr.model || __hdr.manufacturer || __hdr.progress));
        const __msKey = Number((__sum && __sum.counts && __sum.counts.module_state_key) || 0) || 0;

        console.log("[DBG] cycle-summary", jobId, "cycle=", (i+1), "pTot=", __total, "pRaw=", __with, "msKey=", __msKey, "hasHdr=", (__hasHdr?1:0), "snaps=", snapshots.length);

        if ((hitWith || hitTotal) && snapshots.length >= 2 && __hasHdr && __msKey >= 3){
          console.log("[INFO] early-stop", jobId, "total=", __total, "with=", __with, "msKey=", __msKey, "hasHdr=", (__hasHdr?1:0), "thrTotal=", earlyStopMinTotal, "thrWith=", earlyStopMinWith);
          break;
        }

// OPTC_PROGRESS_SEND_V1_LOOP
try{
  const summary = (typeof __cs_summarizeSnapshot === "function") ? (__cs_summarizeSnapshot(snap) || snap) : snap;
  if (!__bestSummary) __bestSummary = summary;
  if (typeof __cs_pickBestSummary === "function") __bestSummary = __cs_pickBestSummary(__bestSummary, summary);
  const percent = Math.round(((i+1)/cycles)*100);
  await postProgress(jobId, percent, (__bestSummary || summary), `cycle ${i+1}/${cycles}`);
  const withVal = Number(((__bestSummary||summary) && (__bestSummary||summary).counts && (__bestSummary||summary).counts.params_with_value) || 0);
  if (withVal > __bestWith) __bestWith = withVal;
}catch(_e){}

      }catch(e){
        const msg = String(e?.message || e);
        errors.push(msg);
        console.log("[WARN] snapshot falhou", jobId, msg.slice(0,200));
      }
      if(i < cycles-1){ const __last = snapshots[0] || null; const __pLen = Array.isArray(__last?.parameters) ? __last.parameters.length : 0; await sleep((__pLen===0)?ZERO_PARAMS_SLEEP_MS:intervalMs); }
    }
  }

  const latest = snapshots[0] || null;
  const latestCan = latest?.can || null;
  const paramsTotal = Array.isArray(latest?.parameters) ? latest.parameters.length : 0;
  const paramsWithValue = Array.isArray(latest?.parameters) ? latest.parameters.filter(x => x && x.value != null && String(x.value).trim() !== "").length : 0;

  const meta = {
    summary: {
      ok: snapshots.length > 0,
      source: "monitor_ws",
      installationId,
      vehicleId,
      capturedAt: latest?.capturedAt || null,
      cyclesRequested: cycles,
      cyclesDone: snapshots.length,
      paramsTotal,
      paramsWithValue,
      can: latestCan,
      errors: errors.length ? errors.slice(0,5) : [],
    },
    snapshots: snapshots, // já vem newest-first
  };

  const ok = snapshots.length > 0;
  const result = ok
    ? { ok: true, status: "success", meta }
    : { ok: false, status: "error", message: (errors[0] || "snapshot falhou"), meta };

  const completeUrl = `${BASE}/api/jobs/${encodeURIComponent(String(jobId))}/complete`;
  // PROVA: dump do body do /complete (optC)
  const __completeBody = __cs_completeBody(result);
  try {
    const __jid = (typeof jobId !== "undefined" ? jobId : (typeof id !== "undefined" ? id : "unknown"));
    fs.writeFileSync(`${__DBG_DIR}/can_complete_${String(__jid)}.json`, __completeBody);
  } catch(_e) {}

  const { r: rc, text: out } = await fetchJsonOrText(completeUrl, {
    method: "POST",
    headers: { "x-worker-key": KEY, "content-type": "application/json", "accept": "application/json" },
    body: __completeBody
  });

  console.log("[INFO] complete", jobId, "HTTP", rc.status, (out || "").slice(0, 200));
  await sleep(200);
}

async function main(){
  console.log("[INFO] canSnapshotWorker start", { base: !!BASE, worker: WORKER_ID });
  while(true){
    try { await pollOnce(); }
    catch(e){
      console.log("[ERR]", e && e.stack ? e.stack.slice(0, 500) : String(e));
      await sleep(5000);
    }
  }
}

main();


// === CAN_ACQ_ENRICH_V2 (override final) ===
// Força summary rico (header + counts úteis) mesmo se existirem versões antigas acima.
function __cs_summarizeSnapshot(snap){
  if (!snap || typeof snap !== "object") return null;

  const params = Array.isArray(snap.parameters) ? snap.parameters
              : Array.isArray(snap.params) ? snap.params
              : [];

  const ms = Array.isArray(snap.moduleState) ? snap.moduleState
           : Array.isArray(snap.module_state) ? snap.module_state
           : [];

  const header = (snap.header && typeof snap.header === "object") ? snap.header : null;
  const rawCounts = (snap.rawCounts && typeof snap.rawCounts === "object") ? snap.rawCounts
                 : (snap.raw_counts && typeof snap.raw_counts === "object") ? snap.raw_counts
                 : null;

  const __valStr = (p) => {
    const v = p && (p.value ?? p.val ?? p.current_value ?? p.currentValue ?? p.raw_value ?? p.rawValue);
    return (v === null || v === undefined) ? "" : String(v);
  };

  const paramsWithValue = params.filter(p => __valStr(p).trim() !== "").length;
  const paramsWithTime  = params.filter(p => String(p?.last_update ?? p?.lastUpdate ?? p?.orig_time ?? "").trim() !== "").length;

  const CAN_SUMMARY_MAX_PARAMS_SAFE = Number(process.env.CAN_SUMMARY_MAX_PARAMS || "120");
  const CAN_SUMMARY_MAX_MS_SAFE = Number(process.env.CAN_SUMMARY_MAX_MS || "80");

  const pickedParams = params
    .filter(p => __valStr(p).trim() !== "")
    .slice(0, CAN_SUMMARY_MAX_PARAMS_SAFE)
    .map(p => ({
      id: p.id ?? p.param_id ?? p.paramId ?? null,
      name: p.name ?? null,
      param_type: p.param_type ?? p.type ?? null,
      value: p.value ?? p.val ?? p.current_value ?? p.currentValue ?? null,
      raw_value: p.raw_value ?? p.rawValue ?? null,
      last_update: p.last_update ?? p.lastUpdate ?? p.orig_time ?? null,
      source: p.source ?? null,
      duplicate_unit: p.duplicate_unit ?? p.duplicateUnit ?? null,
    }));

  const wantedIds = new Set(["8","9","15","19","20"]);
  const pickedMs = ms
    .filter(r => wantedIds.has(String(r?.id ?? r?.module_id ?? r?.moduleId ?? "")) || (r && (r.active!=null || r.ok!=null || r.was_ok!=null)))
    .slice(0, CAN_SUMMARY_MAX_MS_SAFE)
    .map(r => ({
      id: r.id ?? r.module_id ?? r.moduleId ?? null,
      name: r.name ?? r.module_name ?? r.moduleName ?? r.module ?? null,
      module: r.module ?? null,
      sub: r.sub ?? null,
      active: r.active ?? null,
      ok: r.ok ?? r.is_ok ?? r.isOk ?? null,
      was_ok: r.was_ok ?? r.wasOk ?? null,
      message: r.message ?? r.msg ?? r.error_descr ?? null,
      last_update: r.last_update_date ?? r.last_update ?? null,
    }));

  const msKey = pickedMs.filter(r => wantedIds.has(String(r?.id ?? ""))).length;

  return {
    captured_at: snap.capturedAt || snap.captured_at || new Date().toISOString(),
    header: header,
    raw_events: rawCounts,
    counts: {
      params_total: params.length,
      params_with_value: paramsWithValue,
      params_with_time: paramsWithTime,
      module_total: ms.length,
      module_state_key: msKey,
      unit_parameters_events: rawCounts?.unitParametersEvents ?? rawCounts?.unit_parameters_events ?? null,
      unit_messages_events: rawCounts?.unitMessagesEvents ?? rawCounts?.unit_messages_events ?? null,
      unit_conn_events: rawCounts?.unitConnEvents ?? rawCounts?.unit_conn_events ?? null,
    },
    parameters: pickedParams,
    moduleState: pickedMs,
  };
}

function __cs_pickBestSummary(curr, cand){
  if (!cand) return curr;
  if (!curr) return cand;

  const aHdr = curr?.header ? 1 : 0;
  const bHdr = cand?.header ? 1 : 0;
  if (bHdr !== aHdr) return bHdr > aHdr ? cand : curr;

  const aMs = Number(curr?.counts?.module_state_key ?? 0) || 0;
  const bMs = Number(cand?.counts?.module_state_key ?? 0) || 0;
  if (bMs !== aMs) return bMs > aMs ? cand : curr;

  const aRaw = Number(curr?.counts?.params_with_value ?? 0) || 0;
  const bRaw = Number(cand?.counts?.params_with_value ?? 0) || 0;
  if (bRaw !== aRaw) return bRaw > aRaw ? cand : curr;

  const aTot = Number(curr?.counts?.params_total ?? 0) || 0;
  const bTot = Number(cand?.counts?.params_total ?? 0) || 0;
  if (bTot !== aTot) return bTot > aTot ? cand : curr;

  return curr;
}
// === /CAN_ACQ_ENRICH_V2 ===
