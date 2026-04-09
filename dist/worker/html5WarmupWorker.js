// html5WarmupWorker.js
// Worker enxuto de warmup HTML5.
// Fica em polling por jobs do tipo "html5_warmup".
// Quando recebe um: faz login no HTML5 (APPLICATION_LOGIN),
// salva o cookie em /tmp/html5_cookiejar.json e sincroniza com o Render.
// Zero alteração no html5InstallWorker_v8.js.

"use strict";

const fs   = require("fs");
const fsp  = fs.promises;
const http  = require("http");
const https = require("https");

// === Configuração ============================================================
const BASE         = (process.env.JOB_SERVER_BASE_URL || "").replace(/\/+$/, "");
const WORKER_KEY   = (process.env.WORKER_KEY   || "").trim();
const WORKER_ID    = (process.env.WORKER_ID    || "vm-tunel-warmup").trim();
const POLL_MS      = Number(process.env.WARMUP_POLL_MS || process.env.POLL_INTERVAL_MS || 5000);
const HTTP_TIMEOUT = Number(process.env.HTTP_TIMEOUT_MS || 30000);
const COOKIEJAR_PATH = (process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json").trim();
const SYNC_SECRET  = (process.env.COOKIE_SYNC_SECRET || "").trim();

const HTML5_LOGIN_NAME = (process.env.HTML5_LOGIN_NAME || "").trim();
const HTML5_PASSWORD   = (process.env.HTML5_PASSWORD   || "").trim();
const HTML5_LANGUAGE   = (process.env.HTML5_LANGUAGE   || "7001").trim();
const HTML5_ACTION_URL = (process.env.HTML5_ACTION_URL || "https://html5.traffilog.com/AppEngine_2_1/default.aspx").trim();
const HTML5_INDEX_URL  = "https://html5.traffilog.com/appv2/index.htm";

if (!BASE)       { console.error("[warmup] ERRO: JOB_SERVER_BASE_URL não definido"); process.exit(1); }
if (!WORKER_KEY) { console.error("[warmup] ERRO: WORKER_KEY não definido"); process.exit(1); }
if (!HTML5_LOGIN_NAME || !HTML5_PASSWORD) {
  console.error("[warmup] ERRO: HTML5_LOGIN_NAME / HTML5_PASSWORD não definidos"); process.exit(1);
}

// === Helpers ================================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowISO()  { return new Date().toISOString(); }

function cookieKeysFromHeader(h) {
  const keys = [];
  for (const part of String(h || "").split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    keys.push(p.slice(0, eq).trim());
  }
  return Array.from(new Set(keys));
}

function ensureCookieDefaults(h) {
  let c = String(h || "").trim();
  const keys = new Set(cookieKeysFromHeader(c));
  const add = (k, v) => {
    if (!keys.has(k)) { c = c ? `${c}; ${k}=${v}` : `${k}=${v}`; keys.add(k); }
  };
  add("EULA_APPROVED", "1");
  add("LOGIN_DATA", "");
  add("APPLICATION_ROOT_NODE", encodeURIComponent('{"node":"-2"}'));
  return c;
}

function extractSetCookies(headers) {
  if (headers && typeof headers.getSetCookie === "function") {
    try { return headers.getSetCookie() || []; } catch {}
  }
  const one = headers && typeof headers.get === "function" ? headers.get("set-cookie") : null;
  return one ? [one] : [];
}

function mergeCookies(existing, setCookieArr) {
  const map = new Map();
  for (const part of String(existing || "").split(";")) {
    const p = part.trim(); if (!p) continue;
    const eq = p.indexOf("="); if (eq <= 0) continue;
    map.set(p.slice(0, eq).trim(), p.slice(eq + 1).trim());
  }
  for (const sc of (setCookieArr || [])) {
    const first = String(sc || "").split(";")[0].trim();
    const eq = first.indexOf("="); if (eq <= 0) continue;
    map.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  const out = [];
  for (const [k, v] of map.entries()) out.push(`${k}=${v}`);
  return out.join("; ");
}

// === Fetch com cookie ========================================================
async function fetchWithCookie(url, opts = {}, cookieHeader = "") {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT);
  let cookie = ensureCookieDefaults(cookieHeader);
  try {
    const res = await fetch(url, {
      method:   opts.method   || "GET",
      headers:  { ...( opts.headers || {} ), ...(cookie ? { cookie } : {}), "user-agent": "monitor-backend-warmup/1" },
      body:     opts.body     || null,
      redirect: "manual",
      signal:   controller.signal,
    });
    const text = await res.text().catch(() => "");
    cookie = mergeCookies(cookie, extractSetCookies(res.headers));
    return { status: res.status, text, cookie };
  } finally {
    clearTimeout(t);
  }
}

// === Login HTML5 ============================================================
async function html5Login() {
  console.log("[warmup] Iniciando login HTML5...");

  // 1) Bootstrap — pega AWSALB + ASP.NET_SessionId
  const boot = await fetchWithCookie(HTML5_INDEX_URL, {
    method: "GET",
    headers: { accept: "text/html", referer: HTML5_INDEX_URL },
  }, "");
  console.log(`[warmup] bootstrap status=${boot.status} cookieKeys=${cookieKeysFromHeader(boot.cookie).join(",")}`);

  // 2) APPLICATION_LOGIN
  const body = new URLSearchParams({
    username:      HTML5_LOGIN_NAME,
    password:      HTML5_PASSWORD,
    language:      HTML5_LANGUAGE,
    BOL_SAVE_COOKIE: "1",
    action:        "APPLICATION_LOGIN",
    VERSION_ID:    "2",
  }).toString();

  const login = await fetchWithCookie(HTML5_ACTION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "origin":       "https://html5.traffilog.com",
      "referer":      HTML5_INDEX_URL,
      "pragma":       "no-cache",
      "cache-control":"no-cache",
    },
    body,
  }, boot.cookie);

  const keys = cookieKeysFromHeader(login.cookie);
  const hasTfl = keys.includes("TFL_SESSION");
  console.log(`[warmup] login status=${login.status} keys=${keys.join(",")} hasTfl=${hasTfl}`);

  if (!hasTfl) {
    // tenta extrair mensagem de erro do XML de resposta
    const errMatch = login.text.match(/<TEXT>([\s\S]*?)<\/TEXT>/i);
    const errTxt = errMatch ? errMatch[1].trim() : login.text.slice(0, 200);
    throw new Error(`[warmup] TFL_SESSION não obtido após login. Resposta: ${errTxt}`);
  }

  return login.cookie;
}

// === Salvar e sincronizar cookie =============================================
async function saveCookieJar(cookieHeader) {
  const cookie = ensureCookieDefaults(cookieHeader);
  const keys   = cookieKeysFromHeader(cookie);
  const payload = { cookie, keys, updatedAt: nowISO(), meta: { source: "warmup" } };
  await fsp.writeFile(COOKIEJAR_PATH, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
  console.log(`[warmup] cookiejar salvo — keys: ${keys.join(", ")}`);
  return payload;
}

async function syncCookieToRender(payload) {
  if (!BASE) return;
  const bodyBuf = Buffer.from(JSON.stringify(payload), "utf8");
  const u = new URL(BASE + "/api/clients/sync-cookie");
  const mod = u.protocol === "https:" ? https : http;
  await new Promise((resolve) => {
    const req = mod.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === "https:" ? 443 : 80),
      path:     u.pathname,
      method:   "POST",
      headers:  {
        "content-type":   "application/json",
        "content-length": bodyBuf.length,
        ...(SYNC_SECRET ? { "x-sync-secret": SYNC_SECRET } : {}),
      },
    }, (res) => {
      res.resume();
      console.log(`[warmup] sync Render status=${res.statusCode}`);
      resolve(null);
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.on("error", (e) => { console.warn("[warmup] sync erro:", e.message); resolve(null); });
    req.write(bodyBuf);
    req.end();
  });
}

// === Job server =============================================================
async function jobFetch(path, { method = "GET", json = null, params = null } = {}) {
  let url = BASE + path;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += "?" + qs;
  }
  const opts = {
    method,
    headers: {
      "content-type": "application/json",
      ...(WORKER_KEY ? { "x-worker-key": WORKER_KEY } : {}),
    },
    ...(json ? { body: JSON.stringify(json) } : {}),
  };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

async function completeJob(jobId, status, message) {
  try {
    await jobFetch(`/api/jobs/${jobId}/progress`, { method: "POST", json: { percent: 100, stage: "completed" } });
    await jobFetch(`/api/jobs/${jobId}/complete`, { method: "POST", json: { status, result: { status, message } } });
  } catch (e) {
    console.warn("[warmup] completeJob erro:", e.message);
  }
}

// === Loop principal =========================================================
async function mainLoop() {
  console.log(`[warmup] Iniciando. BASE=${BASE} WORKER_ID=${WORKER_ID} POLL_MS=${POLL_MS}`);

  while (true) {
    try {
      const r = await jobFetch("/api/jobs/next", { params: { type: "html5_warmup", worker: WORKER_ID } });

      if (r.status === 204 || !r.data) {
        await sleep(POLL_MS);
        continue;
      }

      const job = r.data?.job || r.data;
      const jobId = job?.id;
      if (!jobId) { await sleep(POLL_MS); continue; }

      console.log(`[warmup] GOT job id=${jobId}`);

      try {
        const cookie  = await html5Login();
        const payload = await saveCookieJar(cookie);
        await syncCookieToRender(payload);
        await completeJob(jobId, "ok", "warmup ok");
        console.log(`[warmup] job ${jobId} concluído com sucesso.`);
      } catch (e) {
        console.error(`[warmup] job ${jobId} ERRO:`, e.message);
        await completeJob(jobId, "error", e.message);
      }

    } catch (e) {
      console.error("[warmup] loop erro:", e.message);
    }

    await sleep(POLL_MS);
  }
}

mainLoop().catch(e => { console.error("[warmup] fatal:", e); process.exit(1); });
