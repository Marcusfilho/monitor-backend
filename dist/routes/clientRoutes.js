"use strict";
// src/routes/clientRoutes.ts
// GET /api/clients — retorna lista de clientes disponíveis na sessão HTML5,
// enriquecida com vehicle_setting_id e profiles.
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
exports.reloadSchemeSources = reloadSchemeSources;
const express_1 = require("express");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const html5Client_1 = require("../services/html5Client");
const router = (0, express_1.Router)();
// ---------------------------------------------------------------------------
// Caminhos dos arquivos de configuração
// ---------------------------------------------------------------------------
const SCHEME_IDS_PATH = path.resolve(process.env.SCHEME_IDS_PATH ||
    path.join(__dirname, "../../config/scheme_ids.txt"));
const CATALOG_PATH = path.resolve(process.env.CATALOG_PATH ||
    path.join(__dirname, "../../config/catalog_vehicle_settings.json"));
// ---------------------------------------------------------------------------
// Carregamento das fontes
// ---------------------------------------------------------------------------
function loadSchemeIds() {
    const map = new Map();
    try {
        const lines = fs.readFileSync(SCHEME_IDS_PATH, "utf8")
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
// Cache em memória
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
router.get("/", async (_req, res) => {
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
// Upload do TXT via endpoint virá em sessão futura.
// ---------------------------------------------------------------------------
router.post("/reload-schemes", (_req, res) => {
    reloadSchemeSources();
    res.json({ status: "ok", message: "Fontes recarregadas e cache invalidado" });
});
exports.default = router;
