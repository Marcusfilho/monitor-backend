"use strict";

// === PATCH_MWS_SAVEBASELINE_V2 ===
// Nota: postcheck/act_load não são HTML; são XML do GET_VHCL_ACTIVATION_DATA_NEW (REFRESH).
function mwsExtractActivationAttrs(xmlText) {
  try {
    if (!xmlText || typeof xmlText !== "string") return {};
    var m = xmlText.match(/<DATA\s+[^>]*DATASOURCE="GET_VHCL_ACTIVATION_DATA_NEW"[^>]*\/>/i);
    if (!m) return {};
    var tag = m[0];
    var attrs = {};
    var reAttr = /\b([A-Za-z0-9_]+)="([^"]*)"/g;
    var am;
    while ((am = reAttr.exec(tag))) attrs[am[1]] = am[2];
    return attrs;
  } catch (e) { return {}; }
}

function mwsReadBaselineXml(jobId) {
  try {
    var fs = require("fs");
    var cand = [
      "/tmp/mws_act_load_resp_" + jobId + ".txt",
      "/tmp/mws_postcheck_form_" + jobId + ".html",
      "/tmp/mws_postcheck_resp_" + jobId + ".txt"
    ];
    for (var i=0;i<cand.length;i++){
      try {
        if (fs.existsSync(cand[i])) {
          var t = fs.readFileSync(cand[i], "utf8");
          if (t && t.indexOf("GET_VHCL_ACTIVATION_DATA_NEW") >= 0) return t;
        }
      } catch(e){}
    }
  } catch(e){}
  return "";
}

function mwsEnrichSavePayloadFromBaseline(jobId, savePayload, baselineXmlText) {
  try {
    var payload = Object.assign({}, savePayload || {});
    var needs = (!payload.ASSET_TYPE || !payload.FIELD_IDS || !payload.FIELD_VALUE || !payload.GROUP_ID);
    if (!needs) return payload;

    var xml = (baselineXmlText && typeof baselineXmlText === "string") ? baselineXmlText : "";
    if (!xml || xml.indexOf("GET_VHCL_ACTIVATION_DATA_NEW") < 0) xml = mwsReadBaselineXml(jobId);

    var base = mwsExtractActivationAttrs(xml);
    var keep = {
      VERSION_ID: payload.VERSION_ID,
      VEHICLE_ID: payload.VEHICLE_ID,
      LICENSE_NMBR: payload.LICENSE_NMBR,
      DIAL_NUMBER: payload.DIAL_NUMBER,
      INNER_ID: payload.INNER_ID
    };

    payload = Object.assign({}, base, payload);

    // preserva o que o caller setou explicitamente
    Object.keys(keep).forEach(function(k){
      if (keep[k] !== undefined && keep[k] !== null) payload[k] = keep[k];
    });

    if (payload.VERSION_ID == null || payload.VERSION_ID === "") payload.VERSION_ID = "2";
    return payload;
  } catch (e) {
    return savePayload || {};
  }
}

function mwsSaveResponseHasError(text) {
  try {
    if (!text) return false;
    if (/Action:\s*SAVE_VHCL_ACTIVATION_NEW\s*error\./i.test(text)) return true;
    if (/<ERROR\b/i.test(text)) return true;
    return false;
  } catch (e) { return false; }
}
// === /PATCH_MWS_SAVEBASELINE_V2 ===
/* PATCH_VHCLS_RESOLVE_ROBUST_V1 */
/* FIX_MWS_COOKIEJAR_V1 */







/* === PATCH_C6A: VHCLS_FORCE_COOKIE v2 (wrap final fetch) ===
 * Objetivo: garantir Cookie no request VHCLS (action=VHCLS) via fetch-hook (não httpFetch).
 * - Injeta cookie do /tmp/html5_cookiejar.json se:
 *     (a) não há Cookie, OU
 *     (b) Cookie existe mas não contém TFL_SESSION= (caso comum de header incompleto/stale).
 * - Loga APENAS tamanhos (sem vazar valores).
 */
(function(){
  try{
    if (globalThis.__VHCLS_FORCE_COOKIE_V2) return;
    globalThis.__VHCLS_FORCE_COOKIE_V2 = true;

    const fs = require("fs");
    const COOKIEJAR_PATH = process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json";

    function readCookieHeaderSafe(){
      try{
        if (!fs.existsSync(COOKIEJAR_PATH)) return "";
        const raw = fs.readFileSync(COOKIEJAR_PATH, "utf8");
        if (!raw) return "";
        let j = null;
        try { j = JSON.parse(raw); } catch { j = raw; }
        if (!j) return "";
        if (typeof j === "string") return j.trim();
        if (typeof j.cookieHeader === "string") return j.cookieHeader.trim();
        if (typeof j.cookie === "string") return j.cookie.trim();

        if (Array.isArray(j.cookies)) {
          const parts = [];
          for (const c of j.cookies) {
            if (!c) continue;
            const name = String(c.name || c.key || c.n || "").trim();
            const val  = String(c.value || c.v || "").trim();
            if (name && val) parts.push(`${name}=${val}`);
          }
          return parts.join("; ");
        }

        const map = j.cookies || j.jar || j;
        if (map && typeof map === "object") {
          const parts = [];
          for (const k of Object.keys(map)) {
            const v = map[k];
            if (typeof v === "string" && v) parts.push(`${k}=${v}`);
            else if (v && typeof v === "object" && typeof v.value === "string" && v.value) parts.push(`${k}=${v.value}`);
          }
          return parts.join("; ");
        }
      }catch(e){}
      return "";
    }

    function bodyText(init){
      try{
        const b = init && init.body;
        if (!b) return "";
        if (typeof b === "string") return b;
        if (typeof URLSearchParams !== "undefined" && b instanceof URLSearchParams) return b.toString();
        if (b && typeof b.toString === "function") {
          const s = String(b);
          if (s && s !== "[object Object]" && s !== "[object FormData]") return s;
        }
      }catch(e){}
      return "";
    }

    process.nextTick(() => {
      try{
        const origFetch = globalThis.fetch;
        if (typeof origFetch !== "function") return;

        globalThis.fetch = async function(input, init){
          const bt = bodyText(init);
          const isVHCLS = /(^|[&?])action=VHCLS(&|$)/i.test(bt);

          if (isVHCLS) {
            const h = new Headers((init && init.headers) || (input && input.headers) || undefined);

            const cur = String(h.get("cookie") || "").trim();
            const curLen = cur.length;
            const hasTfl = /(^|;\s*)TFL_SESSION=/.test(cur);

            if (!cur || !hasTfl) {
              const ck = readCookieHeaderSafe();
              if (ck) {
                h.set("cookie", ck);
                console.log(`[VHCLS_FORCE_COOKIE] injected(cookieLen=${ck.length}) curLen=${curLen}`);
                init = Object.assign({}, init || {}, { headers: h });
              } else {
                console.log(`[VHCLS_FORCE_COOKIE] WARN cookieLen=0 curLen=${curLen}`);
              }
            } else {
              console.log(`[VHCLS_FORCE_COOKIE] pass(curLen=${curLen})`);
            }
          }

          return origFetch(input, init);
        };
      } catch(e){}
    });

  } catch(e){}
})();

// [PATCH_VHCLS_FETCH_TAP] capture VHCLS response via Response.clone() (não consome body original)
try {
  if (!globalThis.__VHCLS_FETCH_TAP_INSTALLED && typeof globalThis.fetch === 'function') {
    globalThis.__VHCLS_FETCH_TAP_INSTALLED = true;
    const __origFetch = globalThis.fetch.bind(globalThis);

    globalThis.fetch = async function(input, init) {
      const res = await __origFetch(input, init);

      try {
        const url = (typeof input === 'string') ? input : ((input && input.url) ? input.url : '');
        const body = (init && init.body) ? init.body : '';
        const bodyStr = (typeof body === 'string') ? body : (body && body.toString ? body.toString() : '');

        const want =
          (bodyStr.indexOf('action=VHCLS') >= 0) ||
          (bodyStr.indexOf('VHCLS') >= 0) ||
          (url.indexOf('VHCLS') >= 0);

        if (want) {
          const c = res.clone();
          const txt = await c.text();

          const ts = Date.now();
          const out = '/tmp/vhcls_raw_' + ts + '.txt';
          require('fs').writeFileSync(out, txt, 'utf8');

          // tenta extrair plate e vehicle_id para log rápido
          let plate = '';
          try {
            const m1 = bodyStr.match(/LICENSE_NMBR=([^&]+)/);
            plate = m1 ? decodeURIComponent(m1[1]) : '';
          } catch (e) {}

          let vid = '';
          try {
            const m2 = txt.match(/VEHICLE_ID\s*=\s*"(\d+)"/) || txt.match(/VEHICLE_ID\s*=\s*(\d+)/);
            vid = m2 ? m2[1] : '';
          } catch (e) {}

          globalThis.__VHCLS_LAST = { ts: ts, url: url, plate: plate, vehicleId: vid, len: (txt || '').length, path: out };

          console.log('[VHCLS_TAP] status=' + res.status + ' len=' + (txt || '').length + ' plate=' + plate + ' vehicleId=' + vid + ' saved=' + out);
          console.log('[VHCLS_TAP_HEAD] ' + JSON.stringify((txt || '').slice(0, 1200)));
        }
      } catch (e) {
        console.log('[VHCLS_TAP_ERR] ' + ((e && e.message) ? e.message : String(e)));
      }

      return res;
    };
  }
} catch (e) {
  console.log('[VHCLS_TAP_INIT_ERR] ' + ((e && e.message) ? e.message : String(e)));
}

// === PATCH_VHCLS_DIRECT_VEHICLE_ID v1 ===
// Resolver universal: LICENSE (placa OU serial gravado em license no bench) -> VEHICLE_ID via VHCLS (REFRESH_FLG=1).
// Motivo: wrapper html5RunStep às vezes não expõe body (len=0). Aqui fazemos fetch direto e parseamos XML.

function _vhclsLog(ctx, msg) {
  try {
    if (ctx && typeof ctx.log === "function") ctx.log(msg);
    else console.log(msg);
  } catch (_) {
    console.log(msg);
  }
}

function _normLicenseKey(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function _readCookieHeaderFromJarFile(ctx) {
  const fs = require("fs");
  const jarPath =
    (ctx && (ctx.cookieCachePath || ctx.cookieJarPath || ctx.cookieJarFile)) ||
    process.env.HTML5_COOKIEJAR_PATH ||
    process.env.HTML5_COOKIE_CACHE ||
    "/tmp/html5_cookiejar.json";

  if (!fs.existsSync(jarPath)) return { cookie: "", jarPath, exists: false };

  const raw = String(fs.readFileSync(jarPath, "utf8") || "").trim();
  if (!raw) return { cookie: "", jarPath, exists: true };

  try {
    const j = JSON.parse(raw);

    if (j && typeof j.cookie === "string") return { cookie: j.cookie.trim(), jarPath, exists: true };
    if (j && typeof j.cookies === "string") return { cookie: j.cookies.trim(), jarPath, exists: true };

    if (j && Array.isArray(j.cookies)) {
      const parts = [];
      for (const c of j.cookies) {
        if (!c) continue;
        if (typeof c.cookie === "string") parts.push(c.cookie.trim());
        else if ((c.key || c.name) && (c.value !== undefined)) parts.push(String(c.key || c.name) + "=" + String(c.value));
      }
      return { cookie: parts.join("; "), jarPath, exists: true };
    }

    if (j && typeof j === "object") {
      const parts = [];
      for (const k of Object.keys(j)) {
        const v = j[k];
        if (v === null || v === undefined) continue;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          parts.push(String(k) + "=" + String(v));
        }
      }
      return { cookie: parts.join("; "), jarPath, exists: true };
    }
  } catch (_) {}

  const ck = String(raw || "")
    .replace(/^\\s*cookie\\s*:\\s*/i, "")
    .replace(/[\\r\\n]+/g, " ")
    .trim();

  return { cookie: ck, jarPath, exists: true };
}

function _extractAttr(tag, name) {
  const re = new RegExp(name + '="([^"]*)"', "i");
  const m = re.exec(tag);
  return m ? m[1] : "";
}

function _parseVehicleIdFromVhclsXml(xml, licenseKey) {
  const lk = _normLicenseKey(licenseKey);

  if (/login\s*=\s*"-1"/i.test(xml) || /Action:\s*VHCLS\s+error/i.test(xml)) {
    return { vehicleId: null, err: "unauthorized_or_vhcls_error" };
  }

  const dataTags = xml.match(/<DATA\b[^>]*\/>/gi) || [];
  for (const tag of dataTags) {
    const lic = _normLicenseKey(_extractAttr(tag, "LICENSE_NMBR"));
    const vid = _extractAttr(tag, "VEHICLE_ID");
    if (lic && vid && lic === lk) {
      const n = Number(vid);
      return { vehicleId: (n > 0 ? n : null), err: null };
    }
  }

  if (dataTags.length === 1) {
    const vid = _extractAttr(dataTags[0], "VEHICLE_ID");
    const n = Number(vid);
    if (n > 0) return { vehicleId: n, err: null };
  }

  return { vehicleId: null, err: "not_found" };
}

async function _vhclsResolveVehicleIdDirect(ctx, licenseKey) {
  // PATCH_VHCLS_DIRECT_COOKIE_V3
  // - request em /tmp/mws_vhcls_req_<JOB>.txt (url, license, jarPath, cookie_len, cookie_has_tfl, body...)
  // - response em /tmp/mws_vhcls_<JOB>.txt (xml bruto)
  // - payload VHCLS alinhado ao VHCLS_CANON: inclui VERSION_ID=2 + campos vazios comuns do HTML5
  const fs = require("fs");

  const jobIdRaw = (ctx && (ctx.jobId || ctx.id)) ? String(ctx.jobId || ctx.id) : "";
  const jobId = jobIdRaw.replace(/[^a-zA-Z0-9_-]/g, "");
  const reqPath = jobId ? ("/tmp/mws_vhcls_req_" + jobId + ".txt") : "";
  const rspPath = jobId ? ("/tmp/mws_vhcls_" + jobId + ".txt") : "";

  function writeSafe(p, content) {
    try { if (p) fs.writeFileSync(p, String(content || ""), "utf8"); } catch (e) {}
  }

  const html5Base =
    (ctx && (ctx.html5Base || ctx.html5_base || ctx.baseHtml5 || ctx.baseURLHtml5)) ||
    process.env.HTML5_BASE ||
    process.env.HTML5_BASE_URL ||
    "https://html5.traffilog.com";

  const url = html5Base.replace(/\/+$/, "") + "/AppEngine_2_1/default.aspx";

  const jar = _readCookieHeaderFromJarFile(ctx);
  const cookie = String(jar.cookie || "").trim();
  const cookieLen = cookie.length;
  const hasTfl = /(^|;\s*)TFL_SESSION=/.test(cookie);

  const license = String(licenseKey || "").trim();

  // payload “canon” (igual ao usado no resolve_by_plate via html5RunStep)
  const params = new URLSearchParams({
    action: "VHCLS",
    REFRESH_FLG: "1",
    LICENSE_NMBR: license,
    CLIENT_DESCR: "",
    OWNER_DESCR: "",
    DIAL_NMBR: "",
    INNER_ID: "",
    VERSION_ID: "2"
  });
  const body = params.toString();

  const headers = {
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    "accept": "*/*",
    "x-requested-with": "XMLHttpRequest",
    "origin": html5Base,
    "referer": url,
    "cookie": cookie,
    "user-agent": "monitor-backend-worker/1.0"
  };

  // artefato de request (sem vazar cookie)
  try {
    const head = body.slice(0, 400) + (body.length > 400 ? "..." : "");
    const reqTxt = [
      "PATCH_VHCLS_DIRECT_COOKIE_V3",
      "ts=" + (new Date()).toISOString(),
      "url=" + url,
      "license=" + license,
      "jarPath=" + String(jar.jarPath || ""),
      "jarExists=" + (jar.exists ? "1" : "0"),
      "cookie_len=" + String(cookieLen),
      "cookie_has_tfl=" + (hasTfl ? "1" : "0"),
      "body_len=" + String(body.length),
      "body_head=" + head
    ].join("\n") + "\n";
    writeSafe(reqPath, reqTxt);
  } catch (e) {}

  _vhclsLog(ctx, `[vhcls] direct_v3: license=${license} cookieLen=${cookieLen} hasTfl=${hasTfl?1:0} jar=${jar && jar.jarPath} exists=${jar && jar.exists}`);

  const controller = new AbortController();
  const timeoutMs = Number((ctx && ctx.vhclsTimeoutMs) || process.env.VHCLS_TIMEOUT_MS || 25000);
  const to = setTimeout(() => { try { controller.abort(); } catch(e) {} }, timeoutMs);

  let res = null;
  let text = "";
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });
    text = await res.text().catch(() => "");
  } catch (e) {
    try { writeSafe(rspPath, "FETCH_ERR " + (e && (e.message || e.toString())) + "\n"); } catch(_) {}
    throw e;
  } finally {
    try { clearTimeout(to); } catch (e) {}
  }

  // artefato de response
  writeSafe(rspPath, text);

  _vhclsLog(ctx, `[vhcls] direct_v3: http=${res ? res.status : "NA"} len=${(text && text.length) || 0} saved=${rspPath}`);

  const parsed = _parseVehicleIdFromVhclsXml(text, license);
  if (parsed.err === "unauthorized_or_vhcls_error") {
    const e = new Error("vhcls_unauthorized_or_error (session invalid or action error)");
    e.code = "VHCLS_UNAUTH";
    e.httpStatus = res ? res.status : 0;
    throw e;
  }
  return parsed.vehicleId;
}


async function ensureVehicleIdByVhcls_(ctx, payload) {
  if (!payload) return null;

  const cur = Number(payload.vehicle_id || payload.VEHICLE_ID || payload.vehicleId || 0);
  if (cur > 0) {
    payload.vehicle_id = cur;
    payload.VEHICLE_ID = cur;
    payload.vehicleId = cur;
    return cur;
  }

  const service = String(payload.service || payload.servico || payload.serviceType || "").trim().toUpperCase();

  const plateRaw  = payload.plate || payload.placa || payload.license || payload.licensePlate || "";
  const serialRaw = payload.serial || payload.serie || payload.innerId || payload.INNER_ID || "";

  const licenseKey = (service === "INSTALL" && String(serialRaw||"").trim()) ? _normLicenseKey(serialRaw) : _normLicenseKey(plateRaw);
  if (!licenseKey) return null;

  const vid = await _vhclsResolveVehicleIdDirect(ctx, licenseKey);
  if (vid) {
    payload.vehicle_id = vid;
    payload.VEHICLE_ID = vid;
    payload.vehicleId = vid;
    _vhclsLog(ctx, `[vhcls] resolved: license=${licenseKey} -> VEHICLE_ID=${vid}`);
    return vid;
  }

  _vhclsLog(ctx, `[vhcls] not found: license=${licenseKey}`);
  return null;
}
// === END PATCH_VHCLS_DIRECT_VEHICLE_ID v1 ===


const patchC8 = require('./patchC8_allowedGroups'); // PATCH_C8_ALLOWED_GROUPS
/* PATCH_C6_HTML5 v2026-02-02 (NO-BACKTICKS)
 * - SAVE_VHCL_ACTIVATION_NEW: garante FIELD_IDS=1,2,6 e FIELD_VALUE com campo 1 copiando 2 (fallback 6)
 * - USER_GROUPS/LOGIN_USER_GROUPS: cache client_id -> group_id
 * - ASSET_BASIC_SAVE: injeta GROUP_ID do cache (guardrail se não houver cache)
 */
(() => {
  if (globalThis.__PATCH_C6_HTML5) return;
  globalThis.__PATCH_C6_HTML5 = { version: 'C6', ts: new Date().toISOString() };

  const origFetch = globalThis.fetch;
  if (typeof origFetch !== 'function') {
    console.error('[PATCH_C6] global fetch missing; nothing patched');
    return;
  }

  const groupMap = new Map(); // clientId -> groupId

  function safeToStr(v){
    try { return (v === undefined || v === null) ? '' : String(v); } catch { return ''; }
  }

  function extractParams(init){
    const body = init && init.body;
    if (!body) return null;
    if (body instanceof URLSearchParams) return body;
    if (typeof body === 'string') {
      if (body.includes('=') && (body.includes('&') || body.startsWith('action=') || body.includes('action='))) {
        return new URLSearchParams(body);
      }
    }
    return null;
  }

  function setBodyFromParams(init, params){
    init = init || {};
    init.body = params.toString();
    init.headers = init.headers || {};
    try {
      if (init.headers instanceof Headers) {
        if (!init.headers.get('content-type')) init.headers.set('content-type', 'application/x-www-form-urlencoded; charset=utf-8');
      } else {
        const h = init.headers;
        const has = Object.keys(h).some(k => k.toLowerCase() === 'content-type');
        if (!has) h['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8';
      }
    } catch {}
    return init;
  }

  function parseFieldValueMap(fieldValueStr){
    const map = new Map();
    const parts = safeToStr(fieldValueStr).split(',');
    for (const raw of parts) {
      const tok = raw.trim();
      if (!tok) continue;
      const i = tok.indexOf(':');
      if (i <= 0) continue;
      const k = tok.slice(0, i).trim();
      const v = tok.slice(i + 1); // keep as-is
      if (k) map.set(k, v);
    }
    return map;
  }

  function ensureField1(params){
    const idsStr = safeToStr(params.get('FIELD_IDS'));
    if (!idsStr) return { changed:false, reason:'no FIELD_IDS' };

    const ids = idsStr.split(',').map(s => s.trim()).filter(Boolean);
    const valMap = parseFieldValueMap(params.get('FIELD_VALUE'));

    // always guarantee 1,2,6 exist (and ordered)
    const v1 = (valMap.get('2') || valMap.get('6') || '');

    const rest = ids.filter(x => x !== '1' && x !== '2' && x !== '6');
    const ordered = ['1','2','6', ...rest];

    params.set('FIELD_IDS', ordered.join(','));

    if (!valMap.has('2')) valMap.set('2','');
    if (!valMap.has('6')) valMap.set('6','');
    valMap.set('1', v1);

    const parts = ordered.map(id => String(id) + ':' + (valMap.get(id) ?? ''));
    params.set('FIELD_VALUE', ',' + parts.join(','));

    // changed if 1 wasn't present OR ordering/values altered
    return { changed: !ids.includes('1'), v1Used: v1 };
  }

  function rememberGroupsFromText(text){
    const t = safeToStr(text);
    if (!t) return 0;

    let found = 0;
    let m;

    // XML-ish patterns
    const re = /CLIENT_ID\s*=\s*\"(\d+)\"[^>]*GROUP_ID\s*=\s*\"(\d+)\"/gi;
    while ((m = re.exec(t))) { groupMap.set(m[1], m[2]); found++; }

    const re2 = /GROUP_ID\s*=\s*\"(\d+)\"[^>]*CLIENT_ID\s*=\s*\"(\d+)\"/gi;
    while ((m = re2.exec(t))) { groupMap.set(m[2], m[1]); found++; }

    // JSON-ish fallback (very lightweight): client_id:123 ... group_id:456
    const re3 = /\"client_id\"\s*:\s*(\d+)[\s\S]{0,200}?\"group_id\"\s*:\s*(\d+)/gi;
    while ((m = re3.exec(t))) { groupMap.set(m[1], m[2]); found++; }

    return found;
  }

  function ensureGroupId(params){
    const clientId = safeToStr(params.get('CLIENT_ID')).trim();
    if (!clientId) return { changed:false, reason:'no CLIENT_ID' };

    const groupId = safeToStr(params.get('GROUP_ID')).trim();
    if (groupId) return { changed:false, reason:'already has GROUP_ID' };

    const resolved = groupMap.get(clientId);
    if (!resolved) return { changed:false, reason:'no groupMap for client ' + clientId };

    params.set('GROUP_ID', resolved);
    return { changed:true, groupId:resolved };
  }

  globalThis.fetch = async (url, init = {}) => {
    let params = null;
    try { params = extractParams(init); } catch {}
    const action = params ? safeToStr(params.get('action')) : '';

    // pre-request patch
    if (params && action === 'SAVE_VHCL_ACTIVATION_NEW') {
      const r = ensureField1(params);
      if (r && r.changed) init = setBodyFromParams(init, params);
    }

    if (params && action === 'ASSET_BASIC_SAVE') {
      const r = ensureGroupId(params);
      if (r && r.changed) init = setBodyFromParams(init, params);
      else if (r && r.reason && r.reason.indexOf('no groupMap') === 0) {
        throw new Error('[PATCH_C6] missing GROUP_ID: execute USER_GROUPS first for client_id=' + safeToStr(params.get('CLIENT_ID')));
      }
    }

    const res = await origFetch(url, init);
        

    // post-response cache
    try {
      if (params && (action === 'USER_GROUPS' || action === 'LOGIN_USER_GROUPS')) {
        const txt = await res.clone().text();
        const n = rememberGroupsFromText(txt);
        if (n) console.log('[PATCH_C6] cached groups: +' + n + ' entries (total=' + groupMap.size + ')');
      }
    } catch (e) {
      console.log('[PATCH_C6] cache parse error:', e && (e.message || e.toString()));
    }

    return res;
  };

  console.log('[PATCH_C6] installed (fetch hook active)');
})();

// === CAPTURE_FETCHWRAP_V8: capture ASSET_BASIC_LOAD via fetch clone ===
const __CAPTURES = {};

function __parseFirstTagAttributes(xml, tagName){
  const t = String(xml || "");
  const re = new RegExp(`<${tagName}\\b([^>]*)\\/?>`, "i");
  const m = re.exec(t);
  if (!m) return null;
  const attrsStr = m[1] || "";
  const attrs = {};
  const reAttr = /([A-Za-z0-9_:-]+)\s*=\s*"([^"]*)"/g;
  let a;
  while ((a = reAttr.exec(attrsStr))) attrs[a[1]] = a[2];
  return attrs;
}

function __snip(text, n){
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.slice(0, (n || 900));
}

try {
  const __origFetch = globalThis.fetch;
  if (__origFetch && !__origFetch.__capV8Wrapped) {
    const wrapped = async function(url, init){
      const u = String(url || "");
      globalThis.__LAST_FETCH_URL = u; // PATCH_A11
      globalThis.__LAST_FETCH_URL = u;
      const body = init && init.body != null ? String(init.body) : "";
      const want = u.includes("AppEngine_2_1/default.aspx") && (body.includes("action=ASSET_BASIC_LOAD") || body.includes("action=ASSET_BASIC_SAVE") || body.includes("action=GET_VHCL_ACTIVATION_DATA_NEW"));

      // chama o fetch anterior (que já inclui PATCH_C6)
      
      // PATCH_C6_VHCLS_INJECT_COOKIE_V2 (antes do fetch original)
      try {
        const __in = (typeof input !== 'undefined') ? input :
                     ((typeof arguments !== 'undefined' && arguments.length>0) ? arguments[0] : undefined);
        const __init = (typeof init !== 'undefined') ? init :
                       ((typeof arguments !== 'undefined' && arguments.length>1) ? arguments[1] : undefined);

        const __body = (__init && __init.body) ? __init.body : null;

        // detecta action=VHCLS de forma robusta
        let __action = '';
        try {
          if (__body && typeof __body.get === 'function') __action = String(__body.get('action') || '');
        } catch(e) {}

        let __bstr = '';
        try {
          if (typeof __body === 'string') __bstr = __body;
          else if (__body && __body.toString) __bstr = __body.toString();
        } catch(e) {}

        if (!__action && __bstr) {
          const m = __bstr.match(/(?:^|&)action=([^&]+)/i);
          if (m) {
            try { __action = decodeURIComponent(m[1]); } catch(e) { __action = m[1]; }
          }
        }

        if (String(__action).toUpperCase() === 'VHCLS') {
          // verifica se já tem cookie no request
          let __hasCookie = false;
          try {
            const h = (__init && __init.headers) ? __init.headers : null;
            if (h) {
              if (typeof h.get === 'function') __hasCookie = !!(h.get('cookie') || h.get('Cookie'));
              else __hasCookie = !!(h.cookie || h.Cookie);
            }
          } catch(e) {}

          if (!__hasCookie) {
            const ck = (typeof __cookieHeaderFromJarSafe === 'function') ? __cookieHeaderFromJarSafe() : '';
            const ckLen = (ck||'').length;
            if (ckLen > 0) {
              try {
                if (__init && __init.headers && typeof __init.headers.set === 'function') __init.headers.set('cookie', ck);
                else {
                  if (__init) {
                    __init.headers = __init.headers || {};
                    __init.headers.cookie = ck;
                  }
                }
              } catch(e) {}
              console.log('[VHCLS_FORCE_COOKIE] injected(cookieLen=' + ckLen + ')');
            } else {
              console.log('[VHCLS_FORCE_COOKIE] WARN cookieLen=0 (jar vazio/parse falhou)');
            }
          } else {
            console.log('[VHCLS_FORCE_COOKIE] already_has_cookie');
          }
        }
      } catch (e) {
        console.log('[VHCLS_FORCE_COOKIE_ERR] ' + ((e && e.message) ? e.message : String(e)));
      }

const res = await __origFetch(url, init);

      if (!want) 

      // PATCH_VHCLS_DBG_C6: captura body do VHCLS sem vazar cookie (v2 - sem depender de input/init)
      try {
        const fs = require('fs');

        const __in = (typeof input !== 'undefined') ? input :
                     ((typeof arguments !== 'undefined' && arguments.length>0) ? arguments[0] : undefined);
        const __init = (typeof init !== 'undefined') ? init :
                       ((typeof arguments !== 'undefined' && arguments.length>1) ? arguments[1] : undefined);

        const __url = (typeof __in === 'string') ? __in : (__in && __in.url ? String(__in.url) : '');
        let __bodyStr = '';
        try {
          const b = (__init && __init.body) ? __init.body : '';
          __bodyStr = (typeof b === 'string') ? b : (b && b.toString ? b.toString() : '');
        } catch (e) {}

        if (__bodyStr && __bodyStr.includes('action=VHCLS')) {
          const c = (typeof res !== 'undefined' && res && typeof res.clone === 'function') ? res.clone() : null;
          const txt = c ? await c.text() : '';

          const ts = Date.now();
          const out = '/tmp/vhcls_dbg_' + ts + '.txt';
          fs.writeFileSync(out, txt || '', 'utf8');

          let plate = '';
          try {
            const m1 = __bodyStr.match(/LICENSE_NMBR=([^&]+)/);
            plate = m1 ? decodeURIComponent(m1[1]) : '';
          } catch (e) {}

          let vid = '';
          try {
            const m2 = (txt || '').match(/VEHICLE_ID\s*=\s*"(\d+)"/) || (txt || '').match(/VEHICLE_ID\s*=\s*(\d+)/);
            vid = m2 ? m2[1] : '';
          } catch (e) {}

          const st = (typeof res !== 'undefined' && res && typeof res.status !== 'undefined') ? res.status : -1;
          console.log('[VHCLS_DBG] status=' + st + ' len=' + (txt||'').length + ' plate=' + plate + ' vehicleId=' + vid + ' saved=' + out);
          console.log('[VHCLS_DBG_HEAD] ' + JSON.stringify((txt||'').slice(0, 900)));
        }
      } catch (e) {
        console.log('[VHCLS_DBG_ERR] ' + ((e && e.message) ? e.message : String(e)));
      }

return res;

      try {
        const txt = await res.clone().text();
        const attrs = __parseFirstTagAttributes(txt, "DATA") || __parseFirstTagAttributes(txt, "ASSET") || __parseFirstTagAttributes(txt, "VHCL") || null;

        const __capKey = body.includes("action=ASSET_BASIC_SAVE") ? "ASSET_BASIC_SAVE" : (body.includes("action=GET_VHCL_ACTIVATION_DATA_NEW") ? "GET_VHCL_ACTIVATION_DATA_NEW" : "ASSET_BASIC_LOAD");
        __CAPTURES[__capKey] = {
          ts: Date.now(),
          url: u,
          req: __snip(body, 2200),
          resp: __snip(txt, 6000),
          tag: attrs
        };

        console.log("[CAPTURE_FETCHWRAP_V8] captured " + __capKey + " bytes=" + String(txt || "").length);
} catch (e) {
        console.log("[CAPTURE_FETCHWRAP_V8] capture error:", e && (e.message || e.toString()));
      }

      return res;
    };
    wrapped.__capV8Wrapped = true;
    globalThis.fetch = wrapped;
    __origFetch.__capV8Wrapped = true;
  }
} catch {}
// === /CAPTURE_FETCHWRAP_V8 ===

/**
 * v8 - HTML5 Actions (multi-step)
 * - mantém guardrails anti-job-preso (JOB_MAX_MS + COMPLETE sempre)
 * - login HTML5 via APPLICATION_LOGIN (TFL_SESSION)
 * - suporta executar uma lista de ações HTML5 por job (payload.html5Steps[])
 *   permitindo UNINSTALL / MAINT_WITH_SWAP / CHANGE_COMPANY sem hardcode de payload.
 * - INSTALL continua suportado via builder SAVE_VHCL_ACTIVATION_NEW (igual v7)
 */

const fs = require("fs");
const fsp = fs.promises;

const BASE = (process.env.JOB_SERVER_BASE_URL || "").replace(/\/+$/, "");
const WORKER_KEY = (process.env.WORKER_KEY || "").trim();
const WORKER_ID = (process.env.WORKER_ID || "tunel").trim();

const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 60000);
const JOB_MAX_MS = Number(process.env.JOB_MAX_MS || 60000);

const DRY_RUN = String(process.env.DRY_RUN || "1") !== "0";
const EXECUTE_HTML5 =
  String(process.env.EXECUTE_HTML5 || "0").toLowerCase() === "true" ||
  String(process.env.EXECUTE_HTML5 || "0") === "1";

const HTML5_ACTION_URL = (process.env.HTML5_ACTION_URL || "https://html5.traffilog.com/AppEngine_2_1/default.aspx").trim();
const COOKIEJAR_PATH = (process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json").trim();




// === PATCH_VA1_CANON_VHCLS_BEGIN ===
// Objetivo: tirar VHCLS do fetch-hook/TAP e executar via caminho canônico (cookiejar + warmup/login).
// - Sem logar cookies/tokens (apenas flags/tamanhos/status).
// - Warmup GET para materializar ASP.NET_SessionId.
// - Reusa __ensureTflSession() (APPLICATION_LOGIN) já existente.
const __va_fs = require("fs");

function __va_hasCookie(ck, name){
  try { return new RegExp("(^|;\\s*)"+name.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')+"=").test(String(ck||"")); }
  catch(e){ return false; }
}
function __va_flags(ck){
  return `ASP=${__va_hasCookie(ck,"ASP.NET_SessionId")?1:0} TFL=${__va_hasCookie(ck,"TFL_SESSION")?1:0} EULA=${__va_hasCookie(ck,"EULA_APPROVED")?1:0} ROOT=${__va_hasCookie(ck,"APPLICATION_ROOT_NODE")?1:0}`;
}
function __va_readJarRaw(){
  try { return __va_fs.readFileSync(COOKIEJAR_PATH, "utf8"); } catch(e){ return ""; }
}
function __va_parseJarToMap(raw){
  const txt = String(raw||"").trim();
  if (!txt) return {};
  // JSON map {TFL_SESSION:"...", ASP.NET_SessionId:"...", ...}
  if (txt[0] === "{") {
    try {
      const j = JSON.parse(txt);
      if (j && typeof j === "object" && !Array.isArray(j)) return j;
    } catch(e){}
  }
  // JSON list [{name,value},...]
  if (txt[0] === "[") {
    try {
      const j = JSON.parse(txt);
      const out = {};
      if (Array.isArray(j)) {
        for (const it of j) {
          if (it && typeof it === "object" && it.name && (it.value !== undefined)) out[String(it.name)] = String(it.value);
        }
      }
      return out;
    } catch(e){}
  }
  // cookie header string "A=B; C=D"
  const out = {};
  for (const part of txt.split(";")) {
    const kv = part.trim();
    if (!kv) continue;
    const i = kv.indexOf("=");
    if (i <= 0) continue;
    const k = kv.slice(0,i).trim();
    const v = kv.slice(i+1).trim();
    if (k) out[k] = v;
  }
  return out;
}
function __va_cookieHeaderFromMap(m){
  const keys = Object.keys(m||{});
  // mantém ordenação estável e evita header gigante: prioriza cookies "core"
  const core = ["ASP.NET_SessionId","TFL_SESSION","EULA_APPROVED","APPLICATION_ROOT_NODE","LOGIN_DATA","AWSALB","AWSALBCORS"];
  const ordered = [];
  for (const k of core) if (k in m) ordered.push(k);
  for (const k of keys) if (!ordered.includes(k)) ordered.push(k);
  const parts = [];
  for (const k of ordered) {
    const v = (m||{})[k];
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${k}=${String(v)}`);
  }
  return parts.join("; ");
}
function __va_writeJarMap(m){
  try {
    const tmp = COOKIEJAR_PATH + ".tmp." + Date.now();
    __va_fs.writeFileSync(tmp, JSON.stringify(m||{}), "utf8");
    __va_fs.renameSync(tmp, COOKIEJAR_PATH);
  } catch(e) {
    console.log("[html5_v8] [VA1] WARN writeJar failed: " + (e && (e.message||e.toString())));
  }
}
function __va_getSetCookieList(res){
  try {
    if (res && res.headers) {
      if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
      const sc = res.headers.get && res.headers.get("set-cookie");
      // fallback frágil (melhor que nada): se não dá pra separar com segurança, não atualiza jar
      if (sc && sc.indexOf(",") < 0) return [sc];
    }
  } catch(e){}
  return [];
}
function __va_mergeSetCookieIntoMap(m, setCookies){
  const out = Object.assign({}, m||{});
  for (const sc of (setCookies||[])) {
    const s = String(sc||"");
    const first = s.split(";")[0];
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const k = first.slice(0,i).trim();
    const v = first.slice(i+1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}
async function __va_warmupAsp(){
  // GET simples para receber ASP.NET_SessionId via Set-Cookie
  try {
    const res = await fetch(HTML5_ACTION_URL, { method:"GET", redirect:"manual" });
    const sc = __va_getSetCookieList(res);
    if (sc && sc.length) {
      const raw = __va_readJarRaw();
      const m = __va_parseJarToMap(raw);
      const merged = __va_mergeSetCookieIntoMap(m, sc);
      __va_writeJarMap(merged);
      const ck = __va_cookieHeaderFromMap(merged);
      console.log(`[html5_v8] [VA1] warmupAsp status=${res.status} setCookie=${sc.length} jarFlags=${__va_flags(ck)} jarBytes=${raw.length}`);
    } else {
      console.log(`[html5_v8] [VA1] warmupAsp status=${res && res.status} setCookie=0`);
    }
  } catch(e) {
    console.log("[html5_v8] [VA1] warmupAsp ERR " + (e && (e.message||e.toString())));
  }
}
async function __va_ensureHtml5Session(){
  const raw0 = __va_readJarRaw();
  const m0 = __va_parseJarToMap(raw0);
  const ck0 = __va_cookieHeaderFromMap(m0);
  const hasAsp0 = __va_hasCookie(ck0,"ASP.NET_SessionId");
  const hasTfl0 = __va_hasCookie(ck0,"TFL_SESSION");

  if (!hasAsp0) await __va_warmupAsp();

  // reusa o ensure já existente (ele chama login via APPLICATION_LOGIN)
  if (!hasTfl0 && (typeof __ensureTflSession === "function")) {
    try { await __ensureTflSession(); } catch(e){ /* keep going */ }
  }

  const raw1 = __va_readJarRaw();
  const m1 = __va_parseJarToMap(raw1);
  const ck1 = __va_cookieHeaderFromMap(m1);
  const flags = __va_flags(ck1);
  console.log(`[html5_v8] [VA1] ensureHtml5Session flags=${flags} jarBytes=${raw1.length} cookieHeaderLen=${ck1.length}`);
  return { map:m1, cookie:ck1, flags };
}
async function __va_appenginePost(action, fields, tag){
  const sess = await __va_ensureHtml5Session();
  const params = new URLSearchParams();
  params.set("action", String(action||""));
  for (const [k,v] of Object.entries(fields||{})) params.set(k, String(v ?? ""));
  const body = params.toString();

  const res = await fetch(HTML5_ACTION_URL, {
    method:"POST",
    headers: {
      "content-type":"application/x-www-form-urlencoded; charset=UTF-8",
      "cookie": sess.cookie
    },
    body
  });

  const txt = await res.text().catch(()=> "");
  const sc = __va_getSetCookieList(res);
  if (sc && sc.length) {
    const merged = __va_mergeSetCookieIntoMap(sess.map, sc);
    __va_writeJarMap(merged);
  }

  const loginNeg = (String(txt||"").indexOf('login="-1"') >= 0);
  const vid = (action === "VHCLS") ? __va_parseVehicleIdFromVhcls(txt, (fields||{}).LICENSE_NMBR) : null;

  console.log(`[html5_v8] [VA1] ${tag||action} status=${res.status} len=${(txt||"").length} loginNeg=${loginNeg?1:0} jarFlags=${sess.flags}`);
  return { status: res.status, text: txt, loginNeg, vehicleId: vid, jarFlags: sess.flags };
}
function __va_parseVehicleIdFromVhcls(txt, plate){
  const t = String(txt||"");
  const p = String(plate||"").trim();
  if (!t) return null;
  if (p) {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re1 = new RegExp('LICENSE_NMBR="\\s*' + esc + '\\s*"[^>]{0,1600}?VEHICLE_ID="(\\d+)"', 'i');
    const m1 = t.match(re1);
    if (m1 && m1[1]) return m1[1];
  }
  const m2 = t.match(/VEHICLE_ID\s*=\s*["\']?(\d+)/i);
  return (m2 && m2[1]) ? m2[1] : null;
}
async function __va_vhclsRefresh(plate){
  const pl = String(plate||"").trim();
  let r = await __va_appenginePost("VHCLS", { REFRESH_FLG:"1", LICENSE_NMBR:pl }, "VHCLS_CANON");;
  // PATCH_VA1_VHCLS_RETRY_LOGINNEG_V1
  try {
    if (r && r.loginNeg) {
      console.log('[html5_v8] [VA1] VHCLS_CANON loginNeg=1 -> forcing relogin + retry');
      try {
        const raw = __va_readJarRaw();
        const mm = __va_parseJarToMap(raw);
        try { delete mm.TFL_SESSION; } catch(e) {}
        __va_writeJarMap(mm);
      } catch(e) {}
      try { globalThis.__HTML5_HAS_TFL = false; } catch(e) {}
      try { if (typeof __ensureTflSession === "function") await __ensureTflSession(); } catch(e) {}
      r = await __va_appenginePost("VHCLS", { REFRESH_FLG:"1", LICENSE_NMBR:pl }, "VHCLS_CANON_RETRY");
    }
  } catch(e) {}

  const head = String(r.text||"").slice(0, 900); // não tem segredo aqui; resposta é pública, mas limita tamanho
  return { plate:pl, status:r.status, len:(r.text||"").length, loginNeg:r.loginNeg, vehicleId:r.vehicleId, jarFlags:r.jarFlags, head };
}

async function __va_deactivateVehicleHistCan(vehicleId, plate){
  const vid = String(vehicleId||"").trim();
  const pl  = String(plate||"").trim();
  // payload mínimo (mesmo do remap)
  const fields = {
    VERSION_ID: "2",
    VEHICLE_ID: vid,
    LICENSE_NMBR: pl,
    REASON_CODE: "5501",
    DELIVER_CODE: "5511",
  };
  const r = await __va_appenginePost("DEACTIVATE_VEHICLE_HIST", fields, "DEACTIVATE_CANON");
  const head = String(r.text||"").slice(0,220).replace(/\s+/g," ");
  console.log(`[html5_v8] [VA2] DEACTIVATE_CANON head="${head}"`);
  return r;
}
// === PATCH_VA1_CANON_VHCLS_END ===
// PATCH_VHCLS_FORCE_COOKIE_V1: monta Cookie header a partir do cookiejar (sem logar valores)
function __cookieHeaderFromJarSafe() {
  const fs = require('fs');
  try {
    if (!fs.existsSync(COOKIEJAR_PATH)) return '';
    const raw = fs.readFileSync(COOKIEJAR_PATH, 'utf8') || '';
    // tenta JSON.parse
    try {
      const j = JSON.parse(raw);
      // formato: {cookies:[{name,value},...]}
      if (j && Array.isArray(j.cookies)) {
        const parts = [];
        for (const c of j.cookies) {
          if (c && c.name && (c.value !== undefined)) parts.push(String(c.name) + '=' + String(c.value));
        }
        return parts.join('; ');
      }
      // formato: [{name,value},...]
      if (Array.isArray(j)) {
        const parts = [];
        for (const c of j) {
          if (c && c.name && (c.value !== undefined)) parts.push(String(c.name) + '=' + String(c.value));
        }
        return parts.join('; ');
      }
      // formato: {TFL_SESSION:"...", ASP.NET_SessionId:"...", ...}
      if (j && typeof j === 'object') {
        const parts = [];
        for (const k of Object.keys(j)) {
          const v = j[k];
          if (typeof v === 'string' && /^[A-Z0-9_]{3,}$/i.test(k)) parts.push(String(k) + '=' + v);
        }
        return parts.join('; ');
      }
    } catch(e) {
      // fallback regex direto no texto
    }
    // fallback: tenta extrair name/value no texto
    const parts = [];
    for (const mm of raw.matchAll(/"name"\s*:\s*"([A-Z0-9_]{3,})"\s*,\s*"value"\s*:\s*"([^"]*)"/gi)) {
      if (mm && mm[1]) parts.push(mm[1] + '=' + (mm[2]||''));
    }
    if (parts.length) return parts.join('; ');
    // fallback final: se já existir algo tipo "TFL_SESSION=..."
    const m2 = raw.match(/TFL_SESSION\s*=\s*[^;,"\s]+/i);
    return m2 ? String(m2[0]) : '';
  } catch(e) { return ''; }
}
// [PATCH_ENSURE_TFL_SESSION] garante TFL_SESSION no cookiejar (sem vazar valores)
async function __ensureTflSession() {
  try {
    if (globalThis.__HTML5_HAS_TFL) return true;
    if (globalThis.__HTML5_LOGIN_BUSY) {
      // espera curta (máx ~10s)
      for (let i=0;i<50;i++) {
        await new Promise(r=>setTimeout(r,200));
        if (globalThis.__HTML5_HAS_TFL) return true;
        if (!globalThis.__HTML5_LOGIN_BUSY) break;
      }
    }

    const fs = require('fs');
    let raw = '';
    try { raw = fs.existsSync(COOKIEJAR_PATH) ? fs.readFileSync(COOKIEJAR_PATH,'utf8') : ''; } catch(e) {}
    // [PATCH_ENSURE_TFL_SESSION_V2B] parser robusto (cookie header + JSON jar)
    const names = new Set();
    try {
      const r = String(raw || '');
      for (const x of (r.match(/\b([A-Z0-9_]{3,})\s*=/g) || [])) {
        names.add(x.replace(/\s*=.*$/,'').toUpperCase());
      }
      for (const m of r.matchAll(/"name"\s*:\s*"([A-Z0-9_]{3,})"/gi)) if (m && m[1]) names.add(String(m[1]).toUpperCase());
      for (const m of r.matchAll(/"key"\s*:\s*"([A-Z0-9_]{3,})"/gi))  if (m && m[1]) names.add(String(m[1]).toUpperCase());
    } catch (e) {}
const hasTfl = names.has('TFL_SESSION');
    console.log('[html5_v8] [ensureTfl] before hasTfl=' + hasTfl + ' keys=' + Array.from(names).slice(0,20).join(','));
    if (hasTfl) { globalThis.__HTML5_HAS_TFL = true; return true; }

    globalThis.__HTML5_LOGIN_BUSY = true;
    try {
      console.log('[html5_v8] [ensureTfl] missing TFL_SESSION -> running login fn: html5LoginAndStoreCookies');
      await html5LoginAndStoreCookies();
    } finally {
      globalThis.__HTML5_LOGIN_BUSY = false;
    }

    
    // [PATCH_ENSURE_TFL_SESSION_V2B] espera o cookiejar materializar TFL_SESSION (até ~3s)
    const __sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
    for (let i=0;i<20;i++) {
      let rr='';
      try { rr = fs.existsSync(COOKIEJAR_PATH) ? fs.readFileSync(COOKIEJAR_PATH,'utf8') : ''; } catch(e) {}
      const __has = (String(rr||'').includes('TFL_SESSION=') || /"name"\s*:\s*"TFL_SESSION"/i.test(String(rr||'')));
      if (__has) break;
      await __sleep(150);
    }
let raw2 = '';
    try { raw2 = fs.existsSync(COOKIEJAR_PATH) ? fs.readFileSync(COOKIEJAR_PATH,'utf8') : ''; } catch(e) {}
    // [PATCH_ENSURE_TFL_SESSION_V2B] parser robusto (cookie header + JSON jar)
    const names2 = new Set();
    try {
      const r = String(raw2 || '');
      for (const x of (r.match(/\b([A-Z0-9_]{3,})\s*=/g) || [])) {
        names2.add(x.replace(/\s*=.*$/,'').toUpperCase());
      }
      for (const m of r.matchAll(/"name"\s*:\s*"([A-Z0-9_]{3,})"/gi)) if (m && m[1]) names2.add(String(m[1]).toUpperCase());
      for (const m of r.matchAll(/"key"\s*:\s*"([A-Z0-9_]{3,})"/gi))  if (m && m[1]) names2.add(String(m[1]).toUpperCase());
    } catch (e) {}
const hasTfl2 = names2.has('TFL_SESSION');
    console.log('[html5_v8] [ensureTfl] after hasTfl=' + hasTfl2 + ' keys=' + Array.from(names2).slice(0,20).join(','));
    // PATCH_NO_ABORT_ENSURETFL
    if (!hasTfl2) {
      try {
        const __sz = (()=>{ try { return require('fs').existsSync(COOKIEJAR_PATH) ? require('fs').statSync(COOKIEJAR_PATH).size : 0; } catch(e){ return 0; } })();
        console.log('[html5_v8] [ensureTfl] WARN: no TFL_SESSION detected; proceeding (cookiejar_size=' + __sz + ')');
      } catch(e) {}
      return true;
    }
    globalThis.__HTML5_HAS_TFL = true;
    return true;
  } catch (e) {
    console.log('[html5_v8] [ensureTfl] FAIL: ' + ((e && e.message) ? e.message : String(e)));
    throw e;
  }
}
const HTML5_LOGIN_NAME = (process.env.HTML5_LOGIN_NAME || "").trim();
const HTML5_PASSWORD = (process.env.HTML5_PASSWORD || "").trim();
const HTML5_LANGUAGE = String(process.env.HTML5_LANGUAGE || "7001").trim();
const HTML5_ORIG_ZOOM_ID = String(process.env.HTML5_ORIG_ZOOM_ID || "3472").trim();

if (!BASE) { console.error("[html5_v8] missing JOB_SERVER_BASE_URL"); process.exit(2); }
if (!WORKER_KEY) { console.error("[html5_v8] missing WORKER_KEY"); process.exit(2); }

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
    let j = null;
    try { j = JSON.parse(raw); } catch (_) { return { cookie: "", updatedAt: null }; }

    // formato canônico: {cookie, keys, updatedAt, meta}
    if (j && typeof j === "object" && typeof j.cookie === "string") {
      return { cookie: String(j.cookie || ""), updatedAt: j.updatedAt || null };
    }

    // formato: {cookies:[{name,value},...]}
    if (j && typeof j === "object" && Array.isArray(j.cookies)) {
      const parts = [];
      for (const c of j.cookies) {
        if (c && c.name && (c.value !== undefined)) parts.push(String(c.name) + "=" + String(c.value));
      }
      return { cookie: parts.join("; "), updatedAt: null };
    }

    // formato: [{name,value},...]
    if (Array.isArray(j)) {
      const parts = [];
      for (const c of j) {
        if (c && c.name && (c.value !== undefined)) parts.push(String(c.name) + "=" + String(c.value));
      }
      return { cookie: parts.join("; "), updatedAt: null };
    }

    // formato "map": {TFL_SESSION:"..", ASP.NET_SessionId:"..", ...}
    if (j && typeof j === "object") {
      const skip = new Set(["cookie","keys","updatedAt","meta","cookies"]);
      const parts = [];
      for (const k of Object.keys(j)) {
        if (skip.has(k)) continue;
        const v = j[k];
        if (v === undefined || v === null) continue;
        if (typeof v === "string" || typeof v === "number") parts.push(String(k) + "=" + String(v));
      }
      return { cookie: parts.join("; "), updatedAt: null };
    }

    return { cookie: "", updatedAt: null };
  } catch (e) {
    return { cookie: "", updatedAt: null };
  }
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
  if (!globalThis.__HTML5_LOGIN_BUSY) { await __ensureTflSession(); }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let cookie = ensureCookieDefaults(cookieHeader || "");
  try{
    const res = await fetch(url, {
      method,
      headers: { ...headers, ...(cookie?{cookie}:{}), "user-agent":"monitor-backend-html5-worker/8" },
      body,
      redirect:"manual",
      signal: controller.signal
    });
    
      // === PATCH_CAPTURE_FETCH_TEXT_V1 ===
      let __rawText = "";
      try { __rawText = await res.text(); } catch (_) {}
      // mantém uma cópia acessível para quem consome o retorno
cookie = mergeCookies(cookie, extractSetCookies(res.headers));
    const text = __rawText || "";
    return { status: res.status, text, cookie, headers: res.headers };
  } finally { clearTimeout(t); }
}

// Job server
async function httpFetch(path, { method="GET", params=null, json=null } = {}) {
  // PATCH_HTTPFETCH_VHCLS_INJECT_COOKIE_V1
  try {
    const __o = (typeof arguments !== 'undefined' && arguments.length>1) ? arguments[1] : null;
    const __b = (__o && __o.body) ? String(__o.body) : '';
    if (__b.includes('action=VHCLS')) {
      // detecta se já tem cookie
      let __has = false;
      try {
        const h = (__o && __o.headers) ? __o.headers : null;
        if (h) {
          if (typeof h.get === 'function') __has = !!(h.get('cookie') || h.get('Cookie'));
          else __has = !!(h.cookie || h.Cookie);
        }
      } catch(e) {}
      if (!__has) {
        const ck = __cookieHeaderFromJarSafe();
        const ckLen = (ck||'').length;
        // injeta cookie se conseguiu montar
        if (ckLen > 0) {
          try {
            if (__o.headers && typeof __o.headers.set === 'function') __o.headers.set('cookie', ck);
            else {
              __o.headers = __o.headers || {};
              __o.headers.cookie = ck;
            }
          } catch(e) {}
          console.log('[VHCLS_FORCE_COOKIE] injected cookieLen=' + ckLen);
        } else {
          console.log('[VHCLS_FORCE_COOKIE] WARN cookieLen=0 (jar vazio/parse falhou)');
        }
      }
    }
  } catch(e) {
    console.log('[VHCLS_FORCE_COOKIE_ERR] ' + ((e && e.message) ? e.message : String(e)));
  }

  // [PATCH_VHCLS_COOKIE_LEN] loga cookieLen só para VHCLS (sem mostrar cookie)
  try {
    const __o = (arguments && arguments.length>1) ? arguments[1] : null;
    const __b = (__o && __o.body) ? String(__o.body) : '';
    if (__b.includes('action=VHCLS')) {
      let __ck='';
      try {
        const h = (__o && __o.headers) ? __o.headers : {};
        __ck = (h && (h.cookie || h.Cookie)) ? String(h.cookie || h.Cookie) : (h && h.get ? String(h.get('cookie') || h.get('Cookie') || '') : '');
      } catch(e) {}
      console.log('[VHCLS_REQ] cookieLen=' + (__ck||'').length);
    }
  } catch(e) {}
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
  // === CAPTURE_FETCHWRAP_V8_ATTACH ===
  try { if (result && typeof result === "object") result.captures = __CAPTURES; } catch {}
  // === /CAPTURE_FETCHWRAP_V8_ATTACH ===

  return httpFetch(`/api/jobs/${encodeURIComponent(String(id))}/complete`, { method:"POST", json:{ status, result, workerId: WORKER_ID } });
}
async function completeJobLogged(id, status, result){
  const r = await completeJob(id, status, result);
  console.log(`[html5_v8] COMPLETE_API id=${id} status=${status} http=${r.status}`);
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

function parseHtml5Message(text, actionName){
  // === PATCH_LOGOFF_REDIRECT_V8 ===
  // Alguns retornos vêm como <REDIRECT ...><ACTION>LOGOFF</ACTION></REDIRECT>
  // (sem <MESSAGE>). Tratar isso como login negado para forçar relogin + retry.
  const __t0 = String(text || "");
  const __redir = /<REDIRECT\b[^>]*>/i.exec(__t0);
  if (__redir) {
    const __tag = __redir[0] || "";
    const __isLogoff = /<ACTION>\s*LOGOFF\s*<\/ACTION>/i.test(__t0) || /\blogin\s*=\s*["']?-1["']?/i.test(__tag) || /index\.aspx\?node=-1/i.test(__t0);
    if (__isLogoff) {
      return { hasMessage:false, login:-1, isLoginNeg:true, status:"logoff", isErrorStatus:false, isRedirectLogoff:true };
    }
  }
  // === /PATCH_LOGOFF_REDIRECT_V8 ===

  const t = String(text || "");
  const m = /<MESSAGE\b[^>]*>/i.exec(t);
  if (!m) return { hasMessage:false };

  const tag = m[0];

  const loginM = /\blogin\s*=\s*["']?(-?\d+)["']?/i.exec(tag);
  const login = loginM ? Number(loginM[1]) : null;
  const isLoginNeg = (login !== null && login < 0) || /login\s*=\s*["']?-1["']?/i.test(tag);

  const statusM = /\bstatus\s*=\s*["']?([a-z0-9_-]+)["']?/i.exec(tag);
  const status = statusM ? String(statusM[1]).toLowerCase() : null;
  const isErrorStatus = status ? ["error","fail","failed","false","ko"].includes(status) : false;

  // fallback leve (não usar pra “inventar” — só pra sinalizar erro óbvio)
  const looksLikeErrorText = /\berror\b/i.test(t) && /\baction\b/i.test(t);

  return { hasMessage:true, login, isLoginNeg, status, isErrorStatus: (isErrorStatus || looksLikeErrorText) };
}


// === PATCH_CF1_V8 ===
function ensureCustomField1(fields){
  try{
    if (!fields || typeof fields !== "object") return;

    const idsStr = String(fields.FIELD_IDS ?? "").trim();
    const valStr = String(fields.FIELD_VALUE ?? "").trim();
    if (!idsStr) return;

    const ids = idsStr.split(",").map(x=>x.trim()).filter(Boolean);
    if (ids.includes("1")) return;

    // só aplica se for o caso clássico (tem 2 e/ou 6)
    if (!ids.includes("2") && !ids.includes("6")) return;

    const leadingComma = valStr.startsWith(",");
    const tokens = valStr.split(",").filter(Boolean);

    const map = {};
    for (const t of tokens){
      const i = t.indexOf(":");
      if (i <= 0) continue;
      const k = t.slice(0,i).trim();
      const v = t.slice(i+1);
      if (!k) continue;
      map[k] = v;
    }

    const baseVal = (map["2"] !== undefined) ? map["2"] : ((map["6"] !== undefined) ? map["6"] : "");
    map["1"] = baseVal;

    const newIds = ["1", ...ids];
    const outTokens = newIds.map(k => `${k}:${map[k] !== undefined ? map[k] : ""}`);

    fields.FIELD_IDS = newIds.join(",");
    fields.FIELD_VALUE = (leadingComma ? "," : "") + outTokens.join(",");
  } catch (e) {
    console.log("[html5_v8] warn ensureCustomField1:", e && (e.message || e.toString()));
  }
}
// === /PATCH_CF1_V8 ===


function ensureCustomField1_(fields, payload){
  try{
    const idsStr = String(fields.FIELD_IDS || "").trim();
    const valStr = String(fields.FIELD_VALUE || "").trim();

    const ids = idsStr.split(",").map(s=>s.trim()).filter(Boolean);
    if (ids.includes("1")) return;

    // parse ",2:aaa,6:bbb" -> map
    const map = new Map();
    const raw = valStr.replace(/^,/, "");
    const parts = raw ? raw.split(",").map(s=>s.trim()).filter(Boolean) : [];
    for (const p of parts){
      const i = p.indexOf(":");
      if (i > 0){
        const k = p.slice(0,i).trim();
        const v = p.slice(i+1);
        if (k) map.set(k, v);
      }
    }

    let v1 = "";
    if (payload && typeof payload === "object") {
      v1 = String(payload.customField1Value || payload.custom_field_1 || payload.customField1 || "").trim();
    }
    if (!v1) v1 = (map.get("2") || map.get("6") || "");

    // força 1 na frente
    ids.unshift("1");
    const uniq = [];
    const seen = new Set();
    for (const x of ids){
      if (!seen.has(x)) { seen.add(x); uniq.push(x); }
    }
    fields.FIELD_IDS = uniq.join(",");

    map.set("1", v1);

    // rebuild FIELD_VALUE seguindo a ordem dos ids
    const out = [];
    for (const code of uniq){
      if (map.has(code)) out.push(code + ":" + map.get(code));
    }
    if (out.length) fields.FIELD_VALUE = "," + out.join(",");
  }catch(e){}
}

function buildSaveActivationFields(payload){
  const serial = String(payload.serial || payload.serial_new || payload.SERIAL_NEW || payload.DIAL_NUMBER || payload.INNER_ID || "").trim();
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
  ensureCustomField1(fields);
  ensureCustomField1_(fields, payload);
  return fields;
}

function encodeForm(fields){
  const usp = new URLSearchParams();
  for (const [k,v] of Object.entries(fields)) usp.set(k, String(v ?? ""));
  return usp.toString();
}

function normalizeStep(step, jobPayload){
  const s = step && typeof step === "object" ? step : {};
  const label = String(s.label || s.name || s.action || "step").slice(0, 40);
  const action = String(s.action || "").trim();

  // Se pedirem builder (para SAVE_VHCL_ACTIVATION_NEW), gera fields a partir do payload.
  if (s.useBuilder) {
    const src = (s.payload && typeof s.payload === "object") ? s.payload : jobPayload;
    const built = buildSaveActivationFields(src || {});
    return { label, action: built.action, fields: built, _from: "builder" };
  }

  const fields = (s.fields && typeof s.fields === "object") ? { ...s.fields } : null;
  if (!action && fields && fields.action) {
    return { label, action: String(fields.action), fields, _from: "fields.action" };
  }
  // PATCH_C8_ALLOWED_GROUPS_HOOK
  try {
    if (typeof patchC8 !== "undefined" && patchC8 && typeof patchC8.applyPatchC8AllowedGroups === "function") {
      const _job = (typeof job !== "undefined") ? job : ((typeof ctx !== "undefined" && ctx && ctx.job) ? ctx.job : null);
      const _cap = (typeof captures !== "undefined") ? captures : ((typeof ctx !== "undefined" && ctx && ctx.captures) ? ctx.captures : null);
      if (_job && _cap && typeof step !== "undefined") patchC8.applyPatchC8AllowedGroups(step, { job: _job, captures: _cap });
    }
  } catch (e) { /* ignore */ }
  if (!action) throw new Error(`html5Steps step missing action (label=${label})`);
  if (!fields) throw new Error(`html5Steps step missing fields for action=${action} (label=${label})`);
  return { label, action, fields, _from: "fields" };
}


/* ASSET_BASIC_SAVE_DEFAULTS_V1
 * Motivo: ASSET_BASIC_SAVE no HTML5 costuma enviar vários campos como 0 e datas (não vazio).
 * Aqui garantimos defaults para evitar "Action: ASSET_BASIC_SAVE error" genérico.
 */
function __fmtDDMMYYYY(d){
  try {
    const dd = String(d.getDate()).padStart(2,"0");
    const mm = String(d.getMonth()+1).padStart(2,"0");
    const yy = String(d.getFullYear());
    return dd + "/" + mm + "/" + yy;
  } catch(e) { return ""; }
}
function ensureAssetBasicSaveDefaults(f){
  try{
    // numéricos que no template real vão como 0
    const zKeys = ["NEXT_SER_KM","NEXT_SER_ENG","MODEL_YEAR","TIRES","DRAGGING_HOOK","IN_GARAGE"];
    for (const k of zKeys){
      const v = f[k];
      if (v === undefined || v === null || String(v).trim() === "") f[k] = "0";
    }

    // datas: usa UNIT_END_OF_WARRANTY_DATE se existir; senão hoje
    const baseDate = (f.UNIT_END_OF_WARRANTY_DATE && String(f.UNIT_END_OF_WARRANTY_DATE).trim()) || __fmtDDMMYYYY(new Date());
    const dKeys = ["EXPIRATION_DATE","OWNERSHIP_DATE","REGISTER_DATE","SERVICE_START","SERVICE_END","POINT_ZERO","DOD"];
    for (const k of dKeys){
      const v = f[k];
      if (v === undefined || v === null || String(v).trim() === "") f[k] = baseDate;
    }
  } catch(e) { /* noop */ }
}


async function html5CallFormAction(actionName, fields, cookieHeader){
  const f = { ...(fields || {}) };
  f.action = String(f.action || actionName);
  if (f.VERSION_ID === undefined) f.VERSION_ID = "2";
  if (String(f.action) === "SAVE_VHCL_ACTIVATION_NEW") ensureCustomField1(f);

  
  if (String(f.action) === "ASSET_BASIC_SAVE") ensureAssetBasicSaveDefaults(f);
const body = encodeForm(f);
  let cookieFixed = ensureCookieDefaults(cookieHeader || "");

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
  await saveCookieJar(r.cookie, { source:`action:${actionName}`, httpStatus:r.status });

  return { httpStatus:r.status, snippet:safeSnippet(r.text), parsed };
}

async function html5RunStep(jobId, step, cookie){
  // === PATCH_VHCLS_RESOLVE_IN_RUNSTEP v1 ===
  // Resolve VEHICLE_ID via VHCLS (REFRESH_FLG=1) quando ausente, antes de ações que exigem VEHICLE_ID.
  try {
    const __ctx = arguments[0];
    const __step = arguments[1];
    const __payload = arguments[2];

    const __act = String((__step && (__step.action || __step.actionName || __step.name || __step.fn || "")) || "").toUpperCase();

    const __needsVid =
      __act.indexOf("DEACTIVATE_VEHICLE_HIST") >= 0 ||
      __act.indexOf("SAVE_VHCL_ACTIVATION_NEW") >= 0 ||
      __act.indexOf("ASSET_BASIC_SAVE") >= 0 ||
      __act.indexOf("ASSET_BASIC_LOAD") >= 0 ||
      __act.indexOf("GET_VHCL_ACTIVATION_DATA_NEW") >= 0;

    if (__needsVid) {
      await ensureVehicleIdByVhcls_(__ctx, __payload);
    }
  } catch (e) {
    try { console.log("[vhcls] pre-runstep resolve skipped:", (e && e.message) ? e.message : e); } catch (_) {}
  }
  // === END PATCH_VHCLS_RESOLVE_IN_RUNSTEP v1 ===

  // PATCH_UNINSTALL_SAVE_TO_DEACTIVATE_V4 (payload-safe)
try {
  const __pl =
    ((typeof payload !== 'undefined') && payload) ? payload :
    ((typeof job !== 'undefined') && job && job.payload) ? job.payload :
    ((typeof currentJob !== 'undefined') && currentJob && currentJob.payload) ? currentJob.payload :
    ((typeof j !== 'undefined') && j && j.payload) ? j.payload :
    ((globalThis && globalThis.__JOB_PAYLOAD) ? globalThis.__JOB_PAYLOAD : null);

  if (__pl && typeof __pl === 'object') {
    try { globalThis.__JOB_PAYLOAD = __pl; } catch(e) {}
  }

  const svc = String((__pl && (__pl.service || __pl.SERVICE)) || '').toUpperCase();

  // só remapeia quando for UNINSTALL + step SAVE (ou label install)
  if (svc === 'UNINSTALL' && step && (step.action === 'SAVE_VHCL_ACTIVATION_NEW' || step.label === 'install')) {
    let vid = String((__pl && (__pl.VEHICLE_ID || __pl.vehicle_id || __pl.vehicleId)) || '');
    if (!vid && globalThis && globalThis.__VHCLS_LAST && globalThis.__VHCLS_LAST.vehicleId) {
      vid = String(globalThis.__VHCLS_LAST.vehicleId || '');
    }
    const plate = String((__pl && (__pl.plate || __pl.LICENSE_NMBR || __pl.license || __pl.licensePlate)) || '').trim();
    if (!vid) throw new Error('uninstall_missing_vehicle_id_before_deactivate');

    // propaga de volta no payload (se existir)
    try {
      if (__pl && typeof __pl === 'object') { __pl.VEHICLE_ID = vid; __pl.vehicle_id = vid; __pl.vehicleId = vid; }
    } catch(e) {}

    step.label = 'uninstall';
    step.action = 'DEACTIVATE_VEHICLE_HIST';
    step.fields = {
      VERSION_ID: '2',
      VEHICLE_ID: vid,
      LICENSE_NMBR: plate,
      REASON_CODE: '5501',
      DELIVER_CODE: '5511'
    };

    console.log(`[html5_v8] [PATCH] UNINSTALL remap SAVE->DEACTIVATE vehicle_id=${vid} plate=${plate}`);
  }
} catch (e) {
  console.log(`[html5_v8] [PATCH] UNINSTALL remap err: ${e && (e.message || e.toString())}`);
  throw e;
}
  // PATCH_LAST_STEP_BEFORE_STAGE
  try {
    globalThis.__LAST_STEP = {
      id: (typeof id !== 'undefined') ? String(id) : '',
      step: (step && step.label) ? String(step.label) : '',
      action: (step && step.action) ? String(step.action) : '',
      attempt: (typeof attempt !== 'undefined') ? attempt : null
    };
  } catch(e) {}
  
  console.log(`[html5_v8] STAGE id=${jobId} step=${step.label} action=${step.action} attempt=1`);
  const r1 = await html5CallFormAction(step.action, step.fields, cookie);

  if (r1.parsed && r1.parsed.isLoginNeg) {
    console.log(`[html5_v8] STAGE id=${jobId} step=login`);
    const loginRes = await html5LoginAndStoreCookies(cookie);
    console.log(`[html5_v8] STAGE id=${jobId} step=login_done hasTfl=${loginRes.hasTfl} keys=${(loginRes.cookieKeys||[]).join(",")}`);

    console.log(`[html5_v8] STAGE id=${jobId} step=${step.label} action=${step.action} attempt=2`);
    const r2 = await html5CallFormAction(step.action, step.fields, loginRes.cookie);

    return { attempt:2, first:r1, login:loginRes, final:r2 };
  }

  return { attempt:1, first:r1, login:null, final:r1 };
}

function stepOk(stepRun){
  const f = stepRun && stepRun.final ? stepRun.final : null;
  if (!f) return false;
  if (f.httpStatus && Number(f.httpStatus) >= 400) return false;
  if (f.parsed && f.parsed.isLoginNeg) return false;
  if (f.parsed && f.parsed.isErrorStatus) return false;
  // heurística leve: alguns responses não têm <MESSAGE>
  return true;
}


// [VA3.1] Robust form parser for GET_VHCL_ACTIVATION_DATA_NEW baseline (input/select/textarea)
function __va_htmlDecode(s){
  const t = String(s == null ? "" : s);
  return t
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return Number.isFinite(c) ? String.fromCharCode(c) : _;
    });
}
function __va_getAttr(tag, name){
  const re = new RegExp(name + String.raw`\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, "i");
  const m = re.exec(String(tag || ""));
  return __va_htmlDecode(m ? (m[1] || m[2] || m[3] || "") : "");
}
function __va_parseFormFieldsFromHtml(html){
  const t = String(html || "");
  const out = {};

  // INPUTs
  const reInp = /<input\b[^>]*>/gi;
  let m;
  while ((m = reInp.exec(t))) {
    const tag = m[0];
    const name = __va_getAttr(tag, "name");
    if (!name) continue;

    const type = String(__va_getAttr(tag, "type") || "").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      if (!/\bchecked\b/i.test(tag)) continue;
    }
    const value = __va_getAttr(tag, "value");
    out[name] = value;
  }

  // TEXTAREA
  const reTa = /<textarea\b[^>]*name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/textarea>/gi;
  while ((m = reTa.exec(t))) {
    const name = __va_htmlDecode(m[1] || m[2] || m[3] || "");
    if (!name) continue;
    const value = __va_htmlDecode(m[4] || "").replace(/\r\n/g, "\n");
    out[name] = value;
  }

  // SELECT (capture selected option value)
  const reSel = /<select\b[^>]*name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/select>/gi;
  while ((m = reSel.exec(t))) {
    const name = __va_htmlDecode(m[1] || m[2] || m[3] || "");
    if (!name) continue;

    const inner = m[4] || "";
    let val = "";

    // try selected option
    const reOpt = /<option\b[^>]*>([\s\S]*?)<\/option>/gi;
    let mo;
    let found = false;
    while ((mo = reOpt.exec(inner))) {
      const optTag = mo[0];
      if (/\bselected\b/i.test(optTag)) {
        val = __va_getAttr(optTag, "value");
        if (!val) val = __va_htmlDecode(mo[1] || "").trim();
        found = true;
        break;
      }
    }

    // fallback: first option
    if (!found) {
      reOpt.lastIndex = 0;
      mo = reOpt.exec(inner);
      if (mo) {
        val = __va_getAttr(mo[0], "value");
        if (!val) val = __va_htmlDecode(mo[1] || "").trim();
      }
    }

    out[name] = val;
  }

  return out;
}
// [VA3.1] end parser

// [VA3] Activation baseline load + swap save builder (keep existing fields)
async function __va_getActivationBaseline(vehicleId){
  const vid = String(vehicleId || "").trim();
  if (!vid) return { ok:false, status:0, len:0, loginNeg:false, attrs:null, jarFlags:"", text:"" };

  const r = await __va_appenginePost("GET_VHCL_ACTIVATION_DATA_NEW", { VEHICLE_ID: vid }, "ACTIVATION_LOAD");

  let aTag = null;
  try { aTag = __parseFirstTagAttributes(r.text, "DATA"); } catch(e) {}
  if (!aTag) { try { aTag = __parseFirstTagAttributes(r.text, "VHCL"); } catch(e) {} }

  let aForm = null;
  try { aForm = __va_parseFormFieldsFromHtml(r.text); } catch(e) {}

  let attrs = null;
  try {
    const merged = {};
    if (aTag && typeof aTag === "object") {
      for (const k of Object.keys(aTag)) merged[k] = (aTag[k] == null) ? "" : String(aTag[k]);
    }
    if (aForm && typeof aForm === "object") {
      for (const k of Object.keys(aForm)) merged[k] = (aForm[k] == null) ? "" : String(aForm[k]);
    }
    if (Object.keys(merged).length) attrs = merged;
  } catch(e) {}

  const cnt = attrs ? Object.keys(attrs).length : 0;
  console.log(`[html5_v8] [VA3] ACTIVATION_LOAD status=${r.status} len=${(r.text||"").length} loginNeg=${r.loginNeg?1:0} attrs=${cnt} jarFlags=${r.jarFlags||""}`);
  return { ...r, attrs };
}

function __va_buildSwapSaveFields(payload, baselineAttrs){
  const f = {};
  const base = (baselineAttrs && typeof baselineAttrs === "object") ? baselineAttrs : {};
  for (const k of Object.keys(base)) f[k] = (base[k] === null || base[k] === undefined) ? "" : String(base[k]);

  // Completa somente CLIENT_ID a partir do ASSET_BASIC_LOAD (quando disponível).
  // (Não inferir GROUP_ID / VEHICLE_TYPE aqui — baseline do Cadastro é a fonte de verdade.)
  const attrs = (payload && payload.__assetLoadAttrs && typeof payload.__assetLoadAttrs === "object") ? payload.__assetLoadAttrs : {};
  if (!f.CLIENT_ID && attrs.CLIENT_ID != null) f.CLIENT_ID = String(attrs.CLIENT_ID);

  const vid = String((payload && (payload.vehicle_id || payload.vehicleId || payload.VEHICLE_ID)) || f.VEHICLE_ID || "").trim();
  const plate = String((payload && (payload.plate || payload.LICENSE_NMBR || payload.license || payload.licensePlate)) || f.LICENSE_NMBR || "").trim();
  const serialNew = String((payload && (payload.serial_new || payload.serialNew || payload.new_serial || payload.SERIAL_NEW || payload.serial || payload.inner_id || payload.INNER_ID || payload.unit || payload.UNIT)) || "").trim();

  if (vid) f.VEHICLE_ID = vid;
  if (plate) f.LICENSE_NMBR = plate;

  if (serialNew) {
    f.DIAL_NUMBER = serialNew;
    f.INNER_ID = serialNew;
    if (Object.prototype.hasOwnProperty.call(f, "UNIT")) f.UNIT = serialNew;
    if (Object.prototype.hasOwnProperty.call(f, "UNIT_NUMBER")) f.UNIT_NUMBER = serialNew;
    if (Object.prototype.hasOwnProperty.call(f, "UNIT_SN")) f.UNIT_SN = serialNew;
  }

  // defaults mínimos (somente quando ausente)
  try {
    if (!f.MILAGE_SOURCE_ID) f.MILAGE_SOURCE_ID = "5067";
    if (!f.WARRANTY_PERIOD_ID) f.WARRANTY_PERIOD_ID = "1";
    if (!f.UNIT_TYPE_ID) f.UNIT_TYPE_ID = "1";

    if (!f.INSTALLATION_DATE) {
      if (typeof __fmtDDMMYYYY === "function") f.INSTALLATION_DATE = __fmtDDMMYYYY(new Date());
    }
    if (!f.WARRANTY_START_DATE && f.INSTALLATION_DATE) f.WARRANTY_START_DATE = f.INSTALLATION_DATE;
    if (!f.LOG_UNIT_DATA_UNTIL_DATE && f.INSTALLATION_DATE) f.LOG_UNIT_DATA_UNTIL_DATE = f.INSTALLATION_DATE;
  } catch(e){}

  f.action = "SAVE_VHCL_ACTIVATION_NEW";
  if (f.VERSION_ID === undefined) f.VERSION_ID = "2";

  // Custom fields: manter exatamente como o baseline devolveu.
  // Só remover se o job pedir explicitamente (payload.strip_fields=1).
  const wantStrip = !!(payload && (payload.strip_fields === 1 || payload.strip_fields === "1" || payload.strip_fields === true));
  if (wantStrip) {
    try { delete f.FIELD_IDS; } catch(e){}
    try { delete f.FIELD_VALUE; } catch(e){}
    try { delete f.FIELD_ID; } catch(e){}
    try { delete f.field_id; } catch(e){}
    try { delete f.field_value; } catch(e){}
  }

  return f;
}


function normService(v){
  const s = String(v || "").trim().toUpperCase();
  if (s === "DESINSTALACAO" || s === "DESINSTALAÇÃO") return "UNINSTALL";
  if (s === "MANUTENCAO_COM_TROCA" || s === "MANUTENÇÃO_COM_TROCA") return "MAINT_WITH_SWAP";
  if (s === "MANUTENCAO_SEM_TROCA" || s === "MANUTENÇÃO_SEM_TROCA") return "MAINT_NO_SWAP";
  if (s === "TROCA_EMPRESA" || s === "TROCA_DE_EMPRESA") return "CHANGE_COMPANY";
  return s;
}

function buildStepsForService(service, payload){
  // PATCH_D2: v8 services (templates reais + preload via ASSET_BASIC_LOAD)
  // Prioridade: payload.html5Steps (lista explícita, com payload idêntico ao da UI)
  if (Array.isArray(payload.html5Steps) && payload.html5Steps.length) {
    return payload.html5Steps.map(s => normalizeStep(s, payload));
  }

  // Compat: payload.html5Action + payload.html5Fields (1 passo)
  if (payload.html5Action && payload.html5Fields) {
    return [normalizeStep({ label: "custom", action: payload.html5Action, fields: payload.html5Fields }, payload)];
  }

  // Fallback: INSTALL conhecido (builder)
  if ((service === "INSTALL" || service === "UNINSTALL")) {
    return [normalizeStep({ label: "install", useBuilder: true }, payload)];
  }

  // MAINT_NO_SWAP: não altera HTML5 (somente Monitor)
  if (service === "MAINT_NO_SWAP") return [];

  const vId = payload.vehicle_id || payload.vehicleId || payload.VEHICLE_ID || payload.vehicleID || payload.VehicleId;

  // Template real: DEACTIVATE_VEHICLE_HIST (descadastro/desvincular)
  const mkDeactivate = (label, note) => {
    if (!vId) return null;
    const installer = payload.installer_name || payload.installer || payload.INSTALLER_NAME || "installer";
    const comments = payload.comments || payload.note || payload.notes || note || "";
    const reason = String(payload.reason_code || payload.REASON_CODE || 5501);
    const deliver = String(payload.deliver_code || payload.DELIVER_CODE || 5511);
    return normalizeStep({
      label,
      action: "DEACTIVATE_VEHICLE_HIST",
      fields: {
        INSTALLER_NAME: String(installer),
        REASON_CODE: String(reason),
        DELIVER_CODE: String(deliver),
        COMMENTS: String(comments),
        LICENSE_NMBR: String(payload.plate || payload.LICENSE_NMBR || payload.license || payload.licensePlate || ""),
        VEHICLE_ID: String(vId),
        action: "DEACTIVATE_VEHICLE_HIST",
        VERSION_ID: "2"
      }
    }, payload);
  };

  // Template real: ASSET_BASIC_LOAD (card do veículo) — usado para baseline/confirm
  const mkAssetLoad = (label, assetIdMaybe) => {
    const aid = assetIdMaybe || vId;
    if (!aid) return null;
    return normalizeStep({
      label,
      action: "ASSET_BASIC_LOAD",
      fields: {
        ASSET_ID: String(aid),
        ASSET_DESCRIPTION: String(payload.asset_description || payload.ASSET_DESCRIPTION || ""),
        action: "ASSET_BASIC_LOAD",
        VERSION_ID: "2"
      }
    }, payload);
  };

  if (service === "UNINSTALL") {
    const s1 = mkDeactivate("uninstall_deactivate", "uninstall");
    if (!s1) return [];
    const steps = [s1];
    if (payload.confirm_asset_load) {
      const s2 = mkAssetLoad("uninstall_confirm");
      if (s2) steps.push(s2);
    }
    return steps;
  }

  if (service === "MAINT_WITH_SWAP") {
    if (!vId) return [];
    const newSerial = (
      payload.serial_new || payload.serialNew || payload.new_serial || payload.SERIAL_NEW ||
      payload.serial || payload.inner_id || payload.INNER_ID || payload.unit || payload.UNIT
    );
    const cur = payload.__assetLoadAttrs && (payload.__assetLoadAttrs.UNIT || payload.__assetLoadAttrs.INNER_ID);
    if (cur && newSerial && String(cur) === String(newSerial)) return []; // já está com o serial desejado
    if (!newSerial) return [];

    // compat: builder legado lê payload.serial
    if (!payload.serial) payload.serial = String(newSerial);

    const steps = [];
    const d = mkDeactivate("swap_deactivate_old", "swap");
    if (d && !payload.skip_deactivate) steps.push(d);

    // Preferir baseline do GET_VHCL_ACTIVATION_DATA_NEW para manter campos existentes
    if (payload.__activationBaselineAttrs && typeof payload.__activationBaselineAttrs === "object") {
      const f = __va_buildSwapSaveFields(payload, payload.__activationBaselineAttrs);
      steps.push(normalizeStep({ label: "swap_activate", action: "SAVE_VHCL_ACTIVATION_NEW", fields: f }, payload));
    } else {
      steps.push(normalizeStep({ label: "swap_activate", useBuilder: true }, payload));
    }
    return steps;
  }

  if (service === "CHANGE_COMPANY") {
    const attrs = payload.__assetLoadAttrs || null;
    const clientId = payload.client_id_target || payload.CLIENT_ID_TARGET || payload.clientIdTarget;
    const groupId  = payload.group_id_target  || payload.GROUP_ID_TARGET  || payload.groupIdTarget; // opcional (ensureGroupId pode preencher)
    if (!attrs || !clientId) return [];

    // keys do template real (Fetchs.txt - mudar empresa)
    const KEYS = [
      "ASSET_ID","ASSET_DESCRIPTION","GROUP_ID","DRIVER_ID","URL","VEHICLE_ID","CLIENT_ID","UNIT_TYPE_DESCR","MODEL_CODE",
      "NEXT_SER_KM","TOTAL_WEIGHT_1","TIRES","DRAGGING_HOOK","EXPIRATION_DATE","OWNERSHIP_DATE","REGISTER_DATE","NEXT_SER_ENG",
      "MODEL_YEAR","CHASSIS_SERIAL","FUEL_I_VOLUME","IN_GARAGE","SERVICE_START","SERVICE_END","INTERNAL_VALUE","ASSET_TYPE_DESCR",
      "CLIENT_NAME","UNIT","GCW","LICENSE_TYPE_CODE","BODY_CONFIGURATION_CODE","LETTERS_SEND_BY_CODE","VEHICLE_STATUS_CODE","FIRMWARE",
      "FUEL_II_VOLUME","VEHICLE_MIN_FUEL_CONS","VEHICLE_MAX_FUEL_CONS","POINT_ZERO_FUEL_CONS","FUEL_COST","POINT_ZERO","DOD",
      "UNIT_END_OF_WARRANTY_DATE","MONTHLY_MILEAGE_LIMIT","PARKING_SCM_ID","FUEL_TYPE_ID"
    ];

    const f = {};
    for (const k of KEYS) {
      if (k === "DRIVER_ID") { f[k] = "undefined"; continue; }
      // campos que tipicamente ficam em branco no template real
      if (k === "TOTAL_WEIGHT_1" || k === "FUEL_I_VOLUME" || k === "FUEL_II_VOLUME" || k === "FUEL_COST" || k === "GCW" ||
          k === "VEHICLE_MIN_FUEL_CONS" || k === "VEHICLE_MAX_FUEL_CONS" || k === "POINT_ZERO_FUEL_CONS" ||
          k === "MONTHLY_MILEAGE_LIMIT" || k === "PARKING_SCM_ID" || k === "FUEL_TYPE_ID") { f[k] = ""; continue; }
      f[k] = (attrs[k] !== undefined && attrs[k] !== null) ? String(attrs[k]) : "";
    }

    // overrides: mudar SOMENTE CLIENT_ID + GROUP_ID (e manter IDs consistentes)
    const aid = attrs.ASSET_ID || vId;
    const vid = attrs.VEHICLE_ID || vId || aid;
    f.ASSET_ID = String(aid);
    f.VEHICLE_ID = String(vid);
    f.CLIENT_ID = String(clientId);
    f.GROUP_ID  = groupId ? String(groupId) : ""; // se vazio, ensureGroupId tenta preencher via groupMap

    const steps = [
      normalizeStep({ label: "change_company_save", action: "ASSET_BASIC_SAVE", fields: { ...f, action:"ASSET_BASIC_SAVE", VERSION_ID:"2" } }, payload)
    ];

    const confirm = mkAssetLoad("change_company_confirm", aid);
    if (confirm !== null && payload.confirm_asset_load !== false) steps.push(confirm);

    return steps;
  }

  // Para as outras ações: NÃO inventar payload (regra do projeto)
  return [];
}

async function main(){
  console.log(`[html5_v8] started base=${BASE} worker=${WORKER_ID} poll=${POLL_MS}ms httpTimeout=${HTTP_TIMEOUT_MS} jobMax=${JOB_MAX_MS} dryRun=${DRY_RUN} exec=${EXECUTE_HTML5} cookiejar=${COOKIEJAR_PATH}`);

  while(true){
    try{
      const r = await httpFetch("/api/jobs/next", { params:{ type:"html5_install", worker:WORKER_ID } });
      if (r.status === 204) { await sleep(POLL_MS); continue; }
      if (r.status !== 200 || !r.data) { await sleep(POLL_MS); continue; }

      const job = r.data.job || r.data;
      const id = job.id || job.jobId || job._id;
      const payload = job.payload || {};
      
  // === PATCH_R_PLATE_RESOLVE_V1 (normalize payload keys for vehicle resolve) ===
  try {
    const _p = payload || {};

    // plate/licenca aliases -> payload.plate
    const _rawPlate =
      (_p.plate ?? _p.placa ?? _p.license ?? _p.licensePlate ?? _p.LICENSE_NMBR ?? _p.license_nmbr ?? _p.licenseNmbr ?? "");
    if (!_p.plate && _rawPlate) _p.plate = String(_rawPlate);
    if (!_p.license && _p.plate) _p.license = _p.plate;

    // normalize plate string (upper, strip spaces/hyphen/etc)
    if (_p.plate) _p.plate = String(_p.plate).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (_p.license) _p.license = String(_p.license).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

    // serial aliases -> payload.serial
    const _rawSerial =
      (_p.serial ?? _p.serie ?? _p.innerId ?? _p.inner_id ?? _p.INNER_ID ?? _p.SERIAL ?? "");
    if (!_p.serial && _rawSerial) _p.serial = String(_rawSerial).trim();

    // serial_new aliases (MAINT_WITH_SWAP) -> payload.serial_new
    const _rawSerialNew =
      (_p.serial_new ?? _p.serialNew ?? _p.new_serial ?? _p.SERIAL_NEW ?? "");
    if (!_p.serial_new && _rawSerialNew) _p.serial_new = String(_rawSerialNew).trim();

    // PATCH_MWS_DEFINITIVE_V1_SERIALMAP: MAINT_WITH_SWAP aceita serial_new como serial efetivo
    try {
      const __svc = String(_p.service || _p.SERVICE || "").toUpperCase();
      if (__svc === "MAINT_WITH_SWAP") {
        if (!_p.serial && _p.serial_new) _p.serial = _p.serial_new;
        if (!_p.inner_id && _p.serial) _p.inner_id = _p.serial;
        if (!_p.INNER_ID && _p.serial) _p.INNER_ID = _p.serial;
      }
    } catch(e) {}

    // PATCH_MWS_SERIALMAP_IN_NORMALIZE_V1: se app enviar só serial_new, tratar como serial
    if (!_p.serial && _p.serial_new) _p.serial = _p.serial_new;
    if (!_p.inner_id && _p.serial) _p.inner_id = _p.serial;
    if (!_p.INNER_ID && _p.serial) _p.INNER_ID = _p.serial;


    // vehicle_id aliases -> payload.vehicle_id / payload.VEHICLE_ID
    const _rawVid = (_p.vehicle_id ?? _p.vehicleId ?? _p.VEHICLE_ID ?? _p.VEHICLEID ?? "");
    if (!_p.vehicle_id && _rawVid) _p.vehicle_id = String(_rawVid).trim();
    if (!_p.VEHICLE_ID && _p.vehicle_id) _p.VEHICLE_ID = _p.vehicle_id;

    // (debug leve) só quando falta vehicle_id
    if (!_p.vehicle_id) {
      console.log(`[html5_v8] RESOLVE_INPUT service=${_p.service||""} plate=${_p.plate||""} serial=${_p.serial||""}`);
    }
  } catch (e) {
    console.log("[html5_v8] WARN normalize payload failed:", e && (e.message || e.toString()));
  }
  // === END PATCH_R_PLATE_RESOLVE_V1 ===
const service = normService(payload.service || payload.SERVICE || payload.servico || payload.serviceType || payload.service_type);
      const hasSteps = Array.isArray(payload.html5Steps) && payload.html5Steps.length > 0;

      console.log(`[html5_v8] GOT job id=${id} service=${service || "?"}`);

/* PATCH_MWS_CANON_FLOW_V1
 * MAINT_WITH_SWAP canônico:
 * VHCLS(plate->vehicle_id) + DEACTIVATE + GET_VHCL_ACTIVATION_DATA_NEW + SAVE (troca só serial)
 * Bypass total dos patches U3/steps quando service=MAINT_WITH_SWAP.
 */
try {
  if (service === "MAINT_WITH_SWAP") {
    const plate = String(payload.plate || payload.LICENSE_NMBR || payload.license_nmbr || payload.PLATE || "").trim().toUpperCase();
    const newSerial = String(
      payload.serial_new || payload.serialNew || payload.new_serial || payload.SERIAL_NEW ||
      payload.serial || payload.inner_id || payload.INNER_ID || payload.unit || payload.UNIT || ""
    ).trim();

    if (!plate) throw new Error("mws_missing_plate");
    if (!newSerial) throw new Error("mws_missing_serial_new");

    // garante aliases (para logs/consistência)
    payload.serial = newSerial;
    payload.serial_new = payload.serial_new || newSerial;
    payload.inner_id = payload.inner_id || newSerial;
    payload.INNER_ID = payload.INNER_ID || newSerial;

    // 1) Resolve VEHICLE_ID (prefer payload.*; fallback VHCLS canônico)
    let vid = Number(payload.vehicle_id || payload.VEHICLE_ID || payload.vehicleId || 0);
    let vh = null;
    if (!vid) {
      // PATCH_PLATEONLY_RESOLVE_VID_V1: resolve VEHICLE_ID por placa/serial via VHCLS direto (gera /tmp/mws_vhcls_<JOB>.txt)
      try {
        const ctx = { log: (m)=>console.log(String(m)), jobId: id };
        const vv = await ensureVehicleIdByVhcls_(ctx, payload);
        if (vv) vid = Number(vv||0);
      } catch(e) {}

      // fallback: método antigo (VA1) — também salva por job
      if (!vid) {
        vh = await __va_appenginePost("VHCLS", { REFRESH_FLG: "1", LICENSE_NMBR: plate }, "MWS_VHCLS");
        try { require("fs").writeFileSync(`/tmp/mws_vhcls_${id}.txt`, String(vh.text||""), "utf8"); } catch(e) {}
        const mt = String(vh.text || "").match(/VEHICLE_ID\s*=\s*["\']?(\d+)/i);
        vid = Number(vh.vehicleId || (mt && mt[1]) || 0);
      }
      // PATCH_PLATEONLY_VHCLS_VHNULL_GUARD: não acessar vh.text quando vh==null
      if (!vid && vh) {
        const mt = String(vh.text || "").match(/VEHICLE_ID\s*=\s*["\']?(\d+)/i);
        vid = Number(vh.vehicleId || (mt && mt[1]) || 0);
      }
    }
    if (!vid) {
      await completeJobLogged(id, "error", {
        flow: "MAINT_WITH_SWAP",
        plate,
        serial_new: newSerial,
        error: "mws_vehicle_id_not_found",
        vhcls: vh ? { http: vh.status, loginNeg: vh.loginNeg ? 1 : 0, head: safeSnippet(vh.text, 220) } : null
      });
      continue;
    }

    payload.vehicle_id = vid; payload.VEHICLE_ID = vid; payload.vehicleId = vid;

    if (!EXECUTE_HTML5) {
      await completeJobLogged(id, "success", { dryRun: true, flow: "MAINT_WITH_SWAP", plate, vehicle_id: vid, serial_new: newSerial });
      continue;
    }

    // 2) DEACTIVATE (desinstala serial antigo daquele vehicle_id)
    const de = await __va_appenginePost("DEACTIVATE_VEHICLE_HIST", {
      VERSION_ID: "2",
      VEHICLE_ID: String(vid),
      LICENSE_NMBR: plate,
      INSTALLER_NAME: String(payload.installer_name || payload.installer || payload.INSTALLER_NAME || "installer"),
      COMMENTS: String(payload.comments || payload.note || payload.notes || "swap"),
      REASON_CODE: "5501",
      DELIVER_CODE: "5511"
    }, "MWS_DEACTIVATE");

    // MWS_DEACTIVATE_POSTCHECK_V1: detectar "Action error" mesmo com HTTP 200
    try {
      const fs = require("fs");
      fs.writeFileSync(`/tmp/mws_deactivate_resp_${id}.txt`, de.text || "", "utf8");
    } catch (e) {}
    const deText = String(de.text || "");
    const deIsActionError =
      /<TEXT>\s*Action:\s*DEACTIVATE_VEHICLE_HIST\s*error/i.test(deText) ||
      /DEACTIVATE_VEHICLE_HIST\s*error/i.test(deText) ||
      /<ERROR\b/i.test(deText);
    if (deIsActionError) {
      await completeJobLogged(id, "error", {
        flow: "MAINT_WITH_SWAP",
        plate, vehicle_id: vid, serial_new: newSerial,
        error: "mws_deactivate_action_error",
        http: de.status,
        head: safeSnippet(de.text, 220)
      });
      continue;
    }
    if (de.loginNeg) throw new Error("mws_deactivate_loginneg");

    // 3) Carrega o form com TODOS os campos atuais (após desinstalar, serial fica vazio, resto permanece)
    const lo = await __va_appenginePost("GET_VHCL_ACTIVATION_DATA_NEW", {
      VERSION_ID: "2",
      VEHICLE_ID: String(vid)
    }, "MWS_ACT_LOAD");
    if (lo.loginNeg) throw new Error("mws_activation_load_loginneg");

    // dump raw baseline (GET_VHCL_ACTIVATION_DATA_NEW)
    try { const fs = require("fs"); fs.writeFileSync(`/tmp/mws_act_load_resp_${id}.txt`, lo.text || "", "utf8"); } catch (e) {}

    // Parser robusto de form (input/select/textarea) para map — preserva valores prefill
    // === PATCH_MWS_FORM_PARSER_V5 ===
    const base = (function(html){
      const out = {};
      const t = String(html || "");

      const decode = (v) => String(v || "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");

      const getAttr = (tag, key) => {
        const re = new RegExp("\\b" + key + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
        const m = re.exec(tag);
        return m ? (m[1] || m[2] || m[3] || "") : "";
      };

      // inputs
      const inRe = /<input\b[^>]*>/ig;
      let m;
      while ((m = inRe.exec(t))) {
        const tag = m[0];
        const nm = getAttr(tag, "name");
        if (!nm) continue;
        const typ = String(getAttr(tag, "type") || "").toLowerCase();
        const checked = /\bchecked\b/i.test(tag);

        
        const disabled = /\bdisabled\b/i.test(tag);
        if (disabled) continue;
        if (typ === "submit" || typ === "button" || typ === "image" || typ === "reset" || typ === "file") continue;
if (typ === "checkbox" || typ === "radio") {
          if (!checked) continue; // browser só envia se marcado
          const v = getAttr(tag, "value") || "on";
          out[nm] = decode(v);
          continue;
        }

        const v = getAttr(tag, "value") || "";
        out[nm] = decode(v);
      }

      // selects
      const selRe = /<select\b[^>]*name\s*=\s*(?:\"([^\"]+)\"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/select>/ig;
      let sm;
      while ((sm = selRe.exec(t))) {
        const nm = sm[1] || sm[2] || sm[3] || "";
        if (!nm) continue;
        const inner = sm[4] || "";

        // selected option, fallback first option
        let opt = inner.match(/<option\b[^>]*\bselected\b[^>]*>/i) || inner.match(/<option\b[^>]*>/i);
        if (!opt) { out[nm] = ""; continue; }

        const tag = opt[0];
        let v = getAttr(tag, "value");
        if (!v) {
          // tenta texto da option
          const mtxt = inner.match(/<option\b[^>]*\bselected\b[^>]*>([\s\S]*?)<\/option>/i) ||
                       inner.match(/<option\b[^>]*>([\s\S]*?)<\/option>/i);
          v = mtxt ? String(mtxt[1] || "").replace(/<[^>]+>/g, "").trim() : "";
        }
        out[nm] = decode(v);
      }

      // textareas
      const taRe = /<textarea\b[^>]*name\s*=\s*(?:\"([^\"]+)\"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/textarea>/ig;
      let tm;
      while ((tm = taRe.exec(t))) {
        const nm = tm[1] || tm[2] || tm[3] || "";
        if (!nm) continue;
        const v = String(tm[4] || "").replace(/\r\n/g, "\n");
        out[nm] = decode(v);
      }

            // PATCH_MWS_SELECT_TEXTAREA_V3 — capturar campos pré-preenchidos do form (select/textarea)
      try {
        function _mwsDec(v){
          return String(v || "")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">");
        }

        // <textarea name="X">...</textarea>
        const taRe = /<textarea\b[^>]*\bname\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/textarea>/ig;
        let tm;
        while ((tm = taRe.exec(t))) {
          const nm = tm[1];
          if (!nm) continue;
          out[nm] = _mwsDec((tm[2] || "").trim());
        }

        // <select name="X"> ... <option selected value="V"> ...
        const selRe = /<select\b[^>]*\bname\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/select>/ig;
        let sm;
        while ((sm = selRe.exec(t))) {
          const nm = sm[1];
          if (!nm) continue;
          const body = sm[2] || "";

          // option selected, fallback first option
          let opt = (body.match(/<option\b[^>]*selected[^>]*>/i) || [])[0];
          if (!opt) opt = (body.match(/<option\b[^>]*>/i) || [])[0];
          if (!opt) continue;

          // value="..."
          const mv = opt.match(/\bvalue\s*=\s*["']([^"']*)["']/i);
          const val = _mwsDec((mv && mv[1]) ? mv[1] : "");
          out[nm] = val;
        }
      } catch(e) {}
return out;
    })(lo.text);

    // PATCH_MWS_XML_BASE_MERGE_V1: baseline real vem como XML attrs (<DATA .../>)
    try {
      const __ax = mwsExtractActivationAttrs(String(lo.text || ""));
      if (__ax && typeof __ax === "object" && Object.keys(__ax).length) {
        for (const k of Object.keys(__ax)) {
          const v = (__ax[k] == null) ? "" : String(__ax[k]);
          // sempre sobrescreve estes (são críticos pro SAVE)
          if (k === "ASSET_TYPE" || k === "FIELD_IDS" || k === "FIELD_VALUE" || k === "GROUP_ID") {
            base[k] = v;
            continue;
          }
          // só preenche se estiver vazio
          if (base[k] === undefined || base[k] === null || String(base[k]).trim() === "") base[k] = v;
        }
      }
    } catch(e) {}

    // === /PATCH_MWS_FORM_PARSER_V5 ===

    // 4) Override só o serial + garantir ids básicos
    base.VERSION_ID = String(base.VERSION_ID || 2);
    base.VEHICLE_ID = String(vid);
    base.LICENSE_NMBR = String(base.LICENSE_NMBR || plate || "");

    // Campos comuns do serial (Unit_Number / Dial_Number)
    base.DIAL_NUMBER = newSerial;
    base.INNER_ID = newSerial;
    if (base.UNIT !== undefined) base.UNIT = newSerial;
    if (base.UNIT_NUMBER !== undefined) base.UNIT_NUMBER = newSerial;
    if (base.UNIT_SN !== undefined) base.UNIT_SN = newSerial;
    if (base.INNERID !== undefined) base.INNERID = newSerial;

    // MWS_SAVE_BASELINE_ONLY_V1
// - Não inferir CLIENT_ID/GROUP_ID/VEHICLE_TYPE (template real do Cadastro não usa GROUP_ID aqui)
// - Não injetar custom fields (FIELD_IDS/FIELD_VALUE) no swap: isso costuma quebrar o SAVE
try {
  const today = (typeof __fmtDDMMYYYY === "function") ? __fmtDDMMYYYY(new Date()) : "";
  if (!base.INSTALLATION_DATE && today) base.INSTALLATION_DATE = today;
  if (!base.WARRANTY_START_DATE && base.INSTALLATION_DATE) base.WARRANTY_START_DATE = base.INSTALLATION_DATE;
  if (!base.MILAGE_SOURCE_ID) base.MILAGE_SOURCE_ID = "5067";
  if (!base.WARRANTY_PERIOD_ID) base.WARRANTY_PERIOD_ID = "1";
} catch(e) {}

// KEEP FIELD_IDS/FIELD_VALUE (required by HTML5 em alguns cenários)
// // PATCH_MWS_SAVEBASELINE_KEEP_FIELDS_V1: NÃO remover FIELD_IDS/FIELD_VALUE (podem ser obrigatórios)
// // PATCH_MWS_KEEP_CUSTOM_FIELDS_V1: manter FIELD_IDS/FIELD_VALUE (necessários em muitos casos)
    // Só remover se o job pedir explicitamente payload.strip_fields=1
    try {
      const __strip = !!(payload && (payload.strip_fields === 1 || payload.strip_fields === "1" || payload.strip_fields === true));
      if (__strip) { try { delete base.FIELD_IDS; delete base.FIELD_VALUE; } catch(e) {} }
    } catch(e) {}

    // MWS_CLEAN_UNDEFINED_V1: evitar "undefined"/"null" que quebram o SAVE
    try {
      for (const k of Object.keys(base || {})) {
        const v = base[k];
        if (v === undefined || v === null) continue;
        const ss = String(v).trim().toLowerCase();
        if (ss === "undefined" || ss === "null") base[k] = "";
      }
    } catch(e) {}

try { delete base.action; delete base.ACTION; } catch(e) {}
/* MWS_SAVE_CAPTURE_V2 */
    try {
      const fs = require("fs");
      const must = ["VERSION_ID","VEHICLE_ID","LICENSE_NMBR","DIAL_NUMBER","INNER_ID","INSTALLATION_DATE","MILAGE_SOURCE_ID","WARRANTY_PERIOD_ID"];
      const missing = [];
      for (const k of must) {
        if (base[k] === undefined || base[k] === null || String(base[k]).trim() === "") missing.push(k);
      }
      const meta = {
        ts: Date.now(),
        flow: "MAINT_WITH_SWAP",
        job_id: id,
        plate,
        vehicle_id: vid,
        serial_new: newSerial,
        keyCount: Object.keys(base||{}).length,
        missing
      };
      fs.writeFileSync(`/tmp/mws_save_${id}.json`, JSON.stringify({ meta, payload: base }, null, 2), "utf8");
      console.log(`[MWS_SAVE_CAPTURE] wrote /tmp/mws_save_${id}.json keys=${meta.keyCount} missing=${missing.join(",")||"-"}`);
    } catch (e) {
      console.log("[MWS_SAVE_CAPTURE_ERR]", e && (e.message || String(e)));
    }
        // PATCH_MWS_SAVEBASELINE_APPLY_V1: garante ASSET_TYPE/FIELD_IDS/FIELD_VALUE/GROUP_ID vindos do baseline (XML)
    try {
      base = mwsEnrichSavePayloadFromBaseline(id, base, (lo && lo.text) ? lo.text : "");
    } catch(e) {}
    const sv = await __va_appenginePost("SAVE_VHCL_ACTIVATION_NEW", base, "MWS_SAVE");

    // === PATCH_MWS_SAVE_POSTCHECK_V1 ===
    try {
      const fs = require("fs");
      fs.writeFileSync(`/tmp/mws_save_resp_${id}.txt`, sv.text || "", "utf8");
    // PATCH_MWS_SAVE_ACTION_ERROR_V1: se SAVE retornou "Action ... error", parar aqui
    const __svTxt = String(sv.text || "");
    if (/Action:\s*SAVE_VHCL_ACTIVATION_NEW\s*error\./i.test(__svTxt) || /<ERROR\b/i.test(__svTxt)) {
      await completeJobLogged(id, "error", {
        flow: "MAINT_WITH_SWAP",
        plate, vehicle_id: vid, serial_new: newSerial,
        error: "mws_save_action_error",
        http: sv.status,
        head: safeSnippet(__svTxt, 240)
      });
      continue;
    }

    // PATCH_MWS_SAVE_ERROR_DETECT_V1: se o SAVE voltou "Action ... error", parar aqui (não virar "dial vazio")
    try {
      if (mwsSaveResponseHasError(String(sv.text || ""))) {
        throw new Error("mws_save_error: SAVE_VHCL_ACTIVATION_NEW");
      }
    } catch (e) { throw e; }

    } catch (e) {}

    // Confirma se o serial realmente foi aplicado (evita "rodou uninstall" sem install)
    const pc = await __va_appenginePost("GET_VHCL_ACTIVATION_DATA_NEW", {
      VERSION_ID: "2",
      VEHICLE_ID: String(vid)
    }, "MWS_POSTCHECK");

    try { const fs = require("fs"); fs.writeFileSync(`/tmp/mws_postcheck_resp_${id}.txt`, pc.text || "", "utf8"); } catch (e) {}

    const pcTxt = String(pc.text || "");
    let dial = "";
    // PATCH_MWS_POSTCHECK_XML_V1: resposta é XML do GET_VHCL_ACTIVATION_DATA_NEW (attrs), não HTML <input>
    try {
      const attrs = mwsExtractActivationAttrs(pcTxt) || {};
      dial = String(attrs.DIAL_NUMBER || attrs.INNER_ID || attrs.DIALNUMBER || "").trim();
    } catch (e) {}
if (String(dial || "").trim() !== String(newSerial || "").trim()) {
      try {
        const fs = require("fs");
        fs.writeFileSync(`/tmp/mws_postcheck_form_${id}.html`, pcTxt, "utf8");
      } catch (e) {}
      throw new Error("mws_save_not_applied: dial=" + String(dial || "<empty>"));
    }
    // === /PATCH_MWS_SAVE_POSTCHECK_V1 ===

    /* MWS_SAVE_CAPTURE_RESP_V2 */
    try {
      const fs = require("fs");
      const txt = String(sv.text || "");
      const meta = { ts: Date.now(), job_id: id, status: sv.status, len: txt.length, loginNeg: sv.loginNeg ? 1 : 0 };
      fs.writeFileSync(`/tmp/mws_save_${id}_resp.meta.json`, JSON.stringify(meta, null, 2), "utf8");
      fs.writeFileSync(`/tmp/mws_save_${id}_resp.head.txt`, txt.slice(0, 20000), "utf8");
      console.log(`[MWS_SAVE_CAPTURE] wrote /tmp/mws_save_${id}_resp.* status=${meta.status} len=${meta.len}`);
    } catch (e) {
      console.log("[MWS_SAVE_CAPTURE_RESP_ERR]", e && (e.message || String(e)));
    }

    if (sv.loginNeg) throw new Error("mws_save_loginneg");

        // PATCH: detectar "Action error" mesmo com HTTP 200
    const svText = String(sv.text || "");
    const svIsActionError =
      /<TEXT>\s*Action:\s*SAVE_VHCL_ACTIVATION_NEW\s*error/i.test(svText) ||
      /SAVE_VHCL_ACTIVATION_NEW\s*error/i.test(svText) ||
      /<ERROR\b/i.test(svText);

    if (svIsActionError) {
      await completeJobLogged(id, "error", {
        flow: "MAINT_WITH_SWAP",
        plate, vehicle_id: vid, serial_new: newSerial,
        error: "mws_save_action_error",
        http: sv.status,
        head: safeSnippet(sv.text, 220)
      });
      continue;
    }

    // PATCH: pós-check (confirmar que o serial mudou de fato)
    const lo2 = await __va_appenginePost(
      "GET_VHCL_ACTIVATION_DATA_NEW",
      { VERSION_ID: "2", VEHICLE_ID: String(vid) },
      "MWS_ACT_LOAD2"
    );
    if (lo2.loginNeg) throw new Error("mws_act_load2_loginneg");

    const t2 = String(lo2.text || "");
    const esc = String(newSerial).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ok2 =
      new RegExp("(DIAL_NUMBER|INNER_ID)[\\s\\S]{0,160}" + esc, "i").test(t2) ||
      new RegExp('value=["\\\']' + esc + '["\\\']', "i").test(t2);

    if (!ok2) {
      await completeJobLogged(id, "error", {
        flow: "MAINT_WITH_SWAP",
        plate, vehicle_id: vid, serial_new: newSerial,
        error: "mws_save_no_effect",
        save_http: sv.status,
        post_http: lo2.status,
        save_head: safeSnippet(sv.text, 220),
        post_head: safeSnippet(lo2.text, 220)
      });
      continue;
    }
const low = String(sv.text || "").toLowerCase();
    if (/(already|exists|in use|used|vinculad|associad|ocupad)/i.test(low)) {
      await completeJobLogged(id, "error", {
        flow: "MAINT_WITH_SWAP",
        plate, vehicle_id: vid, serial_new: newSerial,
        error: "serial_in_use_or_already_linked",
        http: sv.status,
        head: safeSnippet(sv.text, 220)
      });
      continue;
    }

    await completeJobLogged(id, "success", {
      flow: "MAINT_WITH_SWAP",
      plate, vehicle_id: vid, serial_new: newSerial,
      deactivate: { http: de.status, loginNeg: de.loginNeg ? 1 : 0 },
      save: { http: sv.status, loginNeg: sv.loginNeg ? 1 : 0 }
    });
    continue;
  }
} catch (e) {
  try {
    if (service === "MAINT_WITH_SWAP") {
      await completeJobLogged(id, "error", {
        flow: "MAINT_WITH_SWAP",
        error: String(e && (e.message || e.toString())),
        plate: String(payload.plate || payload.LICENSE_NMBR || ""),
        serial_new: String(payload.serial_new || payload.serial || "")
      });
      continue;
    }
  } catch (_) {}
}

/* __PATCH_UNINSTALL_AUTOSTEPS_V1
 * Se service=UNINSTALL e html5Steps vazio, injeta DEACTIVATE_VEHICLE_HIST via payload.html5Steps.
 * Também garante defaults mínimos (VERSION/REASON/DELIVER/plate).
 */
try{
  const __p =
    (typeof payload !== "undefined" && payload && typeof payload === "object") ? payload :
    (typeof job !== "undefined" && job && job.payload && typeof job.payload === "object") ? job.payload :
    (globalThis.__JOB_PAYLOAD && typeof globalThis.__JOB_PAYLOAD === "object") ? globalThis.__JOB_PAYLOAD :
    null;

  const __svc = (__p && (__p.service || __p.SERVICE)) ? String(__p.service || __p.SERVICE) : "";
  if (__p && __svc === "UNINSTALL") {
    __p.VERSION_ID   = __p.VERSION_ID   || 2;
    __p.REASON_CODE  = __p.REASON_CODE  || 5501;
    __p.DELIVER_CODE = __p.DELIVER_CODE || 5511;

    const __plate = __p.LICENSE_NMBR || __p.license_nmbr || __p.plate || __p.PLATE;
    if (__plate) {
      __p.LICENSE_NMBR = __p.LICENSE_NMBR || __plate;
      __p.license_nmbr = __p.license_nmbr || __plate;
    }

    if (!Array.isArray(__p.html5Steps) || __p.html5Steps.length === 0) {
      __p.html5Steps = ["DEACTIVATE_VEHICLE_HIST"];
      console.log("[UNINSTALL_AUTOSTEPS] set html5Steps=[DEACTIVATE_VEHICLE_HIST]");
    } else {
      const has = __p.html5Steps.some(x => String(x).indexOf("DEACTIVATE_VEHICLE_HIST") >= 0);
      if (!has) {
        __p.html5Steps.push("DEACTIVATE_VEHICLE_HIST");
        console.log("[UNINSTALL_AUTOSTEPS] append DEACTIVATE_VEHICLE_HIST");
      } else {
        console.log("[UNINSTALL_AUTOSTEPS] already has DEACTIVATE_VEHICLE_HIST");
      }
    }

    globalThis.__JOB_PAYLOAD = __p;
  }
}catch(e){
  console.log("[UNINSTALL_AUTOSTEPS_ERR] " + ((e && e.message) ? e.message : e));
}
/* __PATCH_UNINSTALL_AUTOSTEPS_V1 END */


      // PATCH_SAVE_JOBCTX_V1
      try {
        const __j = (typeof job !== 'undefined') ? job : ((typeof currentJob !== 'undefined') ? currentJob : null);
        const __pl = (__j && __j.payload) ? __j.payload : ((typeof payload !== 'undefined') ? payload : null);
        const __svc = (__pl && (__pl.service || __pl.SERVICE)) ? String(__pl.service || __pl.SERVICE) : '';
        globalThis.__JOB_PAYLOAD = __pl || globalThis.__JOB_PAYLOAD;
        globalThis.__JOB_SERVICE = __svc || globalThis.__JOB_SERVICE;
      } catch(e) {}
      

      // === CAPTURE_FETCHWRAP_V8_RESET ===
      try { for (const k of Object.keys(__CAPTURES)) delete __CAPTURES[k]; } catch {}
      // === /CAPTURE_FETCHWRAP_V8_RESET ===
      let done = false;
      const finish = async (status, result) => {
        if (done) return;
        done = true;
        await completeJobLogged(id, status, result);
      };

            const jobRunner = async () => {
        // PATCH_D2: preflight ASSET_BASIC_LOAD when needed
// [PATCH_U3] resolve VEHICLE_ID by plate without touching 'cookie' (avoid TDZ)
try {
  const svcNeedVid = new Set(["UNINSTALL","MAINT_WITH_SWAP","CHANGE_COMPANY"]);
  const hasVid = !!(payload.vehicle_id || payload.VEHICLE_ID || payload.vehicleId);
  const plate = String(payload.plate || payload.LICENSE_NMBR || payload.license || payload.licensePlate || "").trim();
  // [VA1] resolve_by_plate prefer VHCLS_CANON (cookiejar + warmup/login); fallback mantém caminho antigo.
  try {
    if (plate && typeof __va_vhclsRefresh === "function") {
      const __va = await __va_vhclsRefresh(plate);
      if (__va && __va.vehicleId) {
        console.log(`[html5_v8] [VA1] resolve_by_plate rescued VEHICLE_ID=${__va.vehicleId} plate=${__va.plate} status=${__va.status} len=${__va.len} loginNeg=${__va.loginNeg?1:0} jarFlags=${__va.jarFlags}`);
        // persist best-effort nas chaves usuais do payload (sem vazar nada)
        try {
          if (payload && typeof payload === "object") {
            payload.VEHICLE_ID = payload.VEHICLE_ID || __va.vehicleId;
            // PATCH_VA1_PERSIST_VID_ALLKEYS_V1
            payload.vehicle_id = payload.vehicle_id || __va.vehicleId;
            payload.vehicleId  = payload.vehicleId  || __va.vehicleId;

            payload.LICENSE_NMBR = payload.LICENSE_NMBR || __va.plate;
            payload.license_nmbr = payload.license_nmbr || __va.plate;
          }
          globalThis.__VHCLS_LAST = __va.head || "";
          globalThis.__VHCLS_LAST_VID = __va.vehicleId;
          globalThis.__VHCLS_LAST_PLATE = __va.plate;
        } catch(e) {}
      } else {
        console.log(`[html5_v8] [VA1] resolve_by_plate VHCLS_CANON no_vid plate=${plate} status=${__va && __va.status} loginNeg=${__va && __va.loginNeg?1:0}`);
      }
    }
  } catch(e) {
    console.log(`[html5_v8] [VA1] resolve_by_plate VHCLS_CANON err ${e && (e.message||e.toString())}`);
  }

  const hasVidNow = !!(payload.vehicle_id || payload.VEHICLE_ID || payload.vehicleId); // PATCH_VA1_HASVID_RECHECK_V1
  if (!hasVidNow && svcNeedVid.has(service) && plate) {
    let cookieForResolve = "";
    try {
      const cj = (typeof loadCookieJar === "function") ? await loadCookieJar() : null;
      cookieForResolve = (cj && cj.cookie) ? cj.cookie : "";
    } catch (_) {}
    const resolveStep = {
      label: "resolve_by_plate",
      action: "VHCLS",
      fields: { REFRESH_FLG: "1", LICENSE_NMBR: plate, CLIENT_DESCR: "", OWNER_DESCR: "", DIAL_NMBR: "", INNER_ID: "", VERSION_ID: "2" }
    };
    console.log(`[html5_v8] [PATCH_U3] resolving VEHICLE_ID by plate=${plate} service=${service}`);
    const outR = await html5RunStep(id, resolveStep, cookieForResolve);
    
    
    // === PATCH_VHCLS_VID_EXTRACT_V1 ===
    try {
      const raw = (() => {
        const f = (outR && outR.final) ? outR.final : outR;
        return String((f && (f.text || f.body || f.raw || f.xml || f.responseText)) || "");
      })();

      if (raw && !payload.vehicle_id) {
        const plateUp = String(plate||"").trim().toUpperCase();
        const esc = plateUp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // pega o <DATA ... LICENSE_NMBR="XYZ1234" ... VEHICLE_ID="123" .../>
        const re1 = new RegExp('LICENSE_NMBR="\\s*' + esc + '\\s*"[^>]{0,1200}?VEHICLE_ID="(\\d+)"', 'i');
        const m1 = re1.exec(raw);
        const vid = m1 ? m1[1] : null;

        if (vid) {
          payload.vehicle_id = String(vid);
          payload.VEHICLE_ID  = String(vid);
          payload.vehicleId   = String(vid);
          console.log(`[html5_v8] [VHCLS_VID_EXTRACT] extracted VEHICLE_ID=${vid} from VHCLS for plate=${plate}`);
        } else {
          console.log(`[html5_v8] [VHCLS_VID_EXTRACT] no VEHICLE_ID in VHCLS for plate=${plate} (raw_len=${raw.length})`);
        }
      }
    } catch (e) {
      console.log(`[html5_v8] [VHCLS_VID_EXTRACT] error: ${e && (e.message || e.toString())}`);
    }
    // === END PATCH_VHCLS_VID_EXTRACT_V1 ===
// === PATCH_U3_DEBUG_DISPLAY_V1 ===
// PATCH_U3_DEBUG_RAW_LET_V1
    try {
      let raw = (() => {
        const f = (outR && outR.final) ? outR.final : outR;
        return String((f && (f.text || f.body || f.raw || f.xml || f.responseText)) || "");
      })();
      const plateNorm = String(plate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const sample = raw.replace(/\s+/g," ").slice(0,220);
      // [PATCH_U3_AUTH_GUARD] fallback pro texto do TAP + falha explícita se VHCLS não autenticou
      try {
        const fs = require('fs');
        const last = (globalThis && globalThis.__VHCLS_LAST) ? globalThis.__VHCLS_LAST : null;
        const lastPath = (last && last.path) ? last.path : '';
        let __u3txt = (typeof respText !== 'undefined' && respText) || (typeof text !== 'undefined' && text) || (typeof raw !== 'undefined' && raw) || (typeof xml !== 'undefined' && xml) || (typeof body !== 'undefined' && body) || '';
        if ((!__u3txt || __u3txt.length === 0) && lastPath && fs.existsSync(lastPath)) {
          const t = fs.readFileSync(lastPath, 'utf8') || '';
          __u3txt = t;
          if (typeof respText !== 'undefined') respText = t;
          if (typeof text !== 'undefined') text = t;
          if (typeof raw !== 'undefined') raw = t;
          if (typeof xml !== 'undefined') xml = t;
          if (typeof body !== 'undefined') body = t;
          console.log('[PATCH_U3_AUTH_GUARD] used VHCLS_TAP file=' + lastPath + ' len=' + (__u3txt||'').length);
        }
        if ((__u3txt || '').includes('login="-1"') || (__u3txt || '').includes('Action: VHCLS error')) {
          console.log('[PATCH_U3_AUTH_GUARD] VHCLS not authenticated (login=-1). Aborting job.');
          throw new Error('vhcls_not_authenticated');
        }
      } catch (e) {
        if (e && e.message === 'vhcls_not_authenticated') throw e;
        console.log('[PATCH_U3_AUTH_GUARD_ERR] ' + ((e && e.message) ? e.message : String(e)));
      }
            console.log(`[html5_v8] [U3_DEBUG] DISPLAY_OBJECTS len=${raw.length} hasVEHICLE_ID=${/VEHICLE_ID/i.test(raw)} hasPlate=${raw.toUpperCase().includes(plateNorm)} sample="${sample}"`);
    } catch (e) {
      console.log(`[html5_v8] [U3_DEBUG] failed: ${e && (e.message||e.toString())}`);
    }
    // === END PATCH_U3_DEBUG_DISPLAY_V1 ===
const parsed = (outR && outR.final && outR.final.parsed) ? outR.final.parsed : (outR && outR.parsed ? outR.parsed : null);
    const seen = new Set();
    const findVid = (obj) => {
      if (!obj || typeof obj !== "object") return null;
      if (seen.has(obj)) return null;
      seen.add(obj);
      if (Object.prototype.hasOwnProperty.call(obj, "VEHICLE_ID")) return obj.VEHICLE_ID;
      if (Object.prototype.hasOwnProperty.call(obj, "vehicle_id")) return obj.vehicle_id;
      if (Array.isArray(obj)) {
        for (const it of obj) { const v = findVid(it); if (v) return v; }
        return null;
      }
      for (const k of Object.keys(obj)) {
        const v = findVid(obj[k]);
        if (v) return v;
      }
      return null;
    };
    const vid = findVid(parsed);
    if (vid) {
      const v = String(vid).trim();
      payload.vehicle_id = v;
      payload.VEHICLE_ID  = v;
      payload.vehicleId   = v;
      console.log(`[html5_v8] [PATCH_U3] resolved vehicle_id=${v} plate=${plate}`);
    } else {
      // [PATCH_U3_VHCLS_DUMP] dump resposta quando não acha VEHICLE_ID
      try {
        const __t = (typeof respText !== 'undefined' && respText) || (typeof text !== 'undefined' && text) || (typeof raw !== 'undefined' && raw) || (typeof xml !== 'undefined' && xml) || (typeof body !== 'undefined' && body) || '';
        const __p = '/tmp/vhcls_last_' + Date.now() + '.txt';
        require('fs').writeFileSync(__p, __t, 'utf8');
        console.log('[PATCH_U3_VHCLS_DUMP] saved=' + __p + ' len=' + (__t || '').length);
        console.log('[PATCH_U3_VHCLS_HEAD] ' + JSON.stringify((__t || '').slice(0, 800)));
      } catch (e) {
        console.log('[PATCH_U3_VHCLS_DUMP_ERR] ' + ((e && e.message) ? e.message : String(e)));
      }
            // PATCH_U3_TAP_FALLBACK2: se o texto local estiver vazio, usa o VHCLS capturado pelo TAP
            try {
              const fs = require('fs');
              const last = (globalThis && globalThis.__VHCLS_LAST) ? globalThis.__VHCLS_LAST : null;
              const lastPath = (last && last.path) ? String(last.path) : '';
              if (lastPath && fs.existsSync(lastPath)) {
                const t = fs.readFileSync(lastPath, 'utf8') || '';
                const empty = (v)=> (!v || String(v).length===0);
                const need = (typeof respText !== 'undefined' && empty(respText)) ||
                             (typeof text    !== 'undefined' && empty(text)) ||
                             (typeof raw     !== 'undefined' && empty(raw)) ||
                             (typeof xml     !== 'undefined' && empty(xml)) ||
                             (typeof body    !== 'undefined' && empty(body));
                if (need && t.length) {
                  if (typeof respText !== 'undefined' && empty(respText)) respText = t;
                  if (typeof text    !== 'undefined' && empty(text))    text    = t;
                  if (typeof raw     !== 'undefined' && empty(raw))     raw     = t;
                  if (typeof xml     !== 'undefined' && empty(xml))     xml     = t;
                  if (typeof body    !== 'undefined' && empty(body))    body    = t;
                  console.log('[html5_v8] [U3_FALLBACK2] used VHCLS_TAP len=' + t.length +
                    ' plate=' + (last && last.plate ? last.plate : '') + ' vehicleId=' + (last && last.vehicleId ? last.vehicleId : '') +
                    ' path=' + lastPath);
                }
              }
            } catch (e) {
              console.log('[html5_v8] [U3_FALLBACK2_ERR] ' + ((e && e.message) ? e.message : String(e)));
            }
                        
            // [PATCH_U3_RESOLVE_FROM_TAP] tenta resolver pelo VHCLS_TAP (__VHCLS_LAST) antes de falhar
            try {
              const fs = require('fs');
              const last = (globalThis && (globalThis.__VHCLS_LAST || globalThis.__VHCLS_DBG)) ? (globalThis.__VHCLS_LAST || globalThis.__VHCLS_DBG) : null;

              let vid = '';
              if (last && last.vehicleId) vid = String(last.vehicleId || '');

              if (!vid && last && last.path && fs.existsSync(String(last.path))) {
                const t = fs.readFileSync(String(last.path), 'utf8') || '';
                const mm = t.match(/VEHICLE_ID\s*=\s*"(\d+)"/i) || t.match(/VEHICLE_ID\s*=\s*(\d+)/i);
                if (mm) vid = String(mm[1] || '');
              }

              if (vid) {
                // tenta propagar em todos os lugares comuns
                try { payload.VEHICLE_ID = vid; payload.vehicle_id = vid; payload.vehicleId = vid; } catch(e) {}
                try { if (typeof built !== 'undefined' && built) { built.VEHICLE_ID = vid; built.vehicle_id = vid; built.vehicleId = vid; } } catch(e) {}
                console.log(`[html5_v8] [PATCH_U3] resolve_by_plate: rescued VEHICLE_ID=${vid} from VHCLS_TAP`);
                // PATCH_MWS_MIN_V1
                const vehicleId = vid;;
/* PATCH_MWS_U3_PERSIST_VID_V1 */
try{
  if (payload && typeof payload === 'object') {
    const __vid = (typeof vehicleId !== 'undefined') ? String(vehicleId) : '';
    if (__vid) {
      payload.vehicleId = __vid;
      payload.vehicle_id = __vid;
      payload.VEHICLE_ID = __vid;
      console.log('[PATCH_MWS] persisted payload.vehicleId=' + __vid);
    }
  }
}catch(e){ console.log('[PATCH_MWS] persist err ' + (e && (e.message||e.toString()))); }
try{ if (typeof vId !== 'undefined' && !vId && typeof vehicleId !== 'undefined') vId = String(vehicleId); }catch(e){}


/* __PATCH_U3_PERSIST_VEHICLE_ID_V2
 * Persistir vehicleId no payload exatamente após o log do "rescued".
 * (sem vazar valores, só loga o ID)
 */
try{
  const __p =
    (typeof payload !== "undefined" && payload && typeof payload === "object") ? payload :
    (typeof job !== "undefined" && job && job.payload && typeof job.payload === "object") ? job.payload :
    (globalThis.__JOB_PAYLOAD && typeof globalThis.__JOB_PAYLOAD === "object") ? globalThis.__JOB_PAYLOAD :
    null;

  const __vid =
    (typeof vehicleId !== "undefined" && vehicleId) ? vehicleId :
    (typeof VEHICLE_ID !== "undefined" && VEHICLE_ID) ? VEHICLE_ID :
    null;

  if (__p && __vid) {
    __p.VEHICLE_ID = __p.VEHICLE_ID || __vid;
    __p.vehicle_id = __p.vehicle_id || __vid;
    __p.vehicleId  = __p.vehicleId  || __vid;

    const __plate = __p.plate || __p.PLATE || __p.LICENSE_NMBR || __p.license_nmbr;
    if (__plate) {
      __p.LICENSE_NMBR = __p.LICENSE_NMBR || __plate;
      __p.license_nmbr = __p.license_nmbr || __plate;
    }

    globalThis.__JOB_PAYLOAD = __p;
    console.log(`[PATCH_U3] resolve_by_plate: persisted VEHICLE_ID=${__vid}`);
  } else {
    console.log(`[PATCH_U3] resolve_by_plate: persist SKIP payload=${!!__p} vid=${!!__vid}`);
  }
}catch(e){
  console.log(`[PATCH_U3] resolve_by_plate: persist ERR ${(e && e.message) ? e.message : e}`);
}



/* __PATCH_U3_PERSIST_VEHICLE_ID_V1
 * Após rescue do vehicleId no resolve_by_plate, persiste em job/payload/globalThis:
 * - VEHICLE_ID / vehicle_id / vehicleId
 * - LICENSE_NMBR / license_nmbr (fallback plate)
 * Sem vazar dados; só loga o id.
 */
try{
  const __p =
    (typeof payload !== "undefined" && payload && typeof payload === "object") ? payload :
    (typeof job !== "undefined" && job && job.payload && typeof job.payload === "object") ? job.payload :
    (globalThis.__JOB_PAYLOAD && typeof globalThis.__JOB_PAYLOAD === "object") ? globalThis.__JOB_PAYLOAD :
    null;

  if (__p && typeof vehicleId !== "undefined" && vehicleId) {
    __p.VEHICLE_ID = __p.VEHICLE_ID || vehicleId;
    __p.vehicle_id = __p.vehicle_id || vehicleId;
    __p.vehicleId  = __p.vehicleId  || vehicleId;

    // placa/licença (ajuda o DEACTIVATE/VHCL templates)
    const plate = __p.plate || __p.PLATE || __p.license_nmbr || __p.LICENSE_NMBR;
    __p.LICENSE_NMBR = __p.LICENSE_NMBR || plate;
    __p.license_nmbr = __p.license_nmbr || plate;

    globalThis.__JOB_PAYLOAD = __p;

    console.log(`[PATCH_U3] resolve_by_plate: persisted VEHICLE_ID=${vehicleId} into payload keys`);
  } else {
    console.log(`[PATCH_U3] resolve_by_plate: WARN cannot persist (payload?=${!!__p} vehicleId?=${typeof vehicleId !== "undefined" && !!vehicleId})`);
  }
}catch(e){
  console.log(`[PATCH_U3] resolve_by_plate: persist ERR ${(e && e.message) ? e.message : e}`);
}


                return vid;
              }
            } catch (e) {
              console.log(`[html5_v8] [PATCH_U3] resolve_by_plate: tap rescue err: ${e && (e.message || e.toString())}`);
            }

            
            // PATCH_U3_RESOLVE_RESCUE_VHCLS_LAST
            try {
              const fs = require('fs');
              const last = (globalThis && globalThis.__VHCLS_LAST) ? globalThis.__VHCLS_LAST : null;

              let vid = '';
              if (last && last.vehicleId) vid = String(last.vehicleId || '');

              if (!vid && last && last.path && fs.existsSync(String(last.path))) {
                const t = fs.readFileSync(String(last.path), 'utf8') || '';
                const mm = t.match(/VEHICLE_ID\s*=\s*"(\d+)"/i) || t.match(/VEHICLE_ID\s*=\s*(\d+)/i);
                if (mm) vid = String(mm[1] || '');
              }

              if (vid) {
                try { payload.VEHICLE_ID = vid; payload.vehicle_id = vid; payload.vehicleId = vid; } catch(e) {}
                try { if (typeof built !== 'undefined' && built) { built.VEHICLE_ID = vid; built.vehicle_id = vid; built.vehicleId = vid; } } catch(e) {}
                console.log(`[html5_v8] [PATCH_U3] resolve_by_plate: rescued VEHICLE_ID=${vid} from VHCLS_TAP`);
                return vid;
              }
            } catch (e) {
              console.log(`[html5_v8] [PATCH_U3] resolve_by_plate: rescue err: ${e && (e.message || e.toString())}`);
            }

            console.log(`[html5_v8] [PATCH_U3] resolve_by_plate: VEHICLE_ID not found in response`);
            throw new Error('resolve_by_plate_vehicle_id_not_found');

            throw new Error('resolve_by_plate_vehicle_id_not_found');

    }
  }
} catch (e) {
  console.log(`[html5_v8] [PATCH_U3] resolve_by_plate error: ${e && (e.message || e.toString())}`);
}


let steps = buildStepsForService(service, payload);
try {
  if (String(service).toUpperCase() === "MAINT_WITH_SWAP") {
    const __vid = String(payload.vehicle_id || payload.vehicleId || payload.VEHICLE_ID || "");
    const __sn  = String(payload.serial || payload.serial_new || payload.SERIAL_NEW || "");
    const __acts = (steps || []).map(x => x && (x.action || (x.useBuilder ? "BUILDER" : ""))).filter(Boolean).join(",");
    console.log(`[html5_v8] [PATCH_MWS_DIAG_V1] post_resolve vid=${__vid||"<empty>"} serial=${__sn||"<empty>"} steps_len=${(steps||[]).length} acts=${__acts}`);
    if (!steps || steps.length === 0) throw new Error("mws_no_steps_generated");
  }
} catch(e) {
  console.log(`[html5_v8] [PATCH_MWS_DIAG_V1] ERR ` + (e && (e.message || e.toString())));
  throw e;
}

      

/* __PATCH_UNINSTALL_APPEND_DEACTIVATE_V1
 * Se service=UNINSTALL, garante que:
 * - payload tenha defaults mínimos para DEACTIVATE_VEHICLE_HIST
 * - steps inclua DEACTIVATE_VEHICLE_HIST após resolve_by_plate
 */
try{
  const __p =
    (typeof payload !== "undefined" && payload && typeof payload === "object") ? payload :
    (typeof job !== "undefined" && job && job.payload && typeof job.payload === "object") ? job.payload :
    (globalThis.__JOB_PAYLOAD && typeof globalThis.__JOB_PAYLOAD === "object") ? globalThis.__JOB_PAYLOAD :
    null;

  const __svc = (__p && (__p.service || __p.SERVICE)) ? String(__p.service || __p.SERVICE) : "";

  if (__p && __svc === "UNINSTALL" && Array.isArray(steps)) {
    // defaults mínimos (não sobrepõe se já existir)
    __p.VERSION_ID  = __p.VERSION_ID  || 2;
    __p.REASON_CODE = __p.REASON_CODE || 5501;
    __p.DELIVER_CODE= __p.DELIVER_CODE|| 5511;

    const __plate = __p.LICENSE_NMBR || __p.license_nmbr || __p.plate || __p.PLATE;
    if (__plate) {
      __p.LICENSE_NMBR = __p.LICENSE_NMBR || __plate;
      __p.license_nmbr = __p.license_nmbr || __plate;
    }

    // append DEACTIVATE se ainda não existir
    const hasDeactivate =
      steps.some(x => (typeof x === "string" && x === "DEACTIVATE_VEHICLE_HIST") ||
                      (x && typeof x === "object" && (x.step === "DEACTIVATE_VEHICLE_HIST" || x.action === "DEACTIVATE_VEHICLE_HIST")));

    if (!hasDeactivate) {
      // suporta steps como array de strings OU objetos
      if (steps.length && typeof steps[0] === "string") {
        steps.push("DEACTIVATE_VEHICLE_HIST");
      } else {
        steps.push({ step: "DEACTIVATE_VEHICLE_HIST", action: "DEACTIVATE_VEHICLE_HIST" });
      }
      console.log(`[UNINSTALL_FIX] appended DEACTIVATE_VEHICLE_HIST (steps=${steps.length})`);
    } else {
      console.log(`[UNINSTALL_FIX] DEACTIVATE already present (steps=${steps.length})`);
    }
  }
}catch(e){
  console.log(`[UNINSTALL_FIX_ERR] ${(e && e.message) ? e.message : e}`);
}

// [PATCH_U6] ensure required fields for DEACTIVATE_VEHICLE_HIST
      try {
        const _rc = String(payload.REASON_CODE || payload.reason_code || 5501);
        const _dc = String(payload.DELIVER_CODE || payload.deliver_code || 5511);
        const _in = String(payload.INSTALLER_NAME || payload.installer_name || payload.installer || "monitor-backend");
        const _cm = String(payload.COMMENTS || payload.comments || payload.notes || "");
        const list = Array.isArray(steps) ? steps : (Array.isArray(payload.html5Steps) ? payload.html5Steps : null);
        if (list) {
          for (const st of list) {
            if (st && st.action === "DEACTIVATE_VEHICLE_HIST") {
              st.fields = st.fields || {};
              if (!st.fields.REASON_CODE) st.fields.REASON_CODE = _rc;
              if (!st.fields.DELIVER_CODE) st.fields.DELIVER_CODE = _dc;
              if (!st.fields.INSTALLER_NAME) st.fields.INSTALLER_NAME = _in;
              if (!st.fields.COMMENTS && _cm) st.fields.COMMENTS = _cm;
            }
          }
        }
      } catch (e) {}


        // DEBUG: não chama HTML5, só monta o payload do SAVE_VHCL_ACTIVATION_NEW
        if (service === "DEBUG_BUILD_SAVE_ACTIVATION_FIELDS") {
          const built = buildSaveActivationFields(payload || {});
          await finish("ok", {
            ok: true,
            service,
            note: "build-only (no HTML5 call)",
            built: {
              FIELD_IDS: built.FIELD_IDS,
              FIELD_VALUE: built.FIELD_VALUE,
              LICENSE_NMBR: built.LICENSE_NMBR,
              DIAL_NUMBER: built.DIAL_NUMBER,
              INNER_ID: built.INNER_ID
            }
          });
          return;
        }

        // DRY_RUN / exec off
        if (DRY_RUN || !EXECUTE_HTML5) {
          await finish("ok", {
            ok:true,
            dryRun: DRY_RUN,
            exec: EXECUTE_HTML5,
            service,
            note: "DRY_RUN or EXECUTE_HTML5 off",
            plannedSteps: steps.map(s => ({ label:s.label, action:s.action, from:s._from }))
          });
          return;
        }

        // load cookie
        let cookie = (await loadCookieJar()).cookie || "";

        // preflight (needed for MAINT_WITH_SWAP + CHANGE_COMPANY)
        if (service === "MAINT_WITH_SWAP" || service === "CHANGE_COMPANY") {
          const vId = payload.vehicle_id || payload.vehicleId || payload.VEHICLE_ID || payload.vehicleID || payload.VehicleId;
          if (vId) {
            const preload = normalizeStep({
              label: "preload_asset",
              action: "ASSET_BASIC_LOAD",
              fields: {
                ASSET_ID: String(vId),
                ASSET_DESCRIPTION: String(payload.asset_description || payload.ASSET_DESCRIPTION || ""),
                action: "ASSET_BASIC_LOAD",
                VERSION_ID: "2"
              }
            }, payload);

            const out = await html5RunStep(id, preload, cookie);
            cookie = (await loadCookieJar()).cookie || cookie;

            // se preload falhar, não “mata” MAINT_WITH_SWAP (ele segue), mas CHANGE_COMPANY vai ficar sem payload e cair no erro abaixo
            if (stepOk(out)) {
              try {
                const cap = __CAPTURES.ASSET_BASIC_LOAD || null;
                const resp = cap && cap.resp ? String(cap.resp) : "";
                const a = __parseFirstTagAttributes(resp, "DATA") || (cap && cap.tag) || null;
                if (a) {
                  payload.__assetLoadAttrs = a;
                  if (!payload.asset_description && a.ASSET_DESCRIPTION) payload.asset_description = a.ASSET_DESCRIPTION;
                }
              } catch {}
            } else {
              console.log("[PATCH_D2] preload ASSET_BASIC_LOAD not ok; continuing");
            }
          }
          // [VA3] preload activation baseline (keep existing fields) for MAINT_WITH_SWAP
          if (service === "MAINT_WITH_SWAP" && vId && !payload.__activationBaselineAttrs) {
            try {
              const act = await __va_getActivationBaseline(vId);
              if (act && act.attrs) {
                payload.__activationBaselineAttrs = act.attrs;
                console.log(`[html5_v8] [VA3] baseline captured keys=${Object.keys(act.attrs).length}`);
              } else {
                console.log(`[html5_v8] [VA3] baseline missing attrs (will fallback to builder)`);
              }
            } catch (e) {
              console.log(`[html5_v8] [VA3] baseline err ${(e && (e.message||e.toString()))}`);
            }
          }

          steps = buildStepsForService(service, payload);
        }

        // serviços que deliberadamente NÃO mutam HTML5
        const html5ShouldSkip = (service === "MAINT_NO_SWAP" && steps.length === 0);

        if (html5ShouldSkip) {
          await finish("ok", {
            ok:true,
            service,
            note: "no HTML5 mutation by design (or not needed)",
            cookieKeys: cookieKeysFromCookieHeader((await loadCookieJar()).cookie || "")
          });
          return;
        }

        if (!steps.length) {
          await finish("error", {
            ok:false,
            service,
            error:"missing_html5_payload",
            message:"For this service, provide payload.html5Steps[] (exact UI fields) or payload.html5Action/html5Fields. INSTALL/UNINSTALL are allowed fallback builders.",
          });
          return;
        }

        const results = [];
        for (const s of steps) {
          const out = await html5RunStep(id, s, cookie);
          results.push({
            label: s.label,
            action: s.action,
            attempt: out.attempt,
            httpStatus: out.final ? out.final.httpStatus : null,
            ok: stepOk(out),
            snippet: out.final ? out.final.snippet : null,
            parsed: out.final ? out.final.parsed : null,
          });

          cookie = (await loadCookieJar()).cookie || cookie;

          if (!stepOk(out)) {
            // MAINT_WITH_SWAP: erro conhecido quando o novo serial já está vinculado a outro veículo
            if (service === "MAINT_WITH_SWAP" && String(s.action||"") === "SAVE_VHCL_ACTIVATION_NEW") {
              const sn = out && out.final ? String(out.final.snippet || "") : "";
              const looksSerialInUse = /(already|duplicate|exist|assigned|attached|vincul|vinculado|link|linked)/i.test(sn);
              const code = looksSerialInUse ? "serial_in_use" :
                ((out && out.final && out.final.parsed && out.final.parsed.isLoginNeg) ? "auth_failed_after_retry" : "step_failed");
              const msg2 = looksSerialInUse
                ? "Serial já vinculado a outro veículo (HTML5 negou a troca). Faça a desinstalação no veículo atual antes e tente novamente."
                : "Falha ao vincular novo serial no mesmo vehicle_id (swap_activate).";
              await finish("error", { ok:false, service, error: code, message: msg2, failedStep: { label: s.label, action: s.action, snippet: sn } });
              return;
            }

            const msg = out && out.final && out.final.parsed && out.final.parsed.isLoginNeg
              ? "auth_failed_after_retry"
              : "step_failed";
            throw new Error(`${msg}:${s.label}:${s.action}`);
          }
        }

        const cookieKeys = cookieKeysFromCookieHeader((await loadCookieJar()).cookie || "");

        await finish("ok", {
          ok:true,
          service,
          cookieKeys,
          steps: results
        });
      };

      try{
        await withTimeout(jobRunner(), JOB_MAX_MS, `job:${id}`);
      } catch (e){
        const msg = e && (e.message || e.toString());
        console.log(`[html5_v8] JOB_FAIL id=${id} err=${msg}`);
        await finish("error", { ok:false, service, error:"job_exception_or_timeout", message: msg });
      }

    } catch (e) {
      // __ABORT_SOFTEN_A10__
      if (e && (e.name === "AbortError" || String((e && (e.message || e)) || "").toLowerCase().includes("aborted"))) {
        const lu = globalThis.__LAST_FETCH_URL ? String(globalThis.__LAST_FETCH_URL) : "";
        console.log("[html5_v8] warn: AbortError (timeout) url=" + lu);
        try { await sleep(1000); } catch (_) {}
        continue;
      }
      // PATCH_A11: soften AbortError
      if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || e)))) {
        const lu = globalThis.__LAST_FETCH_URL ? String(globalThis.__LAST_FETCH_URL) : '';
        console.log('[html5_v8] warn: AbortError (timeout) url=' + lu);
      } else {
      console.log("[html5_v8] loop error:", e && (e.stack || e.message || e.toString()));
      
        // PATCH_LOOP_ERROR_CAUSE
        try {
          const __e = (typeof e !== 'undefined') ? e : ((typeof err !== 'undefined') ? err : ((typeof error !== 'undefined') ? error : null));
          console.log('[html5_v8] loop lastStep=' + JSON.stringify(globalThis.__LAST_STEP || {}));
          const c = (__e && __e.cause) ? (__e.cause.message || String(__e.cause)) : '';
          if (c) console.log('[html5_v8] loop cause=' + c);
        } catch(_e) {}
}
      await sleep(POLL_MS);
    }
  }
}

main().catch(err => { console.error("[html5_v8] fatal:", err && (err.stack || err.message || err)); process.exit(1); });



/* === PATCH_C6B: VHCLS_FORCE_COOKIE v3 (FORCE override + host/flags) ===
 * - Sempre sobrescreve Cookie do VHCLS com cookie do cookiejar (se existir)
 * - Loga apenas host + lens + flags (ASP/TFL/EULA/ROOT), sem vazar valores.
 * - Usa setImmediate para ser "o último wrapper", mesmo se houver nextTick wrappers.
 */
(function(){
  try{
    if (globalThis.__VHCLS_FORCE_COOKIE_V3) return;
    globalThis.__VHCLS_FORCE_COOKIE_V3 = true;

    const fs = require("fs");
    const COOKIEJAR_PATH = process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json";

    function readCookieHeaderSafe(){
      try{
        if (!fs.existsSync(COOKIEJAR_PATH)) return "";
        const raw = fs.readFileSync(COOKIEJAR_PATH, "utf8");
        if (!raw) return "";
        try{
          const j = JSON.parse(raw);
          if (!j) return "";
          if (typeof j.cookieHeader === "string") return j.cookieHeader.trim();
          if (typeof j.cookie === "string") return j.cookie.trim();
        }catch(e){
          // não é JSON -> pode já ser cookie header puro
          return String(raw).trim();
        }
      }catch(e){}
      return "";
    }

    function hasCookie(cookieStr, name){
      try{
        return new RegExp("(^|;\\s*)" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=").test(cookieStr);
      }catch(e){ return false; }
    }

    function bodyText(init){
      try{
        const b = init && init.body;
        if (!b) return "";
        if (typeof b === "string") return b;
        if (typeof URLSearchParams !== "undefined" && b instanceof URLSearchParams) return b.toString();
        if (b && typeof b.toString === "function") {
          const s = String(b);
          if (s && s !== "[object Object]" && s !== "[object FormData]") return s;
        }
      }catch(e){}
      return "";
    }

    function getHost(input){
      try{
        if (typeof input === "string") return (new URL(input)).host;
        if (input && typeof input.url === "string") return (new URL(input.url)).host;
      }catch(e){}
      return "unknown";
    }

    setImmediate(() => {
      try{
        const origFetch = globalThis.fetch;
        if (typeof origFetch !== "function") return;

        globalThis.fetch = async function(input, init){
          const bt = bodyText(init);
          const isVHCLS = /(^|[&?])action=VHCLS(&|$)/i.test(bt);

          if (isVHCLS) {
            const host = getHost(input);
            const h = new Headers((init && init.headers) || (input && input.headers) || undefined);

            const cur = String(h.get("cookie") || "").trim();
            const ck  = readCookieHeaderSafe();

            const curFlags = `ASP=${hasCookie(cur,"ASP.NET_SessionId")?1:0} TFL=${hasCookie(cur,"TFL_SESSION")?1:0} EULA=${hasCookie(cur,"EULA_APPROVED")?1:0} ROOT=${hasCookie(cur,"APPLICATION_ROOT_NODE")?1:0}`;
            const jarFlags = `ASP=${hasCookie(ck,"ASP.NET_SessionId")?1:0} TFL=${hasCookie(ck,"TFL_SESSION")?1:0} EULA=${hasCookie(ck,"EULA_APPROVED")?1:0} ROOT=${hasCookie(ck,"APPLICATION_ROOT_NODE")?1:0}`;

            if (ck) {
              // FORÇA override sempre
              const need = (!cur) || !hasCookie(cur, "TFL_SESSION") || !hasCookie(cur, "ASP.NET_SessionId") || (!hasCookie(cur, "EULA_APPROVED") && hasCookie(ck, "EULA_APPROVED")) || (!hasCookie(cur, "APPLICATION_ROOT_NODE") && hasCookie(ck, "APPLICATION_ROOT_NODE"));
      // PATCH_VHCLS_COOKIE_MERGE_V2: preserva cookies atuais (ex.: AWSALB/AWSALBCORS) e só mescla jar cookies
              if (need) {
                try {
                  const parseCookieHeader = (str) => {
                    const out = Object.create(null);
                    String(str || "").split(";").forEach((part) => {
                      part = String(part || "").trim();
                      if (!part) return;
                      const eq = part.indexOf("=");
                      if (eq <= 0) return;
                      const k = part.slice(0, eq).trim();
                      const v = part.slice(eq + 1).trim();
                      if (k) out[k] = v;
                    });
                    return out;
                  };

                  const curMap = parseCookieHeader(cur);
                  const jarMap = parseCookieHeader(ck);

                  // garante estes se existirem no jar (sem perder os demais do cur)
                  const must = { "TFL_SESSION":1, "ASP.NET_SessionId":1, "EULA_APPROVED":1, "APPLICATION_ROOT_NODE":1 };

                  for (const k of Object.keys(jarMap)) {
                    if (!(k in curMap) || must[k]) curMap[k] = jarMap[k];
                  }

                  const merged = Object.keys(curMap).map((k) => `${k}=${curMap[k]}`).join("; ");
                  h.set("cookie", merged);
                  console.log(`[VHCLS_FORCE_COOKIE] merged finalLen=${merged.length} delta=${merged.length - cur.length}`);
                } catch (e) {
                  // fallback conservador
                  h.set("cookie", ck);
                  console.log(`[VHCLS_FORCE_COOKIE] merged_fallback finalLen=${ck.length}`);
                }
              }
              console.log(`[VHCLS_FORCE_COOKIE] override host=${host} need=${need?1:0} cookieLen=${ck.length} curLen=${cur.length} curFlags={${curFlags}} jarFlags={${jarFlags}}`);
              init = Object.assign({}, init || {}, { headers: h });
            } else {
              console.log(`[VHCLS_FORCE_COOKIE] WARN host=${host} cookieLen=0 curLen=${cur.length} curFlags={${curFlags}}`);
            }
          }

          return origFetch(input, init);
        };
      }catch(e){}
    });

  }catch(e){}
})();




/* === PATCH_C6C: JOBSERVER_FETCH timeout+log v1 ===
 * Objetivo: detectar travas em chamadas ao Job Server (complete/fail/heartbeat).
 * - Aplica somente quando host == host(JOB_SERVER_BASE_URL).
 * - Loga apenas host+pathname, status e duração (sem query/headers).
 * - Timeout padrão 20s (env JOBSERVER_FETCH_TIMEOUT_MS).
 */
(function(){
  try{
    if (globalThis.__JOBSERVER_FETCH_TIMEOUT_V1) return;
    globalThis.__JOBSERVER_FETCH_TIMEOUT_V1 = true;

    const base = process.env.JOB_SERVER_BASE_URL || "";
    let jobHost = "";
    try { jobHost = base ? (new URL(base)).host : ""; } catch(e) { jobHost = ""; }

    if (!jobHost) {
      console.log("[JOBSERVER_FETCH] WARN no JOB_SERVER_BASE_URL host");
      return;
    }

    const install = () => {
      const origFetch = globalThis.fetch;
      if (typeof origFetch !== "function") return;

      globalThis.fetch = async function(input, init){
        let urlStr = "";
        try { urlStr = (typeof input === "string") ? input : (input && input.url) ? input.url : ""; } catch(e) {}
        let host = "", path = "";
        try {
          if (urlStr) { const u = new URL(urlStr); host = u.host; path = u.pathname; }
        } catch(e) {}

        if (host && host === jobHost) {
          const ms = Number(process.env.JOBSERVER_FETCH_TIMEOUT_MS || 20000);
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), ms);
          const t0 = Date.now();
          try{
            const res = await origFetch(input, Object.assign({}, init || {}, { signal: ac.signal }));
            console.log(`[JOBSERVER_FETCH] ok status=${res.status} ms=${Date.now()-t0} path=${path}`);
            return res;
          } catch(err){
            const name = (err && err.name) ? err.name : "ERR";
            console.log(`[JOBSERVER_FETCH] ERR name=${name} ms=${Date.now()-t0} path=${path}`);
            throw err;
          } finally {
            clearTimeout(t);
          }
        }

        return origFetch(input, init);
      };
    };

    // tenta ser o “último wrapper”
    setImmediate(install);
  } catch(e){}
})();




/* __PATCH_LOGHOOK_PERSIST_VID_V1
 * Objetivo: garantir que o VEHICLE_ID resgatado pelo resolve_by_plate seja persistido no payload,
 * sem depender de ancoragem frágil no bundle.
 * - JOB_TAP: quando fetch em /api/jobs/next retorna job, guarda globalThis.__JOB_PAYLOAD
 * - LOGHOOK: quando aparecer "rescued VEHICLE_ID=123", escreve em __JOB_PAYLOAD.VEHICLE_ID/vehicle_id/vehicleId
 * Logs: somente id e flags, sem vazar cookies/tokens.
 */
(function(){
  try{
    if (globalThis.__PATCH_LOGHOOK_PERSIST_VID_V1) return;
    globalThis.__PATCH_LOGHOOK_PERSIST_VID_V1 = true;

    // --- util ---
    function safeStr(x){
      try{
        if (typeof x === "string") return x;
        if (x && typeof x.message === "string") return x.message;
        return JSON.stringify(x);
      }catch(e){ return String(x); }
    }

    // --- JOB_TAP (/api/jobs/next) ---
    const base = process.env.JOB_SERVER_BASE_URL || "";
    let jobHost = "";
    try { jobHost = base ? (new URL(base)).host : ""; } catch(e) { jobHost = ""; }

    const wrapFetch = () => {
      try{
        const origFetch = globalThis.fetch;
        if (typeof origFetch !== "function") return;

        globalThis.fetch = async function(input, init){
          const res = await origFetch(input, init);

          try{
            const urlStr = (typeof input === "string") ? input : (input && input.url) ? input.url : "";
            if (urlStr && jobHost) {
              const u = new URL(urlStr);
              if (u.host === jobHost && /\/api\/jobs\/next\b/.test(u.pathname)) {
                res.clone().json().then((data)=>{
                  const job = data && (data.job || data);
                  if (job && job.payload && typeof job.payload === "object") {
                    globalThis.__JOB_PAYLOAD = job.payload;
                    globalThis.__JOB_LAST = { id: job.id, type: job.type };
                    // log mínimo
                    const k = Object.keys(job.payload || {}).length;
                    console.log(`[JOB_TAP] stored payload for job id=${job.id||"?"} keys=${k}`);
                  }
                }).catch(()=>{});
              }
            }
          }catch(e){}

          return res;
        };
      }catch(e){}
    };

    // tenta ser “último wrapper”
    setImmediate(wrapFetch);

    // --- LOGHOOK (persist VID quando ver o log do rescued) ---
    if (!globalThis.__LOGHOOK_VID_INSTALLED) {
      globalThis.__LOGHOOK_VID_INSTALLED = true;

      const origLog = console.log.bind(console);

      console.log = function(...args){
        try{
          const msg = args.map(safeStr).join(" ");
          const m = msg.match(/resolve_by_plate:\s*rescued\s+VEHICLE_ID=(\d+)/);
          if (m) {
            const vid = m[1];
            const p = globalThis.__JOB_PAYLOAD;
            if (p && typeof p === "object") {
              p.VEHICLE_ID = p.VEHICLE_ID || vid;
              p.vehicle_id = p.vehicle_id || vid;
              p.vehicleId  = p.vehicleId  || vid;

              const plate = p.plate || p.PLATE || p.LICENSE_NMBR || p.license_nmbr;
              if (plate) {
                p.LICENSE_NMBR = p.LICENSE_NMBR || plate;
                p.license_nmbr = p.license_nmbr || plate;
              }

              origLog(`[PATCH_U3] loghook persisted VEHICLE_ID=${vid}`);
            } else {
              origLog(`[PATCH_U3] loghook WARN no __JOB_PAYLOAD for VEHICLE_ID=${vid}`);
            }
          }
        }catch(e){}
        return origLog(...args);
      };
    }
  }catch(e){}
})();




/* __PATCH_UNINSTALL_DIRECT_DEACTIVATE_V1
 * Hotfix robusto: ao detectar no log "rescued VEHICLE_ID=xxxx" dentro de UNINSTALL,
 * dispara imediatamente DEACTIVATE_VEHICLE_HIST via AppEngine_2_1.
 * - Sem depender do step-list.
 * - Força Cookie do cookiejar também no DEACTIVATE.
 * - Loga só status/len/login=-1 (sem vazar cookies).
 */
(function(){
  try{
    if (globalThis.__PATCH_UNINSTALL_DIRECT_DEACTIVATE_V1) return;
    globalThis.__PATCH_UNINSTALL_DIRECT_DEACTIVATE_V1 = true;

    const fs = require("fs");
    const COOKIEJAR_PATH = process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json";
    const APPENGINE_2_1 = (process.env.HTML5_APPENGINE_2_1 || "https://html5.traffilog.com/AppEngine_2_1/default.aspx");

    // guarda contexto do job atual
    globalThis.__CUR_JOB_ID = globalThis.__CUR_JOB_ID || null;
    globalThis.__CUR_SERVICE = globalThis.__CUR_SERVICE || null;

    // anti-replay por job
    globalThis.__UNINSTALL_DEACT_DONE = globalThis.__UNINSTALL_DEACT_DONE || Object.create(null);

    function readCookieHeaderSafe(){
      try{
        if (!fs.existsSync(COOKIEJAR_PATH)) return "";
        const raw = fs.readFileSync(COOKIEJAR_PATH, "utf8");
        if (!raw) return "";
        try{
          const j = JSON.parse(raw);
          if (j && typeof j.cookieHeader === "string") return j.cookieHeader.trim();
          if (j && typeof j.cookie === "string") return j.cookie.trim();
        }catch(e){
          return String(raw).trim();
        }
      }catch(e){}
      return "";
    }

    function bodyText(init){
      try{
        const b = init && init.body;
        if (!b) return "";
        if (typeof b === "string") return b;
        if (typeof URLSearchParams !== "undefined" && b instanceof URLSearchParams) return b.toString();
      }catch(e){}
      return "";
    }

    // 1) fetch wrapper: forçar cookie no DEACTIVATE também
    setImmediate(() => {
      try{
        const origFetch = globalThis.fetch;
        if (typeof origFetch !== "function") return;

        globalThis.fetch = async function(input, init){
          const bt = bodyText(init);
          const isDeactivate = /(^|[&?])action=DEACTIVATE_VEHICLE_HIST(&|$)/i.test(bt);

          if (isDeactivate) {
            const h = new Headers((init && init.headers) || (input && input.headers) || undefined);
            const ck = readCookieHeaderSafe();
            if (ck) {
              h.set("cookie", ck);
              console.log(`[DEACTIVATE_FORCE_COOKIE] override(cookieLen=${ck.length})`);
              init = Object.assign({}, init || {}, { headers: h });
            } else {
              console.log("[DEACTIVATE_FORCE_COOKIE] WARN cookieLen=0");
            }
          }
          return origFetch(input, init);
        };
      }catch(e){}
    });

    async function runDeactivate(vid){
      try{
        const jobId = globalThis.__CUR_JOB_ID || "unknown";
        const key = String(jobId);
        if (globalThis.__UNINSTALL_DEACT_DONE[key]) return;
        globalThis.__UNINSTALL_DEACT_DONE[key] = true;

        // tenta pegar placa do payload "tapado" (se existir)
        const p = globalThis.__JOB_PAYLOAD || {};
        const plate = p.LICENSE_NMBR || p.license_nmbr || p.plate || p.PLATE || "";

        // body mínimo (URL-encoded)
        const params = new URLSearchParams();
        params.set("action", "DEACTIVATE_VEHICLE_HIST");
        params.set("VERSION_ID", String(p.VERSION_ID || 2));
        params.set("VEHICLE_ID", String(vid));
        if (plate) params.set("LICENSE_NMBR", String(plate));
        params.set("REASON_CODE", String(p.REASON_CODE || 5501));
        params.set("DELIVER_CODE", String(p.DELIVER_CODE || 5511));


  const __jobId = (globalThis && globalThis.__CUR_JOB_ID) ? globalThis.__CUR_JOB_ID : "";
  console.log(`[UNINSTALL_DEACTIVATE] start job=${__jobId} vid=${vid} plateLen=${String(plate||"").length}`);
  const __r = (typeof __va_deactivateVehicleHistCan === "function")
    ? await __va_deactivateVehicleHistCan(vid, plate)
    : await __va_appenginePost("DEACTIVATE_VEHICLE_HIST", {
        VERSION_ID:"2", VEHICLE_ID:String(vid), LICENSE_NMBR:String(plate),
        REASON_CODE:"5501", DELIVER_CODE:"5511"
      }, "DEACTIVATE_FALLBACK_CANON");
  console.log(`[UNINSTALL_DEACTIVATE] done status=${__r && __r.status} len=${__r && (__r.text||"").length} loginNeg=${__r && __r.loginNeg?1:0}`);
      }catch(e){
        console.log(`[UNINSTALL_DEACTIVATE] ERR ${(e && e.message)?e.message:e}`);
      }
    }

    // 2) console hook: detectar GOT job e rescued VID
    const prevLog = console.log;
    console.log = function(...args){
      try{
        const msg = args.map(a => (typeof a === "string" ? a : (a && a.message) ? a.message : String(a))).join(" ");

        // captura job atual (UNINSTALL)
        let m = msg.match(/\[html5_v8\]\s+GOT job id=([0-9a-f]+)\s+service=([A-Z_]+)/i);
        if (m) {
          globalThis.__CUR_JOB_ID = m[1];
          globalThis.__CUR_SERVICE = m[2];
        }

        // quando resgatar VEHICLE_ID em UNINSTALL -> dispara DEACTIVATE já
        m = msg.match(/resolve_by_plate:\s*rescued\s+VEHICLE_ID=(\d+)/i);
        if (m && String(globalThis.__CUR_SERVICE||"") === "UNINSTALL") {
          const vid = m[1];
          globalThis.__LAST_VEHICLE_ID = vid;
          // fire-and-forget (não bloquear o log)
          setTimeout(() => runDeactivate(vid), 0);
        }
      }catch(e){}
      return prevLog.apply(console, args);
    };

  }catch(e){}
})();




/* __PATCH_DEACTIVATE_FORCE_COOKIE_V2
 * Monta cookie header robusto do cookiejar (string | cookieHeader | cookies[] | map),
 * e loga apenas flags (ASP/TFL/EULA/ROOT) + len, sem vazar valores.
 */
(function(){
  try{
    if (globalThis.__PATCH_DEACTIVATE_FORCE_COOKIE_V2) return;
    globalThis.__PATCH_DEACTIVATE_FORCE_COOKIE_V2 = true;

    const fs = require("fs");
    const COOKIEJAR_PATH = process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json";

    function hasCookie(cookieStr, name){
      try{
        return new RegExp("(^|;\\s*)" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=").test(cookieStr);
      }catch(e){ return false; }
    }

    function buildCookieHeader(j){
      if (!j) return "";
      if (typeof j === "string") return j.trim();
      if (typeof j.cookieHeader === "string") return j.cookieHeader.trim();
      if (typeof j.cookie === "string") return j.cookie.trim();

      // cookies array
      if (Array.isArray(j.cookies)) {
        const parts = [];
        for (const c of j.cookies) {
          if (!c) continue;
          const name = String(c.name || c.key || c.n || "").trim();
          const val  = String(c.value || c.v || "").trim();
          if (name && val) parts.push(`${name}=${val}`);
        }
        return parts.join("; ");
      }

      // map-like
      const map = j.cookies || j.jar || j;
      if (map && typeof map === "object") {
        const parts = [];
        for (const k of Object.keys(map)) {
          const v = map[k];
          if (typeof v === "string" && v) parts.push(`${k}=${v}`);
          else if (v && typeof v === "object" && typeof v.value === "string" && v.value) parts.push(`${k}=${v.value}`);
        }
        return parts.join("; ");
      }
      return "";
    }

    function readCookieHeaderSafe(){
      try{
        if (!fs.existsSync(COOKIEJAR_PATH)) return "";
        const raw = fs.readFileSync(COOKIEJAR_PATH, "utf8");
        if (!raw) return "";
        try{
          const j = JSON.parse(raw);
          return buildCookieHeader(j);
        }catch(e){
          // pode ser header puro
          return String(raw).trim();
        }
      }catch(e){}
      return "";
    }

    function bodyText(init){
      try{
        const b = init && init.body;
        if (!b) return "";
        if (typeof b === "string") return b;
        if (typeof URLSearchParams !== "undefined" && b instanceof URLSearchParams) return b.toString();
      }catch(e){}
      return "";
    }

    // instala “por último”
    setTimeout(() => {
      try{
        const origFetch = globalThis.fetch;
        if (typeof origFetch !== "function") return;

        globalThis.fetch = async function(input, init){
          const bt = bodyText(init);
          const isDeactivate = /(^|[&?])action=DEACTIVATE_VEHICLE_HIST(&|$)/i.test(bt);

          if (isDeactivate) {
            const h = new Headers((init && init.headers) || (input && input.headers) || undefined);
            const cur = String(h.get("cookie") || "").trim();
            const ck  = readCookieHeaderSafe();

            const curFlags = `ASP=${hasCookie(cur,"ASP.NET_SessionId")?1:0} TFL=${hasCookie(cur,"TFL_SESSION")?1:0} EULA=${hasCookie(cur,"EULA_APPROVED")?1:0} ROOT=${hasCookie(cur,"APPLICATION_ROOT_NODE")?1:0}`;
            const jarFlags = `ASP=${hasCookie(ck,"ASP.NET_SessionId")?1:0} TFL=${hasCookie(ck,"TFL_SESSION")?1:0} EULA=${hasCookie(ck,"EULA_APPROVED")?1:0} ROOT=${hasCookie(ck,"APPLICATION_ROOT_NODE")?1:0}`;

            if (ck) {
              h.set("cookie", ck);
              console.log(`[DEACTIVATE_FORCE_COOKIE_V2] override cookieLen=${ck.length} curLen=${cur.length} curFlags={${curFlags}} jarFlags={${jarFlags}}`);
              init = Object.assign({}, init || {}, { headers: h });
            } else {
              console.log(`[DEACTIVATE_FORCE_COOKIE_V2] WARN cookieLen=0 curLen=${cur.length} curFlags={${curFlags}}`);
            }
          }

          return origFetch(input, init);
        };
      }catch(e){}
    }, 20);

  }catch(e){}
})();

