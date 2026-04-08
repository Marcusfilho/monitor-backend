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

import { Router } from "express";
import * as fs from "fs";
import * as path from "path";
import { clientsQuery } from "../services/html5Client";

const router = Router();

// ---------------------------------------------------------------------------
// Caminhos dos arquivos de configuração
// ---------------------------------------------------------------------------

const SCHEME_IDS_PATH = path.resolve(
  process.env.SCHEME_IDS_PATH ||
  path.join(__dirname, "../../config/scheme_ids.txt")
);

const CATALOG_PATH = path.resolve(
  process.env.CATALOG_PATH ||
  path.join(__dirname, "../../config/catalog_vehicle_settings.json")
);

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface ClientProfile {
  key: string;
  label: string;
  vehicle_setting_id: number;
  is_default: boolean;
}

export interface EnrichedClient {
  client_id: number;
  client_descr: string;
  default_group_name: string;
  vehicle_setting_id: number | null;
  profiles: ClientProfile[];
  has_scheme: boolean;
  multi_profile: boolean;
}

interface SchemeEntry {
  clientId: number;
  clientName: string;
  vehicleSettingId: number;
}

interface CatalogItem {
  clientId: number;
  clientName: string;
  profileKey: string;
  settingName: string;
  vehicleSettingId: number;
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// Carregamento das fontes
// ---------------------------------------------------------------------------

function loadSchemeIds(): Map<number, SchemeEntry> {
  const map = new Map<number, SchemeEntry>();
  try {
    const lines = fs.readFileSync(SCHEME_IDS_PATH, "utf8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("CLIENT_ID"));

    for (const line of lines) {
      const parts = line.split(";");
      if (parts.length < 3) continue;
      const clientId = Number(parts[0].trim());
      const clientName = parts[1].trim();
      const vehicleSettingId = Number(parts[2].trim());
      if (!clientId || !vehicleSettingId) continue;
      map.set(clientId, { clientId, clientName, vehicleSettingId });
    }
    console.log(`[schemes] ${map.size} clientes carregados de scheme_ids.txt`);
  } catch (err: any) {
    console.error("[schemes] Falha ao carregar scheme_ids.txt:", err?.message);
  }
  return map;
}

function loadCatalogIndex(): Map<number, CatalogItem[]> {
  const map = new Map<number, CatalogItem[]>();
  try {
    const raw = fs.readFileSync(CATALOG_PATH, "utf8");
    const catalog: { items: CatalogItem[] } = JSON.parse(raw);
    for (const item of catalog.items) {
      if (!map.has(item.clientId)) map.set(item.clientId, []);
      map.get(item.clientId)!.push(item);
    }
    console.log(`[catalog] ${catalog.items.length} profiles carregados (${map.size} clientes)`);
  } catch (err: any) {
    console.error("[catalog] Falha ao carregar catalog_vehicle_settings.json:", err?.message);
  }
  return map;
}

let schemeIds    = loadSchemeIds();
let catalogIndex = loadCatalogIndex();

export function reloadSchemeSources(): void {
  schemeIds    = loadSchemeIds();
  catalogIndex = loadCatalogIndex();
  clientsCache = null;
  console.log("[schemes] Fontes recarregadas, cache invalidado");
}

// ---------------------------------------------------------------------------
// Merge: scheme_ids.txt + catalog → profiles do cliente
// ---------------------------------------------------------------------------

function buildProfiles(clientId: number): ClientProfile[] {
  const schemeEntry  = schemeIds.get(clientId);
  const catalogItems = catalogIndex.get(clientId) ?? [];

  if (!schemeEntry && catalogItems.length === 0) return [];

  // Está no catalog mas não no TXT → sem default definido
  if (!schemeEntry) return [];

  // Só no TXT → 1 profile simples
  if (catalogItems.length === 0) {
    return [{
      key:               "default",
      label:             schemeEntry.clientName,
      vehicle_setting_id: schemeEntry.vehicleSettingId,
      is_default:        true,
    }];
  }

  // Nos dois → profiles do catalog, default = vehicleSettingId do TXT
  const defaultVsId = schemeEntry.vehicleSettingId;

  const profiles: ClientProfile[] = catalogItems.map(item => ({
    key:               item.profileKey,
    label:             item.settingName,
    vehicle_setting_id: item.vehicleSettingId,
    is_default:        item.vehicleSettingId === defaultVsId,
  }));

  // Fallback defensivo: se nenhum bateu, marca o primeiro isDefault do catalog
  if (!profiles.some(p => p.is_default)) {
    const fallback = catalogItems.find(i => i.isDefault) ?? catalogItems[0];
    const p = profiles.find(p => p.vehicle_setting_id === fallback.vehicleSettingId);
    if (p) p.is_default = true;
  }

  // Default sempre primeiro
  profiles.sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0));
  return profiles;
}

// ---------------------------------------------------------------------------
// Cache em memória
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;

interface ClientCache {
  data: EnrichedClient[];
  fetchedAt: number;
}

let clientsCache: ClientCache | null = null;

function isCacheValid(): boolean {
  return clientsCache !== null && Date.now() - clientsCache.fetchedAt < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Join: resposta Traffilog + fontes locais → EnrichedClient[]
// ---------------------------------------------------------------------------

function enrichClients(rawClients: Awaited<ReturnType<typeof clientsQuery>>): EnrichedClient[] {
  return rawClients.map(c => {
    const profiles = buildProfiles(c.client_id);
    const defaultProfile = profiles.find(p => p.is_default) ?? profiles[0] ?? null;
    return {
      client_id:          c.client_id,
      client_descr:       c.client_descr,
      default_group_name: c.default_group_name,
      vehicle_setting_id: defaultProfile?.vehicle_setting_id ?? null,
      profiles,
      has_scheme:    profiles.length > 0,
      multi_profile: profiles.length > 1,
    };
  });
}

// ---------------------------------------------------------------------------
// GET /api/clients
// ---------------------------------------------------------------------------

router.get("/", async (_req, res) => {
  if (isCacheValid()) {
    return res.json({ status: "ok", cached: true, clients: clientsCache!.data });
  }

  try {
    const rawClients = await clientsQuery();

    if (rawClients.length === 0) {
      console.warn("[GET /api/clients] Lista vazia — sessão HTML5 pode estar expirada");
      return res.json({ status: "ok", cached: false, clients: [], warning: "session_may_be_expired" });
    }

    const enriched = enrichClients(rawClients);
    clientsCache = { data: enriched, fetchedAt: Date.now() };

    const withScheme    = enriched.filter(c => c.has_scheme).length;
    const withoutScheme = enriched.filter(c => !c.has_scheme).length;
    const multiProfile  = enriched.filter(c => c.multi_profile).length;
    console.log(
      `[GET /api/clients] ${enriched.length} clientes — ` +
      `com scheme: ${withScheme}, sem scheme: ${withoutScheme}, multi-profile: ${multiProfile}`
    );

    return res.json({ status: "ok", cached: false, clients: enriched });

  } catch (err: any) {
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

const COOKIEJAR_PATH = (
  process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json"
).trim();

const SYNC_SECRET = (process.env.COOKIE_SYNC_SECRET || "").trim();

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
      cookie:    body.cookie,
      keys:      body.keys      || [],
      updatedAt: body.updatedAt || new Date().toISOString(),
      meta:      body.meta      || {},
      syncedAt:  new Date().toISOString(),
      source:    "worker-push",
    };

    fs.writeFileSync(COOKIEJAR_PATH, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    clientsCache = null; // invalida cache para forçar novo fetch com cookie novo

    console.log(`[sync-cookie] Cookie sincronizado — keys: ${payload.keys.join(", ") || "(nenhuma)"}`);
    return res.json({ status: "ok", syncedAt: payload.syncedAt });

  } catch (err: any) {
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
