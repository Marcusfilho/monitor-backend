import express from "express";
import fs from "fs";
import path from "path";

const router = express.Router();

// Onde salvar (Render pode ser efêmero; ok — você repush quando reiniciar)
const TOKEN_PATH = process.env.SESSION_TOKEN_PATH || path.join(process.cwd(), ".session_token");
const ADMIN_KEY = process.env.SESSION_TOKEN_ADMIN_KEY || "";

let cachedToken = "";
let updatedAtMs = 0;

function now() { return Date.now(); }

function readTokenFromDisk(): string {
  try {
    const t = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    return t || "";
  } catch {
    return "";
  }
}

function writeTokenToDisk(tok: string) {
  // 0600 quando possível (Linux). No Render pode variar, mas não atrapalha.
  try {
    fs.writeFileSync(TOKEN_PATH, tok.trim() + "\n", { mode: 0o600 });
  } catch {
    fs.writeFileSync(TOKEN_PATH, tok.trim() + "\n");
  }
}

function isValidToken(tok: string): boolean {
  const t = (tok || "").trim();
  // token real tem 42 no seu caso, mas vamos aceitar uma faixa segura
  if (t.length < 20 || t.length > 200) return false;
  if (/\s/.test(t)) return false;
  return true;
}

function getKey(req: express.Request): string {
  const q = typeof req.query.key === "string" ? req.query.key : "";
  const h = typeof req.headers["x-admin-key"] === "string" ? req.headers["x-admin-key"] : "";
  return q || h || "";
}

function requireKey(req: express.Request, res: express.Response): boolean {
  if (!ADMIN_KEY) {
    res.status(500).json({ ok: false, error: "SESSION_TOKEN_ADMIN_KEY_not_set" });
    return false;
  }
  const k = getKey(req);
  if (!k || k !== ADMIN_KEY) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// cache init
cachedToken = readTokenFromDisk();
updatedAtMs = cachedToken ? now() : 0;

// CORS básico (para o POST do browser) — e sem cache
router.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  next();
});

// STATUS (não retorna token)
router.get("/session-token/status", (req, res) => {
  if (!requireKey(req, res)) return;

  const disk = readTokenFromDisk();
  const tok = cachedToken || disk;
  const ageSec = updatedAtMs ? Math.floor((now() - updatedAtMs) / 1000) : null;

  res.json({
    ok: true,
    hasToken: !!tok,
    tokenLen: tok ? tok.length : 0,
    updatedAtMs: updatedAtMs || null,
    ageSec,
    tokenPath: TOKEN_PATH,
  });
});

// GET token (pro worker)
router.get("/session-token", (req, res) => {
  if (!requireKey(req, res)) return;

  const disk = readTokenFromDisk();
  const tok = cachedToken || disk;
  if (!tok) return res.status(404).send("");

  res.type("text/plain").send(tok);
});

// POST token (do browser) — body text/plain
router.post(
  "/session-token",
  express.text({ type: "*/*", limit: "8kb" }),
  (req, res) => {
    if (!requireKey(req, res)) return;

    const body = typeof req.body === "string" ? req.body : "";
    const tok = (body || "").trim();

    if (!isValidToken(tok)) {
      return res.status(400).json({ ok: false, error: "invalid_token", tokenLen: tok.length });
    }

    cachedToken = tok;
    updatedAtMs = now();
    writeTokenToDisk(tok);

    // não loga token aqui (só confirma)
    res.json({ ok: true, tokenLen: tok.length, updatedAtMs });
  }
);

export default router;
