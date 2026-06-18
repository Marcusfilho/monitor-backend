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
import { getTrafflogToken, invalidateTrafflogToken } from "../../core/traffilogAuth.js";
import { updateJob } from "../../jobs/jobStore.js";
import {
  collectVehicleMonitorSnapshot,
  buildCanSummary,
  type WsLike,
} from "../../core/vehicleMonitorSnapshotService.js";

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
const BASE          = (process.env.API_BASE_URL  || "").trim().replace(/\/+$/, "");
const KEY           = (process.env.WORKER_KEY    || "").trim();
const GUID          = (process.env.MONITOR_WS_GUID || "").trim();
const WS_ORIGIN     = (process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com").trim();
const POLL_MS       = Number(process.env.POLL_INTERVAL_MS || "5000");
// Delay após SB antes de abrir WS: dá tempo ao equipamento de reconectar após aplicar o scheme
const POST_SB_WARMUP_MS = Number(process.env.POST_SB_WARMUP_MS ?? "20000");
// Tentativas de coleta quando não chega nenhum UNIT_PARAMETERS
const CAN_MAX_ATTEMPTS  = Number(process.env.CAN_MAX_ATTEMPTS  ?? "3");
// Janela de coleta por tentativa (ms) — menor que VM_WINDOW_MS padrão de 300s
const CAN_ATTEMPT_WINDOW_MS = Number(process.env.CAN_ATTEMPT_WINDOW_MS ?? "120000");

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
  const res = await fetch(`${BASE}/api/jobs/next`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-key": KEY },
    body: JSON.stringify({ job_type: "monitor_can_snapshot", worker_key: KEY }),
  });
  if (!res.ok) { console.log(`[can-rw] poll HTTP ${res.status}`); return null; }
  if (res.status === 204) return null;
  const data = await res.json() as any;
  return data?.job ?? null;
}

async function completeJob(jobId: string, result: unknown) {
  const res = await fetch(`${BASE}/api/jobs/${jobId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-key": KEY },
    body: JSON.stringify({ result, worker_key: KEY }),
  });
  if (!res.ok) console.error(`[can-rw] complete HTTP ${res.status} job=${jobId}`);
}

async function failJob(jobId: string, reason: string, detail?: unknown) {
  const res = await fetch(`${BASE}/api/jobs/${jobId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-key": KEY },
    body: JSON.stringify({ status: "error", result: { reason, detail }, worker_key: KEY }),
  });
  if (!res.ok) console.error(`[can-rw] fail HTTP ${res.status} job=${jobId}`);
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

async function openWsAndWait(token: string): Promise<WsLike> {
  const ws = openWs(token);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("[can-rw] WS open timeout 15s")), 15000);
    (ws as any).once("open",  () => { clearTimeout(timer); resolve(); });
    (ws as any).once("error", (e: any) => { clearTimeout(timer); invalidateTrafflogToken(); reject(e); });
  });
  return ws;
}

// ---------------------------------------------------------------------------
// Processamento de job
// ---------------------------------------------------------------------------
async function processJob(job: any): Promise<void> {
  const jobId     = String(job.id     || job.jobId || "");
  const p         = job.payload ?? job;
  const vehicleId = Number(p.vehicle_id || p.vehicleId || 0);
  const clientId  = p.client_id  || p.clientId  || null;
  const fromJob   = p._from; // presente quando dispatched pelo pipeline (ex: após SB)

  console.log(`[can-rw] job=${jobId} vehicleId=${vehicleId} fromJob=${fromJob ?? "direct"}`);

  if (!vehicleId) {
    await failJob(jobId, "missing_vehicle_id");
    return;
  }

  // Quando vem do pipeline (ex: após SB), o token cacheado foi usado pela sessão WS do SB.
  // O Traffilog invalida esse token ao fechar a sessão → vehicle_subscribe retorna 406.
  // Invalidar agora força novo login antes de abrir a sessão CAN.
  if (fromJob) {
    invalidateTrafflogToken();
    console.log(`[can-rw] job=${jobId} fromJob — token SB invalidado, auth fresca para sessão CAN`);
  }

  // Warmup: aguarda o dispositivo reconectar após aplicar o scheme
  if (fromJob && POST_SB_WARMUP_MS > 0) {
    console.log(`[can-rw] job=${jobId} POST_SB_WARMUP ${POST_SB_WARMUP_MS}ms`);
    await new Promise(r => setTimeout(r, POST_SB_WARMUP_MS));
  }

  // Partial update helper
  const onPartialParams = (params: any, counts: any, header: any, moduleState: any) => {
    updateJob(jobId, {
      result: {
        ok: false,
        partial: true,
        snapshot: { vehicleId, header, parameters: params, moduleState,
          isConnected: null, canSummary: buildCanSummary(moduleState), counts },
      },
    });
  };

  // Loop de tentativas: se não chegar nenhum UNIT_PARAMETERS, reabre WS com token fresco
  let lastSnapshot: any = null;

  for (let attempt = 1; attempt <= CAN_MAX_ATTEMPTS; attempt++) {
    let sessionToken: string;
    try {
      sessionToken = await getTrafflogToken();
    } catch (e: any) {
      console.error(`[can-rw] job=${jobId} tentativa ${attempt} falha ao obter token: ${e?.message || e}`);
      await failJob(jobId, "token_unavailable", e?.message);
      return;
    }

    let ws: WsLike | null = null;
    try {
      ws = await openWsAndWait(sessionToken);

      console.log(`[can-rw] job=${jobId} tentativa ${attempt}/${CAN_MAX_ATTEMPTS} WS aberto`);

      const snapshot = await collectVehicleMonitorSnapshot({
        ws,
        sessionToken,
        vehicleId,
        clientId,
        windowMs: CAN_ATTEMPT_WINDOW_MS,
        onPartialParams,
      });

      lastSnapshot = snapshot;
      const events = snapshot.rawCounts.unitParametersEvents;

      console.log(
        `[can-rw] job=${jobId} tentativa ${attempt} concluída` +
        ` params=${snapshot.parameters.length} events=${events}` +
        ` can0_ok=${snapshot.canSummary.can0_ok} can1_ok=${snapshot.canSummary.can1_ok}`
      );

      if (events > 0 || attempt === CAN_MAX_ATTEMPTS) {
        // Dados recebidos OU última tentativa — aceita o que temos
        await completeJob(jobId, { ok: true, snapshot });
        return;
      }

      // Sem dados — tenta de novo com token e WS novos
      console.log(`[can-rw] job=${jobId} tentativa ${attempt} sem UNIT_PARAMETERS — invalidando token e reabrindo WS`);
      invalidateTrafflogToken();
      await new Promise(r => setTimeout(r, 10_000)); // 10s entre tentativas

    } catch (e: any) {
      const msg = String(e?.message || e);
      console.error(`[can-rw] job=${jobId} tentativa ${attempt} FALHOU: ${msg}`);
      if (attempt === CAN_MAX_ATTEMPTS) {
        await failJob(jobId, "can_flow_error", msg);
        return;
      }
      invalidateTrafflogToken();
      await new Promise(r => setTimeout(r, 10_000));
    } finally {
      if (ws) { try { (ws as any).terminate(); } catch {} }
    }
  }

  // Segurança: se saiu do loop sem retornar
  if (lastSnapshot) {
    await completeJob(jobId, { ok: true, snapshot: lastSnapshot });
  } else {
    await failJob(jobId, "can_no_data", "nenhuma tentativa retornou snapshot");
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
