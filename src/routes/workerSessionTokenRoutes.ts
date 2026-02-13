import { Router } from "express";

import { getSessionTokenStatus, setSessionToken } from "../services/sessionTokenStore"

function requireWorkerKey(req: any, res: any, next: any) {
  const got = String(req.header("x-worker-key") || "");
  const want = String(process.env.WORKER_KEY || "");
  if (!want || got !== want) return res.status(401).json({ error: "WORKER_KEY_INVALID" });
  next();
}

const router = Router();

router.post("/session-token", requireWorkerKey, (req, res) => {
  const session_token = String((req.body && (req.body.session_token ?? req.body.sessionToken)) || "").trim();
  if (!session_token) return res.status(400).json({ error: "missing session_token" });

  setSessionToken(session_token)
  return res.json({ ok: true });
});


// --- heartbeat (worker health) ---
router.get("/heartbeat", requireWorkerKey, (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

export default router;
