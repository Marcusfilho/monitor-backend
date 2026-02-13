"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/worker/schemeBuilderWorker.ts
const axios_1 = __importDefault(require("axios"));
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const vehicleMonitorSnapshotService_1 = require("../services/vehicleMonitorSnapshotService");
const heartbeatClient_1 = require("./heartbeatClient");
// progressPercent (job) — updates não bloqueiam o fluxo
// === HEARTBEAT (source) ===
try {
    const baseUrl = process.env.BASE_URL || "";
    const workerId = (process.env.WORKER_ID || "tunel").toLowerCase();
    const workerKey = process.env.WORKER_KEY || "";
    const intervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || 30000);
    (0, heartbeatClient_1.startHeartbeat)({
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
}
catch (e) {
    console.error("[hb] init fail (src):", e?.message || e);
}
// === /HEARTBEAT ===
async function reportProgress(jobId, percent, stage, detail) {
    try {
        // http deve existir no escopo quando a função for chamada
        await http.post(`/api/jobs/${jobId}/progress`, {
            percent,
            stage,
            detail: detail || "",
        });
    }
    catch {
        // ignora falhas de telemetria
    }
}
function appendJobTag(comment, jobId) {
    const base = (typeof comment === "string" ? comment : "").trim();
    const tag = `[JOB:${String(jobId)}]`;
    if (base.includes(tag))
        return base;
    return base ? `${base} ${tag}` : tag;
}
const WORKER_ID = process.env.WORKER_ID || "vm-worker-01";
const JOB_SERVER_BASE_URL = process.env.JOB_SERVER_BASE_URL || process.env.RENDER_BASE_URL || "http://127.0.0.1:3000";
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
const TRAFFILOG_API_BASE_URL = (process.env.TRAFFILOG_API_BASE_URL || process.env.TRAFFILOG_API_URL || process.env.MONITOR_API_BASE_URL || "").trim();
const TRAFFILOG_LOGIN_URL = (process.env.TRAFFILOG_LOGIN_URL || "").trim(); // opcional (se quiser apontar direto no /user_login/)
const WS_LOGIN_NAME = (process.env.WS_LOGIN_NAME || process.env.MONITOR_LOGIN_NAME || "").trim();
const WS_PASSWORD = (process.env.WS_PASSWORD || process.env.MONITOR_PASSWORD || "").trim();
function readTokenIfFresh() {
    try {
        const st = fs.statSync(MONITOR_SESSION_TOKEN_PATH);
        const age = Date.now() - st.mtimeMs;
        if (age > MONITOR_SESSION_TOKEN_TTL_MS)
            return null;
        const tok = String(fs.readFileSync(MONITOR_SESSION_TOKEN_PATH, "utf8") || "").trim();
        if (tok.length < 20)
            return null;
        return tok;
    }
    catch {
        return null;
    }
}
async function userLoginAndGetToken() {
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
    const resp = await axios_1.default.post(loginUrl, loginPayload, {
        timeout: 20000,
        headers: { "content-type": "application/json", accept: "application/json" },
    });
    const tok = resp?.data?.response?.properties?.session_token ||
        resp?.data?.response?.properties?.data?.[0]?.session_token;
    if (!tok || String(tok).trim().length < 20) {
        throw new Error("[worker] user_login não retornou session_token (verifique TRAFFILOG_* e credenciais)");
    }
    return String(tok).trim();
}
async function ensureLocalSessionTokenFile() {
    const cached = readTokenIfFresh();
    if (cached) {
        process.env.MONITOR_SESSION_TOKEN = cached;
        return cached;
    }
    const tok = await userLoginAndGetToken();
    try {
        fs.writeFileSync(MONITOR_SESSION_TOKEN_PATH, tok + "\n", { mode: 0o600 });
    }
    catch {
        // mesmo se não conseguir gravar, mantém em memória
    }
    process.env.MONITOR_SESSION_TOKEN = tok;
    return tok;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(ms) { const j = Math.min(800, Math.floor(ms * 0.1)); return Math.floor(Math.random() * (j + 1)); }
function isLoopbackHost(host) { return host === "127.0.0.1" || host === "localhost" || host === "::1"; }
function assertJobServerIsSafe(baseUrl) {
    const u = new URL(baseUrl);
    if (!ALLOW_REMOTE_JOB_SERVER && !isLoopbackHost(u.hostname)) {
        throw new Error(`[worker] BLOQUEADO: JOB_SERVER_BASE_URL não é localhost (${baseUrl}). Sete ALLOW_REMOTE_JOB_SERVER=1`);
    }
}
const http = axios_1.default.create({
    baseURL: JOB_SERVER_BASE_URL,
    timeout: REQUEST_TIMEOUT_MS,
});
async function fetchNextJob() {
    // Token LOCAL: não depende do backend Render.
    try {
        const tok = await ensureLocalSessionTokenFile();
        console.log(`[worker] session_token LOCAL OK (len=${tok.length})`);
        return null;
    }
    catch (e) {
        const msg = String(e?.message || e);
        console.log(`[worker] falha ao obter session_token LOCAL: ${msg}`);
        return null;
    }
}
async function completeJob(jobId, status, result) {
    try {
        await reportProgress(jobId, 100, "completed");
        await http.post(`/api/jobs/${jobId}/complete`, { status, result, workerId: WORKER_ID });
    }
    catch (err) {
        console.error(`[worker] Erro ao completar job ${jobId}:`, err?.message || err);
    }
}
async function processJob(job) {
    console.log(`[worker] Processando job ${job.id} (vehicleId=${job.payload.vehicleId})...`);
    await reportProgress(job.id, 5, "started", `vehicleId=${job?.payload?.vehicleId ?? ""}`);
    try {
        const token = String(job.payload.sessionToken || "").trim();
        if (!token)
            throw new Error("Job veio sem sessionToken (backend não injetou token).");
        const guid = String(process.env.MONITOR_WS_GUID || "").trim();
        if (!guid)
            throw new Error("Faltou MONITOR_WS_GUID no env do worker.");
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
            MONITOR_WS_COOKIE: "", // ✅ cookie não é necessário (net-export mostrou)
            MONITOR_WS_ORIGIN: origin,
        };
        const r = (0, child_process_1.spawnSync)(process.execPath, args, { cwd: process.cwd(), env, encoding: "utf8" });
        if (r.status !== 0)
            throw new Error(`[sb_run_vm] exit=${r.status}\n${r.stderr || r.stdout || ""}`);
        await completeJob(job.id, "ok", { status: "ok", stdout: r.stdout, stderr: r.stderr });
    }
    catch (err) {
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
        if (job) {
            pollMs = BASE_POLL_INTERVAL_MS;
            await processJob(job);
        }
        else {
            pollMs = Math.min(MAX_IDLE_POLL_INTERVAL_MS, Math.round(pollMs * IDLE_BACKOFF_FACTOR));
        }
        await sleep(pollMs + jitter(pollMs));
    }
}
const FATAL_RETRY_MS = Number(process.env.WORKER_FATAL_RETRY_MS || "15000");
async function runForever() {
    while (true) {
        try {
            await mainLoop();
        }
        catch (e) {
            console.error("[worker] mainLoop caiu:", e);
            await sleep(FATAL_RETRY_MS);
        }
    }
}
if (require.main === module)
    runForever().catch((e) => console.error("[worker] fatal:", e));
// =====================================================
// Vehicle Monitor Snapshot (Validar CAN) — handler
// =====================================================
async function postFirstOk(http, paths, body) {
    let lastErr = null;
    for (const path of paths) {
        try {
            await http.post(path, body);
            return;
        }
        catch (e) {
            lastErr = e;
            const st = e?.response?.status;
            if (st === 404)
                continue;
            throw e;
        }
    }
    throw lastErr || new Error("[vm] nenhum endpoint aceitou");
}
async function readSessionTokenFallback() {
    const envTok = (process.env.MONITOR_SESSION_TOKEN || "").trim();
    if (envTok)
        return envTok;
    try {
        const fsMod = await Promise.resolve().then(() => __importStar(require("fs")));
        const fs = fsMod?.default || fsMod;
        const tok = String(fs.readFileSync("/tmp/.session_token", "utf8") || "").trim();
        return tok || null;
    }
    catch {
        return null;
    }
}
function makeGuidLike() {
    const hex = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    return `${hex()}-${hex().slice(0, 4)}-${hex().slice(0, 4)}-${hex().slice(0, 4)}-${hex()}${hex().slice(0, 4)}`.toUpperCase();
}
async function openMonitorWs(sessionToken, timeoutMs = 15000) {
    const wsMod = await Promise.resolve().then(() => __importStar(require("ws")));
    const WebSocketCtor = wsMod?.default || wsMod;
    const guid = makeGuidLike();
    const url = `wss://websocket.traffilog.com:8182/${guid}/${sessionToken}/json?defragment=1`;
    return await new Promise((resolve, reject) => {
        const ws = new WebSocketCtor(url, { headers: { Origin: "https://operation.traffilog.com" } });
        const t = setTimeout(() => {
            try {
                ws.close();
            }
            catch { }
            reject(new Error(`[vm] WS timeout open (${timeoutMs}ms)`));
        }, timeoutMs);
        ws.on("open", () => { clearTimeout(t); resolve(ws); });
        ws.on("error", (e) => { clearTimeout(t); reject(e); });
    });
}
async function runVehicleMonitorSnapshotJob(job, http) {
    const jobId = String(job?.id || "");
    const payload = job?.payload || {};
    const vehicleId = Number(payload.vehicleId ?? payload.vehicle_id ?? payload.VEHICLE_ID ?? 0);
    if (!jobId)
        throw new Error("[vm] job.id ausente");
    if (!vehicleId)
        throw new Error("[vm] payload.vehicleId ausente");
    let sessionToken = String(payload.sessionToken ?? payload.session_token ?? "").trim();
    if (!sessionToken) {
        const fb = await readSessionTokenFallback();
        if (fb)
            sessionToken = fb;
    }
    if (!sessionToken)
        throw new Error("[vm] sessionToken ausente (payload/env//tmp/.session_token)");
    await reportProgress(jobId, 5, "vm_snapshot", `open ws (vehicleId=${vehicleId})`);
    const ws = await openMonitorWs(sessionToken, 15000);
    try {
        await reportProgress(jobId, 20, "vm_snapshot", "collect snapshot");
        const snap = await (0, vehicleMonitorSnapshotService_1.collectVehicleMonitorSnapshot)({
            ws,
            sessionToken,
            vehicleId,
            windowMs: Number(process.env.VM_WINDOW_MS || "8000"),
            waitAfterCmdMs: Number(process.env.VM_WAIT_AFTER_CMD_MS || "1000"),
            urlEncode: true
        });
        const can = (0, vehicleMonitorSnapshotService_1.summarizeCanFromModuleState)(snap.moduleState);
        await reportProgress(jobId, 90, "vm_snapshot", `done (params=${snap.parameters.length})`);
        await postFirstOk(http, [
            `/api/jobs/${jobId}/complete`,
            `/api/jobs/${jobId}/done`,
            `/api/jobs/${jobId}/result`,
        ], { result: { status: "ok", snapshot: snap, can } });
        await reportProgress(jobId, 100, "vm_snapshot", "completed");
    }
    catch (e) {
        const msg = String(e?.message || e);
        await postFirstOk(http, [
            `/api/jobs/${jobId}/error`,
            `/api/jobs/${jobId}/fail`,
            `/api/jobs/${jobId}/result`,
        ], { result: { status: "error", message: msg } }).catch(() => { });
        throw e;
    }
    finally {
        try {
            ws.close();
        }
        catch { }
    }
}

// === SB_POLL_V1 — poll /api/jobs/next?type=scheme_builder ===
(function(){
  try{
    if (globalThis.__SB_POLL_STARTED) return;
    globalThis.__SB_POLL_STARTED = true;

    const base0 = (process.env.JOB_SERVER_BASE_URL || process.env.BASE_URL || process.env.API_BASE_URL || "");
    const base = (base0 ? base0.replace(/\/+$/,"") : "http://127.0.0.1:3000");
    const workerKey = process.env.WORKER_KEY || "";
    const workerId = process.env.WORKER_ID || process.env.WORKER_NAME || "vm-schemebuilder";

    const log = (...a)=>console.log("[SB_POLL]", ...a);
    const warn = (...a)=>console.warn("[SB_POLL]", ...a);

    function getExec(){
      // payload-first candidates
      if (typeof runSchemeBuilder === "function") return {name:"runSchemeBuilder", mode:"payload", fn: runSchemeBuilder};
      if (typeof executeSchemeBuilder === "function") return {name:"executeSchemeBuilder", mode:"payload", fn: executeSchemeBuilder};

      // job candidates
      if (typeof processJob === "function") return {name:"processJob", mode:"job", fn: processJob};
      if (typeof runJob === "function") return {name:"runJob", mode:"job", fn: runJob};
      if (typeof handleJob === "function") return {name:"handleJob", mode:"job", fn: handleJob};

      return null;
    }

    let busy = false;

    async function pollOnce(){
      if (busy) return;
      if (!workerKey) { warn("WORKER_KEY vazio; poll desabilitado"); return; }

      const ex = getExec();
      if (!ex) { warn("não achei função de execução (runJob/processJob/runSchemeBuilder). Poll desabilitado."); return; }

      busy = true;
      try{
        const url = `${base}/api/jobs/next?type=scheme_builder&worker=${encodeURIComponent(workerId)}`;
        const res = await fetch(url, { headers: { "x-worker-key": workerKey } });

        if (res.status === 204) return;
        if (!res.ok){
          warn("jobs/next http", res.status);
          return;
        }

        const data = await res.json().catch(()=>null);
        const job = data && (data.job || data);
        if (!job || !job.id){
          warn("jobs/next retornou sem job.id");
          return;
        }

        
        // === SB_POLL_V2 — inject sessionToken from local env when missing ===
        if (job) {
          job.payload = job.payload || {};
          const tok =
            job.payload.sessionToken ||
            job.payload.session_token ||
            process.env.SESSION_TOKEN ||
            process.env.SESSION_TOKEN_LOCAL ||
            process.env.MONITOR_SESSION_TOKEN ||
            process.env.TL_SESSION_TOKEN ||
            process.env.APPENGINE_SESSION_TOKEN ||
            "";
          if (tok) {
            if (!job.payload.sessionToken) job.payload.sessionToken = tok;
            if (!job.sessionToken) job.sessionToken = tok;
            log("sessionToken injected (len=" + String(tok).length + ")");
          }
        }
log("claimed job", job.id, "worker", workerId, "exec", ex.name);

        try{
          if (ex.mode === "payload") await ex.fn(job.payload, job);
          else await ex.fn(job);
        } catch(e){
          warn("exec error", (e && e.stack) ? e.stack : e);
        }
      } finally {
        busy = false;
      }
    }

    setTimeout(()=>{ pollOnce().catch(()=>{}); }, 1200);
    setInterval(()=>{ pollOnce().catch(()=>{}); }, 2000);

    log("poll enabled:", base, "workerId:", workerId);
  } catch(e){
    console.warn("[SB_POLL] init error", e && e.stack ? e.stack : e);
  }
})();
