/**
 * installationsRoutes.ts — Rotas de instalações (REWRITE)
 *
 * Endpoints:
 *   POST   /api/installations                          → cria job html5_install
 *   GET    /api/installations/vhcls-lookup?plate=XXX  → proxy VHCLS (evita CORS no browser)
 *   POST   /api/installations/:jobId/actions/complete-maint → finaliza MAINT_NO_SWAP (caminho NÃO)
 *
 * Paralelismo de SB (SB_PARALLEL_V1):
 *   createJob("scheme_builder") é fire-and-forget — sem await.
 *   O schemeBuilderWorker pega e processa em paralelo com outros SBs em andamento.
 */

import { Router, Request, Response } from "express";
import { createJob, getJob, completeJob } from "../jobs/jobStore";
import { resolveByPlate }               from "../core/vhclsService";
import { configFromEnv }               from "../core/html5Session";

const router = Router();
const cfg    = configFromEnv();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normPlate(raw: unknown): string {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
}

function isMaintNoSwap(type: string): boolean {
  const t = String(type || "").toLowerCase();
  return t === "maint_no_swap" || t === "maintnoswap" || t === "html5_maint_no_swap";
}

// ---------------------------------------------------------------------------
// POST /api/installations
// ---------------------------------------------------------------------------

router.post("/", (req: Request, res: Response) => {
  const body    = req.body || {};
  const service = String(body.service || body.SERVICE || "INSTALL").trim().toUpperCase();

  const JOB_TYPE_MAP: Record<string, string> = {
    INSTALL         : "html5_install",
    UNINSTALL       : "html5_uninstall",
    MAINT_WITH_SWAP : "html5_maint_with_swap",
    MAINT_NO_SWAP   : "html5_maint_no_swap",
  };

  const jobType = JOB_TYPE_MAP[service];
  if (!jobType) {
    res.status(400).json({
      ok    : false,
      error : "service_invalido",
      detail: `Serviço desconhecido: "${service}". Use: INSTALL | UNINSTALL | MAINT_WITH_SWAP | MAINT_NO_SWAP`,
    });
    return;
  }

  let job;
  try {
    job = createJob(jobType, body);
  } catch (e: any) {
    res.status(500).json({ ok: false, error: "create_job_failed", detail: e?.message || String(e) });
    return;
  }

  console.log(`[installations] POST / service=${service} job_id=${job.id} type=${jobType}`);

  res.status(201).json({
    ok     : true,
    job_id : job.id,
    type   : jobType,
    service,
    status : job.status,
  });
});

// ---------------------------------------------------------------------------
// GET /api/installations/vhcls-lookup?plate=XXX
// ---------------------------------------------------------------------------

router.get("/vhcls-lookup", async (req: Request, res: Response) => {
  const plate = normPlate(req.query.plate);

  if (!plate) {
    res.status(400).json({ ok: false, error: "plate_ausente", detail: "Query param ?plate= obrigatório" });
    return;
  }

  console.log(`[installations] GET /vhcls-lookup plate=${plate}`);

  try {
    const result = await resolveByPlate(cfg, plate);

    // VhclsResolveResult: { plate, status, len, loginNeg, vehicleId, jarFlags, head }
    // vehicleId é null se não encontrado
    if (!result.vehicleId) {
      res.json({ ok: false, plate, vehicle_id: null });
      return;
    }

    res.json({
      ok        : true,
      plate,
      vehicle_id: result.vehicleId,
    });

  } catch (e: any) {
    const msg = String(e?.message || e);
    console.error(`[installations] vhcls-lookup erro plate=${plate}: ${msg}`);
    res.status(502).json({ ok: false, error: "vhcls_lookup_failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /api/installations/:jobId/actions/complete-maint
// ---------------------------------------------------------------------------

router.post("/:jobId/actions/complete-maint", (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const body  = req.body || {};

  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ ok: false, error: "job_not_found", job_id: jobId });
    return;
  }

  if (!isMaintNoSwap(job.type)) {
    res.status(400).json({
      ok    : false,
      error : "job_type_invalido",
      detail: `Este endpoint só aceita jobs maint_no_swap. Tipo atual: "${job.type}"`,
    });
    return;
  }

  if (job.status === "completed" || job.status === "error") {
    res.status(409).json({
      ok    : false,
      error : "job_ja_finalizado",
      detail: `Job ${jobId} já está em status "${job.status}"`,
    });
    return;
  }

  // Campos para o SB — vindos do body da rota ou do payload original do job
  const jobPayload       = job.payload || {};
  const vehicleId        = String(body.vehicle_id         ?? jobPayload.vehicle_id         ?? jobPayload.vehicleId         ?? "").trim();
  const clientId         = String(body.client_id          ?? jobPayload.client_id          ?? jobPayload.clientId          ?? "").trim();
  const clientName       = String(body.client_name        ?? jobPayload.client_name        ?? jobPayload.clientName        ?? "").trim();
  const vehicleSettingId = String(body.vehicle_setting_id ?? jobPayload.vehicle_setting_id ?? jobPayload.vehicleSettingId  ?? "").trim();
  const comment          = String(body.comment ?? "MAINT_NO_SWAP_SKIP").trim();

  // 1. Marca job como completed
  completeJob(jobId, "completed", {
    ok     : true,
    status : "maint_no_swap_skip",
    message: "Manutenção finalizada sem troca de equipamento (caminho NÃO)",
  });

  console.log(`[installations] complete-maint job=${jobId} vehicle_id=${vehicleId}`);

  // 2. Enfileira SB — fire-and-forget (SB_PARALLEL_V1)
  //    Sem await: retorna ao app imediatamente, SB corre em paralelo no worker
  const sbQueued = !!(vehicleId && vehicleSettingId && clientId);
  if (sbQueued) {
    const sbJob = createJob("scheme_builder", {
      vehicle_id         : vehicleId,
      vehicle_setting_id : vehicleSettingId,
      client_id          : clientId,
      client_name        : clientName,
      comment,
      origin             : `maint_no_swap_skip:${jobId}`,
    });
    console.log(`[installations] SB enfileirado job=${sbJob.id} vehicle_id=${vehicleId} (paralelo)`);
  } else {
    console.log(
      `[installations] complete-maint job=${jobId} — SB não enfileirado ` +
      `(faltam: vehicle_id=${vehicleId || "?"} vehicle_setting_id=${vehicleSettingId || "?"} client_id=${clientId || "?"})`
    );
  }

  res.json({ ok: true, job_id: jobId, status: "completed", sb_queued: sbQueued });
});

export default router;
