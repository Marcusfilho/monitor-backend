const WebSocket = require("ws");

// === AUTOLOGIN PATCH (2025-12-26) ==========================================
const fs = require("fs");

function __readSecretEnvOrFile(envName, fileEnvName) {
  const v = (process.env[envName] || "").trim();
  if (v) return v;
  const f = (process.env[fileEnvName] || "").trim();
  if (!f) return "";
  try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; }
}

const __WS_USER = (process.env.MONITOR_USERNAME || process.env.MONITOR_USER || process.env.WS_USER || process.env.USER_LOGIN || "").trim();
const __WS_PASS =
  __readSecretEnvOrFile("WS_PASSWORD", "WS_PASSWORD_FILE") ||
  __readSecretEnvOrFile("MONITOR_PASSWORD", "MONITOR_PASSWORD_FILE");

function __buildWire(actionName, params, mtkn, sessionToken, tag) {
  const obj = { tag: tag || "loading_screen", _action_name: actionName, parameters: params || {}, mtkn: String(mtkn) };
  if (sessionToken && actionName !== "user_login") obj.session_token = String(sessionToken);
  return encodeURIComponent(JSON.stringify(obj));
}

function __safeOff(ws, ev, fn) {
  try {
    if (typeof ws.off === "function") ws.off(ev, fn);
    else ws.removeListener(ev, fn);
  } catch {}
}

async function __autoWsUserLogin(ws, sessionToken) {
  if (!__WS_USER || !__WS_PASS) {
    console.log("[sb] auto-login skipped (MONITOR_USERNAME / WS_PASSWORD ausentes)");
    return true;
  }
  if (ws.__autoLoggedIn) return true;
  ws.__autoLoggedIn = true; // só marca 1x

  const candidates = [
    { user_name: __WS_USER, password: __WS_PASS },
    { username: __WS_USER, password: __WS_PASS },
    { user: __WS_USER, password: __WS_PASS },
    { login: __WS_USER, password: __WS_PASS },
    { email: __WS_USER, password: __WS_PASS },
    { user_name: __WS_USER, user_password: __WS_PASS },
    { user: __WS_USER, pass: __WS_PASS },
  ];

  for (const params of candidates) {
    const mtkn = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const wire = __buildWire("user_login", params, mtkn, null, "loading_screen");
    console.log("[sb] >> user_login (auto) mtkn=" + mtkn);

    const ok = await new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        __safeOff(ws, "message", onMsg);
        resolve(false);
      }, 8000);

      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(t);
        __safeOff(ws, "message", onMsg);
        resolve(v);
      }

      function onMsg(raw) {
        try {
          const txt = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
          const dec = txt.trim().startsWith("{") ? txt : decodeURIComponent(txt);
          const j = JSON.parse(dec);

          const resp = (j && j.response && j.response.properties) ? j.response.properties
                     : (j && j.response) ? j.response
                     : j;

          const rmtkn = String((resp && (resp.mtkn || (resp.properties && resp.properties.mtkn))) || "");
if (rmtkn !== String(mtkn)) return;

          const av = String((resp && (resp.action_value || (resp.properties && resp.properties.action_value))) || "");
if (av === "0") {
            console.log("[sb] << user_login OK");
            return finish(true);
          }
          console.log("[sb] << user_login FAIL action_value=" + av);
          return finish(false);
        } catch {
          // ignora
        }
      }

      ws.on("message", onMsg);
      ws.send(wire);
    });

    if (ok) return true;
  }

  console.log("[sb] auto-login falhou em todas as variações. Provável: nomes de campos diferentes.");
  return false;
}
// === /AUTOLOGIN PATCH =======================================================


const __SEEN_BY_MTK = new Map();
const __PENDING_BY_MTK = new Map();

function parseWsMessage_(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
  let txt = s;

  // Alguns frames vêm URL-encoded (%7B...%7D)
  if (txt.startsWith("%7B") || (txt.includes("%22") && txt.includes("%7D"))) {
    try { txt = decodeURIComponent(txt); } catch (_) {}
  }
  try { return JSON.parse(txt); } catch (_) { return null; }
}

function getMsgMtkn_(msg) {
  const m =
    msg?.mtkn ??
    msg?.action?.mtkn ??
    msg?.properties?.mtkn ??
    msg?.response?.mtkn ??
    msg?.response?.properties?.mtkn ??
    msg?.response?.action?.mtkn;
  return m == null ? null : String(m);
}

function noteMessage_(msg) {
  const mt = getMsgMtkn_(msg);
  if (!mt) return;

  __SEEN_BY_MTK.set(mt, msg);

  const p = __PENDING_BY_MTK.get(mt);
  if (p) {
    clearTimeout(p.to);
    __PENDING_BY_MTK.delete(mt);
    p.resolve(msg);
  }

  // proteção simples
  if (__SEEN_BY_MTK.size > 1500) __SEEN_BY_MTK.clear();
}


const __SB_PENDING = new Map();
function __sbExtractMtkn(obj){
  return (obj?.response?.properties?.mtkn ?? obj?.properties?.mtkn ?? obj?.response?.mtkn ?? obj?.mtkn ?? null);
}
function __sbResolve(mtkn, payload){
  const key = String(mtkn);
  const entry = __SB_PENDING.get(key);
  if (!entry) return;
  clearTimeout(entry.t);
  __SB_PENDING.delete(key);
  entry.resolve(payload);
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function genFlowId(){ return String(200000 + Math.floor(Math.random()*800000)); }
function genMtkn(){
  const now = Date.now().toString();
  let rnd = Math.floor(Math.random() * 1e12).toString();
  while (rnd.length < 12) rnd = "0" + rnd;
  return now + rnd;
}
function decodeMaybe(s){
  if (typeof s === "string" && (s.startsWith("%7B") || s.startsWith("%7b"))) {
    try { return decodeURIComponent(s); } catch {}
  }
  return s;
}

function buildFrame(actionName, params, sessionToken){
  const mtkn = genMtkn();
  return {
    mtkn,
    frame: {
      action: {
        flow_id: genFlowId(),
        name: actionName,
        parameters: { ...params, _action_name: actionName, mtkn: String(mtkn) },
        session_token: String(sessionToken || ""),
        mtkn: String(mtkn)
      }
    }
  };
}

function sendFrame(ws, actionName, params, sessionToken){
  const { mtkn, frame } = buildFrame(actionName, params, sessionToken);
  const rawJson = JSON.stringify(frame);

  // default RAW (igual Tampermonkey). Para mandar %7B..., use SB_SEND_ENCODE=1
  const out = process.env.SB_SEND_ENCODE === "1" ? encodeURIComponent(rawJson) : rawJson;

  console.log(`[sb] >> ${actionName} mtkn=${mtkn}`);
  ws.send(out);
  return mtkn;
}

function waitRowByMtkn(ws, mtkn, timeoutMs=15000){
  const want = String(mtkn);

  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.removeListener("message", onMsg);
      reject(new Error("Timeout esperando mtkn=" + want));
    }, timeoutMs);

    function onMsg(data){
      const text = decodeMaybe(String(data));
      if (!text.includes(want)) return;

      try {
        const obj = JSON.parse(text);
        if (!obj) return;

        // Aceita:
        // 1) "row" (sem response) ou com process_id (comportamento antigo)
        // 2) "action_value" padrão (response.properties.mtkn)
        const mt =
          obj?.mtkn ??
          obj?.response?.properties?.mtkn ??
          obj?.response?.mtkn ??
          obj?.action?.mtkn;

        if (mt != null && String(mt) !== want) return;

        if (obj.process_id || !obj.response || obj?.response?.properties) {
          clearTimeout(t);
          ws.removeListener("message", onMsg);
          resolve(obj);
        }
      } catch {}
    }

    ws.on("message", onMsg);
  });
}

(async () => {
  const url = process.env.MONITOR_WS_URL;
  const sessionToken = process.env.MONITOR_SESSION_TOKEN;

  if (!url) throw new Error("Faltou MONITOR_WS_URL");
  if (!sessionToken) throw new Error("Faltou MONITOR_SESSION_TOKEN");

  const cookie = process.env.MONITOR_WS_COOKIE || "";
  const origin = process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com";

  const [clientId, clientName, vehicleId, vehicleSettingId, ...rest] = process.argv.slice(2);
  const comment = rest.join(" ") || "vm scheme builder";

  if (!clientId || !clientName || !vehicleId || !vehicleSettingId) {
    console.error("Uso: node tools/sb_run_vm.js <clientId> <clientName> <vehicleId> <vehicleSettingId> [comment...]");
    process.exit(2);
  }

  // IMPORTANTE: sem subprotocol (evita "invalid subprotocol")
  const ws = new WebSocket(url, {
    headers: cookie ? { Cookie: cookie } : {},
    origin,
    handshakeTimeout: 15000,
    perMessageDeflate: false,
  });

  ws.on("open", () => console.log("[sb] WS open"));
  ws.on("close", (c,r) => console.log("[sb] WS close", c, String(r||"")));
  ws.on("error", (e) => console.log("[sb] WS error", e && e.message ? e.message : e));

  ws.on("message", (data) => {
    // --- mtkn correlation (anti-race) ---
    const __msg0 = parseWsMessage_(data);
    if (__msg0) noteMessage_(__msg0);
    // -----------------------------------

    const text = decodeMaybe(String(data));
    if (text.includes("action_value")) {
      try { console.log("[sb] << action_value msg:", JSON.parse(text)); } catch {}
    }
  });

  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });

  // 0) INIT (igual quando a tela carrega): get_client_vehicles_opr
  sendFrame(ws, "get_client_vehicles_opr", {
    vcls_from_previous_process: "0",
    is_checked: "0",
    last_ignition_status: "0",
    license_nmbr: "",
    inner_id: "",
    vehicle_id: "",
    vin_nmbr: "",
    client_group: "",
    vehicle_type_descr: "",
    is_last_SB_error: "0",
    LAST_SB_STATUS_ID: "",
    current_firmware: "",
    is_assigned_fw: "0",
    time_interval_id: "",
    assigned_firmware: "",
    loaded_setting_name: "",
    is_assigned_setting: "0",
    assigned_setting_name: "",
    processor_type: "",
    hardware_type: "",
    client_id: String(clientId),
    client_name: String(clientName)
  }, sessionToken);
  await sleep(800);

  // 1) Marca veículo
  sendFrame(ws, "vcls_check_opr", {
    client_id: String(clientId),
    vehicle_id: String(vehicleId),
    client_name: String(clientName),
    is_checked: "1"
  }, sessionToken);
  await sleep(300);

  // 2) associate call 0
  sendFrame(ws, "associate_vehicles_actions_opr", {
    tag: "loading_screen",
    client_id: String(clientId),
    client_name: String(clientName),
    action_source: "0",
    action_id: "1",
    call_num: "0"
  }, sessionToken);
  await sleep(300);

  // 3) associate call 1 (setting)
  sendFrame(ws, "associate_vehicles_actions_opr", {
    client_id: String(clientId),
    client_name: String(clientName),
    vehicle_setting_id: String(vehicleSettingId),
    action_source: "0",
    action_id: "1",
    call_num: "1"
  }, sessionToken);
  await sleep(500);

  // 4) review
  sendFrame(ws, "review_process_attributes", { client_id: String(clientId) }, sessionToken);
  await sleep(200);

  // 5) get review -> process_id
  const mtknReview = sendFrame(ws, "get_vcls_action_review_opr", {
    client_id: String(clientId),
    client_name: String(clientName),
    action_source: "0"
  }, sessionToken);

  const reviewRow = await waitRowByMtkn(ws, mtknReview, 15000);
  let processId = String(reviewRow && reviewRow.process_id ? reviewRow.process_id : "");
  if (!processId) {
  // get_vcls_action_review_opr costuma trazer o process_id dentro de response.properties.data[]
  const d = reviewRow?.response?.properties?.data;
  if (Array.isArray(d)) {
    for (const it of d) {
      const pid =
        it?.process_id ??
        it?.processId ??
        it?.processID ??
        it?.properties?.process_id ??
        it?.properties?.processId;
      if (pid) { processId = String(pid); break; }
    }
  }

  if (!processId) {
    const preview = Array.isArray(d) ? d.slice(0, 3) : d;
    console.log("[sb] DEBUG: process_id não veio no topo. preview data=", JSON.stringify(preview));
    throw new Error("Não veio process_id");
  }
}
  console.log("[sb] process_id =", processId);

  // 6) execute
  sendFrame(ws, "execute_action_opr", {
    tag: "loading_screen",
    client_id: String(clientId),
    action_source: "0",
    process_id: processId,
    comment: String(comment),
    toggle_check: "1"
  }, sessionToken);

  console.log("[sb] execute_action_opr enviado.");
  await sleep(2000);
  ws.close(1000, "done");
})();

// PATCH_WAITFORMTKN_V2

function parseWsMessage_(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
  let txt = s;

  // Alguns frames vêm URL-encoded (%7B...%7D)
  if (txt.startsWith('%7B') || (txt.includes('%22') && txt.includes('%7D'))) {
    try { txt = decodeURIComponent(txt); } catch (_) {}
  }

  try { return JSON.parse(txt); } catch (_) { return null; }
}

function getMsgMtkn_(msg) {
  const m =
    msg?.mtkn ??
    msg?.action?.mtkn ??
    msg?.properties?.mtkn ??
    msg?.response?.mtkn ??
    msg?.response?.properties?.mtkn ??
    msg?.response?.action?.mtkn;
  return m == null ? null : String(m);
}



/* [cleanup] duplicate waitForMtkn removido (bloco antigo) */
/* WAITFOR OVERRIDE V2 */
function waitForMtkn(ws, mtkn, timeoutMs = 15000) {
  const want = String(mtkn);

  const seen = __SEEN_BY_MTK.get(want);
  if (seen) return Promise.resolve(seen);

  const existing = __PENDING_BY_MTK.get(want);
  if (existing) return existing.promise;

  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });

  const to = setTimeout(() => {
    __PENDING_BY_MTK.delete(want);
    reject(new Error("Timeout esperando mtkn=" + want));
  }, timeoutMs);

  __PENDING_BY_MTK.set(want, { promise, resolve, reject, to });
  return promise;
}
