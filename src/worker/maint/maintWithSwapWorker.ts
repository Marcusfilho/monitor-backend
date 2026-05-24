/**
 * maintWithSwapWorker.ts — HTML5 Maint-With-Swap Worker (REWRITE)
 *
 * Fluxo por job:
 *  1. Normaliza payload (aliases de placa / serial_new)
 *  2. Resolve VEHICLE_ID via VHCLS (por placa)
 *  3. Verifica/libera serial_new no CMDT
 *  4. DEACTIVATE_VEHICLE_HIST (via mwsDeactivate)
 *  5. mwsSwapSerial: ACT_LOAD → SAVE → postcheck
 *  6. Completa com { ok, flow, vehicle_id, serial_new, dial }
 *
 * O backend (jobRoutes._enqueueSchemeBuilderAfterHtml5) detecta
 * flow=MAINT_WITH_SWAP + vehicle_id e encadeia SB → CAN → save_snapshot.
 */
import { configFromEnv, ensureHtml5Session }  from "../../core/html5Session";
import { ensureVehicleId }                     from "../../core/vhclsService";
import { checkAndFreeSerial, CmdtFreeResult }  from "../../core/cmdtService";
import { mwsDeactivate, mwsSwapSerial }        from "../../core/mwsService";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE      = (process.env.API_BASE_URL || "").replace(/\/$/, "");
const KEY       = (process.env.WORKER_KEY   || "").trim();
const WORKER_ID = process.env.WORKER_ID     || "maint-with-swap-rw";
const POLL_MS   = Number(process.env.POLL_INTERVAL_MS || "4000");
if (!BASE) throw new Error("[maintWithSwapWorker] API_BASE_URL não definido");
if (!KEY)  throw new Error("[maintWithSwapWorker] WORKER_KEY não definido");
const cfg = configFromEnv();

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function pollNextJob(): Promise<any | null> {
  const res = await fetch(`${BASE}/api/jobs/next`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ worker_key: KEY, worker_id: WORKER_ID, job_type: "html5_maint_with_swap" }),
  });
  if (res.status === 204) return null;
  if (!res.ok) { console.log(`[maint-with-swap-rw] poll HTTP ${res.status}`); return null; }
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

async function progressJob(jobId: string, percent: number, stage: string): Promise<void> {
  try {
    await fetch(`${BASE}/api/jobs/${jobId}/progress`, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ worker_key: KEY, percent, stage }),
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Normalização do payload
// ---------------------------------------------------------------------------
function normalizePayload(raw: any): any {
  const p = { ...raw };
  // plate aliases
  const rawPlate =
    p.plate ?? p.placa ?? p.license ?? p.licensePlate ??
    p.LICENSE_NMBR ?? p.license_nmbr ?? "";
  if (!p.plate && rawPlate) p.plate = String(rawPlate);
  if (p.plate) p.plate = String(p.plate).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!p.license && p.plate) p.license = p.plate;
  // serial_new aliases
  const rawSerial =
    p.serial_new ?? p.serialNew ?? p.new_serial ?? p.SERIAL_NEW ??
    p.serial ?? p.inner_id ?? p.INNER_ID ?? p.unit ?? p.UNIT ?? "";
  if (rawSerial) {
    const s = String(rawSerial).trim();
    p.serial_new = s;
    p.serial     = p.serial ?? s;
    p.inner_id   = p.inner_id ?? s;
    p.INNER_ID   = p.INNER_ID ?? s;
  }
  // vehicle_id aliases
  const rawVid = p.vehicle_id ?? p.vehicleId ?? p.VEHICLE_ID ?? "";
  if (!p.vehicle_id && rawVid) p.vehicle_id = String(rawVid).trim();
  p.service = "MAINT_WITH_SWAP";
  return p;
}

// ---------------------------------------------------------------------------
// Processamento de um job
// ---------------------------------------------------------------------------
async function processJob(job: any): Promise<void> {
  const jobId     = String(job.id || "");
  const payload   = normalizePayload(job.payload || {});
  const plate     = payload.plate      || "";
  const serialNew = payload.serial_new || "";

  console.log(`[maint-with-swap-rw] job=${jobId} plate=${plate} serial_new=${serialNew}`);

  // 1) Validações obrigatórias
  if (!plate) {
    await failJob(jobId, "missing_plate", { service: "MAINT_WITH_SWAP" });
    return;
  }
  if (!serialNew) {
    await failJob(jobId, "missing_serial_new", { service: "MAINT_WITH_SWAP", plate });
    return;
  }

  // 2) Garantir sessão HTML5 ativa
  try {
    await ensureHtml5Session(cfg);
  } catch (err: any) {
    console.log(`[maint-with-swap-rw] job=${jobId} sessão HTML5 falhou (continua): ${err?.message || String(err)}`);
  }

  await progressJob(jobId, 10, "vhcls");

  // 3) Resolve VEHICLE_ID — assinatura: (cfg, ctx, payload)
  let vehicleId: number =
    payload.vehicle_id ? (Number(payload.vehicle_id) || 0) : 0;

  if (!vehicleId) {
    try {
      const vid = await ensureVehicleId(cfg, null, payload);
      vehicleId = Number(vid) || 0;
    } catch (err: any) {
      console.log(`[maint-with-swap-rw] job=${jobId} VHCLS erro: ${err?.message || String(err)}`);
    }
  }

  if (!vehicleId) {
    await failJob(jobId, "vhcls_no_vehicle_id", {
      ok: false, service: "MAINT_WITH_SWAP", plate,
      resolve_error: "vhcls_no_vehicle_id",
    });
    return;
  }

  console.log(`[maint-with-swap-rw] job=${jobId} vehicle_id=${vehicleId}`);
  await progressJob(jobId, 25, "cmdt");

  // 4) Verifica/libera serial_new no CMDT
  // assinatura: (cfg, newSerial, jobId, installerName?)
  try {
    const cmdt: CmdtFreeResult = await checkAndFreeSerial(cfg, serialNew, jobId);
    if (cmdt.freed === false && cmdt.blocked === true) {
      console.log(`[maint-with-swap-rw] job=${jobId} serial bloqueado vid=${cmdt.vid_blocked}`);
      await failJob(jobId, "serial_in_use", {
        ok: false, service: "MAINT_WITH_SWAP", plate,
        vehicle_id: vehicleId, serial_new: serialNew,
        detail: `serial already linked to vehicle_id=${cmdt.vid_blocked} plate="${cmdt.plate_blocked}" (not a CMDT placeholder)`,
      });
      return;
    }
    if (cmdt.freed === true) {
      console.log(`[maint-with-swap-rw] job=${jobId} CMDT freed serial=${serialNew} was in vid=${cmdt.vid_freed}`);
    }
  } catch (err: any) {
    console.log(`[maint-with-swap-rw] job=${jobId} CMDT check falhou (non-blocking): ${err?.message || String(err)}`);
  }

  await progressJob(jobId, 40, "deactivate");

  // 5) DEACTIVATE_VEHICLE_HIST
  try {
    const de = await mwsDeactivate(cfg, vehicleId, plate, jobId, {
      installerName: String(payload.installer_name || payload.installer || "installer"),
      comments:      String(payload.comments || payload.note || "swap"),
    });
    if (!de.ok) {
      console.log(`[maint-with-swap-rw] job=${jobId} DEACTIVATE action_error http=${de.http}`);
      await failJob(jobId, "mws_deactivate_action_error", {
        ok: false, service: "MAINT_WITH_SWAP",
        plate, vehicle_id: vehicleId, serial_new: serialNew,
        http: de.http, head: de.head,
      });
      return;
    }
  } catch (err: any) {
    console.log(`[maint-with-swap-rw] job=${jobId} DEACTIVATE erro: ${err?.message || String(err)}`);
    await failJob(jobId, "mws_deactivate_error", { message: err?.message || String(err) });
    return;
  }

  await progressJob(jobId, 60, "swap");

  // 6) mwsSwapSerial: ACT_LOAD → SAVE → postcheck
  // assinatura: (cfg, jobId, vehicleId, plate, newSerial, opts?)
  let dial = "";
  try {
    dial = await mwsSwapSerial(cfg, jobId, vehicleId, plate, serialNew);
  } catch (err: any) {
    console.log(`[maint-with-swap-rw] job=${jobId} mwsSwapSerial erro: ${err?.message || String(err)}`);
    await failJob(jobId, "mws_swap_error", {
      ok: false, service: "MAINT_WITH_SWAP",
      plate, vehicle_id: vehicleId, serial_new: serialNew,
      message: err?.message || String(err),
    });
    return;
  }

  console.log(`[maint-with-swap-rw] job=${jobId} completed vehicle_id=${vehicleId} serial_new=${serialNew} dial=${dial}`);

  // 7) Completa — backend encadeia SB → CAN → save_snapshot
  await completeJob(jobId, {
    ok:         true,
    flow:       "MAINT_WITH_SWAP",
    service:    "MAINT_WITH_SWAP",
    vehicle_id: vehicleId,
    serial_new: serialNew,
    dial,
    meta: {
      service:    "MAINT_WITH_SWAP",
      plate,
      vehicle_id: vehicleId,
      serial_new: serialNew,
      dial,
    },
  });
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
    console.error(`[maint-with-swap-rw] processJob erro inesperado job=${job?.id}: ${err?.message || String(err)}`);
    try { await failJob(String(job.id || ""), "unexpected_error", { message: err?.message || String(err) }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log(`[maint-with-swap-rw] iniciando poll BASE=${BASE} POLL_MS=${POLL_MS}`);
(async () => {
  while (true) {
    try { await pollOnce(); } catch (err: any) {
      console.error(`[maint-with-swap-rw] poll erro: ${err?.message || String(err)}`);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
})();
