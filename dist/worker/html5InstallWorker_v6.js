"use strict";

/**
 * v6: login direto no HTML5 (APPLICATION_LOGIN) - sem login cURL file
 * - login POST form-urlencoded em /AppEngine_2_1/default.aspx
 * - valida que cookie final contém TFL_SESSION
 * - retry 1x quando detectar login=-1 na action
 */

const fs = require("fs");
const fsp = fs.promises;

const BASE = (process.env.JOB_SERVER_BASE_URL || "").replace(/\/+$/, "");
const WORKER_KEY = (process.env.WORKER_KEY || "").trim();
const WORKER_ID = (process.env.WORKER_ID || "tunel").trim();

const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 20000);

const DRY_RUN = String(process.env.DRY_RUN || "1") !== "0";
const EXECUTE_HTML5 = String(process.env.EXECUTE_HTML5 || "0").toLowerCase() === "true" || String(process.env.EXECUTE_HTML5 || "0") === "1";

const HTML5_ACTION_URL = (process.env.HTML5_ACTION_URL || "https://html5.traffilog.com/AppEngine_2_1/default.aspx").trim();
const COOKIEJAR_PATH = (process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json").trim();

const HTML5_LOGIN_NAME = (process.env.HTML5_LOGIN_NAME || "").trim();
const HTML5_PASSWORD = (process.env.HTML5_PASSWORD || "").trim();
const HTML5_LANGUAGE = String(process.env.HTML5_LANGUAGE || "7001").trim();

if (!BASE) { console.error("[html5_v6] missing JOB_SERVER_BASE_URL"); process.exit(2); }
if (!WORKER_KEY) { console.error("[html5_v6] missing WORKER_KEY"); process.exit(2); }

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function nowISO(){ return new Date().toISOString(); }

function maskSerial(s){
  s = String(s || "").replace(/\s+/g, "");
  if (!s) return null;
  if (s.length <= 4) return "***";
  return s.slice(0,3) + "***" + s.slice(-2);
}
function safeSnippet(text, n=260){
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.slice(0, n);
}
function cookieKeysFromCookieHeader(cookieHeader){
  const c = String(cookieHeader || "");
  const keys = [];
  for (const part of c.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    keys.push(p.slice(0, eq).trim());
  }
  return Array.from(new Set(keys));
}

function ensureCookieDefaults(cookieHeader){
  // HTML5 costuma carregar estes cookies “base” no browser
  let c = String(cookieHeader || "").trim();
  const keys = new Set(cookieKeysFromCookieHeader(c));
  const add = (k, v) => {
    if (!keys.has(k)) {
      c = c ? (c + "; " + k + "=" + v) : (k + "=" + v);
      keys.add(k);
    }
  };
  add("EULA_APPROVED", "1");
  add("LOGIN_DATA", "");
  // o browser manda exatamente {"node":"-1"}
  add("APPLICATION_ROOT_NODE", '{"node":"-2"}');
  return c;
}
async function loadCookieJar(){
  try {
    const raw = await fsp.readFile(COOKIEJAR_PATH, "utf-8");
    const j = JSON.parse(raw);
    const fields = { cookie: String(j.cookie || ""), updatedAt: j.updatedAt || null };
  } catch { return { cookie: "", updatedAt: null }; }
}
async function saveCookieJar(cookieHeader, meta){
  const keys = cookieKeysFromCookieHeader(cookieHeader);
  const payload = { cookie: cookieHeader, keys, updatedAt: nowISO(), meta: meta || {} };
  await fsp.writeFile(COOKIEJAR_PATH, JSON.stringify(payload, null, 2), { encoding:"utf-8", mode:0o600 });
  return keys;
}
function extractSetCookies(headers){
  if (headers && typeof headers.getSetCookie === "function") {
    try { return headers.getSetCookie() || []; } catch {}
  }
  const one = headers && typeof headers.get === "function" ? headers.get("set-cookie") : null;
  return one ? [one] : [];
}
function mergeCookies(existingCookieHeader, setCookieArr){
  const map = new Map();
  for (const part of String(existingCookieHeader || "").split(";")) {
    const p = part.trim(); if (!p) continue;
    const eq = p.indexOf("="); if (eq <= 0) continue;
    map.set(p.slice(0,eq).trim(), p.slice(eq+1).trim());
  }
  for (const sc of (setCookieArr || [])) {
    const first = String(sc || "").split(";")[0].trim();
    const eq = first.indexOf("="); if (eq <= 0) continue;
    map.set(first.slice(0,eq).trim(), first.slice(eq+1).trim());
  }
  const out=[]; for (const [k,v] of map.entries()) out.push(`${k}=${v}`);
  return out.join("; ");
}

async function fetchWithCookies(url, { method="GET", headers={}, body=null } = {}, cookieHeader=""){
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let cookie = cookieHeader || "";
  let lastStatus = 0, lastText = "", lastHeaders = null;

  try{
    const res = await fetch(url, { method, headers: { ...headers, ...(cookie?{cookie}:{}), "user-agent":"monitor-backend-html5-worker/6" }, body, redirect:"manual", signal: controller.signal });
    lastStatus = res.status;
    lastHeaders = res.headers;
    cookie = mergeCookies(cookie, extractSetCookies(res.headers));
    lastText = await res.text().catch(() => "");
    return { status:lastStatus, text:lastText, cookie, headers:lastHeaders };
  } finally { clearTimeout(t); }
}

// Job server
async function httpFetch(path, { method="GET", params=null, json=null } = {}) {
  const u = new URL(BASE + path);
  if (params) for (const [k,v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), {
      method,
      headers: { "x-worker-key": WORKER_KEY, ...(json ? { "content-type":"application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
      signal: controller.signal
    });
    const text = await res.text().catch(() => "");
    let data=null; try { data = text ? JSON.parse(text) : null; } catch { data=text; }
    return { status: res.status, data };
  } finally { clearTimeout(t); }
}
async function completeJob(id, status, result){
  return httpFetch(`/api/jobs/${encodeURIComponent(String(id))}/complete`, { method:"POST", json:{ status, result, workerId: WORKER_ID } });
}

// HTML5 bootstrap (opcional, mas ajuda a ganhar ASP.NET_SessionId etc.)
async function html5BootstrapCookies(existingCookie){
  const r = await fetchWithCookies("https://html5.traffilog.com/appv2/index.htm", {
    method:"GET",
    headers:{ "accept":"text/html,application/xhtml+xml", "referer":"https://html5.traffilog.com/appv2/index.htm" }
  }, existingCookie || "");
  await saveCookieJar(r.cookie, { source:"bootstrap", httpStatus:r.status });
  return r.cookie;
}

// LOGIN direto: APPLICATION_LOGIN
async function html5LoginAndStoreCookies(existingCookie){
  if (!HTML5_LOGIN_NAME || !HTML5_PASSWORD) throw new Error("missing HTML5_LOGIN_NAME / HTML5_PASSWORD");

  let cookie = existingCookie || "";
  cookie = await html5BootstrapCookies(cookie);

  const body = new URLSearchParams({
    username: HTML5_LOGIN_NAME,
    password: HTML5_PASSWORD,
    language: HTML5_LANGUAGE,
    BOL_SAVE_COOKIE: "0",
    action: "APPLICATION_LOGIN",
    VERSION_ID: "2",
  }).toString();

  const r = await fetchWithCookies(HTML5_ACTION_URL, {
    method:"POST",
    headers:{
      "accept":"*/*",
      "content-type":"application/x-www-form-urlencoded",
      "origin":"https://html5.traffilog.com",
      "referer":"https://html5.traffilog.com/appv2/index.htm",
      "pragma":"no-cache",
      "cache-control":"no-cache"
    },
    body
  }, cookie);

  const keys = await saveCookieJar(ensureCookieDefaults(r.cookie), { source:"login", httpStatus:r.status });
  const hasTfl = keys.includes("TFL_SESSION");

  return { status:r.status, cookie:r.cookie, cookieKeys:keys, snippet:safeSnippet(r.text), hasTfl };
}

// Action SAVE
function buildSaveActivationFields(payload){
  const serial = String(payload.serial || payload.DIAL_NUMBER || payload.INNER_ID || "").trim();
  const plate  = String(payload.plate || payload.LICENSE_NMBR || payload.LICENSE_NMBR || "").trim();
  const installationDate = String(payload.installationDate || payload.INSTALLATION_DATE || "").trim();

  const assetType = payload.assetType != null ? String(payload.assetType) : "";
  const fieldIds  = String(payload.fieldIds || payload.FIELD_IDS || "");
  const fieldVal  = String(payload.fieldValue || payload.FIELD_VALUE || "");

  // defaults (iguais ao browser)
  const fields = {
    ASSIGNED_VEHICLE_SETTING_ID: String(payload.ASSIGNED_VEHICLE_SETTING_ID ?? -1),
    LINK_AND_RUN: String(payload.LINK_AND_RUN ?? 0),
    UPDATE_DRIVER_CODE: String(payload.UPDATE_DRIVER_CODE ?? 0),

    LOG_UNIT_DATA_UNTIL_DATE: String(payload.LOG_UNIT_DATA_UNTIL_DATE || installationDate),

    VEHICLE_ID: payload.vehicleId != null ? String(payload.vehicleId) : "",
    FIELD_IDS: fieldIds,
    FIELD_VALUE: fieldVal,

    LICENSE_NMBR: plate,
    INNER_ID: String(payload.INNER_ID || serial),

    SAFETY_GROUP_ID: String(payload.SAFETY_GROUP_ID ?? -1),
    NICK_NAME: String(payload.NICK_NAME ?? ""),

    DIAL_NUMBER: serial,
    SIM_NUMBER: String(payload.SIM_NUMBER ?? ""),

    UNIT_TYPE_ID: String(payload.UNIT_TYPE_ID ?? 1),

    MILAGE_SOURCE_ID: String(payload.MILAGE_SOURCE_ID ?? 5067),

    ID_DRIVER_ID: String(payload.ID_DRIVER_ID ?? -1),
    ID_TEMP_SENSORS: String(payload.ID_TEMP_SENSORS ?? -1),
    ID_D_MASS: String(payload.ID_D_MASS ?? -1),
    ID_TRAILER: String(payload.ID_TRAILER ?? -1),
    ID_DOORS: String(payload.ID_DOORS ?? -1),
    ID_MDT: String(payload.ID_MDT ?? -1),
    ID_MODEM: String(payload.ID_MODEM ?? -1),
    ID_TACHOGRAPH: String(payload.ID_TACHOGRAPH ?? -1),

    // (sim, o browser escreve assim: ACCOSSORIES...)
    ACCOSSORIES_COMMENTS: String(payload.ACCOSSORIES_COMMENTS ?? ""),

    INSTALLATION_DATE: installationDate,
    INSTALLED_BY: String(payload.installedBy || payload.INSTALLED_BY || ""),
    INSTALLATION_PLACE: String(payload.installationPlace || payload.INSTALLATION_PLACE || ""),

    WARRANTY_START_DATE: String(payload.WARRANTY_START_DATE || payload.warrantyStartDate || installationDate),
    WARRANTY_PERIOD_ID: String(payload.WARRANTY_PERIOD_ID ?? 1),

    ASSET_TYPE: assetType,

    LOGISTIC_COMMENTS: String(payload.LOGISTIC_COMMENTS ?? ""),

    FIRMWARE_TYPE_ID: String(payload.FIRMWARE_TYPE_ID ?? 2),

    iDRIVE_UNIT_SN: String(payload.iDRIVE_UNIT_SN ?? ""),

    DUPLICATE: String(payload.DUPLICATE ?? 0),
    DUPLICATE_VEHICLE: String(payload.DUPLICATE_VEHICLE ?? -1),

    SVR_ID: String(payload.SVR_ID ?? -1),
    BUILD_ID: String(payload.BUILD_ID ?? ""),

    DUPLICATE_CLIENT: String(payload.DUPLICATE_CLIENT ?? -1),

    ORIG_ZOOM_ID: String(payload.ORIG_ZOOM_ID ?? process.env.HTML5_ORIG_ZOOM_ID ?? 3472),
    DUPLICATE_ZOOM_ID: String(payload.DUPLICATE_ZOOM_ID ?? ""),

    ORIG_ZOOM_NUMBER: String(payload.ORIG_ZOOM_NUMBER ?? ""),
    ORIG_ZOOM_DESCR: String(payload.ORIG_ZOOM_DESCR ?? ""),

    DUPLICATE_ZOOM_NUMBER: String(payload.DUPLICATE_ZOOM_NUMBER ?? ""),
    DUPLICATE_ZOOM_DESCR: String(payload.DUPLICATE_ZOOM_DESCR ?? ""),

    CLIENT_ID: payload.clientId != null ? String(payload.clientId) : "",

    action: "SAVE_VHCL_ACTIVATION_NEW",
    VERSION_ID: "2"
  };

  // permite override/adições via job.payload.html5ExtraFields
  const extra = payload.html5ExtraFields || payload.extraFields || null;
  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) continue;
      fields[String(k)] = String(v ?? "");
    }
  }

  return fields;
}
function encodeForm(fields){
  const usp = new URLSearchParams();
  for (const [k,v] of Object.entries(fields)) usp.set(k, String(v ?? ""));
  return usp.toString();
}
function parseHtml5Message(text){
  const t = String(text || "");
  const m = /<MESSAGE\b[^>]*>/i.exec(t);
  if (!m) return { hasMessage:false };
  const tag = m[0];
  const loginM = /\blogin\s*=\s*["']?(-?\d+)["']?/i.exec(tag);
  const login = loginM ? Number(loginM[1]) : null;
  const isLoginNeg = (login !== null && login < 0) || /login\s*=\s*["']?-1["']?/i.test(tag);
  const isError = /error/i.test(t) && /Action:/i.test(t);
  return { hasMessage:true, login, isLoginNeg, isError };
}
async function html5CallSaveActivation(payload, cookieHeader){
  const body = encodeForm(buildSaveActivationFields(payload));
  const r = await fetchWithCookies(HTML5_ACTION_URL, {
    method:"POST",
    headers:{
      "content-type":"application/x-www-form-urlencoded; charset=UTF-8",
      "origin":"https://html5.traffilog.com",
      "referer":"https://html5.traffilog.com/appv2/index.htm"
    },
    body
  }, cookieHeader || "");

  return { httpStatus:r.status, cookie:r.cookie, snippet:safeSnippet(r.text), parsed:parseHtml5Message(r.text) };
}

async function ensureHtml5CookieAndRun(payload, runFn){
  const jar = await loadCookieJar();
  let cookie = jar.cookie || "";

  // tentativa 1
  let r1 = await runFn(cookie);
  if (r1.cookie && r1.cookie !== cookie) { cookie = r1.cookie; await saveCookieJar(cookie, { source:"action", attempt:1, httpStatus:r1.httpStatus }); }

  if (r1.parsed && r1.parsed.isLoginNeg) {
    const loginRes = await html5LoginAndStoreCookies(cookie);
    if (!loginRes.hasTfl) {
      return { attempt:2, first:r1, login:loginRes, final:{ ...r1, snippet:`LOGIN_OK_BUT_NO_TFL_SESSION | ${r1.snippet}` } };
    }
    const r2 = await runFn(loginRes.cookie);
    if (r2.cookie && r2.cookie !== loginRes.cookie) await saveCookieJar(r2.cookie, { source:"action", attempt:2, httpStatus:r2.httpStatus });
    return { attempt:2, first:r1, login:loginRes, final:r2 };
  }

  return { attempt:1, first:r1, login:null, final:r1 };
}

function normStr(v){ return (v === null || v === undefined) ? "" : String(v).trim(); }
function normService(v){
  const s = normStr(v).toUpperCase();
  if (s === "INSTALACAO" || s === "INSTALAÇÃO") return "INSTALL";
  if (s === "DESINSTALACAO" || s === "DESINSTALAÇÃO") return "UNINSTALL";
  return s;
}

async function main(){
  console.log(`[html5_v6] started base=${BASE} worker=${WORKER_ID} poll=${POLL_MS}ms dryRun=${DRY_RUN} exec=${EXECUTE_HTML5} cookiejar=${COOKIEJAR_PATH}`);
  while(true){
    try{
      const r = await httpFetch("/api/jobs/next", { params:{ type:"html5_install", worker:WORKER_ID } });
      if (r.status === 204) { await sleep(POLL_MS); continue; }
      if (r.status !== 200 || !r.data) { await sleep(POLL_MS); continue; }

      const job = r.data.job || r.data;
      const id = job.id || job.jobId || job._id;
      const payload = job.payload || {};
      const service = normService(payload.service || payload.servico || payload.serviceType);

      console.log(`[html5_v6] GOT job id=${id} service=${service || "?"}`);

      const fieldsPreview = {
        service: service || null,
        vehicleId: payload.vehicleId ?? null,
        clientId: payload.clientId ?? null,
        plate: payload.plate ? String(payload.plate) : null,
        serial: maskSerial(payload.serial),
        installationDate: payload.installationDate || null,
        installedBy: payload.installedBy || null
      };

      const html5WillMutate = (service === "INSTALL" || service === "UNINSTALL");

      if (DRY_RUN || !EXECUTE_HTML5 || !html5WillMutate) {
        const result = {
          ok:true, dryRun:true, exec:EXECUTE_HTML5,
          note: (!html5WillMutate ? "no HTML5 mutation by design for this service" : "DRY_RUN or EXECUTE_HTML5 off"),
          fieldsPreview,
          cookieKeys: cookieKeysFromCookieHeader((await loadCookieJar()).cookie || "")
        };
        await completeJob(id, "ok", result);
        continue;
      }

      if (service !== "INSTALL") {
        const result = { ok:false, error:`service=${service} not implemented for HTML5 mutation yet`, fieldsPreview };
        await completeJob(id, "error", result);
        continue;
      }

      const out = await ensureHtml5CookieAndRun(payload, async (cookieHeader) => html5CallSaveActivation(payload, cookieHeader));
      const final = out.final;
      const cookieKeys = cookieKeysFromCookieHeader((await loadCookieJar()).cookie || "");

      const authFail = final.parsed && final.parsed.isLoginNeg;
      const actionErr = final.parsed && final.parsed.isError;

      const result = {
        ok: !(authFail || actionErr),
        attempt: out.attempt,
        httpStatus: final.httpStatus,
        cookieKeys,
        snippet: final.snippet,
        fieldsPreview,
        debug: {
          requestKeys: Object.keys(buildSaveActivationFields(payload)),
          first: { httpStatus: out.first.httpStatus, snippet: out.first.snippet, parsed: out.first.parsed },
          login: out.login ? { httpStatus: out.login.status, hasTfl: out.login.hasTfl, cookieKeys: out.login.cookieKeys, snippet: out.login.snippet } : null
        }
      };

      await completeJob(id, result.ok ? "ok" : "error", result);
      console.log(`[html5_v6] COMPLETE(${result.ok ? "ok" : "error"}) id=${id} cookieKeys=${cookieKeys.join(",")}`);
    } catch (e) {
      console.log("[html5_v6] loop error:", e && (e.stack || e.message || e.toString()));
      await sleep(POLL_MS);
    }
  }
}

main().catch(err => { console.error("[html5_v6] fatal:", err && (err.stack || err.message || err)); process.exit(1); });
