// src/routes/html5CookieRoutes.ts
// POST /api/session/html5-cookie
// Recebe o cookie HTML5 do worker (VM) e salva no filesystem do Render.
// Isso permite que o /api/clients (que roda no Render) use a sessão autenticada.

import { Router } from "express";
import * as fs from "fs";

const router = Router();

const COOKIEJAR_PATH = (
  process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json"
).trim();

const SYNC_SECRET = (process.env.COOKIE_SYNC_SECRET || "").trim();

// ---------------------------------------------------------------------------
// Render cookie persistence
// ---------------------------------------------------------------------------
const RENDER_API_KEY    = (process.env.RENDER_API_KEY    || "").trim();
const RENDER_SERVICE_ID = (process.env.RENDER_SERVICE_ID || "").trim();

function persistCookieToRender(cookieJson: string): void {
  setImmediate(async () => {
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
    try {
      const https = require("https");
      const value = cookieJson.length > 4000 ? cookieJson.slice(0, 4000) : cookieJson;
      const body  = Buffer.from(JSON.stringify([{ key: "HTML5_COOKIE_PERSIST", value }]));
      await new Promise<void>((resolve) => {
        const req = https.request({
          hostname: "api.render.com",
          path:     `/v1/services/${RENDER_SERVICE_ID}/env-vars`,
          method:   "PUT",
          headers:  { "authorization": `Bearer ${RENDER_API_KEY}`, "content-type": "application/json", "content-length": body.length, "accept": "application/json" },
        }, (res: any) => {
          let d = ""; res.on("data", (c: any) => d += c);
          res.on("end", () => { console.log(`[cookie-persist] Render API status=${res.statusCode}`); resolve(); });
        });
        req.on("error", (e: any) => { console.log("[cookie-persist] erro:", e?.message); resolve(); });
        req.write(body); req.end();
      });
    } catch (e: any) { console.log("[cookie-persist] exception:", e?.message); }
  });
}

function restoreCookieFromEnvOnBoot(): void {
  try {
    if (fs.existsSync(COOKIEJAR_PATH)) return;
    const persisted = (process.env.HTML5_COOKIE_PERSIST || "").trim();
    if (!persisted) { console.log("[cookie-boot] sem HTML5_COOKIE_PERSIST — skip"); return; }
    JSON.parse(persisted); // valida JSON
    fs.writeFileSync(COOKIEJAR_PATH, persisted, { encoding: "utf8", mode: 0o600 });
    console.log("[cookie-boot] ✅ Cookie restaurado de HTML5_COOKIE_PERSIST");
  } catch (e: any) { console.log("[cookie-boot] falha:", e?.message); }
}
restoreCookieFromEnvOnBoot();
// ---------------------------------------------------------------------------

/**
 * POST /api/session/html5-cookie
 */
router.post("/", (req, res) => {
  if (SYNC_SECRET) {
    const provided = (req.headers["x-sync-secret"] || "").toString().trim();
    if (provided !== SYNC_SECRET) {
      return res.status(401).json({ status: "error", message: "unauthorized" });
    }
  }

  const body = req.body;
  if (!body?.cookie || typeof body.cookie !== "string") {
    return res.status(400).json({ status: "error", message: "campo 'cookie' obrigatório" });
  }

  try {
    const payload = {
      cookie:    body.cookie,
      keys:      body.keys      || [],
      updatedAt: body.updatedAt || new Date().toISOString(),
      meta:      body.meta      || {},
      syncedAt:  new Date().toISOString(),
      source:    "worker-push",
    };

    fs.writeFileSync(COOKIEJAR_PATH, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    persistCookieToRender(JSON.stringify(payload, null, 2)); // persiste na env var do Render

    console.log(`[html5-cookie] Cookie sincronizado do worker — keys: ${payload.keys.join(", ") || "(nenhuma)"}`);
    return res.json({ status: "ok", syncedAt: payload.syncedAt });

  } catch (err: any) {
    console.error("[html5-cookie] Falha ao salvar cookie:", err?.message);
    return res.status(500).json({ status: "error", message: err?.message });
  }
});

/**
 * GET /api/session/html5-cookie/status
 */
router.get("/status", (_req, res) => {
  try {
    if (!fs.existsSync(COOKIEJAR_PATH)) {
      return res.json({ status: "missing", syncedAt: null });
    }
    const raw = JSON.parse(fs.readFileSync(COOKIEJAR_PATH, "utf8"));
    return res.json({
      status:    "ok",
      syncedAt:  raw.syncedAt  || null,
      updatedAt: raw.updatedAt || null,
      source:    raw.source    || "unknown",
      keys:      raw.keys      || [],
    });
  } catch {
    return res.json({ status: "error", syncedAt: null });
  }
});

export default router;
