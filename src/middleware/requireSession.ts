import { Request, Response, NextFunction } from "express";
import { sessionMap } from "../routes/authRoutes";

/**
 * Middleware: valida sessão do técnico.
 * Aceita o token em duas formas (ordem de prioridade):
 *   1. Header:      X-Session-Token: <token>
 *   2. Query param: ?token=<token>   (compatibilidade com /api/auth/session)
 *
 * Em caso de falha retorna 401 — o frontend redireciona para /index.html.
 */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const token =
    String(req.headers["x-session-token"] || "").trim() ||
    String(req.query.token            || "").trim();

  if (!token) {
    res.status(401).json({ ok: false, reason: "missing_token" });
    return;
  }

  const session = sessionMap.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessionMap.delete(token);
    res.status(401).json({ ok: false, reason: "expired_or_invalid" });
    return;
  }

  // Injeta dados da sessão no request para uso downstream se necessário
  (req as any).session = session;
  next();
}
