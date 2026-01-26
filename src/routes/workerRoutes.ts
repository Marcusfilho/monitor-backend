import { Router } from "express";
import { requireWorkerKey } from "../middleware/requireWorkerKey";
import { upsertHeartbeat, getAllHeartbeats } from "../services/workerHeartbeatStore";

export const workerRoutes = Router();

workerRoutes.post("/heartbeat", requireWorkerKey, (req, res) => {
  const body = req.body || {};
  const worker_id = String(body.worker_id || "").trim();
  if (!worker_id) return res.status(400).json({ ok: false, error: "MISSING_worker_id" });

  const hb = {
    worker_id,
    ts: new Date().toISOString(),
    status: body.status,
    job: body.job,
    checks: body.checks,
    last_error: body.last_error,
    meta: body.meta,
  };

  upsertHeartbeat(hb);
  return res.json({ ok: true });
});

workerRoutes.get("/status", (_req, res) => {
  return res.json({
    ok: true,
    now: new Date().toISOString(),
    workers: getAllHeartbeats(),
  });
});
