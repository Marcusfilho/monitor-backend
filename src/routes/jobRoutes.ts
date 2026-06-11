import { Router, Request, Response } from "express";
import { getSelectedSchemeId } from "../services/schemeSelectionService";
import {
  createJob,
  getNextJob,
  completeJob,
  updateJob,
  getJob,
  listJobs,
  BaseJob,
} from "../jobs/jobStore";
import { getGsCommand } from "../core/gsCommandMap";
import { randomUUID } from "crypto";

const router = Router();

// ─── Pipeline do rewrite ──────────────────────────────────────────────────────
//
//  html5_install        → ok  → scheme_builder
//  html5_uninstall      → ok  → save_snapshot
//  html5_maint_no_swap  → ok  → monitor_can_snapshot   (monitor_skip=1 no payload)
//  html5_maint_with_swap→ ok  → scheme_builder
//  scheme_builder       → ok  → monitor_can_snapshot   (se GS_ONLY=1 → save_snapshot)
//  monitor_can_snapshot → ok  → scheme_builder(GS)     (install/maint_with_swap)
//                             → save_snapshot           (uninstall/maint_no_swap)
//  scheme_builder(GS)   → ok  → save_snapshot
//  save_snapshot        → ok  → fim
//
// ─────────────────────────────────────────────────────────────────────────────


// CHANGE_COMPANY centralizada no installWorker — removida daqui para evitar duplicação.
function dispatchPipeline(job: BaseJob, result: any, finalStatus: string): void {
  if (finalStatus !== "completed") return;

  const plate: string = job.payload?.plate ?? job.payload?.installation_id ?? "";

  switch (job.type) {
    case "html5_install": {
      const schemeId = getSelectedSchemeId(job.payload?.client_id) ?? result.vehicle_setting_id ?? "";
      // SKIP_SB_V1: se installWorker detectou que SB pode ser pulado, vai direto para CAN
      if (result.skip_sb === true) {
        console.log(`[pipeline] html5_install skip_sb=true → monitor_can_snapshot direto plate=${plate}`);
        createJob("monitor_can_snapshot", {
          ...job.payload, ...result, plate, _from: job.id,
          installation_token: randomUUID(),
        });
      } else {
        createJob("scheme_builder", { ...job.payload, ...result, vehicle_setting_id: schemeId, plate, _from: job.id });
      }
      break;
    }

    case "html5_uninstall":
      createJob("save_snapshot", { ...job.payload, ...result, plate, _from: job.id });
      break;

    case "html5_maint_no_swap":
      // monitor_skip=1 já está no payload (definido pelo worker)
      createJob("monitor_can_snapshot", {
        ...job.payload, ...result, plate, _from: job.id,
        installation_token: randomUUID(),
      });
      break;

    case "html5_maint_with_swap": {
      const schemeId = getSelectedSchemeId(job.payload?.client_id) ?? result.vehicle_setting_id ?? "";
      // SKIP_SB_V1: mesma regra do install
      if (result.skip_sb === true) {
        console.log(`[pipeline] html5_maint_with_swap skip_sb=true → monitor_can_snapshot direto plate=${plate}`);
        createJob("monitor_can_snapshot", {
          ...job.payload, ...result, plate, _from: job.id,
          installation_token: randomUUID(),
        });
      } else {
        createJob("scheme_builder", { ...job.payload, ...result, vehicle_setting_id: schemeId, plate, _from: job.id });
      }
      break;
    }

    case "scheme_builder":
      createJob("monitor_can_snapshot", {
        ...job.payload, ...result, plate, _from: job.id,
        installation_token: randomUUID(),
      });
      break;

    // GS_PIPELINE_V1: CAN decide se enfileira gs_calibration ou save_snapshot
    case "monitor_can_snapshot": {
      const service = String(job.payload?.service ?? job.payload?.flow ?? "").toUpperCase();
      const needsGs = ["INSTALL", "MAINT_WITH_SWAP"].includes(service);

      // INSTALL e MAINT_WITH_SWAP aguardam aprovação manual do técnico (approve-can)
      if (needsGs) {
        updateJob(job.id, { status: "waiting_approval" as any });
        console.log(`[pipeline] monitor_can_snapshot → waiting_approval plate=${plate}`);
        break;
      }

      // Serviços sem GS (UNINSTALL, MAINT_NO_SWAP) → save_snapshot direto
      createJob("save_snapshot", { ...job.payload, ...result, plate, _from: job.id });
      break;
    }

    // GS_PIPELINE_V1: GS concluído → save_snapshot
    case "gs_calibration":
      createJob("save_snapshot", { ...job.payload, ...result, plate, _from: job.id });
      console.log(`[pipeline] gs_calibration concluído → save_snapshot plate=${plate}`);
      break;

    case "save_snapshot":
      // fim da cadeia
      break;

    default:
      // job type desconhecido — não encadeia nada
      break;
  }
}

// ─── POST /api/jobs  — enfileirar job ─────────────────────────────────────────
router.post("/", (req: Request, res: Response) => {
  try {
    const { type, payload } = req.body ?? {};
    if (!type || typeof type !== "string") {
      res.status(400).json({ error: "missing_type" });
      return;
    }
    const job = createJob(type.trim(), payload ?? {});
    res.status(201).json({ ok: true, job });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "internal_error" });
  }
});

// ─── POST /api/jobs/next  — dequeue (workers usam POST) ──────────────────────
router.post("/next", (req: Request, res: Response) => {
  try {
    const { job_type, worker_key } = req.body ?? {};
    if (!job_type || typeof job_type !== "string") {
      res.status(400).json({ error: "missing_job_type" });
      return;
    }
    const workerId = String(worker_key || job_type);
    const job = getNextJob(job_type.trim(), workerId);
    if (!job) {
      res.status(204).end();
      return;
    }
    res.json({ ok: true, job });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "internal_error" });
  }
});

// ─── GET /api/jobs/next  — alias GET (alguns workers usam) ───────────────────
router.get("/next", (req: Request, res: Response) => {
  try {
    const job_type = (req.query.job_type || req.query.type) as string | undefined;
    const worker_key = (req.query.worker_key || req.query.worker || req.headers["x-worker-key"]) as string | undefined;
    if (!job_type) {
      res.status(400).json({ error: "missing_job_type" });
      return;
    }
    const workerId = String(worker_key || job_type);
    const job = getNextJob(job_type.trim(), workerId);
    if (!job) {
      res.status(204).end();
      return;
    }
    res.json({ ok: true, job });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "internal_error" });
  }
});

// ─── POST /api/jobs/:id/complete  — completar + disparar pipeline ─────────────
router.post("/:id/complete", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { status, result, worker_key } = req.body ?? {};

    const finalStatus: string =
      status === "error" || status === "cancelled" ? status : "completed";

    const job = completeJob(id, finalStatus as any, result ?? {}, worker_key ? String(worker_key) : undefined);
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }

    dispatchPipeline(job, result, finalStatus);

    res.json({ ok: true, job });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "internal_error" });
  }
});

// ─── POST /api/jobs/:id/retry  — reseta job error/processing → pending ────────
router.post("/:id/retry", (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = getJob(id);
    if (!existing) { res.status(404).json({ ok: false, error: "job_not_found" }); return; }
    if (existing.status !== "error" && existing.status !== "processing") {
      res.status(400).json({ ok: false, error: `job status="${existing.status}" não pode ser retentado` });
      return;
    }
    const job = updateJob(id, { status: "pending" as any, result: null } as any);
    console.log(`[jobs] retry job=${id} type=${existing.type} status=error→pending`);
    res.json({ ok: true, job_id: id, type: existing.type, status: "pending" });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "internal_error" });
  }
});

// ─── POST /api/jobs/:id/progress  — atualizar progresso ──────────────────────
router.post("/:id/progress", (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { progress, message, partial } = req.body ?? {};

    const existing = getJob(id);
    const job = updateJob(id, {
      result: { ...(existing?.result ?? {}), progress, message, ...(partial != null ? { partial } : {}) },
    });
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    res.json({ ok: true, job });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "internal_error" });
  }
});

// ─── GET /api/jobs  — listar (debug) ──────────────────────────────────────────
router.get("/", (_req: Request, res: Response) => {
  try {
    const jobs = listJobs();
    res.json({ ok: true, count: jobs.length, jobs });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "internal_error" });
  }
});

// ─── GET /api/jobs/:id  — buscar por id (debug) ───────────────────────────────
router.get("/:id", (req: Request, res: Response) => {
  try {
    const job = getJob(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    res.json({ ok: true, job });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "internal_error" });
  }
});

// ─── POST /api/jobs/worker/heartbeat ─────────────────────────────────────────
router.post("/worker/heartbeat", (req: Request, res: Response) => {
  const key = req.headers["x-worker-key"] || "";
  const expectedKey = process.env.WORKER_KEY || "";
  if (expectedKey && key !== expectedKey) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { worker_id, ts, status, checks } = req.body || {};
  // log apenas se houver problema
  if (checks && Object.values(checks).some((v) => v === false)) {
    console.warn(`[hb] worker=${worker_id} ts=${ts} checks=${JSON.stringify(checks)}`);
  }
  res.json({ ok: true, ts: new Date().toISOString() });
});

export default router;
