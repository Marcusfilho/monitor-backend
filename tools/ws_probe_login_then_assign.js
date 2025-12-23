/**
 * WS PROBE: abre WS, (opcional) envia user_login, depois envia assign_setting_to_vehicle.
 * NÃO cole senha no chat. Use variáveis de ambiente.
 *
 * Requisitos:
 *  - MONITOR_WS_URL (wss://...)
 *  - MONITOR_WS_COOKIE (opcional)
 *  - MONITOR_WS_ORIGIN (opcional; default https://operation.traffilog.com)
 *
 * Para login:
 *  - WS_LOGIN_NAME
 *  - WS_PASSWORD
 *  - WS_LANGUAGE (default "en")
 *  - WS_TAG (default "loading_screen")
 *
 * Para assign:
 *  - ASSIGN_CLIENT_ID, ASSIGN_CLIENT_NAME (opcional), ASSIGN_VEHICLE_ID, ASSIGN_VEHICLE_SETTING_ID, ASSIGN_COMMENT
 */

const WebSocket = require("ws");

function safeStr(x, n=140) {
  const s = typeof x === "string" ? x : Buffer.isBuffer(x) ? x.toString("utf8") : String(x);
  return s.length > n ? s.slice(0, n) + "..." : s;
}

function encodeFirefoxFrameFromPayload(payload, sessionToken) {
  // formato “Firefox/Monitor” (o que você viu como %7B%22action%22...)
  const mtkn = String(Math.floor(Math.random() * 1e18)).padStart(18, "0") + String(Date.now());

  const actionName = payload._action_name || payload.action_name || payload.actionName || "";
  const token = (actionName === "user_login") ? "" : (payload.session_token || sessionToken || "");
const reserved = new Set([
    "tag",
    "_action_name", "action_name", "actionName",
    "parameters", "action_parameters",
    "session_token", "sessionToken", "mtkn"
  ]);

  // ✅ Se não vier parameters, usa o topo do payload como params (ex.: login_name/password/language)
  let params = payload.parameters || payload.action_parameters;
  if (!params || typeof params !== "object") {
    params = {};
    if (payload && typeof payload === "object") {
      for (const [k, v] of Object.entries(payload)) {
        if (!reserved.has(k)) params[k] = v;
      }
    }
  }

  // inclui tag dentro de parameters (como o Monitor costuma fazer)
  if (payload.tag) params = { tag: payload.tag, ...params };

  const frame = {
    action: {
      action: {
        name: actionName,
        parameters: { ...params, _action_name: actionName, mtkn },
      },
      session_token: token,
      mtkn,
    },
  };

  return encodeURIComponent(JSON.stringify(frame));
}

function tryParseAny(msg) {
  // tenta: encoded JSON -> JSON puro -> retorna string
  try {
    const s = Buffer.isBuffer(msg) ? msg.toString("utf8") : String(msg);
    if (s.startsWith("%7B")) {
      const dec = decodeURIComponent(s);
      return { kind: "encoded", raw: s, obj: JSON.parse(dec) };
    }
    if (s.trim().startsWith("{")) {
      return { kind: "json", raw: s, obj: JSON.parse(s) };
    }
    return { kind: "text", raw: s, obj: null };
  } catch (e) {
    return { kind: "unknown", raw: Buffer.isBuffer(msg)?msg.toString("utf8"):String(msg), obj: null, err: String(e) };
  }
}

async function main() {
  const url = process.env.MONITOR_WS_URL;
  if (!url) {
    console.log("ERRO: MONITOR_WS_URL não definido.");
    return;
  }

  const cookie = process.env.MONITOR_WS_COOKIE || "";
  const origin = process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com";
  const protocol = (process.env.MONITOR_WS_PROTOCOL || "").trim();

  
const wsOpts = {
  headers: cookie ? { Cookie: cookie } : {},
  origin,
  handshakeTimeout: 15000,
  perMessageDeflate: false,
};

console.log("[probe] url_len=", String(url).length, " protocol=<" + protocol + ">", " hasCookie=", !!cookie);

const ws = protocol
  ? new WebSocket(url, protocol, wsOpts)
  : new WebSocket(url, wsOpts);
let sessionToken = process.env.MONITOR_SESSION_TOKEN || "";

  const loginName = process.env.WS_LOGIN_NAME || "";
  const password  = process.env.WS_PASSWORD || "";
  const language  = process.env.WS_LANGUAGE || "en";
  const tag       = process.env.WS_TAG || "loading_screen";

  const assign = {
    client_id: Number(process.env.ASSIGN_CLIENT_ID || "0"),
    client_name: process.env.ASSIGN_CLIENT_NAME || undefined,
    vehicle_id: Number(process.env.ASSIGN_VEHICLE_ID || "0"),
    vehicle_setting_id: Number(process.env.ASSIGN_VEHICLE_SETTING_ID || "0"),
    comment: process.env.ASSIGN_COMMENT || "probe assign",
  };

  function sendPayload(payload, tokenForSend) {
    const wire = encodeFirefoxFrameFromPayload(payload, tokenForSend);
    console.log("[PROBE] SEND encodedPrefix=", wire.slice(0, 60));
    ws.send(wire);
  }

  let stage = "wait_open";

  ws.on("open", () => {
    console.log("[PROBE] WS open. origin=", origin, " protocol=", protocol, " hasCookie=", !!cookie);
    stage = "opened";

    if (loginName && password) {
      console.log("[PROBE] enviando user_login...");
      sendPayload(
        { tag, _action_name: "user_login", login_name: loginName, password, language },
        sessionToken
      );
      stage = "sent_login";
      return;
    }

    console.log("[PROBE] pulando login (sem WS_LOGIN_NAME/WS_PASSWORD). enviando assign direto...");
    sendPayload(
      { tag, _action_name: "assign_setting_to_vehicle", parameters: assign },
      sessionToken
    );
    stage = "sent_assign";
  });

  ws.on("message", (msg) => {
    const parsed = tryParseAny(msg);
    console.log("[PROBE] RECV kind=", parsed.kind, " rawPrefix=", safeStr(parsed.raw, 120));

    if (parsed.obj) {
      // tenta achar action_value / session_token em qualquer lugar
      const j = parsed.obj;

      const foundToken =
        j?.action?.session_token ||
        j?.session_token ||
        j?.sessionToken ||
        j?.payload?.session_token;

      if (foundToken && foundToken !== sessionToken) {
        sessionToken = foundToken;
        console.log("[PROBE] sessionToken atualizado (tamanho=", String(sessionToken).length, ")");
      }

      const actionValue =
        j?.payload?.action_value ??
        j?.action_value ??
        j?.action?.payload?.action_value;

      const errDesc =
        j?.payload?.error_description ??
        j?.error_description ??
        j?.action?.payload?.error_description;

      if (actionValue !== undefined) {
        console.log("[PROBE] action_value=", actionValue, " error_description=", errDesc || "");
      }
    }

    // Se acabou de logar, manda assign usando o token atualizado
    if (stage === "sent_login") {
      console.log("[PROBE] agora enviando assign_setting_to_vehicle...");
      sendPayload(
        { tag, _action_name: "assign_setting_to_vehicle", parameters: assign },
        sessionToken
      );
      stage = "sent_assign_after_login";
      return;
    }

    // encerra depois de receber resposta do assign
    if (stage === "sent_assign" || stage === "sent_assign_after_login") {
      console.log("[PROBE] encerrando probe.");
      ws.close(1000, "done");
    }
  });

  ws.on("close", (c, r) => console.log("[PROBE] WS close", c, r?.toString?.() || ""));
  ws.on("error", (e) => console.log("[PROBE] WS error", String(e)));
}

main().catch((e) => console.log("[PROBE] fatal", String(e)));
