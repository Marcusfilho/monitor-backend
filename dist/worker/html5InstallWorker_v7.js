"use strict";

/**
 * v7 - Guardrails anti-job-preso:
 * - timeout global por job (JOB_MAX_MS)
 * - COMPLETE sempre (ok/error) mesmo em exceção/timeout
 * - STAGE logs p/ saber onde travou
 * - login HTML5 via APPLICATION_LOGIN (TFL_SESSION)
 */

const fs = require("fs");
const fsp = fs.promises;

const BASE = (process.env.JOB_SERVER_BASE_URL || "").replace(/\/+$/, "");
const WORKER_KEY = (process.env.WORKER_KEY || "").trim();
const WORKER_ID = (process.env.WORKER_ID || "tunel").trim();

const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 20000);
const JOB_MAX_MS = Number(process.env.JOB_MAX_MS || 60000);

const DRY_RUN = String(process.env.DRY_RUN || "1") !== "0";
const EXECUTE_HTML5 = String(process.env.EXECUTE_HTML5 || "0").toLowerCase() === "true" || String(process.env.EXECUTE_HTML5 || "0") === "1";

const HTML5_ACTION_URL = (process.env.HTML5_ACTION_URL || "https://html5.traffilog.com/AppEngine_2_1/default.aspx").trim();
const COOKIEJAR_PATH = (process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json").trim();

const HTML5_LOGIN_NAME = (process.env.HTML5_LOGIN_NAME || "").trim();
const HTML5_PASSWORD = (process.env.HTML5_PASSWORD || "").trim();
const HTML5_LANGUAGE = String(process.env.HTML5_LANGUAGE || "7001").trim();
const HTML5_ORIG_ZOOM_ID = String(process.env.HTML5_ORIG_ZOOM_ID || "3472").trim();

if (!BASE) { console.error("[html5_v7] missing JOB_SERVER_BASE_URL"); process.exit(2); }
if (!WORKER_KEY) { console.error("[html5_v7] missing WORKER_KEY"); process.exit(2); }

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function nowISO(){ return new Date().toISOString(); }
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
  add("APPLICATION_ROOT_NODE", '{"node":"-2"}'); // igual ao browser
  return c;
}

async function loadCookieJar(){
  try {
    const raw = await fsp.readFile(COOKIEJAR_PATH, "utf-8");
    const j = JSON.parse(raw);
    return { cookie: String(j.cookie || ""), updatedAt: j.updatedAt || null };
  } catch { return { cookie: "", updatedAt: null }; }
}
async function saveCookieJar(cookieHeader, meta){
  const cookie = ensureCookieDefaults(cookieHeader || "");
  const keys = cookieKeysFromCookieHeader(cookie);
  const payload = { cookie, keys, updatedAt: nowISO(), meta: meta || {} };
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
  const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let cookie = ensureCookieDefaults(cookieHeader || "");
  try{
    const res = await fetch(url, {
      method,
      headers: { ...headers, ...(cookie?{cookie}:{}), "user-agent":"monitor-backend-html5-worker/7" },
      body,
      redirect:"manual",
      signal: controller.signal
    });
    cookie = mergeCookies(cookie, extractSetCookies(res.headers));
    const text = await res.text().catch(() => "");
    return { status: res.status, text, cookie, headers: res.headers };
  } finally { clearTimeout(t); }
}

// Job server
async function httpFetch(path, { method="GET", params=null, json=null } = {}) {
  const u = new URL(BASE + path);
  if (params) for (const [k,v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
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
async function completeJobLogged(id, status, result){
  const r = await completeJob(id, status, result);
  console.log(`[html5_v7] COMPLETE_API id=${id} status=${status} http=${r.status}`);
  return r;
}

function withTimeout(promise, ms, label){
  let to;
  const t = new Promise((_, rej) => {
    to = setTimeout(() => rej(new Error(`timeout:${label}:${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(to)), t]);
}

// HTML5 login (APPLICATION_LOGIN)
async function html5BootstrapCookies(existingCookie){
  const r = await fetchWithCookies("https://html5.traffilog.com/appv2/index.htm", {
    method:"GET",
    headers:{ "accept":"text/html,application/xhtml+xml", "referer":"https://html5.traffilog.com/appv2/index.htm" }
  }, existingCookie || "");
  await saveCookieJar(r.cookie, { source:"bootstrap", httpStatus:r.status });
  return r.cookie;
}
async function html5LoginAndStoreCookies(existingCookie){
  if (!HTML5_LOGIN_NAME || !HTML5_PASSWORD) throw new Error("missing HTML5_LOGIN_NAME / HTML5_PASSWORD");

  let cookie = await html5BootstrapCookies(existingCookie || "");

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

  const keys = await saveCookieJar(r.cookie, { source:"login", httpStatus:r.status });
  const hasTfl = keys.includes("TFL_SESSION");
  return { status:r.status, cookie:r.cookie, cookieKeys:keys, snippet:safeSnippet(r.text), hasTfl };
}

function parseHtml5Message(text){
  const t = String(text || "");
  const m = /<MESSAGE\b[^>]*>/i.exec(t);
  if (!m) return { hasMessage:false };
  const tag = m[0];
  const loginM = /\blogin\s*=\s*["']?(-?\d+)["']?/i.exec(tag);
  const login = loginM ? Number(loginM[1]) : null;
  const isLoginNeg = (login !== null && login < 0) || /login\s*=\s*["']?-1["']?/i.test(tag);
  const isError = /Action:\s*SAVE_VHCL_ACTIVATION_NEW/i.test(t) && /error/i.test(t);
  return { hasMessage:true, login, isLoginNeg, isError };
}

function buildSaveActivationFields(payload){
  const serial = String(payload.serial || payload.DIAL_NUMBER || payload.INNER_ID || "").trim();
  const plate  = String(payload.plate || payload.LICENSE_NMBR || "").trim();
  const installationDate = String(payload.installationDate || payload.INSTALLATION_DATE || "").trim();
  const assetType = payload.assetType != null ? String(payload.assetType) : "";

  const fields = {
    ASSIGNED_VEHICLE_SETTING_ID: String(payload.ASSIGNED_VEHICLE_SETTING_ID ?? -1),
    LINK_AND_RUN: String(payload.LINK_AND_RUN ?? 0),
    UPDATE_DRIVER_CODE: String(payload.UPDATE_DRIVER_CODE ?? 0),
    LOG_UNIT_DATA_UNTIL_DATE: String(payload.LOG_UNIT_DATA_UNTIL_DATE || installationDate),

    VEHICLE_ID: payload.vehicleId != null ? String(payload.vehicleId) : "",
    FIELD_IDS: String(payload.fieldIds || payload.FIELD_IDS || ""),
    FIELD_VALUE: String(payload.fieldValue || payload.FIELD_VALUE || ""),

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

    ORIG_ZOOM_ID: String(payload.ORIG_ZOOM_ID ?? HTML5_ORIG_ZOOM_ID),
    DUPLICATE_ZOOM_ID: String(payload.DUPLICATE_ZOOM_ID ?? ""),

    ORIG_ZOOM_NUMBER: String(payload.ORIG_ZOOM_NUMBER ?? ""),
    ORIG_ZOOM_DESCR: String(payload.ORIG_ZOOM_DESCR ?? ""),

    DUPLICATE_ZOOM_NUMBER: String(payload.DUPLICATE_ZOOM_NUMBER ?? ""),
    DUPLICATE_ZOOM_DESCR: String(payload.DUPLICATE_ZOOM_DESCR ?? ""),

    CLIENT_ID: payload.clientId != null ? String(payload.clientId) : "",

    action: "SAVE_VHCL_ACTIVATION_NEW",
    VERSION_ID: "2"
  };

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

async function html5CallSaveActivation(payload, cookieHeader){
  const body = encodeForm(buildSaveActivationFields(payload));
  const cookieFixed = ensureCookieDefaults(cookieHeader || "");
  const r = await fetchWithCookies(HTML5_ACTION_URL, {
    method:"POST",
    headers:{
      "content-type":"application/x-www-form-urlencoded; charset=UTF-8",
      "origin":"https://html5.traffilog.com",
      "referer":"https://html5.traffilog.com/appv2/index.htm"
    },
    body
  }, cookieFixed);

  const parsed = parseHtml5Message(r.text);
  await saveCookieJar(r.cookie, { source:"action", httpStatus:r.status });
  return { httpStatus:r.status, snippet:safeSnippet(r.text), parsed };
}

async function runInstallJob(id, payload){
  const jar = await loadCookieJar();
  let cookie = jar.cookie || "";

  console.log(`[html5_v7] STAGE id=${id} step=save_attempt1`);
  let r1 = await html5CallSaveActivation(payload, cookie);

  if (r1.parsed && r1.parsed.isLoginNeg) {
    console.log(`[html5_v7] STAGE id=${id} step=login`);
    const loginRes = await html5LoginAndStoreCookies(cookie);
    console.log(`[html5_v7] STAGE id=${id} step=login_done hasTfl=${loginRes.hasTfl} keys=${(loginRes.cookieKeys||[]).join(",")}`);

    console.log(`[html5_v7] STAGE id=${id} step=save_attempt2`);
    let r2 = await html5CallSaveActivation(payload, loginRes.cookie);

    return { attempt:2, first:r1, login:loginRes, final:r2 };
  }

  return { attempt:1, first:r1, login:null, final:r1 };
}

function normService(v){ return String(v || "").trim().toUpperCase(); }

async function main(){
  console.log(`[html5_v7] started base=${BASE} worker=${WORKER_ID} poll=${POLL_MS}ms httpTimeout=${HTTP_TIMEOUT_MS} jobMax=${JOB_MAX_MS} dryRun=${DRY_RUN} exec=${EXECUTE_HTML5} cookiejar=${COOKIEJAR_PATH}`);

  while(true){
    try{
      const r = await httpFetch("/api/jobs/next", { params:{ type:"html5_install", worker:WORKER_ID } });
      if (r.status === 204) { await sleep(POLL_MS); continue; }
      if (r.status !== 200 || !r.data) { await sleep(POLL_MS); continue; }

      const job = r.data.job || r.data;
      const id = job.id || job.jobId || job._id;
      const payload = job.payload || {};
      const service = normService(payload.service);

      console.log(`[html5_v7] GOT job id=${id} service=${service || "?"}`);

      let done = false;
      const finish = async (status, result) => {
        if (done) return;
        done = true;
        await completeJobLogged(id, status, result);
      };

      const jobRunner = async () => {
        const html5WillMutate = (service === "INSTALL" || service === "UNINSTALL");
        if (DRY_RUN || !EXECUTE_HTML5 || !html5WillMutate) {
          await finish("ok", {
            ok:true, dryRun:DRY_RUN, exec:EXECUTE_HTML5,
            note: (!html5WillMutate ? "no HTML5 mutation by design for this service" : "DRY_RUN or EXECUTE_HTML5 off"),
            cookieKeys: cookieKeysFromCookieHeader((await loadCookieJar()).cookie || "")
          });
          return;
        }

        if (service !== "INSTALL") {
          await finish("error", { ok:false, error:`service=${service} not implemented for HTML5 mutation yet` });
          return;
        }

        const out = await runInstallJob(id, payload);
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
          debug: {
            first: out.first,
            login: out.login ? { httpStatus: out.login.status, hasTfl: out.login.hasTfl, cookieKeys: out.login.cookieKeys, snippet: out.login.snippet } : null
          }
        };

        await finish(result.ok ? "ok" : "error", result);
        console.log(`[html5_v7] COMPLETE(${result.ok ? "ok" : "error"}) id=${id} cookieKeys=${cookieKeys.join(",")}`);
      };

      try{
        await withTimeout(jobRunner(), JOB_MAX_MS, `job:${id}`);
      } catch (e){
        const msg = e && (e.message || e.toString());
        console.log(`[html5_v7] JOB_FAIL id=${id} err=${msg}`);
        await finish("error", { ok:false, error:"job_exception_or_timeout", message: msg });
      }

    } catch (e) {
      console.log("[html5_v7] loop error:", e && (e.stack || e.message || e.toString()));
      await sleep(POLL_MS);
    }
  }
}

main().catch(err => { console.error("[html5_v7] fatal:", err && (err.stack || err.message || err)); process.exit(1); });
