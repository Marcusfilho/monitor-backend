// src/worker/schemeBuilderWorker.ts
import axios from "axios";
import { spawnSync } from "child_process";


// progressPercent (job) — updates não bloqueiam o fluxo
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
  payload: SchemeBuilderPayload;
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
  try {
    const resp = await http.get(`/api/jobs/next`, { params: { type: "scheme_builder", worker: WORKER_ID, workerId: WORKER_ID } });

    if (resp.status === 204) { console.log(`[worker] poll /api/jobs/next: 204 (sem job)`); return null; }

    const job = (resp.data as any)?.job as SchemeBuilderJob | undefined;
    if (!job) return null;

    (job.payload as any).comment = appendJobTag((job.payload as any).comment, job.id);
    console.log(`[worker] Job recebido: id=${job.id}, vehicleId=${job.payload.vehicleId}`);
    return job;
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 503) {
      console.log(`[worker] backend sem session token (503). Rode o snippet no Chrome e envie o token pro Render.`);
      return null;
    }
    console.error("[worker] Erro ao buscar job:", err?.message || err);
    return null;
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