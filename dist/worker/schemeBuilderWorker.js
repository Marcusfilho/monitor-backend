"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/worker/schemeBuilderWorker.ts
const axios_1 = __importDefault(require("axios"));
const schemeBuilderService_1 = require("../services/schemeBuilderService");
const RENDER_BASE_URL = process.env.RENDER_BASE_URL || "https://seu-servico-no-render.onrender.com";
const WORKER_ID = process.env.WORKER_ID || "vm-worker-01";
// Para o app dos instaladores, queremos algo rápido.
// Aqui deixamos 2000 ms, mas isso é ajustável via env.
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || "2000");
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function fetchNextJob() {
    try {
        console.log(`[worker] Buscando job em ${RENDER_BASE_URL}/api/jobs/next?type=scheme_builder&worker=${WORKER_ID}`);
        const resp = await axios_1.default.get(`${RENDER_BASE_URL}/api/jobs/next`, {
            params: {
                type: "scheme_builder",
                worker: WORKER_ID,
            },
            timeout: 10000,
        });
        const data = resp.data;
        if (resp.status === 204 || !data || !data.job) {
            console.log("[worker] Nenhum job disponível.");
            return null;
        }
        const job = data.job;
        console.log(`[worker] Job recebido: id=${job.id}, vehicleId=${job.payload.vehicleId}`);
        return job;
    }
    catch (err) {
        if (err.response) {
            console.error(`[worker] Erro ao buscar job: status=${err.response.status}`, err.response.data);
        }
        else {
            console.error("[worker] Erro ao buscar job:", err.message || err);
        }
        return null;
    }
}
async function completeJob(jobId, status, result) {
    try {
        console.log(`[worker] Enviando resultado do job ${jobId} para o Render...`);
        await axios_1.default.post(`${RENDER_BASE_URL}/api/jobs/${jobId}/complete`, {
            status,
            result,
            workerId: WORKER_ID,
        }, { timeout: 10000 });
        console.log(`[worker] Resultado do job ${jobId} enviado com sucesso.`);
    }
    catch (err) {
        if (err.response) {
            console.error(`[worker] Erro ao enviar resultado do job ${jobId}: status=${err.response.status}`, err.response.data);
        }
        else {
            console.error(`[worker] Erro ao enviar resultado do job ${jobId}:`, err.message || err);
        }
    }
}
// === STUB por enquanto ===
// Aqui, no futuro, vamos chamar o fluxo real do Monitor (via WebSocket).
// Por enquanto, só simulamos um processamento rápido para validar o worker.
async function processJob(job) {
    console.log(`[worker] Processando job ${job.id} (vehicleId=${job.payload.vehicleId})...`);
    try {
        const result = await (0, schemeBuilderService_1.runSchemeBuilderBackend)({
            clientId: job.payload.clientId,
            clientName: job.payload.clientName,
            vehicleId: job.payload.vehicleId,
            vehicleSettingId: job.payload.vehicleSettingId,
            comment: job.payload.comment,
        });
        await completeJob(job.id, result.status, result);
    }
    catch (err) {
        console.error(`[worker] Erro ao processar job ${job.id}:`, err?.message || err);
        await completeJob(job.id, "error", {
            message: err?.message ||
                "Erro desconhecido ao processar job SchemeBuilder no worker.",
            rawError: err,
        });
    }
}
async function mainLoop() {
    console.log(`[worker] Iniciando worker SchemeBuilder. RENDER_BASE_URL=${RENDER_BASE_URL}, WORKER_ID=${WORKER_ID}, POLL_INTERVAL_MS=${POLL_INTERVAL_MS}`);
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
