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
// Token simples para proteger o endpoint de escrita
// Defina COOKIE_SYNC_SECRET nas env vars do Render e do worker_secrets.env
const SYNC_SECRET = (process.env.COOKIE_SYNC_SECRET || "").trim();
/**
 * POST /api/session/html5-cookie
 * Body: { cookie: string, keys?: string[], updatedAt?: string, meta?: object }
 * Header: x-sync-secret: <COOKIE_SYNC_SECRET>
 */
router.post("/", (req, res) => {
    // Validação do secret
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
 * Retorna quando o cookie foi sincronizado pela última vez (sem expor o valor).
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
