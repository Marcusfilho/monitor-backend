// src/worker/schemeBuilderWorker.ts
import axios from "axios";
import { runSchemeBuilderBackend } from "../services/schemeBuilderService";

const WORKER_ID = process.env.WORKER_ID || "vm-worker-01";

// ✅ Use um nome mais claro: este é o servidor de jobs (seu backend do monitor)
// Compatível com seu env antigo RENDER_BASE_URL (não quebra seu deploy)
const JOB_SERVER_BASE_URL =
  process.env.JOB_SERVER_BASE_URL ||
  process.env.RENDER_BASE_URL ||
  "http://127.0.0.1:3000";

// Poll base (quando tem job ou acabou de ter job)
const BASE_POLL_INTERVAL_MS = Number(
  process.env.BASE_POLL_INTERVAL_MS ||
    process.env.WORKER_POLL_INTERVAL_MS ||
    "5000"
);


// Quando NÃO tem job, o worker entra em “modo silêncio” (backoff)
const MAX_IDLE_POLL_INTERVAL_MS = Number(process.env.WORKER_MAX_IDLE_POLL_MS || "60000");
const IDLE_BACKOFF_FACTOR = Number(process.env.WORKER_IDLE_BACKOFF_FACTOR || "1.6");

// Timeouts curtos pra evitar pendurar em rede
const REQUEST_TIMEOUT_MS = Number(process.env.WORKER_HTTP_TIMEOUT_MS || "10000");

// ✅ Segurança: por padrão o worker NÃO aceita falar com host remoto.
// Se você realmente quiser apontar pra Render, precisa setar ALLOW_REMOTE_JOB_SERVER=1
const ALLOW_REMOTE_JOB_SERVER = process.env.ALLOW_REMOTE_JOB_SERVER === "1";

interface SchemeBuilderPayload {
  clientId: number;
  clientName: string;
  vehicleId: number;
  vehicleSettingId: number;
  comment?: string;
}

interface SchemeBuilderJob {
  id: string;
  type: string;
  payload: SchemeBuilderPayload;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoopbackHost(host: string) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function assertJobServerIsSafe(baseUrl: string) {
  try {
    const u = new URL(baseUrl);
    if (!ALLOW_REMOTE_JOB_SERVER && !isLoopbackHost(u.hostname)) {
      throw new Error(
        `[worker] BLOQUEADO: JOB_SERVER_BASE_URL/RENDER_BASE_URL não é localhost (${baseUrl}).\n` +
          `[worker] Isso evita tráfego externo quando estiver sem job.\n` +
          `[worker] Se você REALMENTE quiser usar host remoto, exporte ALLOW_REMOTE_JOB_SERVER=1.`
      );
    }
  } catch (e: any) {
    // mantém a mensagem original quando der
    if (e?.message?.includes("[worker] BLOQUEADO")) throw e;
    throw new Error(`[worker] URL inválida em JOB_SERVER_BASE_URL: ${baseUrl}`);
  }
}


function jitter(ms: number) {
  // até 10% ou 800ms, o menor deles (pra não sincronizar múltiplos workers)
  const j = Math.min(800, Math.floor(ms * 0.1));
  return Math.floor(Math.random() * (j + 1));
}

// Axios “blindado” (proxy: false evita env http_proxy/https_proxy atrapalhar)
const http = axios.create({
  baseURL: JOB_SERVER_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
});

async function fetchNextJob(): Promise<SchemeBuilderJob | null> {
  try {
    const resp = await http.get(`/api/jobs/next`, {
      params: { type: "scheme_builder", worker: WORKER_ID, workerId: WORKER_ID },
    });

    if (resp.status === 204) {
      console.log(`[worker] poll /api/jobs/next: 204 (sem job)`);
      return null;
    }

    console.log(`[worker] poll /api/jobs/next: status=${resp.status}`);

    const job = (resp.data as any)?.job as SchemeBuilderJob | undefined;
    if (!job) {
      console.log(`[worker] poll /api/jobs/next: sem job no body (status=${resp.status})`);
      return null;
    }

    console.log(`[worker] Job recebido: id=${job.id}, vehicleId=${job.payload.vehicleId}`);
    return job;
  } catch (err: any) {
    const status = err?.response?.status;
    if (status) {
      console.error(`[worker] Erro ao buscar job: status=${status}`, err.response?.data);
    } else {
      console.error("[worker] Erro ao buscar job:", err?.message || err);
    }
    return null;
  }
}

async function completeJob(jobId: string, status: string, result: any) {
  try {
    await http.post(`/api/jobs/${jobId}/complete`, {
      status,
      result,
      workerId: WORKER_ID,
    });
  } catch (err: any) {
    const statusCode = err?.response?.status;
    if (statusCode) {
      console.error(
        `[worker] Erro ao enviar resultado do job ${jobId}: status=${statusCode}`,
        err.response?.data
      );
    } else {
      console.error(`[worker] Erro ao enviar resultado do job ${jobId}:`, err?.message || err);
    }
  }
}

async function processJob(job: SchemeBuilderJob) {
  console.log(`[worker] Processando job ${job.id} (vehicleId=${job.payload.vehicleId})...`);

  try {
    const result = await runSchemeBuilderBackend({
      clientId: job.payload.clientId,
      clientName: job.payload.clientName,
      vehicleId: job.payload.vehicleId,
      vehicleSettingId: job.payload.vehicleSettingId,
      comment: job.payload.comment,
    });

    await completeJob(job.id, result.status, result);
  } catch (err: any) {
    console.error(`[worker] Erro ao processar job ${job.id}:`, err?.message || err);

    await completeJob(job.id, "error", {
      message: err?.message || "Erro desconhecido ao processar job SchemeBuilder no worker.",
      rawError: err,
    });
  }
}

async function mainLoop() {
  assertJobServerIsSafe(JOB_SERVER_BASE_URL);

  console.log(
    `[worker] Iniciando SchemeBuilder. JOB_SERVER_BASE_URL=${JOB_SERVER_BASE_URL}, WORKER_ID=${WORKER_ID}, BASE_POLL_INTERVAL_MS=${BASE_POLL_INTERVAL_MS}`
  );

  let pollMs = BASE_POLL_INTERVAL_MS;

  // loop infinito simples
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await fetchNextJob();

    if (job) {
      pollMs = BASE_POLL_INTERVAL_MS; // voltou a ter job → volta rápido
      await processJob(job);
    } else {
      // sem job → entra em modo silêncio (reduz tráfego)
      pollMs = Math.min(MAX_IDLE_POLL_INTERVAL_MS, Math.round(pollMs * IDLE_BACKOFF_FACTOR));
    }

    await sleep(pollMs + jitter(pollMs));
  }
}

const FATAL_RETRY_MS = Number(process.env.WORKER_FATAL_RETRY_MS || "15000");

process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[worker] uncaughtException:", err);
  // não derruba o processo; o loop continua e o systemd não entra em restart loop
});

async function runForever() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await mainLoop(); // idealmente nunca retorna
    } catch (err) {
      console.error("[worker] mainLoop caiu (vou continuar):", err);
      await sleep(FATAL_RETRY_MS);
    }
  }
}

if (require.main === module) {
  runForever().catch((err) => {
    console.error("[worker] Erro inesperado no runForever:", err);
  });
}

