// src/routes/adminRoutes.ts
// POST /api/admin/asset-types/sync  — faz match VHCLS x ASSET_TYPES e salva JSON
// GET  /api/admin/asset-types        — retorna o JSON salvo (usado pelo app)
// POST /api/admin/jobs/:id/cancel    — cancela job SEM requireWorkerKey (uso pela página admin)
// POST /api/admin/installations/:id/cancel — cancela instalação SEM requireWorkerKey

import { Router } from "express";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { getSessionTokenStatus, setSessionToken } from "../services/sessionTokenStore";
import { reloadSchemeSources, SCHEME_IDS_PATH } from "./clientRoutes";
import { createJob } from "../jobs/jobStore";

const router = Router();

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const HTML5_ACTION_URL = (
  process.env.HTML5_ACTION_URL ||
  "https://html5.traffilog.com/AppEngine_2_1/default.aspx"
).trim();

const HTML5_INDEX_URL = "https://html5.traffilog.com/appv2/index.htm";

// Caminho onde o JSON resultante é salvo (mesmo padrão do scheme_ids.txt)
const ASSET_TYPES_PATH = path.resolve(
  process.env.ASSET_TYPES_PATH ||
  path.join(__dirname, "../../config/asset_types_active.json")
);

// ---------------------------------------------------------------------------
// Helpers HTTP (reutiliza o mesmo padrão do authRoutes — https nativo)
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
        port: u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: { accept: "text/html", ...reqHeaders },
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
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("GET timeout")); });
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
        port: u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(buf.length),
          accept: "*/*",
          origin: "https://html5.traffilog.com",
          referer: HTML5_INDEX_URL,
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
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("POST timeout")); }); // 30s — VHCLS pode ser lento
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Cookie helpers (mesmos do authRoutes)
// ---------------------------------------------------------------------------

function extractSetCookie(headers: Record<string, string | string[]>): string {
  const raw = headers["set-cookie"];
  if (!raw) return "";
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((s) => s.split(";")[0].trim()).filter(Boolean).join("; ");
}

function mergeCookies(base: string, incoming: string): string {
  const map = new Map<string, string>();
  const parse = (s: string) => {
    for (const part of s.split(";")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) { map.set(trimmed, ""); }
      else { map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim()); }
    }
  };
  parse(base);
  parse(incoming);
  return [...map.entries()].map(([k, v]) => (v ? `${k}=${v}` : k)).join("; ");
}

// ---------------------------------------------------------------------------
// loginAdminToHtml5 — reutiliza lógica do authRoutes
// ---------------------------------------------------------------------------

async function loginAdminToHtml5(): Promise<string | null> {
  const adminName = (process.env.HTML5_LOGIN_NAME || "").trim();
  const adminPass = (process.env.HTML5_PASSWORD   || "").trim();

  if (!adminName || !adminPass) {
    throw new Error("HTML5_LOGIN_NAME / HTML5_PASSWORD não definidos");
  }

  const bootstrap = await httpGet(HTML5_INDEX_URL, { referer: HTML5_INDEX_URL });
  let cookie = extractSetCookie(bootstrap.headers);

  const bodyParams = new URLSearchParams({
    username: adminName,
    password: adminPass,
    language:        process.env.HTML5_LANGUAGE || "0",
    BOL_SAVE_COOKIE: "1",
    action:          "APPLICATION_LOGIN",
    VERSION_ID:      "2",
  });

  const loginResp = await httpPost(HTML5_ACTION_URL, bodyParams.toString(), { cookie });
  cookie = mergeCookies(cookie, extractSetCookie(loginResp.headers));

  const isOk =
    /REDIRECT[^>]*node=-2/i.test(loginResp.body) ||
    cookie.includes("TFL_SESSION");

  if (!isOk) {
    console.log(`[admin] loginAdminToHtml5 falhou — resp: ${loginResp.body.slice(0, 200)}`);
    return null;
  }

  return cookie;
}

// ---------------------------------------------------------------------------
// fetchVhcls — chama VHCLS com cookie admin e retorna Set de ASSET_TYPE usados
// Retorna: Map<assetTypeId, true>
// ---------------------------------------------------------------------------

async function fetchUsedAssetTypeIds(adminCookie: string): Promise<Set<string>> {
  const bodyParams = new URLSearchParams({
    action:      "VHCLS",
    REFRESH_FLG: "1",
    LICENSE_NMBR: "",
    CLIENT_DESCR: "",
    OWNER_DESCR:  "",
    DIAL_NMBR:    "",
    INNER_ID:     "",
    VERSION_ID:  "2",
  });

  console.log("[admin] chamando VHCLS...");
  const resp = await httpPost(HTML5_ACTION_URL, bodyParams.toString(), { cookie: adminCookie });
  const xml = resp.body;
  console.log(`[admin] VHCLS resposta: ${xml.length} chars`);

  const used = new Set<string>();
  const reData = /<DATA\s([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = reData.exec(xml)) !== null) {
    const attrs = m[1];
    const attr = (name: string) => {
      const hit = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
      return hit ? hit[1].trim() : "";
    };
    const mfg   = attr("MANUFACTURER_DESCR").toUpperCase();
    const model = attr("MODEL").toUpperCase();
    if (mfg && model) used.add(`${mfg}|${model}`);
  }

  console.log(`[admin] VHCLS — pares fabricante+modelo únicos: ${used.size}`);
  return used;
}

// ---------------------------------------------------------------------------
// fetchAssetTypesCatalog — chama ASSET_TYPES e retorna catálogo completo
// Retorna: Array<{ id, manufacturer, model, sub_model, descr }>
// ---------------------------------------------------------------------------

interface AssetTypeEntry {
  id: number;
  manufacturer: string;
  model: string;
  sub_model: string;
  descr: string;
}

async function fetchAssetTypesCatalog(adminCookie: string): Promise<AssetTypeEntry[]> {
  const bodyParams = new URLSearchParams({
    action:     "ASSET_TYPES",
    VERSION_ID: "2",
  });

  console.log("[admin] chamando ASSET_TYPES...");
  const resp = await httpPost(HTML5_ACTION_URL, bodyParams.toString(), { cookie: adminCookie });
  const xml = resp.body;
  console.log(`[admin] ASSET_TYPES resposta: ${xml.length} chars`);

  const catalog: AssetTypeEntry[] = [];
  const re = /<ASSET_TYPE\s([^>]*?)\/>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const attr = (name: string) => {
      const hit = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
      return hit ? hit[1].trim() : "";
    };
    const id = Number(attr("ASSET_TYPE"));
    if (!id) continue;
    catalog.push({
      id,
      manufacturer: attr("MANUFACTURER_DESCR"),
      model:        attr("MODEL"),
      sub_model:    attr("SUB_MODEL"),
      descr:        attr("ASSET_TYPE_DESCR"),
    });
  }

  console.log(`[admin] ASSET_TYPES — total no catálogo: ${catalog.length}`);
  return catalog;
}

// ---------------------------------------------------------------------------
// POST /api/admin/asset-types/sync
// ---------------------------------------------------------------------------

router.post("/asset-types/sync", async (_req, res) => {
  try {
    console.log("[admin] iniciando sync de asset types...");

    // 1. Login admin
    const adminCookie = await loginAdminToHtml5();
    if (!adminCookie) {
      return res.status(502).json({ ok: false, error: "Login admin falhou — verifique HTML5_LOGIN_NAME/HTML5_PASSWORD" });
    }

    // 2. Em paralelo: VHCLS + ASSET_TYPES
    const [usedIds, catalog] = await Promise.all([
      fetchUsedAssetTypeIds(adminCookie),
      fetchAssetTypesCatalog(adminCookie),
    ]);

    // 3. Match: filtra por MANUFACTURER_DESCR+MODEL (VHCLS não expõe ASSET_TYPE_ID)
    const matched = catalog.filter(entry =>
      usedIds.has(`${entry.manufacturer.toUpperCase()}|${entry.model.toUpperCase()}`)
    );

    // Ordena por fabricante + modelo para facilitar inspeção
    matched.sort((a, b) => {
      const mfg = a.manufacturer.localeCompare(b.manufacturer);
      return mfg !== 0 ? mfg : a.model.localeCompare(b.model);
    });

    console.log(`[admin] match: ${matched.length} modelos de ${catalog.length} no catálogo (${usedIds.size} pares fabricante+modelo nos veículos)`);

    // 4. Salva JSON
    const output = {
      generated_at:    new Date().toISOString(),
      total_vhcls_pairs: usedIds.size,
      total_catalog:   catalog.length,
      total_matched:   matched.length,
      asset_types:     matched,
    };

    // Garante que o diretório config/ existe
    const dir = path.dirname(ASSET_TYPES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(ASSET_TYPES_PATH, JSON.stringify(output, null, 2), "utf8");
    console.log(`[admin] JSON salvo em ${ASSET_TYPES_PATH}`);
    // Persistir no SQLite da VM via job assíncrono
    try {
      createJob("admin_config_sync", { key: "asset_types", value: output });
      console.log("[admin] admin_config_sync (asset_types) enfileirado");
    } catch (e: any) {
      console.warn("[admin] admin_config_sync (asset_types) falhou (não crítico):", e?.message);
    }

    return res.json({
      ok:              true,
      total_vhcls_pairs: usedIds.size,
      total_catalog:   catalog.length,
      total_matched:   matched.length,
      generated_at:    output.generated_at,
      asset_types:     matched,
    });

  } catch (err: any) {
    console.error("[admin] sync error:", err?.message);
    return res.status(500).json({ ok: false, error: err?.message || "Erro interno" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/asset-types  — serve o JSON salvo para o app
// ---------------------------------------------------------------------------

router.get("/asset-types", (_req, res) => {
  try {
    if (!fs.existsSync(ASSET_TYPES_PATH)) {
      return res.status(404).json({ ok: false, error: "asset_types_active.json não encontrado — execute sync primeiro" });
    }
    const raw = fs.readFileSync(ASSET_TYPES_PATH, "utf8");
    const data = JSON.parse(raw);
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/jobs/:id/cancel — sem requireWorkerKey (uso pela página admin)
// Fix do bug: o cancel na rota /api/jobs/:id/cancel exige requireWorkerKey,
// que a página admin não envia. Esta rota paralela não exige a chave.
// ---------------------------------------------------------------------------

router.post("/jobs/:id/cancel", (req, res) => {
  try {
    // Importa dinamicamente para não criar dependência circular
    const { getJob, updateJob } = require("../jobs/jobStore");
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: "job_not_found" });

    const terminal = ["completed", "cancelled", "error"];
    if (terminal.includes(job.status)) {
      return res.json({ ok: true, skipped: true, status: job.status });
    }

    updateJob(req.params.id, { status: "cancelled" });
    console.log(`[admin] job ${req.params.id} cancelado via admin`);
    return res.json({ ok: true, id: req.params.id });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/installations/:id/cancel — sem requireWorkerKey
// ---------------------------------------------------------------------------

router.post("/installations/:id/cancel", (req, res) => {
  try {
    const paths = ["../services/installationsStore", "../services/installationsEngine"];
    let store: any = null;
    for (const p of paths) {
      try {
        const mod = require(p);
        const cand = [mod, mod?.default, mod?.installationsStore, mod?.store];
        for (const c of cand) {
          if (c && typeof c?.patchInstallation === "function") { store = c; break; }
        }
        if (store) break;
      } catch {}
    }

    if (!store) {
      return res.status(500).json({ ok: false, error: "installationsStore indisponível" });
    }

    const inst = store.getInstallation(req.params.id);
    if (!inst) return res.status(404).json({ ok: false, error: "installation_not_found" });

    const terminal = ["COMPLETED", "ERROR", "CANCELLED"];
    if (terminal.includes(String(inst.status || "").toUpperCase())) {
      return res.json({ ok: true, skipped: true, status: inst.status });
    }

    store.patchInstallation(req.params.id, { status: "CANCELLED" });
    console.log(`[admin] installation ${req.params.id} cancelada via admin`);
    return res.json({ ok: true, id: req.params.id });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// ---------------------------------------------------------------------------
// Constante do arquivo de schemes
// ---------------------------------------------------------------------------

const SCHEMES_JSON_PATH = path.resolve(
  process.env.SCHEMES_PATH ||
  path.join(__dirname, "../../config/schemes_active.json")
);

// ---------------------------------------------------------------------------
// parseClientsXml — extrai <CLIENT> da resposta CLIENTS
// ---------------------------------------------------------------------------

function parseClientsXml(xml: string): Array<{ client_id: string; client_descr: string }> {
  const results: Array<{ client_id: string; client_descr: string }> = [];
  const regex = /<CLIENT\s([^>]+)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xml)) !== null) {
    const attrs = m[1];
    const attr = (name: string) => {
      const hit = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
      return hit ? hit[1].trim() : "";
    };
    const client_id = attr("CLIENT_ID");
    const client_descr = attr("CLIENT_DESCR");
    if (client_id) results.push({ client_id, client_descr });
  }
  return results;
}

// ---------------------------------------------------------------------------
// parseSchemesXml — extrai <DATA> do datasource GET_VEHICLE_SETTINGS_GRID
// ---------------------------------------------------------------------------

interface SchemeEntry {
  vehicle_setting_id: number;
  vehicle_setting_name: string;
  created_by_user_name: string;
  updated_at: string;
}

function parseSchemesXml(xml: string): SchemeEntry[] {
  const results: SchemeEntry[] = [];
  const dsMatch = xml.match(/DATASOURCE="GET_VEHICLE_SETTINGS_GRID"[^>]*>([\s\S]*?)<\/DATASOURCE>/);
  if (!dsMatch) return results;
  const inner = dsMatch[1];
  const regex = /<DATA\s([^>]+)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(inner)) !== null) {
    const attrs = m[1];
    const attr = (name: string) => {
      const hit = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
      return hit ? hit[1].trim() : "";
    };
    const vehicle_setting_id = parseInt(attr("VEHICLE_SETTING_ID") || "0", 10);
    if (!vehicle_setting_id) continue;
    results.push({
      vehicle_setting_id,
      vehicle_setting_name: attr("VEHICLE_SETTING_NAME"),
      created_by_user_name: attr("CREATED_BY_USER_NAME"),
      updated_at:           attr("UPDATED_AT"),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// GET /api/admin/schemes — serve o JSON salvo
// ---------------------------------------------------------------------------

router.get("/schemes", (_req, res) => {
  try {
    if (!fs.existsSync(SCHEMES_JSON_PATH)) {
      return res.status(404).json({ ok: false, error: "schemes_active.json não encontrado — execute sync primeiro" });
    }
    const raw = fs.readFileSync(SCHEMES_JSON_PATH, "utf8");
    return res.json(JSON.parse(raw));
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/schemes — salva a seleção de schemes
// ---------------------------------------------------------------------------

router.post("/schemes", (req, res) => {
  try {
    const { clients } = req.body;
    if (!Array.isArray(clients)) {
      return res.status(400).json({ ok: false, error: "campo clients ausente ou inválido" });
    }
    const payload = {
      ok:            true,
      generated_at:  new Date().toISOString(),
      total_clients: clients.length,
      total_schemes: clients.reduce((acc: number, c: any) => acc + (c.schemes?.length || 0), 0),
      clients,
    };

    // 1. Salvar schemes_active.json (comportamento anterior)
    const dir = path.dirname(SCHEMES_JSON_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SCHEMES_JSON_PATH, JSON.stringify(payload, null, 2), "utf8");
    console.log(`[admin] schemes_active.json salvo — ${payload.total_clients} clientes, ${payload.total_schemes} schemes`);

    // ── PATCH_ADMIN_SYNC_SCHEME_IDS_V1 ──────────────────────────────────────
    // 2. Regenerar scheme_ids.txt a partir da seleção do Admin.
    //    Só inclui clientes que têm selected_scheme_id definido.
    //    Formato: CLIENT_ID;CLIENT_DESCR;VEHICLE_SETTING_ID
    try {
      const lines: string[] = ["CLIENT_ID;CLIENT_DESCR;VEHICLE_SETTING_ID"];
      for (const c of clients as any[]) {
        if (c.selected_scheme_id && c.client_id && c.client_descr) {
          lines.push(`${c.client_id};${c.client_descr};${c.selected_scheme_id}`);
        }
      }
      const schemeIdDir = path.dirname(SCHEME_IDS_PATH);
      if (!fs.existsSync(schemeIdDir)) fs.mkdirSync(schemeIdDir, { recursive: true });
      fs.writeFileSync(SCHEME_IDS_PATH, lines.join("\n") + "\n", "utf8");
      console.log(`[admin] scheme_ids.txt regenerado — ${lines.length - 1} clientes com scheme selecionado`);

      // 3. Recarregar fontes em memória — próximo job já usa o scheme correto
      reloadSchemeSources();
      console.log("[admin] clientRoutes recarregado após atualização de schemes");
    } catch (syncErr: any) {
      // Não bloqueia a resposta — schemes_active.json já foi salvo
      console.error("[admin] WARN: falha ao regenerar scheme_ids.txt:", syncErr?.message);
    }
    // ── fim PATCH_ADMIN_SYNC_SCHEME_IDS_V1 ──────────────────────────────────

    // Persistir no SQLite da VM via job assíncrono
    try {
      createJob("admin_config_sync", { key: "schemes_active", value: payload });
      console.log("[admin] admin_config_sync (schemes_active) enfileirado");
    } catch (e: any) {
      console.warn("[admin] admin_config_sync (schemes_active) falhou (não crítico):", e?.message);
    }

    return res.json({ ok: true, total_clients: payload.total_clients, total_schemes: payload.total_schemes });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/schemes/clients — busca lista de clientes no Traffilog
// ---------------------------------------------------------------------------

router.get("/schemes/clients", async (_req, res) => {
  try {
    console.log("[admin] buscando lista de clientes...");
    const adminCookie = await loginAdminToHtml5();
    if (!adminCookie) {
      return res.status(502).json({ ok: false, error: "Login admin falhou" });
    }

    const bodyParams = new URLSearchParams({
      REFRESH_FLG: "1",
      action:      "CLIENTS",
      VERSION_ID:  "2",
    });

    const resp = await httpPost(HTML5_ACTION_URL, bodyParams.toString(), { cookie: adminCookie });
    const clients = parseClientsXml(resp.body);
    console.log(`[admin] CLIENTS — ${clients.length} clientes encontrados`);
    return res.json({ ok: true, total: clients.length, clients });
  } catch (err: any) {
    console.error("[admin] schemes/clients error:", err?.message);
    return res.status(500).json({ ok: false, error: err?.message || "Erro interno" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/schemes/client/:clientId — schemes de um cliente específico
// ---------------------------------------------------------------------------

router.get("/schemes/client/:clientId", async (req, res) => {
  const clientId = req.params["clientId"];
  try {
    console.log(`[admin] buscando schemes do cliente ${clientId}...`);
    const adminCookie = await loginAdminToHtml5();
    if (!adminCookie) {
      return res.status(502).json({ ok: false, error: "Login admin falhou" });
    }

    const bodyParams = new URLSearchParams({
      CLIENT_ID:  clientId,
      action:     "GET_VEHICLE_SETTINGS_GRID",
      VERSION_ID: "2",
    });

    const resp = await httpPost(HTML5_ACTION_URL, bodyParams.toString(), { cookie: adminCookie });
    const schemes = parseSchemesXml(resp.body);
    console.log(`[admin] cliente ${clientId} — ${schemes.length} schemes`);
    return res.json({ ok: true, client_id: clientId, total: schemes.length, schemes });
  } catch (err: any) {
    console.error(`[admin] schemes/client/${clientId} error:`, err?.message);
    return res.status(500).json({ ok: false, error: err?.message || "Erro interno" });
  }
});

// ---------------------------------------------------------------------------
// Rotas de session-token (restauradas — existiam no adminRoutes original)
// ---------------------------------------------------------------------------

function requireAdminKey(req: any, res: any, next: any) {
  const expected = (process.env.SESSION_TOKEN_ADMIN_KEY || "").trim();
  const got = (req.header("x-admin-key") || req.header("X-Admin-Key") || "").trim();
  if (!expected) return res.status(500).json({ error: "SESSION_TOKEN_ADMIN_KEY not set" });
  if (!got || got !== expected) return res.status(401).json({ error: "unauthorized" });
  return next();
}

router.get("/session-token/status", requireAdminKey, (_req, res) => {
  return res.json(getSessionTokenStatus());
});

router.post("/session-token", requireAdminKey, (req, res) => {
  const token = (req.body && (req.body.sessionToken || req.body.token))
    ? String(req.body.sessionToken || req.body.token) : "";
  if (!token.trim()) return res.status(400).json({ error: "missing token (body.token or body.sessionToken)" });
  setSessionToken(token);
  return res.json({ ok: true, ...getSessionTokenStatus() });
});

router.get("/session-token", requireAdminKey, (_req, res) => {
  try {
    const token = String(fs.readFileSync("/tmp/.session_token", "utf8") || "").trim();
    if (!token) return res.status(404).json({ error: "empty_token" });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ token });
  } catch (e) {
    return res.status(404).json({ error: "not_found" });
  }
});

export default router;
