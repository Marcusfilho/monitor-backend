import { Router, Request, Response, NextFunction } from "express";
import { getSessionTokenStatus, setSessionToken } from "../services/sessionTokenStore";

const router = Router();

function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const expected = (process.env.SESSION_TOKEN_ADMIN_KEY || "").trim();
  const got =
    (req.header("x-admin-key") || req.header("X-Admin-Key") || "").trim();

  if (!expected) {
    return res.status(500).json({ error: "SESSION_TOKEN_ADMIN_KEY not set" });
  }
  if (!got || got !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return next();
}

router.get("/session-token/status", requireAdminKey, (req: Request, res: Response) => {
  return res.json(getSessionTokenStatus());
});

router.post("/session-token", requireAdminKey, (req: Request, res: Response) => {
  const token =
    (req.body && (req.body.sessionToken || req.body.token)) ? String(req.body.sessionToken || req.body.token) : "";

  if (!token.trim()) {
    return res.status(400).json({ error: "missing token (body.token or body.sessionToken)" });
  }

  setSessionToken(token);
  return res.json({ ok: true, ...getSessionTokenStatus() });
});

export default router;
