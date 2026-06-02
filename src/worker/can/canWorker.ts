/**
 * canWorker.ts — CAN Snapshot Worker (REWRITE v1)
 *
 * Fluxo por job:
 *   1. getTrafflogToken()  — login HTTP ~1s, sem VPN
 *   2. Abre WS em wss://websocket.traffilog.com:8182/{GUID}/{token}/json
 *   3. collectVehicleMonitorSnapshot() — coleta params CAN + moduleState
 *   4. completeJob() com VmSnapshot
 */

import WebSocket from "ws";
import { getTrafflogToken } from "../../core/traffilogAuth.js";
import {
  collectVehicleMonitorSnapshot,
  type WsLike,
} from "../../core/vehicleMonitorSnapshotService.js";

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
const BASE     = (process.env.API_BASE_URL  || "").trim().replace(/\/+$/, "");
const KEY      = (process.env.WORKER_KEY    || "").trim();
const GUID     = (process.env.MONITOR_WS_GUID || "").trim();
const WS_ORIGIN = (process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com").trim();
const POLL_MS  = Number(process.env.POLL_INTERVAL_MS || "5000");

if (!BASE) throw new Error("[can-rw] API_BASE_URL não definido");
if (!KEY)  throw new Error("[can-rw] WORKER_KEY não definido");
if (!GUID) throw new Error("[can-rw] MONITOR_WS_GUID não definido");

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function apiFetch(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-key": KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`[can-rw] HTTP ${res.status} ${path}`);
  return res.json() as any;
}

async function pollNextJob(): Promise<any | null> {
  const data = await apiFetch("/worker/can/poll", {});
  return data?.job ?? null;
}

async function completeJob(jobId: string, result: unknown) {
  await apiFetch(`/worker/can/complete/${jobId}`, { result });
}

async function failJob(jobId: string, reason: string, detail?: unknown) {
  await apiFetch(`/worker/can/fail/${jobId}`, { reason, detail });
}

// ---------------------------------------------------------------------------
// WS factory
// ---------------------------------------------------------------------------
function openWs(token: string): WsLike {
  const url = `wss://websocket.traffilog.com:8182/${GUID}/${token}/json?defragment=1`;
  const ws = new WebSocket(url, {
    headers: {
      "Pragma"         : "no-cache",
      "Cache-Control"  : "no-cache",
      "User-Agent"     : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept-Language": "pt-BR,pt;q=0.9",
    },
    origin          : WS_ORIGIN,
    handshakeTimeout: 15000,
    perMessageDeflate: { clientMaxWindowBits: 15 },
  });
  return ws as unknown as WsLike;
}

// ---------------------------------------------------------------------------
// Processamento de job
// ---------------------------------------------------------------------------
async function processJob(job: any): Promise<void> {
  const jobId     = String(job.id     || job.jobId || "");
  const vehicleId = Number(job.vehicle_id || job.vehicleId || 0);
  const clientId  = job.client_id  || job.clientId  || null;

  console.log(`[can-rw] job=${jobId} vehicleId=${vehicleId}`);

  if (!vehicleId) {
    await failJob(jobId, "missing_vehicle_id");
    return;
  }

  let sessionToken: string;
  try {
    sessionToken = await getTrafflogToken();
  } catch (e: any) {
    console.error(`[can-rw] job=${jobId} falha ao obter token: ${e?.message || e}`);
    await failJob(jobId, "token_unavailable", e?.message);
    return;
  }

  const ws = openWs(sessionToken);

  // Aguarda WS abrir antes de passar para o service
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("[can-rw] WS open timeout 15s")), 15000);
    (ws as any).once("open",  () => { clearTimeout(timer); resolve(); });
    (ws as any).once("error", (e: any) => { clearTimeout(timer); reject(e); });
  });

  try {
    const snapshot = await collectVehicleMonitorSnapshot({
      ws,
      sessionToken,
      vehicleId,
      clientId,
    });

    console.log(
      `[can-rw] job=${jobId} OK params=${snapshot.parameters.length}` +
      ` moduleState=${snapshot.moduleState.length}` +
      ` can0_ok=${snapshot.canSummary.can0_ok}` +
      ` can1_ok=${snapshot.canSummary.can1_ok}`
    );

    await completeJob(jobId, { ok: true, snapshot });
  } catch (e: any) {
    const msg = String(e?.message || e);
    console.error(`[can-rw] job=${jobId} FALHOU: ${msg}`);
    await failJob(jobId, "can_flow_error", msg);
  } finally {
    try { (ws as any).terminate(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------------
async function loop(): Promise<void> {
  console.log(`[can-rw] iniciando poll BASE=${BASE} POLL_MS=${POLL_MS} GUID=${GUID.slice(0, 8)}...`);
  while (true) {
    try {
      const job = await pollNextJob();
      if (job) {
        processJob(job).catch((err: any) =>
          console.error(`[can-rw] processJob unhandled: ${err?.message || String(err)}`)
        );
      }
    } catch (err: any) {
      console.error("[can-rw] poll erro:", err?.message || String(err));
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

async function runForever(): Promise<void> {
  while (true) {
    try { await loop(); }
    catch (e) { console.error("[can-rw] loop caiu:", e); await new Promise(r => setTimeout(r, 15000)); }
  }
}

runForever().catch(e => console.error("[can-rw] fatal:", e));
