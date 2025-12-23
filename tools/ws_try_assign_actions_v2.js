const WebSocket = require("ws");

function encodeFrame(payload, sessionToken) {
  const mtkn = String(Math.floor(Math.random() * 1e18)).padStart(18, "0") + String(Date.now());
  const actionName = payload._action_name || payload.action_name || payload.actionName || "";
  const reserved = new Set([
    "tag",
    "_action_name", "action_name", "actionName",
    "parameters", "action_parameters",
    "session_token", "sessionToken", "mtkn"
  ]);

  let params = payload.parameters || payload.action_parameters;
  if (!params || typeof params !== "object") {
    params = {};
    for (const [k, v] of Object.entries(payload || {})) {
      if (!reserved.has(k)) params[k] = v;
    }
  }
  if (payload.tag) params = { tag: payload.tag, ...params };

  const token = (actionName === "user_login") ? "" : (payload.session_token || sessionToken || "");

  const frame = { action: { name: actionName, parameters: { ...params, _action_name: actionName, mtkn } }, mtkn };
  if (token) frame.session_token = token;

  return encodeURIComponent(JSON.stringify(frame));
}

function waitFor(ws, { valueRe, tokenRe, timeoutMs = 2500 }) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => cleanup(() => reject(new Error("timeout"))), timeoutMs);

    function onMsg(buf) {
      const raw = buf.toString("utf-8");
      const mTok = tokenRe ? raw.match(tokenRe) : null;
      const mVal = valueRe ? raw.match(valueRe) : null;

      if (mTok || mVal) cleanup(() => resolve({ raw, token: mTok?.[1] || "", value: mVal?.[1] || "" }));
    }
    function onErr(e) { cleanup(() => reject(e)); }
    function cleanup(fn) {
      clearTimeout(t);
      ws.off("message", onMsg);
      ws.off("error", onErr);
      fn();
    }

    ws.on("message", onMsg);
    ws.on("error", onErr);
  });
}

function maskToken(tok) {
  if (!tok) return "(vazio)";
  return `${tok.slice(0,4)}...${tok.slice(-4)} (len=${tok.length})`;
}

(async () => {
  const url = process.env.MONITOR_WS_URL || "";
  const cookie = process.env.MONITOR_WS_COOKIE || "";
  const origin = process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com";

  const login = process.env.WS_LOGIN_NAME || "";
  const pass = process.env.WS_PASSWORD || "";
  const lang = process.env.WS_LANGUAGE || "en";
  const tag = process.env.WS_TAG || "loading_screen";

  const client_id = Number(process.env.ASSIGN_CLIENT_ID || 0);
  const client_name = process.env.ASSIGN_CLIENT_NAME || "";
  const vehicle_id = Number(process.env.ASSIGN_VEHICLE_ID || 0);
  const vehicle_setting_id = Number(process.env.ASSIGN_VEHICLE_SETTING_ID || 0);
  const comment = process.env.ASSIGN_COMMENT || "probe assign";

  console.log("[try] url_len=", url.length, "hasCookie=", !!cookie, "origin=", origin);
  console.log("[try] login_len=", login.length, "pass_len=", pass.length);
  console.log("[try] ids:", { client_id, vehicle_id, vehicle_setting_id });

  if (!url) process.exit(2);
  if (!login || !pass) process.exit(3);

  const ws = new WebSocket(url, {
    headers: cookie ? { Cookie: cookie } : {},
    origin,
    handshakeTimeout: 15000,
    perMessageDeflate: false,
  });

  let sessionToken = process.env.MONITOR_SESSION_TOKEN || "";

  ws.on("open", async () => {
    try {
      // 1) LOGIN
      const loginPayload = { tag, _action_name: "user_login", login_name: login, password: pass, language: lang };
      ws.send(encodeFrame(loginPayload, sessionToken));

      // espera o session_token aparecer em algum retorno
      const gotTok = await waitFor(ws, {
        tokenRe: /"session_token":"([^"]{10,})"/,
        timeoutMs: 3500
      });
      sessionToken = gotTok.token;
      console.log("[try] login OK -> session_token:", maskToken(sessionToken));

      // 2) Testar ações candidatas de assign
      const candidates = [
        "assign_setting_to_vehicle",
        "assign_setting_to_vehicle_opr",
        "assign_setting_to_vehicle_operator",
        "assign_setting_to_vehicle_operation",
        "associate_vehicles_actions_opr",
        "associate_vehicles_actions",
      ];

      for (const name of candidates) {
        const payload = {
          tag,
          _action_name: name,
          client_id,
          client_name,
          vehicle_id,
          vehicle_setting_id,
          comment,
        };

        ws.send(encodeFrame(payload, sessionToken));

        // pega o primeiro action_value que aparecer após o envio
        let value = "???";
        try {
          const gotVal = await waitFor(ws, { valueRe: /"action_value":"?(\d+)"?/, timeoutMs: 2500 });
          value = gotVal.value || "???";
        } catch {
          value = "timeout";
        }

        console.log(`[try] ${name} -> action_value=${value}`);
      }

      ws.close(1000);
    } catch (e) {
      console.log("[try] erro:", e?.message || String(e));
      ws.close(1000);
    }
  });

  ws.on("close", (c) => console.log("[try] WS close", c));
  ws.on("error", (e) => console.log("[try] WS error", e?.message || String(e)));
})();
