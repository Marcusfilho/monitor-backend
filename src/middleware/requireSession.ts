import { Request, Response, NextFunction } from "express";
import { getSession, deleteSession } from "../services/sessionStore";

/**
 * Middleware: valida sessão do técnico via SQLite.
 * Aceita o token em duas formas (ordem de prioridade):
 *   1. Header:      X-Session-Token: <token>
 *   2. Query param: ?token=<token>
 */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const token =
    String(req.headers["x-session-token"] || "").trim() ||
    String(req.query.token               || "").trim();

  if (!token) {
    res.status(401).json({ ok: false, reason: "missing_token" });
    return;
  }

  const session = getSession(token);
  if (!session || session.expiresAt < Date.now()) {
    deleteSession(token);
    res.status(401).json({ ok: false, reason: "expired_or_invalid" });
    return;
  }

  (req as any).session = session;
  next();
}
