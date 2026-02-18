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
const crypto = require("crypto");
const { collectVehicleMonitorSnapshot, summarizeCanFromModuleState } = require("../services/vehicleMonitorSnapshotService");

const WORKER_ID = process.env.WORKER_ID || "can_snapshot";
const BASE = (process.env.JOB_SERVER_BASE_URL || process.env.BASE_URL || process.env.BACKEND_BASE_URL || "").replace(/\/$/, "");
const KEY  = (process.env.WORKER_KEY || "").trim();

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
const URL_ENCODE = (process.env.VM_URL_ENCODE || "1") !== "0";

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function fetchJsonOrText(url, opts){
  const r = await fetch(url, opts);
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { r, text: t, json: j };
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
  const guid = makeGuidLike();
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

  const job = json;
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

  console.log("[INFO] job", jobId, "vehicleId=", vehicleId, "cycles=", cycles, "intervalMs=", intervalMs);

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
    for(let i=0;i<cycles;i++){
      try{
        const snap = await takeSnapshotOnce(sessionToken, vehicleId);
        snapshots.unshift(snap); // newest first
        console.log("[INFO] snapshot ok", jobId, "params=", Array.isArray(snap.parameters)?snap.parameters.length:0);
      }catch(e){
        const msg = String(e?.message || e);
        errors.push(msg);
        console.log("[WARN] snapshot falhou", jobId, msg.slice(0,200));
      }
      if(i < cycles-1) await sleep(intervalMs);
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
  const { r: rc, text: out } = await fetchJsonOrText(completeUrl, {
    method: "POST",
    headers: { "x-worker-key": KEY, "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify({ status: "completed", workerId: WORKER_ID, result })
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
