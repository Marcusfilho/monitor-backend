// src/routes/jobRoutes.ts
import { Router, Request, Response } from "express";
import {
  createJob,
  getNextJob,
  completeJob,
  getJob,
  listJobs,
} from "../jobs/jobStore";

const router = Router();

/**
 * POST /api/jobs
 * Cria um job novo
 */
router.post("/", (req: Request, res: Response) => {
  const { type, payload } = req.body || {};

  if (!type) {
    return res.status(400).json({ error: "Field 'type' is required" });
  }

  const job = createJob(type, payload);
  return res.status(201).json({ job });
});

/**
 * GET /api/jobs/next?type=scheme_builder&worker=vm-worker-01
 * Usado pelo worker na VM
 */
router.get("/next", (req: Request, res: Response) => {
  const type = (req.query.type as string) || "";
  const workerId = (req.query.worker as string) || "unknown-worker";

  if (!type) {
    return res
      .status(400)
      .json({ error: "Query param 'type' is required" });
  }

  const job = getNextJob(type, workerId);

  if (!job) {
    return res.status(204).send();
  }

  return res.json({ job });
});

/**
 * POST /api/jobs/:id/complete
 * Worker marca job como concluído
 */
router.post("/:id/complete", (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, result, workerId } = req.body || {};

  if (!status) {
    return res
      .status(400)
      .json({ error: "Field 'status' is required" });
  }

  const finalStatus = status === "ok" ? "completed" : "error";

  const job = completeJob(id, finalStatus, result, workerId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  return res.json({ job });
});

/**
 * GET /api/jobs/:id
 * Consultar status de um job
 */
router.get("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const job = getJob(id);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  return res.json({ job });
});

/**
 * GET /api/jobs
 * Lista jobs (debug)
 */
router.get("/", (_req: Request, res: Response) => {
  return res.json({ jobs: listJobs() });
});

export default router;
