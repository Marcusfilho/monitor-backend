/**
 * maintNoSwapWorker.ts — HTML5 Maint-No-Swap Worker (REWRITE)
 *
 * Fluxo por job:
 *  1. Normaliza payload (aliases de placa)
 *  2. Resolve VEHICLE_ID via VHCLS (por placa — zero mutação HTML5)
 *  3. Reporta vehicle_id + monitor_skip=1 para o backend orquestrar CAN/snapshot
 *
 * O backend (jobRoutes._enqueueSchemeBuilderAfterHtml5) detecta monitor_skip=1
 * e enfileira monitor_can_snapshot diretamente.
 */
import { configFromEnv, ensureHtml5Session } from "../../core/html5Session";
import { ensureVehicleId }                   from "../../core/vhclsService";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE      = (process.env.API_BASE_URL || "").replace(/\/$/, "");
const KEY       = (process.env.WORKER_KEY   || "").trim();
const WORKER_ID = process.env.WORKER_ID     || "maint-no-swap-rw";
const POLL_MS   = Number(process.env.POLL_INTERVAL_MS || "4000");
if (!BASE) throw new Error("[maintNoSwapWorker] API_BASE_URL não definido");
if (!KEY)  throw new Error("[maintNoSwapWorker] WORKER_KEY não definido");
const cfg = configFromEnv();

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function pollNextJob(): Promise<any | null> {
  const res = await fetch(`${BASE}/api/jobs/next`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ worker_key: KEY, worker_id: WORKER_ID, job_type: "html5_maint_no_swap" }),
  });
  if (res.status === 204) return null;
  if (!res.ok) { console.log(`[maint-no-swap-rw] poll HTTP ${res.status}`); return null; }
  const body = await res.json() as any;
  const job  = body?.job ?? body;
  const j = job?.job ?? job; return j?.id ? j : null;
}

async function completeJob(jobId: string, result: any): Promise<void> {
  await fetch(`${BASE}/api/jobs/${jobId}/complete`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ worker_key: KEY, result }),
  });
}

async function failJob(jobId: string, reason: string, detail?: any): Promise<void> {
  await fetch(`${BASE}/api/jobs/${jobId}/complete`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ worker_key: KEY, status: "error", result: { ok: false, error: reason, detail } }),
  });
}

// ---------------------------------------------------------------------------
// Normalização do payload
// ---------------------------------------------------------------------------
function normalizePayload(raw: any): any {
  const p = { ...raw };
  const rawPlate =
    p.plate ?? p.placa ?? p.license ?? p.licensePlate ??
    p.LICENSE_NMBR ?? p.license_nmbr ?? "";
  if (!p.plate && rawPlate) p.plate = String(rawPlate);
  if (p.plate) p.plate = String(p.plate).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!p.license && p.plate) p.license = p.plate;
  const rawVid = p.vehicle_id ?? p.vehicleId ?? p.VEHICLE_ID ?? "";
  if (!p.vehicle_id && rawVid) p.vehicle_id = String(rawVid).trim();
  p.service = "MAINT_NO_SWAP";
  return p;
}

// ---------------------------------------------------------------------------
// Processamento de um job
// ---------------------------------------------------------------------------
async function processJob(job: any): Promise<void> {
  const jobId   = String(job.id || "");
  const payload = normalizePayload(job.payload || {});
  const plate   = payload.plate || "";

  console.log(`[maint-no-swap-rw] job=${jobId} plate=${plate}`);

  if (!plate) {
    await failJob(jobId, "missing_plate", { service: "MAINT_NO_SWAP" });
    return;
  }

  // Garantir sessão HTML5 ativa
  try {
    await ensureHtml5Session(cfg);
  } catch (err: any) {
    console.log(`[maint-no-swap-rw] job=${jobId} sessão HTML5 falhou (continua): ${err?.message || String(err)}`);
  }

  // Resolve VEHICLE_ID via VHCLS — assinatura: (cfg, ctx, payload)
  let vehicleId: number | null = null;
  try {
    vehicleId = await ensureVehicleId(cfg, null, payload);
  } catch (err: any) {
    console.log(`[maint-no-swap-rw] job=${jobId} VHCLS erro: ${err?.message || String(err)}`);
  }

  if (!vehicleId) {
    console.log(`[maint-no-swap-rw] job=${jobId} resolve_failed plate=${plate}`);
    await failJob(jobId, "vhcls_no_vehicle_id", {
      ok: false, service: "MAINT_NO_SWAP", plate,
      resolve_error: "vhcls_no_vehicle_id",
    });
    return;
  }

  console.log(`[maint-no-swap-rw] job=${jobId} resolved plate=${plate} vehicle_id=${vehicleId}`);

  // vehicle_id no nível raiz para que complete-maint e start-can o encontrem
  await completeJob(jobId, {
    ok:           true,
    service:      "MAINT_NO_SWAP",
    vehicle_id:   vehicleId,
    monitor_skip: 1,
    meta: {
      service:      "MAINT_NO_SWAP",
      plate,
      vehicle_id:   vehicleId,
      monitor_skip: 1,
    },
  });

  console.log(`[maint-no-swap-rw] job=${jobId} completed vehicle_id=${vehicleId}`);
}

// ---------------------------------------------------------------------------
// Loop de poll
// ---------------------------------------------------------------------------
async function pollOnce(): Promise<void> {
  const job = await pollNextJob();
  if (!job) return;
  try {
    await processJob(job);
  } catch (err: any) {
    console.error(`[maint-no-swap-rw] processJob erro inesperado job=${job?.id}: ${err?.message || String(err)}`);
    try { await failJob(String(job.id || ""), "unexpected_error", { message: err?.message || String(err) }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log(`[maint-no-swap-rw] iniciando poll BASE=${BASE} POLL_MS=${POLL_MS}`);
(async () => {
  while (true) {
    try { await pollOnce(); } catch (err: any) {
      console.error(`[maint-no-swap-rw] poll erro: ${err?.message || String(err)}`);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
})();
