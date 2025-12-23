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

  // no user_login, NÃO manda session_token
  const token = (actionName === "user_login") ? "" : (payload.session_token || sessionToken || "");

  const frame = {
    action: {
      name: actionName,
      parameters: { ...params, _action_name: actionName, mtkn },
    },
    mtkn,
  };
  if (token) frame.session_token = token;

  return encodeURIComponent(JSON.stringify(frame));
}

function decode(encoded) {
  return JSON.parse(decodeURIComponent(encoded));
}

function mask(obj) {
  const j = JSON.parse(JSON.stringify(obj));
  const p = j?.action?.parameters;
  if (p?.password) p.password = "***";
  if (j?.session_token) j.session_token = "***";
  return j;
}

(async () => {
  const url = process.env.MONITOR_WS_URL;
  const cookie = process.env.MONITOR_WS_COOKIE || "";
  const origin = process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com";

  const login = process.env.WS_LOGIN_NAME || "";
  const pass = process.env.WS_PASSWORD || "";

  console.log("[dump2] url_len=", url ? url.length : 0, "hasCookie=", !!cookie, "origin=", origin);
  console.log("[dump2] login_len=", login.length, "pass_len=", pass.length);

  if (!url) process.exit(2);
  if (!login || !pass) {
    console.error("[dump2] ERRO: WS_LOGIN_NAME/WS_PASSWORD vazios.");
    process.exit(3);
  }

  const ws = new WebSocket(url, {
    headers: cookie ? { Cookie: cookie } : {},
    origin,
    handshakeTimeout: 15000,
    perMessageDeflate: false,
  });

  let sessionToken = process.env.MONITOR_SESSION_TOKEN || "";

  ws.on("open", () => {
    console.log("[dump2] WS open.");

    const loginPayload = {
      tag: process.env.WS_TAG || "loading_screen",
      _action_name: "user_login",
      login_name: process.env.WS_LOGIN_NAME,
      password: process.env.WS_PASSWORD,
      language: process.env.WS_LANGUAGE || "en",
    };

    const encLogin = encodeFrame(loginPayload, sessionToken);
    console.log("[dump2] LOGIN frame(decoded, masked)=\n", JSON.stringify(mask(decode(encLogin)), null, 2));
    ws.send(encLogin);

    setTimeout(() => {
      const assignPayload = {
        tag: process.env.WS_TAG || "loading_screen",
        _action_name: "assign_setting_to_vehicle",
        client_id: Number(process.env.ASSIGN_CLIENT_ID || 0),
        client_name: process.env.ASSIGN_CLIENT_NAME || "",
        vehicle_id: Number(process.env.ASSIGN_VEHICLE_ID || 0),
        vehicle_setting_id: Number(process.env.ASSIGN_VEHICLE_SETTING_ID || 0),
        comment: process.env.ASSIGN_COMMENT || "probe assign",
      };

      const encAssign = encodeFrame(assignPayload, sessionToken);
      console.log("[dump2] ASSIGN frame(decoded, masked)=\n", JSON.stringify(mask(decode(encAssign)), null, 2));
      ws.send(encAssign);

      setTimeout(() => ws.close(1000), 1500);
    }, 800);
  });

  ws.on("message", (buf) => {
    const raw = buf.toString("utf-8");
    let msg;
    try { msg = JSON.parse(raw); } catch { msg = null; }

    if (msg && typeof msg === "object") {
      if (msg.session_token && typeof msg.session_token === "string") sessionToken = msg.session_token;
      console.log("[dump2] RECV json:", raw);
    } else {
      console.log("[dump2] RECV raw:", raw.slice(0, 200));
    }
  });

  ws.on("close", (c) => console.log("[dump2] WS close", c));
  ws.on("error", (e) => console.log("[dump2] WS error", e?.message || String(e)));
})();
