import type { Request, Response, NextFunction } from "express";

export function requireWorkerKey(req: Request, res: Response, next: NextFunction) {
  const want = (process.env.WORKER_KEY || "").trim();
  if (!want) return res.status(500).json({ ok: false, error: "WORKER_KEY_NOT_SET" });

  const got = String(req.header("x-worker-key") || "").trim();
  if (!got || got !== want) return res.status(401).json({ ok: false, error: "WORKER_KEY_INVALID" });

  next();
}
