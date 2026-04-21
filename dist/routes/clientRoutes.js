"use strict";
// src/routes/clientRoutes.ts
// GET /api/clients — retorna lista de clientes disponíveis na sessão HTML5,
// enriquecida com vehicle_setting_id e profiles.
//
// MODOS:
//   Com header X-Session-Token válido → lista filtrada do usuário (não cacheada globalmente)
//   Sem header → comportamento admin atual (lista completa, cache de 5 min)
//
// FONTES DE DADOS:
//   config/scheme_ids.txt                  → fonte de verdade para o vehicle_setting_id DEFAULT
//   config/catalog_vehicle_settings.json   → define profiles alternativos (multi-profile)
//
// REGRA DE MERGE:
//   1. Para cada cliente, o default é sempre o que está no scheme_ids.txt
//   2. Se o catalog tiver profiles alternativos para aquele clientId,
//      eles são incluídos como opções extras — mas o default do TXT prevalece
//   3. Clientes no TXT mas não no catalog → entram com 1 profile (o do TXT)
//   4. Clientes no catalog mas não no TXT → sem vehicle_setting_id (has_scheme: false)
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
exports.SCHEME_IDS_PATH = void 0;
exports.reloadSchemeSources = reloadSchemeSources;
const express_1 = require("express");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const html5Client_1 = require("../services/html5Client");
const authRoutes_1 = require("./authRoutes");
const router = (0, express_1.Router)();
// ---------------------------------------------------------------------------
// Caminhos dos arquivos de configuração
// ---------------------------------------------------------------------------
exports.SCHEME_IDS_PATH = path.resolve(process.env.SCHEME_IDS_PATH ||
    path.join(__dirname, "../../config/scheme_ids.txt"));
const CATALOG_PATH = path.resolve(process.env.CATALOG_PATH ||
    path.join(__dirname, "../../config/catalog_vehicle_settings.json"));
// ---------------------------------------------------------------------------
// Carregamento das fontes
// ---------------------------------------------------------------------------
function loadSchemeIds() {
    const map = new Map();
    try {
        const lines = fs.readFileSync(exports.SCHEME_IDS_PATH, "utf8")
            .split("\n")
            .map(l => l.trim())
            .filter(l => l && !l.startsWith("CLIENT_ID"));
        for (const line of lines) {
            const parts = line.split(";");
            if (parts.length < 3)
                continue;
            const clientId = Number(parts[0].trim());
            const clientName = parts[1].trim();
            const vehicleSettingId = Number(parts[2].trim());
            if (!clientId || !vehicleSettingId)
                continue;
            map.set(clientId, { clientId, clientName, vehicleSettingId });
        }
        console.log(`[schemes] ${map.size} clientes carregados de scheme_ids.txt`);
    }
    catch (err) {
        console.error("[schemes] Falha ao carregar scheme_ids.txt:", err?.message);
    }
    return map;
}
function loadCatalogIndex() {
    const map = new Map();
    try {
        const raw = fs.readFileSync(CATALOG_PATH, "utf8");
        const catalog = JSON.parse(raw);
        for (const item of catalog.items) {
            if (!map.has(item.clientId))
                map.set(item.clientId, []);
            map.get(item.clientId).push(item);
        }
        console.log(`[catalog] ${catalog.items.length} profiles carregados (${map.size} clientes)`);
    }
    catch (err) {
        console.error("[catalog] Falha ao carregar catalog_vehicle_settings.json:", err?.message);
    }
    return map;
}
let schemeIds = loadSchemeIds();
let catalogIndex = loadCatalogIndex();
function reloadSchemeSources() {
    schemeIds = loadSchemeIds();
    catalogIndex = loadCatalogIndex();
    clientsCache = null;
    console.log("[schemes] Fontes recarregadas, cache invalidado");
}
// ---------------------------------------------------------------------------
// Merge: scheme_ids.txt + catalog → profiles do cliente
// ---------------------------------------------------------------------------
function buildProfiles(clientId) {
    const schemeEntry = schemeIds.get(clientId);
    const catalogItems = catalogIndex.get(clientId) ?? [];
    if (!schemeEntry && catalogItems.length === 0)
        return [];
    // Está no catalog mas não no TXT → sem default definido
    if (!schemeEntry)
        return [];
    // Só no TXT → 1 profile simples
    if (catalogItems.length === 0) {
        return [{
                key: "default",
                label: schemeEntry.clientName,
                vehicle_setting_id: schemeEntry.vehicleSettingId,
                is_default: true,
            }];
    }
    // Nos dois → profiles do catalog, default = vehicleSettingId do TXT
    const defaultVsId = schemeEntry.vehicleSettingId;
    const profiles = catalogItems.map(item => ({
        key: item.profileKey,
        label: item.settingName,
        vehicle_setting_id: item.vehicleSettingId,
        is_default: item.vehicleSettingId === defaultVsId,
    }));
    // Fallback defensivo: se nenhum bateu, marca o primeiro isDefault do catalog
    if (!profiles.some(p => p.is_default)) {
        const fallback = catalogItems.find(i => i.isDefault) ?? catalogItems[0];
        const p = profiles.find(p => p.vehicle_setting_id === fallback.vehicleSettingId);
        if (p)
            p.is_default = true;
    }
    // Default sempre primeiro
    profiles.sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0));
    return profiles;
}
// ---------------------------------------------------------------------------
// Cache em memória (apenas para modo admin/sem token)
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000;
let clientsCache = null;
function isCacheValid() {
    return clientsCache !== null && Date.now() - clientsCache.fetchedAt < CACHE_TTL_MS;
}
// ---------------------------------------------------------------------------
// Join: resposta Traffilog + fontes locais → EnrichedClient[]
// ---------------------------------------------------------------------------
function enrichClients(rawClients) {
    return rawClients.map(c => {
        const profiles = buildProfiles(c.client_id);
        const defaultProfile = profiles.find(p => p.is_default) ?? profiles[0] ?? null;
        return {
            client_id: c.client_id,
            client_descr: c.client_descr,
            default_group_name: c.default_group_name,
            vehicle_setting_id: defaultProfile?.vehicle_setting_id ?? null,
            profiles,
            has_scheme: profiles.length > 0,
            multi_profile: profiles.length > 1,
        };
    });
}
// ---------------------------------------------------------------------------
// GET /api/clients
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
    // ── MODO TOKEN: header X-Session-Token presente ──────────────────────────
    const rawToken = (req.headers["x-session-token"] || "").toString().trim();
    if (rawToken) {
        const session = authRoutes_1.sessionMap.get(rawToken);
        // Token inválido ou expirado → lista vazia (proteção passiva)
        if (!session || session.expiresAt < Date.now()) {
            authRoutes_1.sessionMap.delete(rawToken);
            console.warn(`[GET /api/clients] token inválido/expirado: ${rawToken.slice(0, 8)}...`);
            return res.json({
                status: "ok",
                cached: false,
                clients: [],
                warning: "invalid_session",
            });
        }
        // Token válido → enriquece a lista filtrada do usuário
        const enriched = enrichClients(session.clients);
        console.log(`[GET /api/clients] token mode — user="${session.username}" ` +
            `${enriched.length} clientes filtrados`);
        return res.json({ status: "ok", cached: false, clients: enriched });
    }
    // ── MODO ADMIN: sem token → comportamento atual (retrocompat) ────────────
    if (isCacheValid()) {
        return res.json({ status: "ok", cached: true, clients: clientsCache.data });
    }
    try {
        const rawClients = await (0, html5Client_1.clientsQuery)();
        if (rawClients.length === 0) {
            console.warn("[GET /api/clients] Lista vazia — sessão HTML5 pode estar expirada");
            return res.json({ status: "ok", cached: false, clients: [], warning: "session_may_be_expired" });
        }
        const enriched = enrichClients(rawClients);
        clientsCache = { data: enriched, fetchedAt: Date.now() };
        const withScheme = enriched.filter(c => c.has_scheme).length;
        const withoutScheme = enriched.filter(c => !c.has_scheme).length;
        const multiProfile = enriched.filter(c => c.multi_profile).length;
        console.log(`[GET /api/clients] ${enriched.length} clientes — ` +
            `com scheme: ${withScheme}, sem scheme: ${withoutScheme}, multi-profile: ${multiProfile}`);
        return res.json({ status: "ok", cached: false, clients: enriched });
    }
    catch (err) {
        console.error("[GET /api/clients] Erro:", err?.message || err);
        if (clientsCache) {
            console.warn("[GET /api/clients] Servindo cache expirado como fallback");
            return res.json({
                status: "ok", cached: true, stale: true,
                clients: clientsCache.data,
                warning: "fetch_error_using_stale_cache",
            });
        }
        return res.json({ status: "ok", cached: false, clients: [], warning: "fetch_error", detail: err?.message });
    }
});
// ---------------------------------------------------------------------------
// POST /api/clients/reload-schemes
// Recarrega scheme_ids.txt + catalog sem restart do servidor.
// ---------------------------------------------------------------------------
router.post("/reload-schemes", (_req, res) => {
    reloadSchemeSources();
    res.json({ status: "ok", message: "Fontes recarregadas e cache invalidado" });
});
// ---------------------------------------------------------------------------
// POST /api/clients/sync-cookie
// Recebe o cookie HTML5 do worker (VM) e salva no filesystem do Render.
// Permite que /api/clients use a sessão autenticada do Traffilog.
// Header obrigatório: x-sync-secret (deve bater com env COOKIE_SYNC_SECRET)
// ---------------------------------------------------------------------------
const COOKIEJAR_PATH = (process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json").trim();
const SYNC_SECRET = (process.env.COOKIE_SYNC_SECRET || "").trim();
// ---------------------------------------------------------------------------
// Render cookie persistence — salva cookie como env var para sobreviver restart
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
            // GET atual para não sobrescrever as outras env vars
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
// Restaura cookie do /tmp a partir da env var HTML5_COOKIE_PERSIST se ausente (boot após restart)
function restoreCookieFromEnvOnBoot() {
    try {
        if (fs.existsSync(COOKIEJAR_PATH))
            return;
        const persisted = (process.env.HTML5_COOKIE_PERSIST || "").trim();
        if (!persisted) {
            console.log("[cookie-boot] sem HTML5_COOKIE_PERSIST — skip");
            return;
        }
        JSON.parse(persisted); // valida JSON antes de escrever
        fs.writeFileSync(COOKIEJAR_PATH, persisted, { encoding: "utf8", mode: 0o600 });
        console.log("[cookie-boot] ✅ Cookie restaurado de HTML5_COOKIE_PERSIST");
    }
    catch (e) {
        console.log("[cookie-boot] falha:", e?.message);
    }
}
restoreCookieFromEnvOnBoot();
// ---------------------------------------------------------------------------
router.post("/sync-cookie", (req, res) => {
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
        clientsCache = null; // invalida cache para forçar novo fetch com cookie novo
        console.log(`[sync-cookie] Cookie sincronizado — keys: ${payload.keys.join(", ") || "(nenhuma)"}`);
        return res.json({ status: "ok", syncedAt: payload.syncedAt });
    }
    catch (err) {
        console.error("[sync-cookie] Falha ao salvar cookie:", err?.message);
        return res.status(500).json({ status: "error", message: err?.message });
    }
});
// GET /api/clients/sync-cookie/status — quando foi sincronizado pela última vez
router.get("/sync-cookie/status", (_req, res) => {
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
