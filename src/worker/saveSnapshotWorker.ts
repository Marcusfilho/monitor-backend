// src/worker/saveSnapshotWorker.ts
// SAVE_SNAPSHOT_V1 — consome jobs "save_snapshot" e grava no SQLite local

import axios from "axios";
import { saveSnapshot } from "../services/snapshotStore";

const WORKER_ID        = process.env.WORKER_ID      || "vm-snapshot-worker";
const WORKER_KEY       = (process.env.WORKER_KEY    || "").trim();
const JOB_SERVER_URL   = (process.env.JOB_SERVER_BASE_URL || process.env.RENDER_BASE_URL || "http://127.0.0.1:3000").trim();
const POLL_MS          = Number(process.env.SNAPSHOT_POLL_MS || "8000");
const MAX_IDLE_POLL_MS = Number(process.env.SNAPSHOT_MAX_IDLE_MS || "60000");
const BACKOFF          = 1.6;

const http = axios.create({ baseURL: JOB_SERVER_URL, timeout: 30000 });

async function fetchNext(): Promise<any | null> {
  try {
    const r = await http.get("/api/jobs/next", {
      params: { type: "save_snapshot", worker: WORKER_ID },
      headers: WORKER_KEY ? { "x-worker-key": WORKER_KEY } : {},
      validateStatus: () => true,
    });
    if (r.status === 204) return null;
    if (r.status !== 200) { console.error(`[snapshot-worker] /next status=${r.status}`); return null; }
    const job = (r.data as any)?.job;
    return job?.id ? job : null;
  } catch (e: any) {
    console.error("[snapshot-worker] fetchNext erro:", e?.message || e);
    return null;
  }
}

async function completeJob(jobId: string, status: string, result: any) {
  try {
    await http.post(`/api/jobs/${jobId}/complete`, { status, result, workerId: WORKER_ID });
  } catch (e: any) {
    console.error(`[snapshot-worker] complete erro job=${jobId}:`, e?.message || e);
  }
}

async function processJob(job: any) {
  const p = job.payload || {};
  console.log(`[snapshot-worker] processando job=${job.id} service=${p.service} plate=${p.plate_real}`);

  try {
    const tech = typeof p.technician === "object"
      ? (p.technician?.nick ?? p.technician?.id ?? null)
      : (p.technician ?? null);

    await saveSnapshot({
      job_id:             job.id,
      service:            String(p.service    ?? "UNKNOWN"),
      technician:         tech,
      plate:              p.plate_real        ?? p.plate ?? null,
      serial:             p.serial            ?? null,
      vehicle_id:         p.vehicleId         ? Number(p.vehicleId)         : null,
      asset_type:         p.assetType         ? Number(p.assetType)         : null,
      vehicle_setting_id: p.vehicleSettingId  ? Number(p.vehicleSettingId)  : null,
      client_id:          p.clientId          ? Number(p.clientId)          : null,
      client_descr:       p.clientName        ?? null,
      snapshot_json: {
        cadastro: {
          plate_real:      p.plate_real       ?? null,
          serial:          p.serial           ?? null,
          technician:      { id: tech, nick: tech },
          client:          p.clientName       ?? null,
          service:         p.service          ?? null,
          vehicle:         p.vehicle          ?? { manufacturer: null, model: null, year: null },
          gsensor:         p.gsensor          ?? null,
          comment:         p.comment          ?? null,
          cor:             p.cor              ?? null,
          chassi:          p.chassi           ?? null,
          localInstalacao: p.localInstalacao  ?? null,
        },
        can: {},
        ts:  Date.now(),
      },
    });

    await completeJob(job.id, "ok", { status: "ok" });
  } catch (e: any) {
    console.error(`[snapshot-worker] erro job=${job.id}:`, e?.message || e);
    await completeJob(job.id, "error", { status: "error", message: e?.message || "erro" });
  }
}

async function mainLoop() {
  console.log(`[snapshot-worker] iniciando. server=${JOB_SERVER_URL} worker=${WORKER_ID}`);
  let pollMs = POLL_MS;
  while (true) {
    const job = await fetchNext();
    if (job) {
      pollMs = POLL_MS;
      await processJob(job);
    } else {
      pollMs = Math.min(MAX_IDLE_POLL_MS, Math.round(pollMs * BACKOFF));
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

async function runForever() {
  while (true) {
    try { await mainLoop(); }
    catch (e) { console.error("[snapshot-worker] mainLoop caiu:", e); await new Promise(r => setTimeout(r, 15000)); }
  }
}

runForever().catch(e => console.error("[snapshot-worker] fatal:", e));

// ─── cron de retry dos pendentes ─────────────────────────────────────────────
import { retryPending } from "../services/snapshotStore";

const RETRY_INTERVAL_MS = Number(process.env.SNAPSHOT_RETRY_MS || String(5 * 60 * 1000)); // 5min padrão

async function startRetryCron() {
  // roda imediatamente no boot para exportar pendentes acumulados
  console.log("[snapshot-worker] retry boot: verificando pendentes...");
  await retryPending().catch(e => console.error("[snapshot-worker] retryPending boot erro:", e));

  // depois roda a cada RETRY_INTERVAL_MS
  setInterval(async () => {
    await retryPending().catch(e => console.error("[snapshot-worker] retryPending cron erro:", e));
  }, RETRY_INTERVAL_MS);
}

startRetryCron().catch(e => console.error("[snapshot-worker] startRetryCron fatal:", e));
