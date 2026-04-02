"use strict";

// =============================================================================
// vehicleResolverWorker.js
// Worker standalone para jobs do tipo "vehicle_resolve".
// Roda na VM (onde o cookie jar existe), consulta o VHCLS e completa o job
// com o resultado da resolução de vehicle_id.
//
// NÃO executa nenhuma ação destrutiva — apenas leitura.
// Padrão idêntico ao html5InstallWorker_v8.js (sem tocar nele).
// =============================================================================

const fs   = require("fs");
const fsp  = fs.promises;
const https = require("https");

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
const BASE         = (process.env.JOB_SERVER_BASE_URL || "").replace(/\/+$/, "");
const WORKER_KEY   = (process.env.WORKER_KEY || "").trim();
const WORKER_ID    = (process.env.WORKER_ID  || "resolver-worker").trim();
const POLL_MS      = Number(process.env.RESOLVER_POLL_MS || 4000);
const TIMEOUT_MS   = Number(process.env.RESOLVER_TIMEOUT_MS || 10000);
const COOKIEJAR    = (process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json").trim();
const HTML5_URL    = (process.env.HTML5_ACTION_URL || "https://html5.traffilog.com/AppEngine_2_1/default.aspx").trim();
const JOB_TYPE          = "vehicle_resolve";
const HTML5_LOGIN_NAME  = (process.env.HTML5_LOGIN_NAME || "").trim();
const HTML5_PASSWORD    = (process.env.HTML5_PASSWORD   || "").trim();
const HTML5_BASE        = "https://html5.traffilog.com";

if (!BASE)       { console.error("[resolver] missing JOB_SERVER_BASE_URL"); process.exit(2); }
if (!WORKER_KEY) { console.error("[resolver] missing WORKER_KEY");          process.exit(2); }

console.log(`[resolver] start BASE=${BASE} WORKER_ID=${WORKER_ID} POLL_MS=${POLL_MS}`);

// ---------------------------------------------------------------------------
// Cookie jar (mesmo padrão do v8)
// ---------------------------------------------------------------------------
function readCookieHeader() {
  try {
    if (!fs.existsSync(COOKIEJAR)) return "";
    const raw = fs.readFileSync(COOKIEJAR, "utf8").trim();
    if (!raw) return "";
    if (raw[0] !== "{") return raw; // cookie header puro
    const j = JSON.parse(raw);
    if (typeof j.cookieHeader === "string") return j.cookieHeader.trim();
    if (typeof j.cookie      === "string") return j.cookie.trim();
    return "";
  } catch (_) { return ""; }
}

// ---------------------------------------------------------------------------
// Cookie renewal (auto-login quando VHCLS retorna vazio)
// ---------------------------------------------------------------------------
function saveCookieHeader(cookieHeader) {
  try {
    const data = JSON.stringify({ cookie: cookieHeader, updatedAt: new Date().toISOString() }, null, 2);
    fs.writeFileSync(COOKIEJAR, data, { mode: 0o600 });
  } catch (e) {
    console.log(`[resolver] saveCookieHeader err: ${e && e.message}`);
  }
}

function parseCookieFromNetscape(txt) {
  const parts = [];
  for (const line of txt.split("\n")) {
    let l = line.trim();
    if (!l) continue;
    if (l.startsWith("#HttpOnly_")) l = l.slice("#HttpOnly_".length);
    else if (l.startsWith("#")) continue;
    const cols = l.split("	");
    if (cols.length >= 7) {
      const name = cols[5].trim(), value = cols[6].trim();
      if (name) parts.push(`${name}=${value}`);
    }
  }
  let cookie = parts.join("; ");
  if (!cookie.includes("EULA_APPROVED"))         cookie += "; EULA_APPROVED=1";
  if (!cookie.includes("APPLICATION_ROOT_NODE")) cookie += "; APPLICATION_ROOT_NODE=%7B%22node%22%3A%22-2%22%7D";
  return cookie;
}

async function html5Login() {
  if (!HTML5_LOGIN_NAME || !HTML5_PASSWORD) {
    console.log("[resolver] html5Login: sem credenciais (HTML5_LOGIN_NAME/HTML5_PASSWORD)");
    return false;
  }
  try {
    console.log("[resolver] html5Login: bootstrap GET...");
    // Bootstrap — pega ASP.NET_SessionId
    const r1 = await fetch(`${HTML5_BASE}/appv2/index.htm`, {
      headers: { accept: "text/html" },
      redirect: "follow",
    });
    const setCookie1 = r1.headers.get("set-cookie") || "";

    // Monta cookie inicial a partir dos set-cookie do bootstrap
    const bootCookies = [];
    for (const c of setCookie1.split(",")) {
      const part = c.trim().split(";")[0].trim();
      if (part.includes("=")) bootCookies.push(part);
    }
    const bootCookieHeader = bootCookies.join("; ");

    console.log("[resolver] html5Login: APPLICATION_LOGIN...");
    const body = new URLSearchParams({
      username: HTML5_LOGIN_NAME,
      password: HTML5_PASSWORD,
      language: "7001",
      BOL_SAVE_COOKIE: "1",
      action: "APPLICATION_LOGIN",
      VERSION_ID: "2",
    }).toString();

    const r2 = await fetch(HTML5_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "accept": "*/*",
        "origin": HTML5_BASE,
        "referer": `${HTML5_BASE}/appv2/index.htm`,
        ...(bootCookieHeader ? { cookie: bootCookieHeader } : {}),
      },
      body,
      redirect: "manual",
    });

    const setCookie2 = r2.headers.get("set-cookie") || "";
    const txt = await r2.text().catch(() => "");
    const isOk = txt.includes("node=-2") || r2.status === 302 || r2.status === 200;

    if (!isOk) {
      console.log(`[resolver] html5Login FAIL status=${r2.status} txt=${txt.slice(0,120)}`);
      return false;
    }

    // Combina cookies do bootstrap + login
    const allCookies = [...bootCookies];
    for (const c of setCookie2.split(",")) {
      const part = c.trim().split(";")[0].trim();
      if (part.includes("=")) allCookies.push(part);
    }
    let cookie = allCookies.join("; ");
    if (!cookie.includes("EULA_APPROVED"))         cookie += "; EULA_APPROVED=1";
    if (!cookie.includes("APPLICATION_ROOT_NODE")) cookie += "; APPLICATION_ROOT_NODE=%7B%22node%22%3A%22-2%22%7D";

    saveCookieHeader(cookie);
    console.log(`[resolver] html5Login OK cookieLen=${cookie.length}`);
    return true;
  } catch (e) {
    console.log(`[resolver] html5Login EXCEPTION: ${e && e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function httpsPost(urlStr, bodyStr, extraHeaders) {
  const headers = Object.assign({
    "content-type": "application/x-www-form-urlencoded",
    "accept":       "*/*",
    "origin":       "https://html5.traffilog.com",
    "referer":      "https://html5.traffilog.com/appv2/index.htm",
  }, extraHeaders || {});
  const res = await fetch(urlStr, { method: "POST", headers, body: bodyStr });
  return await res.text();
}

async function jobServerFetch(path, opts) {
  const method  = (opts && opts.method) || "GET";
  const bodyJson = (opts && opts.json) ? JSON.stringify(opts.json) : null;
  const params  = (opts && opts.params)
    ? "?" + Object.entries(opts.params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";
  const url = BASE + path + params;
  const headers = { "accept": "application/json", "x-worker-key": WORKER_KEY };
  if (bodyJson) headers["content-type"] = "application/json";

  const res  = await fetch(url, { method, headers, body: bodyJson || undefined });
  const txt  = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch (_) {}
  return { status: res.status, body: txt, json };
}

async function fetchNextJob() {
  try {
    const r = await jobServerFetch("/api/jobs/next", { params: { type: JOB_TYPE, worker: WORKER_ID } });
    if (r.status === 204) return null;
    if (r.status !== 200) { console.log(`[resolver] /next status=${r.status}`); return null; }
    const job = r.json && (r.json.job || r.json);
    if (!job || !job.id) return null;
    return job;
  } catch (e) {
    console.log(`[resolver] fetchNextJob err: ${e && e.message}`);
    return null;
  }
}

async function completeJob(id, status, result) {
  try {
    await jobServerFetch(`/api/jobs/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      json: { status, result, workerId: WORKER_ID },
    });
  } catch (e) {
    console.log(`[resolver] completeJob err: ${e && e.message}`);
  }
}

// ---------------------------------------------------------------------------
// VHCLS
// ---------------------------------------------------------------------------
function buildBody(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function parseVhcls(xml) {
  const records = [];
  const re = /<DATA\s([^>]*?)\/>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    function attr(name) {
      const hit = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
      return hit ? hit[1].trim() : "";
    }
    const vid = Number(attr("VEHICLE_ID"));
    if (!vid) continue;
    records.push({
      vehicle_id:   vid,
      licence_nmbr: attr("LICENSE_NMBR"),
      inner_id:     attr("INNER_ID"),
      client_id:    Number(attr("CLIENT_ID")),
      client_descr: attr("CLIENT_DESCR"),
    });
  }
  return records;
}

async function vhclsPost(params) {
  const cookie = readCookieHeader();
  const xml = await httpsPost(HTML5_URL, buildBody(params), cookie ? { cookie } : {});
  const records = parseVhcls(xml);

  // Se retornou vazio E temos credenciais, tenta renovar o cookie e repetir uma vez
  if (records.length === 0 && HTML5_LOGIN_NAME && HTML5_PASSWORD) {
    console.log("[resolver] VHCLS retornou vazio — tentando renovar cookie...");
    const ok = await html5Login();
    if (ok) {
      const cookie2 = readCookieHeader();
      const xml2 = await httpsPost(HTML5_URL, buildBody(params), cookie2 ? { cookie: cookie2 } : {});
      return parseVhcls(xml2);
    }
  }
  return records;
}

async function vhclsByPlate(plate) {
  return vhclsPost({ REFRESH_FLG:"1", LICENSE_NMBR: plate, CLIENT_DESCR:"", OWNER_DESCR:"", DIAL_NMBR:"", INNER_ID:"", action:"VHCLS", VERSION_ID:"2" });
}

async function vhclsBySerial(serial) {
  return vhclsPost({ REFRESH_FLG:"1", LICENSE_NMBR:"", CLIENT_DESCR:"", OWNER_DESCR:"", DIAL_NMBR:"", INNER_ID: serial, action:"VHCLS", VERSION_ID:"2" });
}

// ---------------------------------------------------------------------------
// Helpers de comparação
// ---------------------------------------------------------------------------
function isEmpty(v)  { return !v || /^0+$/.test(v.trim()); }
function norm(v)     { return v.trim().replace(/^0+/, "") || "0"; }
function match(a, b) { return norm(a) === norm(b); }
function upper(v)    { return String(v || "").trim().toUpperCase(); }

// ---------------------------------------------------------------------------
// Resolução INSTALL
// ---------------------------------------------------------------------------
async function resolveInstall({ licence_nmbr, serial, client_descr }) {
  console.log(`[resolver] INSTALL plate="${licence_nmbr}" serial="${serial}" client="${client_descr}"`);

  let vehicle_id_final  = null;
  let licence_nmbr_final = licence_nmbr;
  let needs_uninstall_cmdt = false;
  let resolution_path = "";

  // Passo 1: busca pela placa
  const plateRecs = await vhclsByPlate(licence_nmbr);
  const plateRec  = plateRecs.find(r => upper(r.licence_nmbr) === upper(licence_nmbr)) || null;
  console.log(`[resolver] INSTALL step1 plate_found=${!!plateRec} inner_id="${plateRec ? plateRec.inner_id : "-"}"`);

  if (plateRec && isEmpty(plateRec.inner_id)) {
    vehicle_id_final   = plateRec.vehicle_id;
    licence_nmbr_final = plateRec.licence_nmbr;
    resolution_path    = "PLATE_FOUND_EMPTY";
  }

  // Passo 2: busca serial em inner_id
  if (vehicle_id_final === null) {
    const innerRecs = await vhclsBySerial(serial);
    const innerRec  = innerRecs.find(r => match(r.inner_id, serial)) || null;
    console.log(`[resolver] INSTALL step2 serial_inner_found=${!!innerRec}`);

    if (innerRec) {
      if (match(innerRec.inner_id, innerRec.licence_nmbr)) {
        vehicle_id_final = innerRec.vehicle_id;
        resolution_path  = "SERIAL_INNER_FREE";
      } else if (upper(innerRec.licence_nmbr) === "CMDT") {
        vehicle_id_final     = innerRec.vehicle_id;
        needs_uninstall_cmdt = true;
        resolution_path      = "SERIAL_INNER_CMDT";
      } else {
        return { status: "ERROR_SERIAL_ALREADY_USED", error_message: `Serial já utilizado (vehicle_id=${innerRec.vehicle_id} plate=${innerRec.licence_nmbr})` };
      }
    }
  }

  // Passo 3: busca serial em licence_nmbr
  if (vehicle_id_final === null) {
    const licRecs = await vhclsByPlate(serial);
    const licRec  = licRecs.find(r => upper(r.licence_nmbr) === upper(serial)) || null;
    console.log(`[resolver] INSTALL step3 serial_as_plate=${!!licRec}`);

    if (licRec) {
      vehicle_id_final = licRec.vehicle_id;
      resolution_path  = "SERIAL_AS_PLATE";
    }
  }

  // Passo 4: nenhum encontrado — criar novo
  if (vehicle_id_final === null) {
    resolution_path = "CREATE_NEW";
    console.log(`[resolver] INSTALL step4 CREATE_NEW`);
  }

  // Passo 5: cliente atual
  let client_descr_current = null;
  let client_id_current    = null;
  let client_mismatch      = false;

  if (vehicle_id_final !== null) {
    // Reutiliza os registros já buscados para encontrar o cliente
    const allRecs  = await vhclsByPlate(licence_nmbr_final);
    const found    = allRecs.find(r => r.vehicle_id === vehicle_id_final) || null;
    if (found) {
      client_descr_current = found.client_descr;
      client_id_current    = found.client_id;
    } else {
      // Tenta pelo serial
      const bySerial = await vhclsBySerial(serial);
      const found2   = bySerial.find(r => r.vehicle_id === vehicle_id_final) || null;
      if (found2) {
        client_descr_current = found2.client_descr;
        client_id_current    = found2.client_id;
      }
    }
    if (client_descr_current) {
      client_mismatch = upper(client_descr_current) !== upper(client_descr);
    }
  }

  return {
    status:               "OK",
    vehicle_id_final,
    licence_nmbr_final,
    client_descr_current,
    client_id_current,
    client_mismatch,
    needs_uninstall_cmdt,
    resolution_path,
  };
}

// ---------------------------------------------------------------------------
// Resolução MAINT_WITH_SWAP
// ---------------------------------------------------------------------------
async function resolveMaintWithSwap({ licence_nmbr, serial_old, serial_new, client_descr }) {
  console.log(`[resolver] MAINT_WITH_SWAP plate="${licence_nmbr}" old="${serial_old}" new="${serial_new}" client="${client_descr}"`);

  // Passo 1: busca placa
  const plateRecs = await vhclsByPlate(licence_nmbr);
  const plateRec  = plateRecs.find(r => upper(r.licence_nmbr) === upper(licence_nmbr)) || null;
  console.log(`[resolver] MAINT step1 plate_found=${!!plateRec} inner_id="${plateRec ? plateRec.inner_id : "-"}"`);

  if (!plateRec) {
    return { status: "ERROR_PLATE_NOT_FOUND", error_message: "Placa incorreta ou inexistente" };
  }

  // Passo 2: valida coerência
  let vehicle_id_final;
  let serial_old_found = "";

  if (isEmpty(plateRec.inner_id)) {
    vehicle_id_final = plateRec.vehicle_id;
    serial_old_found = "";
  } else if (match(plateRec.inner_id, serial_old)) {
    vehicle_id_final = plateRec.vehicle_id;
    serial_old_found = plateRec.inner_id;
  } else {
    console.log(`[resolver] MAINT step2 mismatch inner="${plateRec.inner_id}" old="${serial_old}"`);
    return { status: "ERROR_PLATE_INVALID", error_message: "Placa incorreta ou inexistente" };
  }

  // Passo 3: valida serial_new ANTES de qualquer ação
  const newRecs = await vhclsBySerial(serial_new);
  const newRec  = newRecs.find(r => match(r.inner_id, serial_new)) || null;
  console.log(`[resolver] MAINT step3 serial_new_found=${!!newRec}`);

  let needs_uninstall_cmdt = false;

  if (newRec) {
    if (match(newRec.inner_id, newRec.licence_nmbr)) {
      // disponível para reaproveitamento
    } else if (upper(newRec.licence_nmbr) === "CMDT") {
      needs_uninstall_cmdt = true;
    } else {
      return { status: "ERROR_SERIAL_NEW_ALREADY_USED", error_message: "Serial novo já está em uso em outro veículo" };
    }
  }

  // Passo 4: cliente
  const client_descr_current = plateRec.client_descr;
  const client_id_current    = plateRec.client_id;
  const client_mismatch      = upper(client_descr_current) !== upper(client_descr);

  return {
    status: "OK",
    vehicle_id_final,
    serial_old_found,
    client_descr_current,
    client_id_current,
    client_mismatch,
    needs_uninstall_cmdt,
    resolution_path: isEmpty(plateRec.inner_id) ? "PLATE_EMPTY" : "PLATE_SERIAL_MATCH",
  };
}

// ---------------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processJob(job) {
  const id      = String(job.id || "");
  const payload = job.payload || {};
  const flow    = String(payload.flow || "").trim().toUpperCase();

  console.log(`[resolver] job id=${id} flow=${flow}`);

  try {
    let result;

    if (flow === "INSTALL") {
      result = await resolveInstall({
        licence_nmbr: String(payload.licence_nmbr || payload.plate || "").trim(),
        serial:       String(payload.serial || payload.inner_id || "").trim(),
        client_descr: String(payload.client_descr || payload.clientName || "").trim(),
      });
    } else if (flow === "MAINT_WITH_SWAP") {
      result = await resolveMaintWithSwap({
        licence_nmbr: String(payload.licence_nmbr || payload.plate || "").trim(),
        serial_old:   String(payload.serial_old || "").trim(),
        serial_new:   String(payload.serial_new || payload.serial || "").trim(),
        client_descr: String(payload.client_descr || payload.clientName || "").trim(),
      });
    } else {
      result = { status: "ERROR", error_message: `flow inválido: ${flow}` };
    }

    const jobStatus = result.status === "OK" ? "completed" : "error";
    console.log(`[resolver] job id=${id} done status=${jobStatus} path=${result.resolution_path || result.status}`);
    await completeJob(id, jobStatus, result);

  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.error(`[resolver] job id=${id} EXCEPTION: ${msg}`);
    await completeJob(id, "error", { status: "ERROR", error_message: msg });
  }
}

async function mainLoop() {
  while (true) {
    try {
      const job = await fetchNextJob();
      if (job) {
        await processJob(job);
      } else {
        await sleep(POLL_MS);
      }
    } catch (e) {
      console.error(`[resolver] mainLoop err: ${e && e.message}`);
      await sleep(POLL_MS);
    }
  }
}

mainLoop();
