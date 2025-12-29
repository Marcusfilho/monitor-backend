// src/routes/jobRoutes.ts
import { Router, Request, Response } from "express";
import { createJob, getNextJob, completeJob, getJob, listJobs } from "../jobs/jobStore";
import { getSessionToken } from "../services/sessionTokenStore";

const router = Router();

/** POST /api/jobs */
router.post("/", (req: Request, res: Response) => {
  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: "Field 'type' is required" });
  const job = createJob(type, payload);
  return res.status(201).json({ job });
});

/** GET /api/jobs/next?type=scheme_builder&worker=vm-worker-01 */
router.get("/next", (req: Request, res: Response) => {
  const type = (req.query.type as string) || "";
  const workerId = (req.query.worker as string) || "unknown-worker";
  if (!type) return res.status(400).json({ error: "Query param 'type' is required" });

  // ✅ só libera job se houver token carregado
  const token = (getSessionToken() || "").trim();
  if (!token) return res.status(503).json({ error: "missing session token (set via /api/admin/session-token)" });

  const job = getNextJob(type, workerId);
  if (!job) return res.status(204).send();

  // ✅ injeta token apenas na resposta
  const out: any = JSON.parse(JSON.stringify(job));
  out.payload = out.payload || {};
  out.payload.sessionToken = token;

  return res.json({ job: out });
});

/** POST /api/jobs/:id/complete */
router.post("/:id/complete", (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, result, workerId } = req.body || {};
  if (!status) return res.status(400).json({ error: "Field 'status' is required" });

  const finalStatus = status === "ok" ? "completed" : "error";
  const job = completeJob(id, finalStatus, result, workerId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  return res.json({ job });
});

router.get("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const job = getJob(id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json({ job });
});

router.get("/", (_req: Request, res: Response) => res.json({ jobs: listJobs() }));

export default router;
