// src/worker/schemeBuilderWorker.ts
import axios from "axios";

const RENDER_BASE_URL =
  process.env.RENDER_BASE_URL || "https://seu-servico-no-render.onrender.com";

const WORKER_ID = process.env.WORKER_ID || "vm-worker-01";

// Para o app dos instaladores, queremos algo rápido.
// Aqui deixamos 2000 ms, mas isso é ajustável via env.
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || "2000");

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

async function fetchNextJob(): Promise<SchemeBuilderJob | null> {
  try {
    console.log(
      `[worker] Buscando job em ${RENDER_BASE_URL}/api/jobs/next?type=scheme_builder&worker=${WORKER_ID}`
    );

    const resp = await axios.get<any>(`${RENDER_BASE_URL}/api/jobs/next`, {
      params: {
        type: "scheme_builder",
        worker: WORKER_ID,
      },
      timeout: 10000,
    });

    const data = resp.data as any;

    if (resp.status === 204 || !data || !data.job) {
      console.log("[worker] Nenhum job disponível.");
      return null;
    }

    const job = data.job as SchemeBuilderJob;
    console.log(
      `[worker] Job recebido: id=${job.id}, vehicleId=${job.payload.vehicleId}`
    );
    return job;
  } catch (err: any) {
    if (err.response) {
      console.error(
        `[worker] Erro ao buscar job: status=${err.response.status}`,
        err.response.data
      );
    } else {
      console.error("[worker] Erro ao buscar job:", err.message || err);
    }
    return null;
  }
}

async function completeJob(jobId: string, status: string, result: any) {
  try {
    console.log(`[worker] Enviando resultado do job ${jobId} para o Render...`);
    await axios.post(
      `${RENDER_BASE_URL}/api/jobs/${jobId}/complete`,
      {
        status,
        result,
        workerId: WORKER_ID,
      },
      { timeout: 10000 }
    );
    console.log(`[worker] Resultado do job ${jobId} enviado com sucesso.`);
  } catch (err: any) {
    if (err.response) {
      console.error(
        `[worker] Erro ao enviar resultado do job ${jobId}: status=${err.response.status}`,
        err.response.data
      );
    } else {
      console.error(
        `[worker] Erro ao enviar resultado do job ${jobId}:`,
        err.message || err
      );
    }
  }
}

// === STUB por enquanto ===
// Aqui, no futuro, vamos chamar o fluxo real do Monitor (via WebSocket).
// Por enquanto, só simulamos um processamento rápido para validar o worker.
async function processJob(job: SchemeBuilderJob) {
  console.log(
    `[worker] Processando job ${job.id} (vehicleId=${job.payload.vehicleId})...`
  );

  // Simulação de processamento rápido
  await sleep(500);

  const fakeResult = {
    status: "ok",
    message: "Processamento stub executado na VM",
    vehicleId: job.payload.vehicleId,
    clientId: job.payload.clientId,
    workerId: WORKER_ID,
  };

  console.log(
    `[worker] Job ${job.id} finalizado (stub) com status ${fakeResult.status}.`
  );
  await completeJob(job.id, fakeResult.status, fakeResult);
}

async function mainLoop() {
  console.log(
    `[worker] Iniciando worker SchemeBuilder. RENDER_BASE_URL=${RENDER_BASE_URL}, WORKER_ID=${WORKER_ID}, POLL_INTERVAL_MS=${POLL_INTERVAL_MS}`
  );

  // loop infinito simples
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await fetchNextJob();
    if (job) {
      await processJob(job);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// Só executa o loop se esse arquivo for o entrypoint
if (require.main === module) {
  mainLoop().catch((err) => {
    console.error("[worker] Erro fatal no mainLoop:", err);
    process.exit(1);
  });
}

