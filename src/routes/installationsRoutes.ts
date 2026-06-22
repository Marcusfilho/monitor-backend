import { getSelectedSchemeId } from "../services/schemeSelectionService";
/**
 * installationsRoutes.ts — Rotas de instalações (REWRITE)
 *
 * Endpoints:
 *   POST   /api/installations                          → cria job html5_install
 *   GET    /api/installations/vhcls-lookup?plate=XXX  → proxy VHCLS (evita CORS no browser)
 *   POST   /api/installations/:jobId/actions/complete-maint → finaliza MAINT_NO_SWAP (caminho NÃO)
 *   POST   /api/installations/:id/retry-html5         → reprocessa job HTML5 com erro ou travado
 *
 * Paralelismo de SB (SB_PARALLEL_V1):
 *   createJob("scheme_builder") é fire-and-forget — sem await.
 *   O schemeBuilderWorker pega e processa em paralelo com outros SBs em andamento.
 */

import { Router, Request, Response } from "express";
import { createJob, getJob, completeJob, updateJob } from "../jobs/jobStore";
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

  // Garantir que plate usa plate_real quando disponível (não o serial)
  // INSTALL usa plate=serial intencionalmente (Caminho B) — não sobrescrever
  if (body.plate_real && body.plate_real !== body.plate && service !== "INSTALL") {
    body.plate = body.plate_real;
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
  const plate     = normPlate(req.query.plate);
  const bySerial  = String(req.query.by || "").toLowerCase() === "serial";

  if (!plate) {
    res.status(400).json({ ok: false, error: "plate_ausente", detail: "Query param ?plate= obrigatório" });
    return;
  }

  console.log(`[installations] GET /vhcls-lookup plate=${plate} by=${bySerial ? "serial" : "plate"}`);

  try {
    const result = await resolveByPlate(cfg, plate, "VHCLS", "", bySerial);

    // VhclsResolveResult: { plate, status, len, loginNeg, vehicleId, jarFlags, head }
    // vehicleId é null se não encontrado
    if (!result.vehicleId) {
      res.json({ ok: false, plate, vehicle_id: null });
      return;
    }

    res.json({
      ok          : true,
      plate,
      vehicle_id  : result.vehicleId,
      inner_id    : result.innerId      ?? null,
      license_nmbr: result.licensePlate ?? null,
      client_id   : result.clientId     ?? null,
      client_descr: result.clientDescr  ?? null,
    });

  } catch (e: any) {
    const msg = String(e?.message || e);
    console.error(`[installations] vhcls-lookup erro plate=${plate}: ${msg}`);
    res.status(502).json({ ok: false, error: "vhcls_lookup_failed", detail: msg });
  }
});


// ---------------------------------------------------------------------------
// GET /api/installations/:id  — poll de status (pipeline unificado)
// ---------------------------------------------------------------------------
router.get("/:id", (req: Request, res: Response) => {
  const { listJobs } = require("../jobs/jobStore");

  const rootId = String(req.params.id);
  const allJobs: any[] = listJobs();

  // job raiz (html5_install)
  const root = allJobs.find((j: any) => j.id === rootId);
  if (!root) { res.status(404).json({ ok: false, error: "job_not_found" }); return; }

  // coleta toda a cadeia _from → rootId (em qualquer profundidade)
  function collectChain(fromId: string): any[] {
    const direct = allJobs.filter((j: any) => j.payload?._from === fromId);
    return direct.flatMap((j: any) => [j, ...collectChain(j.id)]);
  }
  const chain = [root, ...collectChain(rootId)];

  // job mais recente por tipo
  function latest(type: string) {
    return chain.filter((j: any) => j.type === type).sort((a: any, b: any) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )[0] ?? null;
  }

  const sbJob    = latest("scheme_builder");
  const canJob   = latest("monitor_can_snapshot");
  const gsJob    = latest("gs_calibration");
  const saveJob  = latest("save_snapshot");

  // status unificado
  let status = "HTML5_DONE";

  if (root.status === "processing" || root.status === "pending") {
    status = "HTML5_RUNNING";
  } else if (root.status === "error") {
    status = "HTML5_ERROR";
  } else if (saveJob) {
    if (saveJob.status === "completed")                           status = "COMPLETED";
    else if (saveJob.status === "error")                          status = "SAVE_ERROR";
    else                                                          status = "GS_RUNNING";
  } else if (gsJob) {
    if (gsJob.status === "error")                                 status = "GS_ERROR";
    else                                                          status = "GS_RUNNING";
  } else if (canJob) {
    if (canJob.status === "waiting_approval" as any)              status = "WAITING_APPROVAL";
    else if (canJob.status === "error")                           status = "CAN_ERROR";
    else                                                          status = "CAN_RUNNING";
  } else if (sbJob) {
    if (sbJob.status === "error")                                 status = "SB_ERROR";
    else if (sbJob.status === "completed")                        status = "SB_DONE";
    else                                                          status = "SB_RUNNING";
  }

  // último erro da cadeia
  const errJob = [...chain].reverse().find((j: any) => j.status === "error");
  const lastError = errJob
    ? { job_type: errJob.type, ...(errJob.result ?? {}) }
    : null;

  // token para approve-can: vem do payload do canJob
  const canToken    = canJob?.payload?.installation_token ?? canJob?.result?.token ?? root.payload?.installation_token ?? null;
  const canJobId    = canJob?.id ?? null;

  // progresso SB para o frontend (inst.sb.last_progress)
  const sbProgress = sbJob?.result?.progress ?? sbJob?.result?.last_progress ?? null;

  res.json({
    ok: true,
    id: root.id,
    installation_id: root.id,
    installation_token: canToken,
    status,
    payload: root.payload,
    result: root.result,
    sb: sbProgress != null ? { progress: sbProgress, last_progress: sbProgress } : undefined,
    jobs: {
      html5_install:       root,
      scheme_builder:      sbJob,
      monitor_can_snapshot: canJob,
      gs_calibration:      gsJob,
      save_snapshot:       saveJob,
    },
    last_error: lastError,
    updatedAt: chain.reduce((acc: string, j: any) =>
      new Date(j.updatedAt) > new Date(acc) ? j.updatedAt : acc, root.updatedAt),
  });
});


// ---------------------------------------------------------------------------
// POST /api/installations/:id/approve-can  — técnico valida CAN e dispara próxima etapa
// ---------------------------------------------------------------------------
router.post("/:id/approve-can", (req: Request, res: Response) => {
  const { getJob, listJobs, updateJob, createJob } = require("../jobs/jobStore");
  const { getGsCommand } = require("../core/gsCommandMap");

  const job = getJob(String(req.params.id));
  if (!job) { res.status(404).json({ ok: false, error: "job_not_found" }); return; }

  // busca o snapshot CAN na cadeia de jobs
  const allJobs: any[] = listJobs();
  function collectChain(fromId: string): any[] {
    return allJobs
      .filter((j: any) => j.payload?._from === fromId)
      .flatMap((j: any) => [j, ...collectChain(j.id)]);
  }
  const chain = [job, ...collectChain(job.id)];
  const canJob = chain
    .filter((j: any) => j.type === "monitor_can_snapshot")
    .sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  const canSnapshot = canJob?.result?.snapshot ?? null;

  const service = String(job.payload?.service ?? "").toUpperCase();
  const needsGs = ["INSTALL", "MAINT_WITH_SWAP"].includes(service);
  const plate   = job.payload?.plate ?? "";

  const base = { ...job.payload, ...(job.result ?? {}), plate, _from: job.id, can: canSnapshot };

  if (needsGs) {
    const label   = String(job.payload?.gsensor?.label_pos   ?? job.payload?.label_position   ?? "").toUpperCase();
    const harness = String(job.payload?.gsensor?.harness_pos ?? job.payload?.harness_position ?? "").toUpperCase();
    const gsCmd   = getGsCommand(label, harness);
    if (gsCmd) {
      createJob("gs_calibration", { ...base, GS_ACTION_ID: gsCmd.action_id, GS_COMMAND_SYNTAX: gsCmd.command_syntax });
    } else {
      createJob("save_snapshot", base);
    }
  } else if (service === "MAINT_NO_SWAP") {
    // Caminho "validar CAN": salva o CAN validado e aplica o scheme silenciosamente.
    // SB é terminal (não recoleta CAN) — fluxo: CAN > finaliza > SB silencioso.
    createJob("save_snapshot", base);
    const clientId   = String(job.payload?.client_id ?? job.payload?.clientId ?? "").trim();
    const clientName = String(job.payload?.client_name ?? job.payload?.client_descr ?? "").trim();
    const vehicleId  = String(base.vehicle_id ?? "").trim();
    const schemeId   = getSelectedSchemeId(clientId) ?? "";
    if (vehicleId && clientId && schemeId) {
      const sbJob = createJob("scheme_builder", {
        ...job.payload,
        vehicle_id         : vehicleId,
        vehicle_setting_id : schemeId,
        client_id          : clientId,
        client_name        : clientName,
        _terminal          : true,
        origin             : `maint_no_swap_can:${job.id}`,
        _from              : job.id,
      });
      console.log(`[installations] approve-can MAINT_NO_SWAP → SB silencioso job=${sbJob.id} vehicle_id=${vehicleId}`);
    } else {
      console.log(
        `[installations] approve-can MAINT_NO_SWAP job=${job.id} — SB não enfileirado ` +
        `(faltam: vehicle_id=${vehicleId || "?"} client_id=${clientId || "?"} scheme_id=${schemeId || "?"})`
      );
    }
  } else {
    createJob("save_snapshot", base);
  }

  updateJob(job.id, { status: "approved" as any });
  res.json({ ok: true, job_id: job.id, status: "approved" });
});

// ---------------------------------------------------------------------------
// POST /api/installations/:jobId/actions/complete-maint
// ---------------------------------------------------------------------------

router.post("/:jobId/complete-maint", (req: Request, res: Response) => {
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

  // Rejeita só se já foi confirmado por este endpoint (não pelo worker)
  const alreadyConfirmed = (job.result as any)?.status === "maint_no_swap_skip";
  if (alreadyConfirmed || job.status === "error") {
    res.status(409).json({
      ok    : false,
      error : "job_ja_finalizado",
      detail: `Job ${jobId} já está em status "${job.status}"`,
    });
    return;
  }

  // Campos para o SB — vindos do body da rota, resultado do worker, ou payload original do job
  const jobPayload       = job.payload || {};
  const jobResult        = job.result  || {};
  const vehicleId        = String(body.vehicle_id         ?? jobPayload.vehicle_id         ?? jobPayload.vehicleId         ?? jobResult.vehicle_id ?? "").trim();
  const clientId         = String(body.client_id          ?? jobPayload.client_id          ?? jobPayload.clientId          ?? "").trim();
  const clientName       = String(body.client_name        ?? jobPayload.client_name        ?? jobPayload.clientName        ?? jobPayload.client_descr  ?? jobPayload.clientDescr  ?? "").trim();
  const vehicleSettingId = String(body.vehicle_setting_id ?? jobPayload.vehicle_setting_id ?? jobPayload.vehicleSettingId  ?? "").trim();
  // Comentário do SB: usa o comentário da tela de cadastro (jobPayload.comment) quando houver;
  // só cai no marcador "MAINT_NO_SWAP_SKIP" quando o cadastro não tem comentário.
  const regComment       = String(body.comment ?? jobPayload.comment ?? "").trim();
  const comment          = regComment || "MAINT_NO_SWAP_SKIP";

  // 1. Marca job como completed
  completeJob(jobId, "completed", {
    ok     : true,
    status : "maint_no_swap_skip",
    message: "Manutenção finalizada sem troca de equipamento (caminho NÃO)",
  });

  console.log(`[installations] complete-maint job=${jobId} vehicle_id=${vehicleId}`);

  // 2. Enfileira SB — fire-and-forget (SB_PARALLEL_V1)
  //    Sem await: retorna ao app imediatamente, SB corre em paralelo no worker.
  //    O scheme vem de getSelectedSchemeId(clientId) — o frontend não envia vehicle_setting_id.
  //    Payload completo (...jobPayload) preserva comment/technician; _terminal encerra o SB
  //    sem coletar CAN (caminho "não testar" não gera snapshot).
  const schemeId = getSelectedSchemeId(clientId) ?? vehicleSettingId ?? "";
  const sbQueued = !!(vehicleId && clientId && schemeId);
  if (sbQueued) {
    const sbJob = createJob("scheme_builder", {
      ...jobPayload,
      vehicle_id         : vehicleId,
      vehicle_setting_id : schemeId,
      client_id          : clientId,
      client_name        : clientName,
      comment,
      _terminal          : true,
      origin             : `maint_no_swap_skip:${jobId}`,
      _from              : jobId,
    });
    console.log(`[installations] SB enfileirado job=${sbJob.id} vehicle_id=${vehicleId} (paralelo)`);
  } else {
    console.log(
      `[installations] complete-maint job=${jobId} — SB não enfileirado ` +
      `(faltam: vehicle_id=${vehicleId || "?"} client_id=${clientId || "?"} scheme_id=${schemeId || "?"})`
    );
  }

  res.json({ ok: true, job_id: jobId, status: "completed", sb_queued: sbQueued });
});

// ---------------------------------------------------------------------------
// POST /api/installations/:id/start-can  — técnico escolheu "Testar CAN" no MAINT_NO_SWAP
// ---------------------------------------------------------------------------

router.post("/:id/start-can", (req: Request, res: Response) => {
  const { randomUUID } = require("crypto");
  const rootId  = String(req.params.id);
  const root    = getJob(rootId);

  if (!root) {
    res.status(404).json({ ok: false, error: "job_not_found" });
    return;
  }
  if (!isMaintNoSwap(root.type)) {
    res.status(400).json({ ok: false, error: "job_type_invalido", detail: `Tipo inválido: "${root.type}"` });
    return;
  }
  if (root.status !== "completed") {
    res.status(409).json({ ok: false, error: "job_nao_concluido", detail: `Job ${rootId} está em status "${root.status}" — aguardar resolução do vehicle_id` });
    return;
  }

  const vehicleId = String(
    (root.result as any)?.vehicle_id ??
    root.payload?.vehicle_id ??
    root.payload?.vehicleId ??
    ""
  ).trim();

  if (!vehicleId) {
    res.status(422).json({ ok: false, error: "vehicle_id_ausente", detail: "Worker ainda não resolveu o vehicle_id" });
    return;
  }

  const canJob = createJob("monitor_can_snapshot", {
    ...root.payload,
    ...(root.result ?? {}),
    vehicle_id:         vehicleId,
    _from:              rootId,
    installation_token: randomUUID(),
  });

  console.log(`[installations] start-can root=${rootId} → can=${canJob.id} vehicle_id=${vehicleId}`);
  res.json({ ok: true, job_id: rootId, can_job_id: canJob.id });
});

// ---------------------------------------------------------------------------
// POST /api/installations/:id/retry-html5  — reprocessa job HTML5 com erro
// ---------------------------------------------------------------------------

const HTML5_JOB_TYPES = ["html5_install", "html5_uninstall", "html5_maint_with_swap", "html5_maint_no_swap"];

router.post("/:id/retry-html5", (req: Request, res: Response) => {
  const jobId = String(req.params.id);
  const job   = getJob(jobId);

  if (!job) {
    res.status(404).json({ ok: false, error: "job_not_found" });
    return;
  }

  if (!HTML5_JOB_TYPES.includes(job.type)) {
    res.status(400).json({
      ok    : false,
      error : "job_type_invalido",
      detail: `Apenas jobs HTML5 podem ser reprocessados. Tipo atual: "${job.type}"`,
    });
    return;
  }

  if (job.status !== "error" && job.status !== "processing") {
    res.status(409).json({
      ok    : false,
      error : "status_invalido",
      detail: `Job ${jobId} está em "${job.status}" — só é possível reprocessar jobs com erro ou em processamento`,
    });
    return;
  }

  const anterior = job.status;
  updateJob(jobId, { status: "pending" as any, result: null } as any);

  console.log(`[installations] retry-html5 job=${jobId} type=${job.type} anterior=${anterior}`);

  res.json({ ok: true, job_id: jobId, status: "pending" });
});

export default router;
