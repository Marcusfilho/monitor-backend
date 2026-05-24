/**
 * html5Session.ts
 * Serviço de sessão HTML5 (Traffilog) — extraído do monolito html5InstallWorker_v8.js
 *
 * Responsabilidades:
 *  - Manter cookiejar em disco (leitura/escrita atômica)
 *  - Garantir ASP.NET_SessionId via GET de warmup
 *  - Garantir TFL_SESSION via APPLICATION_LOGIN
 *  - Expor cookiejar como header string pronto para uso
 *
 * NÃO contém lógica de job, VHCLS, MWS, CMDT ou AppEngine.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";

// ---------------------------------------------------------------------------
// Config (injetada via env — mesmos nomes do monolito)
// ---------------------------------------------------------------------------

export interface Html5SessionConfig {
  cookieJarPath: string;     // HTML5_COOKIEJAR_PATH
  actionUrl: string;         // HTML5_ACTION_URL
  loginName: string;         // HTML5_LOGIN_NAME
  password: string;          // HTML5_PASSWORD
  language: string;          // HTML5_LANGUAGE (default "7001")
  httpTimeoutMs: number;     // HTTP_TIMEOUT_MS
}

export function configFromEnv(): Html5SessionConfig {
  return {
    cookieJarPath : (process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json").trim(),
    actionUrl     : (process.env.HTML5_ACTION_URL     || "https://html5.traffilog.com/AppEngine_2_1/default.aspx").trim(),
    loginName     : (process.env.HTML5_LOGIN_NAME     || "").trim(),
    password      : (process.env.HTML5_PASSWORD       || "").trim(),
    language      : String(process.env.HTML5_LANGUAGE || "7001").trim(),
    httpTimeoutMs : Number(process.env.HTTP_TIMEOUT_MS || 30_000),
  };
}

// ---------------------------------------------------------------------------
// Tipos internos
// ---------------------------------------------------------------------------

type CookieMap = Record<string, string>;

export interface CookieJarPayload {
  cookie: string;
  keys: string[];
  updatedAt: string;
  meta: Record<string, unknown>;
}

export interface SessionResult {
  map: CookieMap;
  cookie: string;
}

// ---------------------------------------------------------------------------
// Utilitários de cookie
// ---------------------------------------------------------------------------

/** Extrai lista de nomes de cookie de um header "A=1; B=2" */
export function cookieKeysFromCookieHeader(cookieHeader: string): string[] {
  const keys: string[] = [];
  for (const part of String(cookieHeader || "").split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    keys.push(p.slice(0, eq).trim());
  }
  return Array.from(new Set(keys));
}

/** Garante que EULA_APPROVED, LOGIN_DATA e APPLICATION_ROOT_NODE existam no header */
export function ensureCookieDefaults(cookieHeader: string): string {
  let c = String(cookieHeader || "").trim();
  const keys = new Set(cookieKeysFromCookieHeader(c));
  const add = (k: string, v: string) => {
    if (!keys.has(k)) {
      c = c ? `${c}; ${k}=${v}` : `${k}=${v}`;
      keys.add(k);
    }
  };
  add("EULA_APPROVED", "1");
  add("LOGIN_DATA", "");
  add("APPLICATION_ROOT_NODE", '{"node":"-2"}');
  return c;
}

/** Verifica se um nome de cookie existe no header */
function hasCookie(cookieHeader: string, name: string): boolean {
  try {
    return new RegExp(`(^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=`).test(String(cookieHeader || ""));
  } catch {
    return false;
  }
}

/** Flags de diagnóstico (sem vazar valores) */
export function cookieFlags(cookieHeader: string): string {
  return (
    `ASP=${hasCookie(cookieHeader, "ASP.NET_SessionId") ? 1 : 0}` +
    ` TFL=${hasCookie(cookieHeader, "TFL_SESSION") ? 1 : 0}` +
    ` EULA=${hasCookie(cookieHeader, "EULA_APPROVED") ? 1 : 0}` +
    ` ROOT=${hasCookie(cookieHeader, "APPLICATION_ROOT_NODE") ? 1 : 0}`
  );
}

// ---------------------------------------------------------------------------
// Operações de CookieMap (estrutura interna do jar)
// ---------------------------------------------------------------------------

function parseCookieHeaderToMap(h: string): CookieMap {
  const out: CookieMap = {};
  for (const part of String(h || "").split(";")) {
    const kv = part.trim();
    if (!kv) continue;
    const i = kv.indexOf("=");
    if (i <= 0) continue;
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Converte conteúdo raw do jar (JSON ou header puro) para CookieMap */
function parseJarToMap(raw: string): CookieMap {
  const txt = String(raw || "").trim();
  if (!txt) return {};

  // cookie header direto "A=B; C=D"
  if (txt[0] !== "{" && txt[0] !== "[" && txt.indexOf("=") > 0) {
    return parseCookieHeaderToMap(txt);
  }

  // JSON object
  if (txt[0] === "{") {
    try {
      const j = JSON.parse(txt);
      if (j && typeof j === "object" && !Array.isArray(j)) {
        const DROP = new Set(["cookie","cookies","keys","updatedAt","createdAt","meta","id","job","payload","status","type","service","plate","workerId"]);

        // formato canônico: { cookie: "A=1; B=2", ... }
        if (typeof j.cookie === "string" && j.cookie.indexOf("=") > 0) {
          const out = parseCookieHeaderToMap(j.cookie);
          // merge de extras fora do campo "cookie" (PATCH_VA1_COOKIEJAR_MERGE_EXTRAS_V3)
          for (const k of Object.keys(j)) {
            if (!k || DROP.has(k)) continue;
            const v = j[k];
            if (typeof v !== "string") continue;
            if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) continue;
            if (out[k] === undefined) out[k] = v;
          }
          return out;
        }

        // formato: { cookies: [{name, value}] }
        if (Array.isArray(j.cookies)) {
          const out: CookieMap = {};
          for (const it of j.cookies) {
            if (it && typeof it === "object" && it.name && it.value !== undefined)
              out[String(it.name)] = String(it.value);
          }
          return out;
        }

        // formato map: { TFL_SESSION: "...", ASP.NET_SessionId: "..." }
        const out: CookieMap = {};
        for (const k of Object.keys(j)) {
          if (!k || DROP.has(k)) continue;
          const v = j[k];
          if (typeof v !== "string") continue;
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) continue;
          out[k] = v;
        }
        return out;
      }
    } catch { /* continua */ }
  }

  // JSON list [{name, value}]
  if (txt[0] === "[") {
    try {
      const j = JSON.parse(txt);
      const out: CookieMap = {};
      if (Array.isArray(j)) {
        for (const it of j) {
          if (it && typeof it === "object" && it.name && it.value !== undefined)
            out[String(it.name)] = String(it.value);
        }
      }
      return out;
    } catch { /* continua */ }
  }

  return parseCookieHeaderToMap(txt);
}

/** Converte CookieMap → cookie header string, com ordenação canônica */
function mapToCookieHeader(m: CookieMap): string {
  const obj = { ...m };

  // URL-encode APPLICATION_ROOT_NODE se contiver chaves/aspas (PATCH_ROOTNODE_URLENCODE_V1)
  try {
    const rv = obj["APPLICATION_ROOT_NODE"];
    if (typeof rv === "string" && rv && /[{}"]/.test(rv) && !rv.includes("%7B")) {
      obj["APPLICATION_ROOT_NODE"] = encodeURIComponent(rv);
    }
  } catch { /* ignora */ }

  const DROP = new Set(["cookie","cookies","keys","updatedAt","createdAt","meta","id","job","payload","status","type","service","plate","workerId"]);
  const CORE = ["ASP.NET_SessionId","TFL_SESSION","EULA_APPROVED","APPLICATION_ROOT_NODE","LOGIN_DATA","AWSALB","AWSALBCORS"];

  const ordered: string[] = [];
  const seen = new Set<string>();

  const add = (k: string) => {
    if (!k || DROP.has(k) || seen.has(k)) return;
    const v = obj[k];
    if (typeof v !== "string" || v === "") return;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) return;
    seen.add(k);
    ordered.push(k);
  };

  for (const k of CORE) add(k);
  for (const k of Object.keys(obj)) add(k);

  return ordered.map(k => `${k}=${obj[k]}`).join("; ");
}

/** Seed de cookies obrigatórios (EULA_APPROVED + APPLICATION_ROOT_NODE) */
function seedCoreCookies(mapIn: CookieMap): { m: CookieMap; changed: boolean } {
  const m = { ...mapIn };
  let changed = false;
  if (!m["EULA_APPROVED"]) { m["EULA_APPROVED"] = "1"; changed = true; }
  if (!m["APPLICATION_ROOT_NODE"]) { m["APPLICATION_ROOT_NODE"] = "%7B%22node%22%3A%22-2%22%7D"; changed = true; }
  return { m, changed };
}

/** Merge de Set-Cookie headers no CookieMap */
function mergeSetCookieIntoMap(m: CookieMap, setCookies: string[]): CookieMap {
  const out = { ...m };
  for (const sc of setCookies) {
    const first = String(sc || "").split(";")[0];
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const k = first.slice(0, i).trim();
    const v = first.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leitura/escrita atômica do jar
// ---------------------------------------------------------------------------

function readJarRaw(jarPath: string): string {
  try { return fs.readFileSync(jarPath, "utf8"); } catch { return ""; }
}

function writeJarMap(jarPath: string, m: CookieMap): void {
  try {
    const tmp = `${jarPath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(m), "utf8");
    fs.renameSync(tmp, jarPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[html5Session] WARN writeJar failed: ${msg}`);
  }
}

function getSetCookieList(res: Response): string[] {
  try {
    if (res.headers) {
      if (typeof (res.headers as any).getSetCookie === "function")
        return (res.headers as any).getSetCookie() || [];
      const sc = res.headers.get("set-cookie");
      if (sc && !sc.includes(",")) return [sc];
    }
  } catch { /* ignora */ }
  return [];
}

// ---------------------------------------------------------------------------
// Operações de jar públicas (para uso pelos workers)
// ---------------------------------------------------------------------------

/** Lê o jar e retorna o cookie header pronto */
export function readJarCookie(jarPath: string): string {
  const raw = readJarRaw(jarPath);
  const m = parseJarToMap(raw);
  return mapToCookieHeader(m);
}

/** Salva cookie header no jar (formato canônico JSON) */
export async function saveJar(
  jarPath: string,
  cookieHeader: string,
  meta: Record<string, unknown> = {}
): Promise<string[]> {
  const cookie = ensureCookieDefaults(cookieHeader || "");
  const keys = cookieKeysFromCookieHeader(cookie);
  const payload: CookieJarPayload = {
    cookie,
    keys,
    updatedAt: new Date().toISOString(),
    meta,
  };
  await fsp.writeFile(jarPath, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
  return keys;
}

// ---------------------------------------------------------------------------
// HTTP helpers (isolados — sem dependência dos outros serviços)
// ---------------------------------------------------------------------------

async function fetchGet(url: string, cookieHeader: string, timeoutMs: number): Promise<{ status: number; setCookies: string[] }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        cookie: cookieHeader,
        "user-agent": "monitor-backend-html5-worker/rw",
      },
      signal: controller.signal,
    });
    return { status: res.status, setCookies: getSetCookieList(res) };
  } finally {
    clearTimeout(t);
  }
}

async function fetchPost(
  url: string,
  body: string,
  cookieHeader: string,
  extraHeaders: Record<string, string>,
  timeoutMs: number
): Promise<{ status: number; text: string; cookie: string }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "monitor-backend-html5-worker/rw",
        ...extraHeaders,
      },
      body,
      signal: controller.signal,
    });
    // merge Set-Cookie de volta no cookieHeader
    const setCookies = getSetCookieList(res);
    let mergedCookie = cookieHeader;
    for (const sc of setCookies) {
      const first = sc.split(";")[0];
      const i = first.indexOf("=");
      if (i > 0) {
        const k = first.slice(0, i).trim();
        const v = first.slice(i + 1).trim();
        // substitui ou acrescenta
        const re = new RegExp(`(^|;\\s*)${k}=[^;]*`);
        if (re.test(mergedCookie)) {
          mergedCookie = mergedCookie.replace(re, `$1${k}=${v}`);
        } else {
          mergedCookie = mergedCookie ? `${mergedCookie}; ${k}=${v}` : `${k}=${v}`;
        }
      }
    }
    const text = await res.text().catch(() => "");
    return { status: res.status, text, cookie: mergedCookie };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// warmupAsp — GET para materializar ASP.NET_SessionId
// ---------------------------------------------------------------------------

export async function warmupAsp(cfg: Html5SessionConfig): Promise<void> {
  const jarPath = cfg.cookieJarPath;
  try {
    const raw = readJarRaw(jarPath);
    const currentCookie = mapToCookieHeader(parseJarToMap(raw));

    const { status, setCookies } = await fetchGet(cfg.actionUrl, currentCookie, cfg.httpTimeoutMs);

    if (setCookies.length > 0) {
      const m = parseJarToMap(readJarRaw(jarPath));
      const merged = mergeSetCookieIntoMap(m, setCookies);
      writeJarMap(jarPath, merged);
      const ck = mapToCookieHeader(merged);
      console.log(`[html5Session] warmupAsp status=${status} setCookie=${setCookies.length} flags=${cookieFlags(ck)} jarBytes=${raw.length}`);
    } else {
      console.log(`[html5Session] warmupAsp status=${status} setCookie=0`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[html5Session] warmupAsp ERR ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// html5Login — APPLICATION_LOGIN (bootstrap + login)
// ---------------------------------------------------------------------------

async function bootstrapCookies(cfg: Html5SessionConfig, existingCookie: string): Promise<string> {
  const r = await fetchGet(
    "https://html5.traffilog.com/appv2/index.htm",
    existingCookie,
    cfg.httpTimeoutMs
  );
  // merge Set-Cookie no jar
  const m = parseJarToMap(readJarRaw(cfg.cookieJarPath));
  const merged = mergeSetCookieIntoMap(m, r.setCookies);
  writeJarMap(cfg.cookieJarPath, merged);
  return mapToCookieHeader(merged);
}

export async function html5Login(
  cfg: Html5SessionConfig,
  existingCookie = ""
): Promise<{ status: number; cookie: string; cookieKeys: string[]; hasTfl: boolean }> {
  if (!cfg.loginName || !cfg.password)
    throw new Error("[html5Session] html5Login: missing loginName / password");

  const cookie = await bootstrapCookies(cfg, existingCookie);

  const body = new URLSearchParams({
    username      : cfg.loginName,
    password      : cfg.password,
    language      : cfg.language,
    BOL_SAVE_COOKIE: "1",
    action        : "APPLICATION_LOGIN",
    VERSION_ID    : "2",
  }).toString();

  const r = await fetchPost(
    cfg.actionUrl,
    body,
    cookie,
    {
      accept         : "*/*",
      origin         : "https://html5.traffilog.com",
      referer        : "https://html5.traffilog.com/appv2/index.htm",
      "pragma"       : "no-cache",
      "cache-control": "no-cache",
    },
    cfg.httpTimeoutMs
  );

  const keys = await saveJar(cfg.cookieJarPath, r.cookie, { source: "login", httpStatus: r.status });
  const hasTfl = keys.includes("TFL_SESSION");

  console.log(`[html5Session] html5Login status=${r.status} hasTfl=${hasTfl} keys=${keys.join(",")}`);
  return { status: r.status, cookie: r.cookie, cookieKeys: keys, hasTfl };
}

// ---------------------------------------------------------------------------
// ensureHtml5Session — ponto de entrada principal
// ---------------------------------------------------------------------------

/**
 * Garante que o jar tem ASP.NET_SessionId + TFL_SESSION + cookies core.
 * Chame antes de qualquer request HTML5.
 *
 * @returns SessionResult com o CookieMap atualizado e o cookie header pronto
 */
export async function ensureHtml5Session(cfg: Html5SessionConfig, tag = "ENSURE"): Promise<SessionResult> {
  const raw0 = readJarRaw(cfg.cookieJarPath);
  const m0 = parseJarToMap(raw0);
  const ck0 = mapToCookieHeader(m0);

  const hasAsp0 = hasCookie(ck0, "ASP.NET_SessionId");
  const hasTfl0 = hasCookie(ck0, "TFL_SESSION");

  if (!hasAsp0) {
    console.log(`[html5Session] [${tag}] no ASP.NET_SessionId → warmupAsp`);
    await warmupAsp(cfg);
  }

  if (!hasTfl0) {
    console.log(`[html5Session] [${tag}] no TFL_SESSION → html5Login`);
    await html5Login(cfg);
  }

  // lê jar atualizado
  const raw1 = readJarRaw(cfg.cookieJarPath);
  const m1 = parseJarToMap(raw1);

  // seed de cookies core obrigatórios
  const { m: m1s, changed } = seedCoreCookies(m1);
  if (changed) writeJarMap(cfg.cookieJarPath, m1s);

  const ck1 = mapToCookieHeader(m1s);
  console.log(`[html5Session] [${tag}] flags=${cookieFlags(ck1)} jarBytes=${raw1.length} cookieLen=${ck1.length}`);

  return { map: m1s, cookie: ck1 };
}
