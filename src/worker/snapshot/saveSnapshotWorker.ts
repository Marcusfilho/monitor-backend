/**
 * saveSnapshotWorker.ts — Save Snapshot Worker (REWRITE)
 *
 * Consome jobs "save_snapshot" da API do rewrite.
 * Grava no SQLite local via snapshotStore nativo do rewrite.
 *
 * SNAPSHOT_STORE_NATIVE_V1:
 *   Importa src/services/snapshotStore.ts diretamente (sem depender do monolito).
 *   DB_PATH controlado por SQLITE_DB_PATH no worker_secrets_rw.env.
 *
 * FIX_SS_204_V1: trata 204 antes de res.json()
 * FIX_SS_JOB_WRAP_V1: extrai job de { ok, job }
 */

import { saveSnapshot } from "../../services/snapshotStore";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE      = (process.env.API_BASE_URL || "").replace(/\/$/, "");
const KEY       = (process.env.WORKER_KEY   || "").trim();
const WORKER_ID = process.env.WORKER_ID     || "snapshot-rw";
const POLL_MS   = Number(process.env.POLL_INTERVAL_MS     || "8000");
const MAX_IDLE  = Number(process.env.POLL_INTERVAL_MS     || "60000");
const BACKOFF   = 1.6;

if (!BASE) throw new Error("[snapshot-rw] API_BASE_URL não definido");
if (!KEY)  throw new Error("[snapshot-rw] WORKER_KEY não definido");

// ---------------------------------------------------------------------------
// API helpers (job queue)
// ---------------------------------------------------------------------------

async function pollNextJob(): Promise<any | null> {
  const res = await fetch(`${BASE}/api/jobs/next`, {
    method  : "POST",
    headers : { "Content-Type": "application/json" },
    body    : JSON.stringify({ worker_key: KEY, worker_id: WORKER_ID, job_type: "save_snapshot" }),
  });

  if (res.status === 204) return null;
  if (!res.ok) { console.log(`[snapshot-rw] poll HTTP ${res.status}`); return null; }

  const data = await res.json() as any;
  const job  = data?.job ?? data;
  return job?.id ? job : null;
}

async function completeJob(jobId: string, result: any): Promise<void> {
  await fetch(`${BASE}/api/jobs/${jobId}/complete`, {
    method  : "POST",
    headers : { "Content-Type": "application/json" },
    body    : JSON.stringify({ worker_key: KEY, result }),
  });
}

async function failJob(jobId: string, reason: string, detail?: any): Promise<void> {
  await fetch(`${BASE}/api/jobs/${jobId}/complete`, {
    method  : "POST",
    headers : { "Content-Type": "application/json" },
    body    : JSON.stringify({ worker_key: KEY, status: "error", result: { reason, detail } }),
  });
}

// ---------------------------------------------------------------------------
// Processamento
// ---------------------------------------------------------------------------

async function processJob(job: any): Promise<void> {
  const jobId   = String(job.id || "");
  const p       = job.payload || {};

  console.log(
    `[snapshot-rw] job=${jobId}` +
    ` service=${p.service     ?? "?"}` +
    ` plate=${p.plate_real    ?? p.plate ?? "?"}` +
    ` serial=${p.serial       ?? "?"}`
  );

  try {
    const tech =
      typeof p.technician === "object"
        ? (p.technician?.nick ?? p.technician?.id ?? null)
        : (p.technician ?? null);

    await saveSnapshot({
      job_id             : jobId,
      service            : String(p.service           ?? "UNKNOWN"),
      technician         : tech,
      plate              : p.plate_real                ?? p.plate     ?? null,
      serial             : p.serial                   ?? null,
      vehicle_id         : p.vehicle_id ?? p.vehicleId   ? Number(p.vehicle_id ?? p.vehicleId)        : null,
      asset_type         : p.assetType                ? Number(p.assetType)        : null,
      vehicle_setting_id : p.vehicle_setting_id ?? p.vehicleSettingId ? Number(p.vehicle_setting_id ?? p.vehicleSettingId) : null,
      client_id          : p.client_id ?? p.clientId  ? Number(p.client_id ?? p.clientId)           : null,
      client_descr       : p.client_descr ?? p.clientName ?? null,
      snapshot_json: {
        cadastro: {
          plate_real      : p.plate_real              ?? null,
          serial          : p.serial                  ?? null,
          technician      : { id: tech, nick: tech },
          client          : p.client_descr ?? p.clientName ?? null,
          service         : p.service                 ?? null,
          vehicle         : p.vehicle                 ?? { manufacturer: null, model: null, year: null },
          gsensor         : p.gsensor                 ?? null,
          comment         : p.comment                 ?? null,
          cor             : p.cor             ?? p.vehicle_color    ?? null,
          chassi          : p.chassi          ?? p.vehicle_chassis  ?? null,
          localInstalacao : p.localInstalacao ?? p.install_location ?? null,
        },
        can : (p.can && typeof p.can === "object") ? p.can : {},
        ts  : Date.now(),
      },
    });

    await completeJob(jobId, { ok: true, status: "ok" });
    console.log(`[snapshot-rw] job=${jobId} salvo no SQLite OK`);
  } catch (e: any) {
    console.error(`[snapshot-rw] job=${jobId} ERRO:`, e?.message || e);
    await failJob(jobId, "save_error", { message: e?.message || String(e) });
  }
}

// ---------------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------------

async function loop(): Promise<void> {
  console.log(`[snapshot-rw] iniciando poll BASE=${BASE} POLL_MS=${POLL_MS}`);
  let pollMs = POLL_MS;

  while (true) {
    try {
      const job = await pollNextJob();
      if (job) {
        pollMs = POLL_MS;
        await processJob(job);
      } else {
        pollMs = Math.min(MAX_IDLE, Math.round(pollMs * BACKOFF));
      }
    } catch (err: any) {
      console.error("[snapshot-rw] poll erro:", err?.message || String(err));
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

async function runForever(): Promise<void> {
  while (true) {
    try { await loop(); }
    catch (e) { console.error("[snapshot-rw] loop caiu:", e); await new Promise(r => setTimeout(r, 15000)); }
  }
}

runForever().catch(e => console.error("[snapshot-rw] fatal:", e));
