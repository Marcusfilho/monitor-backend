// src/routes/adminRoutes.ts
// Rotas administrativas — sem requireSession (acesso via túnel Cloudflare)
//
// GET  /api/admin/jobs                       — lista jobs (do jobStore)
// GET  /api/admin/installations              — lista instalações (do installationStore)
// POST /api/admin/jobs/:id/cancel            — cancela job
// POST /api/admin/installations/:id/cancel   — cancela instalação
//
// GET  /api/admin/asset-types                — retorna JSON salvo em config/
// POST /api/admin/asset-types/sync           — faz match catalog_vehicle_type.json x ASSET_TYPES e salva
//
// GET  /api/admin/schemes                    — retorna JSON salvo em config/
// POST /api/admin/schemes                    — salva seleção de schemes
// GET  /api/admin/schemes/clients            — lista clientes via HTML5 (usa env HTML5_LOGIN_NAME/PASS)
// GET  /api/admin/schemes/client/:id         — lista schemes de um cliente

import { Router } from "express";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

const router = Router();

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const HTML5_ACTION_URL = (
  process.env.HTML5_ACTION_URL ||
  "https://html5.traffilog.com/AppEngine_2_1/default.aspx"
).trim();

const HTML5_INDEX_URL = "https://html5.traffilog.com/appv2/index.htm";

// config/ fica na raiz do projeto (~/monitor-backend-rewrite/config/)
const CONFIG_DIR       = path.resolve(__dirname, "../../config");
const ASSET_TYPES_PATH = path.join(CONFIG_DIR, "asset_types_active.json");
const SCHEMES_PATH                = path.join(CONFIG_DIR, "schemes_selection.json");
const ASSET_TYPES_BY_CLIENT_PATH  = path.join(CONFIG_DIR, "asset_types_by_client.json");

// catalog_vehicle_type.json — lista dos modelos que a Questar usa (já filtrado)
const CATALOG_PATH = path.resolve(__dirname, "../../public/catalog_vehicle_type.json");

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------

interface HttpResult {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

function httpGet(url: string, reqHeaders: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = (lib as typeof https).request(
      {
        hostname: u.hostname,
        port:     u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80),
        path:     u.pathname + u.search,
        method:   "GET",
        headers:  { accept: "*/*", ...reqHeaders },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers as any, body: Buffer.concat(chunks).toString("utf8") })
        );
        res.on("error", reject);
      }
    );
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("GET timeout")); });
    req.on("error", reject);
    req.end();
  });
}

function httpPost(url: string, body: string, reqHeaders: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const buf = Buffer.from(body, "utf8");
    const req = (lib as typeof https).request(
      {
        hostname: u.hostname,
        port:     u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80),
        path:     u.pathname + u.search,
        method:   "POST",
        headers: {
          "content-type":   "application/x-www-form-urlencoded",
          "content-length": String(buf.length),
          accept:    "*/*",
          origin:    "https://html5.traffilog.com",
          referer:   HTML5_INDEX_URL,
          ...reqHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers as any, body: Buffer.concat(chunks).toString("utf8") })
        );
        res.on("error", reject);
      }
    );
    req.setTimeout(45000, () => { req.destroy(); reject(new Error("POST timeout")); });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function extractSetCookie(headers: Record<string, string | string[]>): string {
  const raw = headers["set-cookie"];
  if (!raw) return "";
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((s) => s.split(";")[0].trim()).filter(Boolean).join("; ");
}

function mergeCookies(base: string, incoming: string): string {
  const map = new Map<string, string>();
  for (const pair of base.split(";").map(s => s.trim()).filter(Boolean)) {
    const [k, ...rest] = pair.split("=");
    map.set(k.trim(), rest.join("="));
  }
  for (const pair of incoming.split(";").map(s => s.trim()).filter(Boolean)) {
    const [k, ...rest] = pair.split("=");
    map.set(k.trim(), rest.join("="));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// ---------------------------------------------------------------------------
// Login HTML5 — retorna cookie de sessão
// ---------------------------------------------------------------------------

async function loginHtml5(username: string, password: string): Promise<string | null> {
  try {
    // 1. Bootstrap: GET index.htm para obter ASP.NET_SessionId (igual ao authRoutes)
    const bootstrap = await httpGet(HTML5_INDEX_URL, { referer: HTML5_INDEX_URL });
    let cookie = extractSetCookie(bootstrap.headers);

    // 2. APPLICATION_LOGIN (mesmo action da rewrite)
    const bodyParams = new URLSearchParams({
      username,
      password,
      language:        process.env.HTML5_LANGUAGE || "0",
      BOL_SAVE_COOKIE: "1",
      action:          "APPLICATION_LOGIN",
      VERSION_ID:      "2",
    });
    const loginResp = await httpPost(HTML5_ACTION_URL, bodyParams.toString(), { cookie });
    cookie = mergeCookies(cookie, extractSetCookie(loginResp.headers));

    const text = loginResp.body;
    const isOk = /REDIRECT[^>]*node=-2/i.test(text) || cookie.includes("TFL_SESSION");
    if (!isOk) {
      console.error(`[admin] loginHtml5 falhou para "${username}" — ${text.slice(0, 200)}`);
      return null;
    }
    return cookie;
  } catch (e: any) {
    console.error("[admin] loginHtml5 exception:", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Garantir que config/ existe
// ---------------------------------------------------------------------------

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// XML parser mínimo para DATASOURCE do Traffilog
// ---------------------------------------------------------------------------

function parseXmlAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

function parseAssetTypesXml(xml: string): Array<{ id: number; manufacturer: string; model: string; sub_model: string }> {
  const result: Array<{ id: number; manufacturer: string; model: string; sub_model: string }> = [];
  const re = /<ASSET_TYPE ([^/]+)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const a = parseXmlAttrs(m[1]);
    const id = parseInt(a.ASSET_TYPE, 10);
    if (isNaN(id)) continue;
    result.push({
      id,
      manufacturer: a.MANUFACTURER_DESCR || "",
      model:        a.MODEL     || "",
      sub_model:    a.SUB_MODEL || "",
    });
  }
  return result;
}

function parseClientsXml(xml: string): Array<{ client_id: number; client_descr: string }> {
  const result: Array<{ client_id: number; client_descr: string }> = [];
  // Traffilog retorna: <CLIENT CLIENT_ID="123" CLIENT_DESCR="Nome" ... />
  const re = /<CLIENT\s([^>]+?)\s*\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const a = parseXmlAttrs(m[1]);
    const id = parseInt(a.CLIENT_ID || "", 10);
    const descr = (a.CLIENT_DESCR || "").trim();
    if (!isNaN(id) && id > 0 && descr) result.push({ client_id: id, client_descr: descr });
  }
  console.log(`[admin] parseClientsXml: ${result.length} clientes encontrados`);
  return result;
}

function parseSchemesXml(xml: string): Array<{ vehicle_setting_id: number; vehicle_setting_name: string; created_by_user_name: string; updated_at: string }> {
  const result: Array<{ vehicle_setting_id: number; vehicle_setting_name: string; created_by_user_name: string; updated_at: string }> = [];
  // Traffilog retorna: <DATA VEHICLE_SETTING_ID="..." VEHICLE_SETTING_NAME="..." />
  // dentro de <DATASOURCE DATASOURCE="GET_VEHICLE_SETTINGS_GRID">
  const re = /<DATA\s([^>]+?)\s*\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const a = parseXmlAttrs(m[1]);
    const id = parseInt(a.VEHICLE_SETTING_ID || "", 10);
    if (isNaN(id) || !a.VEHICLE_SETTING_NAME) continue;
    result.push({
      vehicle_setting_id:   id,
      vehicle_setting_name: a.VEHICLE_SETTING_NAME,
      created_by_user_name: a.CREATED_BY_USER_NAME || "",
      updated_at:           a.UPDATED_AT || "",
    });
  }
  console.log("[admin] parseSchemesXml: " + result.length + " schemes encontrados");
  return result;
}

// ---------------------------------------------------------------------------
// Imports de runtime — jobStore e installationStore
// (lazy para não quebrar se os módulos mudarem)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listJobs, updateJob: updateJobStore, getJob } = require("../jobs/jobStore");

// ---------------------------------------------------------------------------
// ── JOBS ────────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

router.get("/jobs", (_req, res) => {
  try {
    const jobs = listJobs();
    res.json({ ok: true, jobs });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/jobs/:id/cancel", (req, res) => {
  try {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: "Job não encontrado" });
    const updated = updateJobStore(req.params.id, { status: "cancelled" });
    res.json({ ok: true, job: updated });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// ── INSTALAÇÕES ─────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

router.get("/installations", (_req, res) => {
  try {
    // Instalações são jobs do tipo html5_install / html5_maint_*
    const all = listJobs();
    const installations = all.filter((j: any) =>
      typeof j.type === "string" && j.type.startsWith("html5")
    );
    res.json({ ok: true, installations });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/installations/:id/cancel", (req, res) => {
  try {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: "Instalação não encontrada" });
    const updated = updateJobStore(req.params.id, { status: "cancelled" });
    res.json({ ok: true, job: updated });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// ── ASSET TYPES (Modelos de Veículos) ───────────────────────────────────────
// ---------------------------------------------------------------------------

// GET /api/admin/asset-types — retorna JSON salvo
router.get("/asset-types", (_req, res) => {
  if (!fs.existsSync(ASSET_TYPES_PATH)) {
    return res.status(404).json({ ok: false, error: "Nenhuma lista salva. Execute a sincronização primeiro." });
  }
  try {
    const data = JSON.parse(fs.readFileSync(ASSET_TYPES_PATH, "utf8"));
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/asset-types/sync
// Faz match entre catalog_vehicle_type.json (modelos usados) e ASSET_TYPES (catálogo completo)
// Salva resultado em config/asset_types_active.json
router.post("/asset-types/sync", async (_req, res) => {
  const loginName = (process.env.HTML5_LOGIN_NAME || "").trim();
  const loginPass = (process.env.HTML5_PASSWORD   || "").trim();

  if (!loginName || !loginPass) {
    return res.status(500).json({ ok: false, error: "HTML5_LOGIN_NAME/HTML5_PASSWORD não configurados" });
  }

  try {
    // 1. Login para obter cookie
    const cookie = await loginHtml5(loginName, loginPass);
    if (!cookie) return res.status(502).json({ ok: false, error: "Falha no login HTML5" });

    // 2. Buscar catálogo completo de ASSET_TYPES
    const r = await httpPost(
      HTML5_ACTION_URL,
      "action=ASSET_TYPES&VERSION_ID=2",
      { cookie }
    );
    const catalog = parseAssetTypesXml(r.body);
    if (!catalog.length) {
      return res.status(502).json({ ok: false, error: "Catálogo ASSET_TYPES vazio ou parse falhou" });
    }
    // 3. Buscar VHCLS completo para descobrir quais manufacturer|model estão em uso
    const rVhcls = await httpPost(
      HTML5_ACTION_URL,
      "action=VHCLS&VERSION_ID=2&REFRESH_FLG=1&LICENSE_NMBR=&CLIENT_DESCR=&OWNER_DESCR=&DIAL_NMBR=&INNER_ID=",
      { cookie }
    );
    const allVehicles = parseVhclsXml(rVhcls.body);
    console.log(`[admin] asset-types sync: ${allVehicles.length} veículos no VHCLS`);

    // 4. Montar Set de pares manufacturer|model em uso
    const usedPairs = new Set<string>();
    for (const v of allVehicles) {
      if (v.manufacturer_descr && v.model) usedPairs.add(v.manufacturer_descr + "|" + v.model);
    }
    console.log(`[admin] asset-types sync: ${usedPairs.size} pares distintos`);

    // 5. Filtrar catálogo pelos pares em uso
    const matched = catalog.filter(c => usedPairs.has(c.manufacturer + "|" + c.model));
    const fallback: typeof matched = [];
    const finalList = [...matched, ...fallback].sort((a, b) => {
      const mfg = a.manufacturer.localeCompare(b.manufacturer);
      return mfg !== 0 ? mfg : a.model.localeCompare(b.model);
    });

    // 6. Salvar
    ensureConfigDir();
    const output = {
      ok: true,
      generated_at:   new Date().toISOString(),
      total_matched:  finalList.length,
      total_vhcls_ids: usedPairs.size,
      total_catalog:  catalog.length,
      asset_types:    finalList,
    };
    fs.writeFileSync(ASSET_TYPES_PATH, JSON.stringify(output, null, 2), "utf8");

    console.log(`[admin] asset-types sync: ${finalList.length} modelos salvos`);
    res.json(output);
  } catch (e: any) {
    console.error("[admin] asset-types sync error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// ── SCHEMES ─────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

// GET /api/admin/schemes — retorna JSON salvo
router.get("/schemes", (_req, res) => {
  if (!fs.existsSync(SCHEMES_PATH)) {
    // Retorna lista vazia em vez de 404 — frontend usa para preservar seleções anteriores
    return res.json({ ok: true, generated_at: null, clients: [] });
  }
  try {
    const data = JSON.parse(fs.readFileSync(SCHEMES_PATH, "utf8"));
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/schemes — salva seleção
router.post("/schemes", (req, res) => {
  const { clients } = req.body as { clients: any[] };
  if (!Array.isArray(clients)) {
    return res.status(400).json({ ok: false, error: "Campo 'clients' deve ser array" });
  }
  try {
    ensureConfigDir();
    const output = { ok: true, generated_at: new Date().toISOString(), clients };
    fs.writeFileSync(SCHEMES_PATH, JSON.stringify(output, null, 2), "utf8");
    console.log(`[admin] schemes salvos: ${clients.length} clientes`);
    res.json({ ok: true, saved: clients.length });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/schemes/clients — lista clientes via HTML5
router.get("/schemes/clients", async (_req, res) => {
  const loginName = (process.env.HTML5_LOGIN_NAME || "").trim();
  const loginPass = (process.env.HTML5_PASSWORD   || "").trim();

  if (!loginName || !loginPass) {
    return res.status(500).json({ ok: false, error: "HTML5_LOGIN_NAME/HTML5_PASSWORD não configurados" });
  }

  try {
    const cookie = await loginHtml5(loginName, loginPass);
    if (!cookie) return res.status(502).json({ ok: false, error: "Falha no login HTML5" });

    const r = await httpPost(
      HTML5_ACTION_URL,
      "action=CLIENTS&VERSION_ID=2",
      { cookie }
    );

    const clients = parseClientsXml(r.body);
    if (!clients.length) {
      // fallback: tentar extrair de JSON embutido no XML
      const jsonMatch = r.body.match(/\{.*"clients".*\}/s);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return res.json({ ok: true, clients: parsed.clients || [] });
        } catch { /* continua */ }
      }
      console.warn("[admin] schemes/clients — parse XML retornou 0 clientes. body sample:", r.body.slice(0, 300));
    }
    res.json({ ok: true, clients });
  } catch (e: any) {
    console.error("[admin] schemes/clients error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/schemes/client/:id — schemes de um cliente
router.get("/schemes/client/:clientId", async (req, res) => {
  const loginName = (process.env.HTML5_LOGIN_NAME || "").trim();
  const loginPass = (process.env.HTML5_PASSWORD   || "").trim();

  if (!loginName || !loginPass) {
    return res.status(500).json({ ok: false, error: "HTML5_LOGIN_NAME/HTML5_PASSWORD não configurados" });
  }

  const { clientId } = req.params;

  try {
    const cookie = await loginHtml5(loginName, loginPass);
    if (!cookie) return res.status(502).json({ ok: false, error: "Falha no login HTML5" });

    const body = `action=GET_VEHICLE_SETTINGS_GRID&VERSION_ID=2&CLIENT_ID=${encodeURIComponent(clientId)}`;
    const r = await httpPost(HTML5_ACTION_URL, body, { cookie });

    const schemes = parseSchemesXml(r.body);
    res.json({ ok: true, client_id: Number(clientId), schemes });
  } catch (e: any) {
    console.error(`[admin] schemes/client/${clientId} error:`, e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /api/admin/asset-types/by-client?clientId=X&clientName=Y
// Cruza asset_types_active.json com VHCLS filtrado por cliente
// Retorna Set de pares "manufacturer|model" que o cliente usa
// ---------------------------------------------------------------------------
function parseVhclsXml(xml: string): Array<{ client_id: string; manufacturer_descr: string; model: string; asset_type_id: number }> {
  const results: Array<{ client_id: string; manufacturer_descr: string; model: string; asset_type_id: number }> = [];
  const re = /<DATA\s([^>]*?)\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const attr = (name: string): string => {
      const hit = attrs.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'));
      return hit ? hit[1].trim() : '';
    };
    const vehicle_id = attr('VEHICLE_ID');
    if (!vehicle_id) continue;
    results.push({
      client_id:          attr('CLIENT_ID'),
      manufacturer_descr: attr('MANUFACTURER_DESCR'),
      model:              attr('MODEL'),
      asset_type_id:      parseInt(attr('ASSET_TYPE'), 10) || 0,
    });
  }
  return results;
}

router.get("/asset-types/by-client", (req, res) => {
  const clientId = String(req.query.clientId || "").trim();
  if (!clientId) {
    return res.status(400).json({ ok: false, error: "clientId é obrigatório" });
  }
  // Lê JSON pré-gerado pelo sync — zero latência, zero HTML5
  if (!fs.existsSync(ASSET_TYPES_BY_CLIENT_PATH)) {
    return res.status(404).json({
      ok: false,
      error: "Cache não gerado. Execute POST /api/admin/asset-types/sync-by-client primeiro.",
    });
  }
  try {
    const data = JSON.parse(fs.readFileSync(ASSET_TYPES_BY_CLIENT_PATH, "utf8"));
    const ids: number[] = data.by_client?.[clientId] ?? [];
    res.json({ ok: true, client_id: clientId, asset_type_ids: ids, generated_at: data.generated_at });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: "Erro ao ler cache: " + e.message });
  }
});

// ---------------------------------------------------------------------------
// syncAssetTypesByClient — itera todos os clientes, acumula asset_type IDs
// Salva em config/asset_types_by_client.json
// ---------------------------------------------------------------------------
async function syncAssetTypesByClient(): Promise<void> {
  const loginName = (process.env.HTML5_LOGIN_NAME || "").trim();
  const loginPass = (process.env.HTML5_PASSWORD   || "").trim();
  if (!loginName || !loginPass) throw new Error("HTML5_LOGIN_NAME/HTML5_PASSWORD não configurados");

  console.log("[admin] syncAssetTypesByClient — iniciando...");

  const cookie = await loginHtml5(loginName, loginPass);
  if (!cookie) throw new Error("Falha no login HTML5");

  // 1. Buscar lista de clientes
  const rClients = await httpPost(HTML5_ACTION_URL, "action=CLIENTS&VERSION_ID=2", { cookie });
  const clients = parseClientsXml(rClients.body);
  console.log(`[admin] syncAssetTypesByClient — ${clients.length} clientes`);

  // 2. Buscar VHCLS completo uma única vez (sem filtro — retorna todos)
  const rVhcls = await httpPost(
    HTML5_ACTION_URL,
    "action=VHCLS&VERSION_ID=2&REFRESH_FLG=1&LICENSE_NMBR=&CLIENT_DESCR=&OWNER_DESCR=&DIAL_NMBR=&INNER_ID=",
    { cookie }
  );
  const allVehicles = parseVhclsXml(rVhcls.body);
  console.log(`[admin] syncAssetTypesByClient — ${allVehicles.length} veículos no VHCLS`);

  // 3. Ler asset_types_active para montar lookup manufacturer|model → id
  let assetTypes: Array<{ id: number; manufacturer: string; model: string }> = [];
  if (fs.existsSync(ASSET_TYPES_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(ASSET_TYPES_PATH, "utf8"));
      assetTypes = saved.asset_types || [];
    } catch { /* continua sem catálogo */ }
  }
  const catalogLookup = new Map<string, number>();
  for (const t of assetTypes) {
    catalogLookup.set(t.manufacturer + "|" + t.model, t.id);
  }

  // 4. Agrupar asset_type_ids por client_id via cruzamento manufacturer|model
  const byClient: Record<string, Set<number>> = {};
  for (const v of allVehicles) {
    if (!v.client_id) continue;
    if (!byClient[v.client_id]) byClient[v.client_id] = new Set();
    const key = v.manufacturer_descr + "|" + v.model;
    const id = catalogLookup.get(key);
    if (id) byClient[v.client_id].add(id);
  }

  // 4. Serializar Sets para arrays
  const byClientSerialized: Record<string, number[]> = {};
  for (const [cid, ids] of Object.entries(byClient)) {
    byClientSerialized[cid] = [...ids].sort((a, b) => a - b);
  }

  // 5. Salvar
  const output = {
    generated_at:  new Date().toISOString(),
    total_clients: clients.length,
    total_vehicles: allVehicles.length,
    by_client:     byClientSerialized,
  };
  ensureConfigDir();
  fs.writeFileSync(ASSET_TYPES_BY_CLIENT_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`[admin] syncAssetTypesByClient — salvo: ${Object.keys(byClientSerialized).length} clientes em ${ASSET_TYPES_BY_CLIENT_PATH}`);
}

// POST /api/admin/asset-types/sync-by-client — dispara sync manual
router.post("/asset-types/sync-by-client", async (_req, res) => {
  try {
    await syncAssetTypesByClient();
    const data = JSON.parse(fs.readFileSync(ASSET_TYPES_BY_CLIENT_PATH, "utf8"));
    res.json({ ok: true, ...data, by_client: undefined,
      clients_synced: Object.keys(data.by_client).length });
  } catch (e: any) {
    console.error("[admin] sync-by-client error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export { syncAssetTypesByClient };
export default router;
