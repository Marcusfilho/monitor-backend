"use strict";
// src/routes/html5CookieRoutes.ts
// POST /api/session/html5-cookie
// Recebe o cookie HTML5 do worker (VM) e salva no filesystem do Render.
// Isso permite que o /api/clients (que roda no Render) use a sessão autenticada.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const fs = __importStar(require("fs"));
const router = (0, express_1.Router)();
const COOKIEJAR_PATH = (process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json").trim();
const SYNC_SECRET = (process.env.COOKIE_SYNC_SECRET || "").trim();
// ---------------------------------------------------------------------------
// Render cookie persistence
// ---------------------------------------------------------------------------
const RENDER_API_KEY = (process.env.RENDER_API_KEY || "").trim();
const RENDER_SERVICE_ID = (process.env.RENDER_SERVICE_ID || "").trim();
function persistCookieToRender(cookieJson) {
    setImmediate(async () => {
        if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
            console.log("[cookie-persist] keys ausentes — skip");
            return;
        }
        try {
            const https = require("https");
            const value = cookieJson.length > 4000 ? cookieJson.slice(0, 4000) : cookieJson;
            const current = await new Promise((resolve) => {
                const r = https.request({ hostname: "api.render.com", path: `/v1/services/${RENDER_SERVICE_ID}/env-vars`, method: "GET", headers: { "authorization": `Bearer ${RENDER_API_KEY}`, "accept": "application/json" } }, (res) => {
                    let d = "";
                    res.on("data", (c) => d += c);
                    res.on("end", () => { try {
                        resolve(JSON.parse(d).map((e) => ({ key: e.envVar.key, value: e.envVar.value })));
                    }
                    catch {
                        resolve([]);
                    } });
                });
                r.on("error", () => resolve([]));
                r.end();
            });
            const merged = [...current.filter(e => e.key !== "HTML5_COOKIE_PERSIST"), { key: "HTML5_COOKIE_PERSIST", value }];
            const body = Buffer.from(JSON.stringify(merged));
            await new Promise((resolve) => {
                const req = https.request({ hostname: "api.render.com", path: `/v1/services/${RENDER_SERVICE_ID}/env-vars`, method: "PUT", headers: { "authorization": `Bearer ${RENDER_API_KEY}`, "content-type": "application/json", "content-length": body.length, "accept": "application/json" } }, (res) => {
                    let d = "";
                    res.on("data", (c) => d += c);
                    res.on("end", () => { console.log(`[cookie-persist] status=${res.statusCode} vars=${merged.length}`); resolve(); });
                });
                req.on("error", (e) => { console.log("[cookie-persist] erro:", e?.message); resolve(); });
                req.write(body);
                req.end();
            });
        }
        catch (e) {
            console.log("[cookie-persist] exception:", e?.message);
        }
    });
}
function restoreCookieFromEnvOnBoot() {
    try {
        if (fs.existsSync(COOKIEJAR_PATH))
            return;
        const persisted = (process.env.HTML5_COOKIE_PERSIST || "").trim();
        if (!persisted) {
            console.log("[cookie-boot] sem HTML5_COOKIE_PERSIST — skip");
            return;
        }
        JSON.parse(persisted); // valida JSON
        fs.writeFileSync(COOKIEJAR_PATH, persisted, { encoding: "utf8", mode: 0o600 });
        console.log("[cookie-boot] ✅ Cookie restaurado de HTML5_COOKIE_PERSIST");
    }
    catch (e) {
        console.log("[cookie-boot] falha:", e?.message);
    }
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
            cookie: body.cookie,
            keys: body.keys || [],
            updatedAt: body.updatedAt || new Date().toISOString(),
            meta: body.meta || {},
            syncedAt: new Date().toISOString(),
            source: "worker-push",
        };
        fs.writeFileSync(COOKIEJAR_PATH, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
        persistCookieToRender(JSON.stringify(payload, null, 2)); // persiste na env var do Render
        console.log(`[html5-cookie] Cookie sincronizado do worker — keys: ${payload.keys.join(", ") || "(nenhuma)"}`);
        return res.json({ status: "ok", syncedAt: payload.syncedAt });
    }
    catch (err) {
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
            status: "ok",
            syncedAt: raw.syncedAt || null,
            updatedAt: raw.updatedAt || null,
            source: raw.source || "unknown",
            keys: raw.keys || [],
        });
    }
    catch {
        return res.json({ status: "error", syncedAt: null });
    }
});
exports.default = router;
