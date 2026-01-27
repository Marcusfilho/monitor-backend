// src/worker/schemeBuilderWorker.ts
import axios from "axios";
import { spawnSync } from "child_process";


import * as fs from "fs";
import { collectVehicleMonitorSnapshot, summarizeCanFromModuleState } from "../services/vehicleMonitorSnapshotService";
import { startHeartbeat } from "./heartbeatClient";
// progressPercent (job) — updates não bloqueiam o fluxo

// === HEARTBEAT (source) ===
try {
  const baseUrl = process.env.BASE_URL || "";
  const workerId = (process.env.WORKER_ID || "tunel").toLowerCase();
  const workerKey = process.env.WORKER_KEY || "";
  const intervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || 30000);

  startHeartbeat({
    baseUrl,
    workerId,
    workerKey,
    intervalMs,
    getState: () => ({
      status: "running",
      checks: { backend_ok: true },
      meta: { uptime_s: Math.round(process.uptime()) },
    }),
  });

  console.log("[hb] enabled (src):", { workerId, intervalMs });
} catch (e: any) {
  console.error("[hb] init fail (src):", e?.message || e);
}
// === /HEARTBEAT ===

async function reportProgress(jobId: string, percent: number, stage: string, detail?: string) {
  try {
    // http deve existir no escopo quando a função for chamada
    await (http as any).post(`/api/jobs/${jobId}/progress`, {
      percent,
      stage,
      detail: detail || "",
    });
  } catch {
    // ignora falhas de telemetria
  }
}

function appendJobTag(comment: any, jobId: any) {
  const base = (typeof comment === "string" ? comment : "").trim();
  const tag = `[JOB:${String(jobId)}]`;
  if (base.includes(tag)) return base;
  return base ? `${base} ${tag}` : tag;
}

const WORKER_ID = process.env.WORKER_ID || "vm-worker-01";
const JOB_SERVER_BASE_URL =
  process.env.JOB_SERVER_BASE_URL || process.env.RENDER_BASE_URL || "http://127.0.0.1:3000";

const BASE_POLL_INTERVAL_MS = Number(process.env.BASE_POLL_INTERVAL_MS || process.env.WORKER_POLL_INTERVAL_MS || "5000");
const MAX_IDLE_POLL_INTERVAL_MS = Number(process.env.WORKER_MAX_IDLE_POLL_MS || "60000");
const IDLE_BACKOFF_FACTOR = Number(process.env.WORKER_IDLE_BACKOFF_FACTOR || "1.6");
const REQUEST_TIMEOUT_MS = Number(process.env.WORKER_HTTP_TIMEOUT_MS || "45000");
const ALLOW_REMOTE_JOB_SERVER = process.env.ALLOW_REMOTE_JOB_SERVER === "1";


// =====================================================
// Session Token LOCAL (não depende do Render)
// - Gera via user_login (Traffilog API) usando env:
//   TRAFFILOG_API_BASE_URL (…/1/json) + WS_LOGIN_NAME + WS_PASSWORD
// - Salva em /tmp/.session_token (ou MONITOR_SESSION_TOKEN_PATH)
// =====================================================
const MONITOR_SESSION_TOKEN_PATH = (process.env.SESSION_TOKEN_PATH || process.env.MONITOR_SESSION_TOKEN_PATH || "/tmp/.session_token");
const MONITOR_SESSION_TOKEN_TTL_MS = Number(process.env.MONITOR_SESSION_TOKEN_TTL_MS || "21600000"); // 6h

const TRAFFILOG_API_BASE_URL =
  (process.env.TRAFFILOG_API_BASE_URL || process.env.TRAFFILOG_API_URL || process.env.MONITOR_API_BASE_URL || "").trim();

const TRAFFILOG_LOGIN_URL =
  (process.env.TRAFFILOG_LOGIN_URL || "").trim(); // opcional (se quiser apontar direto no /user_login/)

const WS_LOGIN_NAME =
  (process.env.WS_LOGIN_NAME || process.env.MONITOR_LOGIN_NAME || "").trim();

const WS_PASSWORD =
  (process.env.WS_PASSWORD || process.env.MONITOR_PASSWORD || "").trim();

function readTokenIfFresh(): string | null {
  try {
    const st = fs.statSync(MONITOR_SESSION_TOKEN_PATH);
    const age = Date.now() - st.mtimeMs;
    if (age > MONITOR_SESSION_TOKEN_TTL_MS) return null;
    const tok = String(fs.readFileSync(MONITOR_SESSION_TOKEN_PATH, "utf8") || "").trim();
    if (tok.length < 20) return null;
    return tok;
  } catch {
    return null;
  }
}

async function userLoginAndGetToken(): Promise<string> {
  if (!WS_LOGIN_NAME || !WS_PASSWORD) {
    throw new Error("[worker] faltam envs: WS_LOGIN_NAME / WS_PASSWORD");
  }

  const base = (TRAFFILOG_LOGIN_URL || TRAFFILOG_API_BASE_URL).replace(/\/+$/g, "");
  if (!base) {
    throw new Error("[worker] falta env: TRAFFILOG_API_BASE_URL (terminando em /1/json) ou TRAFFILOG_LOGIN_URL");
  }

  // Normaliza URL: se vier .../1/json -> usa .../1/json/user_login/
  const loginUrl = base; // PATCH: AppEngine aceita POST em .../1/json (sem /user_login/)



  // ✅ Postman: POST .../1/json com body { action: { name, parameters } }
  const loginPayload = {
    action: {
      name: "user_login",
      parameters: { login_name: WS_LOGIN_NAME, password: WS_PASSWORD },
    },
  };

  const resp: any = await axios.post(loginUrl, loginPayload, {
    timeout: 20000,
    headers: { "content-type": "application/json", accept: "application/json" },
  });


  const tok =
    resp?.data?.response?.properties?.session_token ||
    resp?.data?.response?.properties?.data?.[0]?.session_token;

  if (!tok || String(tok).trim().length < 20) {
    throw new Error("[worker] user_login não retornou session_token (verifique TRAFFILOG_* e credenciais)");
  }
  return String(tok).trim();
}

async function ensureLocalSessionTokenFile(): Promise<string> {
  const cached = readTokenIfFresh();
  if (cached) {
    process.env.MONITOR_SESSION_TOKEN = cached;
    return cached;
  }

  const tok = await userLoginAndGetToken();
  try {
    fs.writeFileSync(MONITOR_SESSION_TOKEN_PATH, tok + "\n", { mode: 0o600 });
  } catch {
    // mesmo se não conseguir gravar, mantém em memória
  }
  process.env.MONITOR_SESSION_TOKEN = tok;
  return tok;
}

interface SchemeBuilderPayload {
  clientId: number;
  clientName: string;
  vehicleId: number;
  vehicleSettingId: number;
  comment?: string;
  sessionToken?: string; // ✅ vem do backend
}

interface SchemeBuilderJob {
  id: string;
  type: string;
  payload: any;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(ms: number) { const j = Math.min(800, Math.floor(ms * 0.1)); return Math.floor(Math.random() * (j + 1)); }
function isLoopbackHost(host: string) { return host === "127.0.0.1" || host === "localhost" || host === "::1"; }
function assertJobServerIsSafe(baseUrl: string) {
  const u = new URL(baseUrl);
  if (!ALLOW_REMOTE_JOB_SERVER && !isLoopbackHost(u.hostname)) {
    throw new Error(`[worker] BLOQUEADO: JOB_SERVER_BASE_URL não é localhost (${baseUrl}). Sete ALLOW_REMOTE_JOB_SERVER=1`);
  }
}

const http = axios.create({
  baseURL: JOB_SERVER_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
});

async function fetchNextJob(): Promise<SchemeBuilderJob | null> {
  // Token LOCAL: não depende do backend Render.
  try {
    const tok = await ensureLocalSessionTokenFile();
    console.log(`[worker] session_token LOCAL OK (len=${tok.length})`);
    return null as any;
  } catch (e: any) {
    const msg = String(e?.message || e);
    console.log(`[worker] falha ao obter session_token LOCAL: ${msg}`);
    return null as any;
  }
}

async function completeJob(jobId: string, status: string, result: any) {
  try {
    await reportProgress(jobId, 100, "completed");
    await http.post(`/api/jobs/${jobId}/complete`, { status, result, workerId: WORKER_ID });
  } catch (err: any) {
    console.error(`[worker] Erro ao completar job ${jobId}:`, err?.message || err);
  }
}

async function processJob(job: SchemeBuilderJob) {
  console.log(`[worker] Processando job ${job.id} (vehicleId=${job.payload.vehicleId})...`);

  
await reportProgress(job.id, 5, "started", `vehicleId=${(job as any)?.payload?.vehicleId ?? ""}`);try {
    const token = String(job.payload.sessionToken || "").trim();
    if (!token) throw new Error("Job veio sem sessionToken (backend não injetou token).");

    const guid = String(process.env.MONITOR_WS_GUID || "").trim();
    if (!guid) throw new Error("Faltou MONITOR_WS_GUID no env do worker.");

    const wsUrl = `wss://websocket.traffilog.com:8182/${guid}/${token}/json?defragment=1`;
    const origin = String(process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com");

    const args = [
      "tools/sb_run_vm.js",
      String(job.payload.clientId ?? ""),
      String(job.payload.clientName ?? ""),
      String(job.payload.vehicleId ?? ""),
      String(job.payload.vehicleSettingId ?? ""),
      String(job.payload.comment ?? ""),
    ];

    const env = {
      ...process.env,
      MONITOR_WS_URL: wsUrl,
      MONITOR_SESSION_TOKEN: token,
      MONITOR_WS_COOKIE: "",   // ✅ cookie não é necessário (net-export mostrou)
      MONITOR_WS_ORIGIN: origin,
    } as NodeJS.ProcessEnv;

    const r = spawnSync(process.execPath, args, { cwd: process.cwd(), env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`[sb_run_vm] exit=${r.status}\n${r.stderr || r.stdout || ""}`);

    await completeJob(job.id, "ok", { status: "ok", stdout: r.stdout, stderr: r.stderr });
  } catch (err: any) {
    console.error(`[worker] Erro no job ${job.id}:`, err?.message || err);
    await completeJob(job.id, "error", { status: "error", message: err?.message || "erro" });
  }
}

async function mainLoop() {
  assertJobServerIsSafe(JOB_SERVER_BASE_URL);
  console.log(`[worker] Iniciando. JOB_SERVER_BASE_URL=${JOB_SERVER_BASE_URL}, WORKER_ID=${WORKER_ID}`);

  let pollMs = BASE_POLL_INTERVAL_MS;

  while (true) {
    const job = await fetchNextJob();
    if (job) { pollMs = BASE_POLL_INTERVAL_MS; await processJob(job); }
    else { pollMs = Math.min(MAX_IDLE_POLL_INTERVAL_MS, Math.round(pollMs * IDLE_BACKOFF_FACTOR)); }
    await sleep(pollMs + jitter(pollMs));
  }
}

const FATAL_RETRY_MS = Number(process.env.WORKER_FATAL_RETRY_MS || "15000");
async function runForever() {
  while (true) {
    try { await mainLoop(); }
    catch (e) { console.error("[worker] mainLoop caiu:", e); await sleep(FATAL_RETRY_MS); }
  }
}

if (require.main === module) runForever().catch((e) => console.error("[worker] fatal:", e));

// =====================================================
// Vehicle Monitor Snapshot (Validar CAN) — handler
// =====================================================
async function postFirstOk(http: any, paths: string[], body: any) {
  let lastErr: any = null;
  for (const path of paths) {
    try {
      await http.post(path, body);
      return;
    } catch (e: any) {
      lastErr = e;
      const st = e?.response?.status;
      if (st === 404) continue;
      throw e;
    }
  }
  throw lastErr || new Error("[vm] nenhum endpoint aceitou");
}

async function readSessionTokenFallback(): Promise<string | null> {
  const envTok = (process.env.MONITOR_SESSION_TOKEN || "").trim();
  if (envTok) return envTok;

  try {
    const fsMod: any = await import("fs");
    const fs = fsMod?.default || fsMod;
    const tok = String(fs.readFileSync("/tmp/.session_token", "utf8") || "").trim();
    return tok || null;
  } catch {
    return null;
  }
}

function makeGuidLike(): string {
  const hex = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `${hex()}-${hex().slice(0,4)}-${hex().slice(0,4)}-${hex().slice(0,4)}-${hex()}${hex().slice(0,4)}`.toUpperCase();
}

async function openMonitorWs(sessionToken: string, timeoutMs = 15000): Promise<any> {
  const wsMod: any = await import("ws");
  const WebSocketCtor = wsMod?.default || wsMod;

  const guid = makeGuidLike();
  const url = `wss://websocket.traffilog.com:8182/${guid}/${sessionToken}/json?defragment=1`;

  return await new Promise((resolve, reject) => {
    const ws = new WebSocketCtor(url, { headers: { Origin: "https://operation.traffilog.com" } });

    const t = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`[vm] WS timeout open (${timeoutMs}ms)`));
    }, timeoutMs);

    ws.on("open", () => { clearTimeout(t); resolve(ws); });
    ws.on("error", (e: any) => { clearTimeout(t); reject(e); });
  });
}

async function runVehicleMonitorSnapshotJob(job: any, http: any) {
  const jobId = String(job?.id || "");
  const payload = job?.payload || {};
  const vehicleId = Number(payload.vehicleId ?? payload.vehicle_id ?? payload.VEHICLE_ID ?? 0);

  if (!jobId) throw new Error("[vm] job.id ausente");
  if (!vehicleId) throw new Error("[vm] payload.vehicleId ausente");

  let sessionToken = String(payload.sessionToken ?? payload.session_token ?? "").trim();
  if (!sessionToken) {
    const fb = await readSessionTokenFallback();
    if (fb) sessionToken = fb;
  }
  if (!sessionToken) throw new Error("[vm] sessionToken ausente (payload/env//tmp/.session_token)");

  await reportProgress(jobId, 5, "vm_snapshot", `open ws (vehicleId=${vehicleId})`);

  const ws = await openMonitorWs(sessionToken, 15000);

  try {
    await reportProgress(jobId, 20, "vm_snapshot", "collect snapshot");

    const snap = await collectVehicleMonitorSnapshot({
      ws,
      sessionToken,
      vehicleId,
      windowMs: Number(process.env.VM_WINDOW_MS || "8000"),
      waitAfterCmdMs: Number(process.env.VM_WAIT_AFTER_CMD_MS || "1000"),
      urlEncode: true
    });

    const can = summarizeCanFromModuleState(snap.moduleState);

    await reportProgress(jobId, 90, "vm_snapshot", `done (params=${snap.parameters.length})`);

    await postFirstOk(http, [
      `/api/jobs/${jobId}/complete`,
      `/api/jobs/${jobId}/done`,
      `/api/jobs/${jobId}/result`,
    ], { result: { status: "ok", snapshot: snap, can } });

    await reportProgress(jobId, 100, "vm_snapshot", "completed");
  } catch (e: any) {
    const msg = String(e?.message || e);
    await postFirstOk(http, [
      `/api/jobs/${jobId}/error`,
      `/api/jobs/${jobId}/fail`,
      `/api/jobs/${jobId}/result`,
    ], { result: { status: "error", message: msg } }).catch(() => {});
    throw e;
  } finally {
    try { ws.close(); } catch {}
  }
}
