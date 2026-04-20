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

async function fetchUsedAssetTypeIds(adminCookie: string): Promise<Set<number>> {
  const bodyParams = new URLSearchParams({
    action:     "VHCLS",
    VERSION_ID: "2",
  });

  console.log("[admin] chamando VHCLS...");
  const resp = await httpPost(HTML5_ACTION_URL, bodyParams.toString(), { cookie: adminCookie });
  const xml = resp.body;
  console.log(`[admin] VHCLS resposta: ${xml.length} chars`);

  const used = new Set<number>();
  const re = /ASSET_TYPE\s*=\s*"(\d+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const id = Number(m[1]);
    if (id > 0) used.add(id);
  }

  console.log(`[admin] VHCLS — asset_type IDs únicos encontrados: ${used.size}`);
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

    // 3. Match: filtra apenas os modelos que têm veículos na base
    const matched = catalog.filter(entry => usedIds.has(entry.id));

    // Ordena por fabricante + modelo para facilitar inspeção
    matched.sort((a, b) => {
      const mfg = a.manufacturer.localeCompare(b.manufacturer);
      return mfg !== 0 ? mfg : a.model.localeCompare(b.model);
    });

    console.log(`[admin] match: ${matched.length} modelos de ${catalog.length} no catálogo (${usedIds.size} IDs únicos nos veículos)`);

    // 4. Salva JSON
    const output = {
      generated_at:    new Date().toISOString(),
      total_vhcls_ids: usedIds.size,
      total_catalog:   catalog.length,
      total_matched:   matched.length,
      asset_types:     matched,
    };

    // Garante que o diretório config/ existe
    const dir = path.dirname(ASSET_TYPES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(ASSET_TYPES_PATH, JSON.stringify(output, null, 2), "utf8");
    console.log(`[admin] JSON salvo em ${ASSET_TYPES_PATH}`);

    return res.json({
      ok:              true,
      total_vhcls_ids: usedIds.size,
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

export default router;
