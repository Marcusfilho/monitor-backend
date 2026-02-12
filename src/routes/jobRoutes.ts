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

  // ✅ HTML5 jobs não dependem de session token (são server-to-server via HTML5 cookie-jar)
  const isHtml5 = String(type).toLowerCase().startsWith("html5_");

  if (!isHtml5) {
    // ✅ mantém comportamento atual: só libera job se houver token carregado
    const token = (getSessionToken() || "").trim();
    if (!token) return res.status(503).json({ error: "missing session token (set via /api/admin/session-token)" });

    const job = getNextJob(type, workerId);
    if (!job) return res.status(204).send();

    // ✅ injeta token apenas na resposta
    const out: any = JSON.parse(JSON.stringify(job));
    out.payload = out.payload || {};
    out.payload.sessionToken = token;

    return res.json({ job: out });
  }

  // ✅ HTML5: não injeta token
  const job = getNextJob(type, workerId);
  if (!job) return res.status(204).send();
  return res.json({ job });
});


/** POST /api/jobs/:id/complete */
// POST /api/jobs/:id/progress  body: { percent: 0..100, stage?: string, detail?: string }
// POST /api/jobs/:id/progress  body: { percent: 0..100, stage?: string, detail?: string }
router.post("/:id/progress", (req, res) => {
  const jobId = String((req as any).params?.id || "");
  const id = jobId; // compat: alguns lookups usam "id"
  const body = (req as any).body || {};

  const p = Number(body.percent);
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    return res.status(400).json({ error: "percent must be 0..100" });
  }

  const job = getJob(id);
  if (!job) return res.status(404).json({ error: "job not found" });

  (job as any).progressPercent = Math.round(p);
  (job as any).progressStage = (typeof body.stage === "string") ? body.stage : null;
  (job as any).progressDetail = (typeof body.detail === "string") ? body.detail : null;
  (job as any).lastProgressAt = new Date().toISOString();

  return res.json({ ok: true });
});
router.post("/:id/complete", (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, result, workerId } = req.body || {};
  if (!status) return res.status(400).json({ error: "Field 'status' is required" });

  const rawStatus = String(status || "").toLowerCase();

// worker pode mandar status=success; também aceitamos done/completed/complete.
// além disso, se result.ok === true, consideramos completed.
const okFlag =
  rawStatus === "ok" ||
  rawStatus === "success" ||
  rawStatus === "done" ||
  rawStatus === "completed" ||
  rawStatus === "complete" ||
  ((req.body as any)?.ok === true) ||
  ((result as any)?.ok === true);

const finalStatus = okFlag ? "completed" : "error";
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
