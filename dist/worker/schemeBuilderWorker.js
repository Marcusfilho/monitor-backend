"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/worker/schemeBuilderWorker.ts
const axios_1 = __importDefault(require("axios"));
const child_process_1 = require("child_process");
// progressPercent (job) — updates não bloqueiam o fluxo
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
    try {
        const resp = await http.get(`/api/jobs/next`, { params: { type: "scheme_builder", worker: WORKER_ID, workerId: WORKER_ID } });
        if (resp.status === 204) {
            console.log(`[worker] poll /api/jobs/next: 204 (sem job)`);
            return null;
        }
        const job = resp.data?.job;
        if (!job)
            return null;
        job.payload.comment = appendJobTag(job.payload.comment, job.id);
        console.log(`[worker] Job recebido: id=${job.id}, vehicleId=${job.payload.vehicleId}`);
        return job;
    }
    catch (err) {
        const status = err?.response?.status;
        if (status === 503) {
            console.log(`[worker] backend sem session token (503). Rode o snippet no Chrome e envie o token pro Render.`);
            return null;
        }
        console.error("[worker] Erro ao buscar job:", err?.message || err);
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
