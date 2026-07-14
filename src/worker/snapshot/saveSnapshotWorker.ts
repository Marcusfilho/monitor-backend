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

import WebSocket from "ws";

import { saveSnapshot } from "../../services/snapshotStore";
import { getTrafflogToken } from "../../core/traffilogAuth";
import { fetchModuleState, buildCanSummary, WsLike } from "../../core/vehicleMonitorSnapshotService";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE      = (process.env.API_BASE_URL || "").replace(/\/$/, "");
const KEY       = (process.env.WORKER_KEY   || "").trim();
const WORKER_ID = process.env.WORKER_ID     || "snapshot-rw";
const POLL_MS   = Number(process.env.POLL_INTERVAL_MS     || "8000");
const MAX_IDLE  = Number(process.env.POLL_INTERVAL_MS     || "60000");
const BACKOFF   = 1.6;

// Backfill do module state (FIX_MODULE_STATE_POLL_V1)
const WS_GUID       = (process.env.MONITOR_WS_GUID   || "").trim();
const WS_ORIGIN     = (process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com").trim();
const MS_MAX_WAIT   = Number(process.env.SNAPSHOT_MS_MAX_WAIT_MS  || "60000");
const MS_INTERVAL   = Number(process.env.SNAPSHOT_MS_INTERVAL_MS  || "15000");

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
// Backfill do module state (FIX_MODULE_STATE_POLL_V1)
//
// A captura CAN roda ~20s após a ativação do veículo, e nessa janela o servidor
// Traffilog ainda não materializou o registro de module state (responde av=0 com
// data=[]). Aqui — já depois da aprovação do técnico — tentamos de novo antes de
// gravar/exportar. Falha é não-fatal: o snapshot é salvo com o que houver.
// ---------------------------------------------------------------------------

async function backfillModuleState(jobId: string, can: any, vehicleId: number): Promise<void> {
  if (!WS_GUID) {
    console.log(`[snapshot-rw] job=${jobId} backfill pulado — MONITOR_WS_GUID não definido`);
    return;
  }

  let ws: WebSocket | null = null;
  try {
    const token = await getTrafflogToken();
    ws = new WebSocket(`wss://websocket.traffilog.com:8182/${WS_GUID}/${token}/json?defragment=1`, {
      headers: {
        "Pragma"         : "no-cache",
        "Cache-Control"  : "no-cache",
        "User-Agent"     : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9",
      },
      origin           : WS_ORIGIN,
      handshakeTimeout : 15000,
      perMessageDeflate: { clientMaxWindowBits: 15 },
    });

    const sock = ws;
    await new Promise<void>((resolve, reject) => {
      sock.once("open", () => resolve());
      sock.once("error", reject);
    });

    const rows = await fetchModuleState(sock as unknown as WsLike, token, vehicleId, {
      maxWaitMs : MS_MAX_WAIT,
      intervalMs: MS_INTERVAL,
    });

    if (rows.length > 0) {
      can.moduleState = rows;
      can.canSummary  = buildCanSummary(rows);
      console.log(
        `[snapshot-rw] job=${jobId} backfill OK módulos=${rows.length}` +
        ` can0_ok=${can.canSummary.can0_ok} can1_ok=${can.canSummary.can1_ok}`
      );
    } else {
      console.log(`[snapshot-rw] job=${jobId} backfill vazio — snapshot vai sem module state`);
    }
  } catch (e: any) {
    console.log(`[snapshot-rw] job=${jobId} backfill FALHOU (non-fatal): ${e?.message || String(e)}`);
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
  }
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

    const can       = (p.can && typeof p.can === "object") ? p.can : null;
    const vehicleId = Number(can?.vehicleId ?? p.vehicle_id ?? p.vehicleId ?? 0);
    if (can && vehicleId && (can.moduleState?.length ?? 0) === 0) {
      await backfillModuleState(jobId, can, vehicleId);
    }

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
