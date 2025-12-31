import express, { Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";

const router = express.Router();

function requireWorkerKey(req: Request, res: Response, next: NextFunction) {
  const expected = (process.env.WORKER_KEY || "").trim();
  if (!expected) return res.status(500).json({ ok: false, error: "WORKER_KEY_not_set" });

  const got = (
    req.header("x-worker-key") ||
    req.header("X-Worker-Key") ||
    ""
  ).trim();

  if (!got || got !== expected) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

// No Render você usa SESSION_TOKEN_PATH=/tmp/.session_token
const TOKEN_PATH =
  process.env.SESSION_TOKEN_PATH || path.join(process.cwd(), ".session_token");

router.get("/session-token", requireWorkerKey, (_req: Request, res: Response) => {
  let token = "";
  try {
    token = fs.readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {}

  res.json({
    ok: true,
    hasToken: !!token,
    tokenLen: token.length,
    token,              // necessário pra VM salvar localmente
    path: TOKEN_PATH
  });
});

export default router;
