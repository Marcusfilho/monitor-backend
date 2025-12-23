import WebSocket from "ws";
import { getSessionToken, refreshSessionTokenFromDisk } from "../services/sessionTokenStore";
import { buildEncodedWsFrameFromPayload } from "./wsFrame";


function buildEncodedWsFrame(actionName: string, params: any, sessionToken: string): string {
  // payload "flat" mínimo (wrapMonitorFrame já cria { action: {...} })
  const payload = { tag: "loading_screen", parameters: params ?? {} };

  // NÃO embrulhar novamente em { action: ... }
  let frame: any = wrapMonitorFrame(actionName, payload, sessionToken);

  // SAFETY: se em algum lugar alguém criou { action: { action: {...} } }, achata aqui
  if (frame?.action?.action?.name) {
    frame.action = frame.action.action;
  }

  return encodeURIComponent(JSON.stringify(frame));
}



function patchWsPrototypeSendForMonitorV3() {
  const proto: any = (WebSocket as any)?.prototype;
  if (!proto) return;
  if (proto.__patched_monitor_encode_v3) return;
  proto.__patched_monitor_encode_v3 = true;

  console.log("[WS] proto-send wrapper INSTALLED (v3)");

  const orig = proto.send;

  function toUtf8String(data: any): { raw: string | null; kind: string } {
    const B: any = (globalThis as any).Buffer;
    try {
      if (typeof data === "string") return { raw: data, kind: "string" };
      if (B && B.isBuffer && B.isBuffer(data)) return { raw: data.toString("utf8"), kind: "buffer" };
      if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer)
        return { raw: (B ? B.from(data).toString("utf8") : null), kind: "arraybuffer" };
      if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView?.(data)) {
        const view: any = data;
        const buf = B ? B.from(view.buffer, view.byteOffset ?? 0, view.byteLength ?? view.length ?? undefined) : null;
        return { raw: buf ? buf.toString("utf8") : null, kind: "typedarray" };
      }
      if (data && typeof data === "object") {
        // caso extremo: alguém chama send(obj)
        try { return { raw: JSON.stringify(data), kind: "object-json" }; } catch {}
      }
    } catch {}
    return { raw: null, kind: typeof data };
  }

  proto.send = function (data: any, ...args: any[]) {
    try {
      const { raw, kind } = toUtf8String(data);

      if (raw) {
        const t = raw.trimStart();
        const isEnc = t.startsWith("%7B%22action%22");

        // Log mínimo do que está indo pro send (sem vazar token)
        if (t.includes("_action_name") || t.includes("action_name") || t.includes("assign_setting_to_vehicle") || isEnc) {
          console.log(`[WS] WIRE kind=${kind} enc=${isEnc} prefix=${t.slice(0, 60)}`);
        }

        // 1) Se já vier encoded, tenta validar shape; se estiver errado, re-encoda
        if (isEnc) {
          try {
            const obj = JSON.parse(decodeURIComponent(t));
            const hasMonitorShape = !!(obj?.action?.action?.name);
            if (hasMonitorShape) {
              // já no shape certo: deixa passar como está (não re-encoda)
              return orig.call(this, t, ...args);
            } else {
              // encoded mas shape estranho -> tenta tratar como payload
              const storeToken = (typeof getSessionToken === "function") ? getSessionToken() : "";
              const wire = buildEncodedWsFrameFromPayload(obj, storeToken || obj?.session_token || "");
              console.log(`[WS] SEND encodedPrefix=${wire.slice(0, 60)}`);
              return orig.call(this, wire, ...args);
            }
          } catch {
            // se não deu pra parsear, manda como estava
            return orig.call(this, data, ...args);
          }
        }

        // 2) Se vier JSON puro, converte para o frame Firefox
        if (t.startsWith("{")) {
          const obj = JSON.parse(t);

          // Caso já seja o frame do monitor em JSON (não encoded):
          if (obj?.action?.action?.name) {
            const actionName = obj.action.action.name;
            const params = obj.action.action.parameters || {};
            const storeToken = (typeof getSessionToken === "function") ? getSessionToken() : "";
            const token = obj.action.session_token || storeToken || "";
            const wire = buildEncodedWsFrame(actionName, (params || {}), token);
            console.log(`[WS] SEND encodedPrefix=${wire.slice(0, 60)}`);
            return orig.call(this, wire, ...args);
          }

          // Caso payload “flat” (_action_name, parameters, session_token...)
          const storeToken = (typeof getSessionToken === "function") ? getSessionToken() : "";
          const token = storeToken || obj.session_token || "";
          const wire = buildEncodedWsFrameFromPayload(obj, token);
          console.log(`[WS] SEND encodedPrefix=${wire.slice(0, 60)}`);
          return orig.call(this, wire, ...args);
        }
      }
    } catch (e: any) {
      console.log(`[WS] sendWrapErr=${String(e).slice(0, 120)}`);
    }

    return orig.call(this, data, ...args);
  };
}
patchWsPrototypeSendForMonitorV3();



function patchWsSendToFirefox(ws: any) {
  try {
    if (ws && ws.__patched_firefox_send) return;
    if (ws) ws.__patched_firefox_send = true;
  } catch {}

  const orig = ws.send.bind(ws);

  ws.send = (data: any, ...args: any[]) => {
    try {
      // Já URL-encoded? deixa passar
      if (typeof data === "string" && data.startsWith("%7B%22action%22")) {
        return orig(data, ...args);
      }

      // Se for JSON string, converte para frame Firefox
      if (typeof data === "string" && data.trim().startsWith("{")) {
        const obj = JSON.parse(data);

        // token atual do store (já existe no seu wsClient.ts)
        const token = getSessionToken();

        const wire = buildEncodedWsFrameFromPayload(obj, token);

        console.log(`[WS] SEND encodedPrefix=${wire.slice(0, 60)}`);
        return orig(wire, ...args);
      }
    } catch {
      // fallback silencioso
    }

    return orig(data, ...args);
  };
}



// === PATCH: compat Monitor (frame action + flow_id + mtkn) ===
function genFlowId(): string {
  return String(200000 + Math.floor(Math.random() * 800000));
}
function genMtkn(): string {
  const now = Date.now().toString();
  let rnd = Math.floor(Math.random() * 1e12).toString();
  while (rnd.length < 12) rnd = "0" + rnd;
  return now + rnd;
}

/**
 * Monitor (Scheme Builder) usa frame: { action: { flow_id, name, parameters, session_token, mtkn } }
 * Este wrapper converte payloads "flat" (tag/_action_name/parameters/mtkn/session_token) para o frame esperado.
 */
function wrapMonitorFrame(actionName: string, payload: any, sessionToken: string) {
  if (payload && payload.action && payload.action.name) return payload;

  const mtkn = String(payload?.mtkn || genMtkn());
  const sess = String(payload?.session_token || sessionToken);

  // pega parâmetros do lugar mais comum
  const baseParams = (payload && payload.parameters) ? payload.parameters : (payload || {});
  const params = { ...baseParams, _action_name: actionName, mtkn };

  return {
    action: {
      flow_id: genFlowId(),
      name: actionName,
      parameters: params,
      session_token: sess,
      mtkn
    }
  };
}
// === /PATCH ===


export interface OpenWsResult {
  socket: WebSocket;
  ws: WebSocket;
  sessionToken: string;
}

let cached: OpenWsResult | null = null;
let connecting: Promise<OpenWsResult> | null = null;
let seq = 0;

const WS_DEBUG = (process.env.WS_DEBUG || "").trim() === "1";

function pickToken(): string {
  const envToken = (process.env.MONITOR_SESSION_TOKEN || "").trim();
  if (envToken) return envToken;
  return (getSessionToken() || "").trim();
}

function tryJson(x: any) {
  try {
    const s = Buffer.isBuffer(x) ? x.toString("utf8") : (typeof x === "string" ? x : null);
    if (!s) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function mask(obj: any) {
  const S = new Set(["password", "mtkn", "session_token", "token", "cookie"]);
  const walk = (v: any): any => {
    if (v && typeof v === "object") {
      if (Array.isArray(v)) return v.map(walk);
      const out: any = {};
      for (const [k, val] of Object.entries(v)) out[k] = S.has(k) ? "***" : walk(val);
      return out;
    }
    return v;
  };
  return walk(obj);
}

/**
 * Converte { action:{ name, parameters, mtkn, session_token } }
 * para formato aceito pelo Monitor.
 *
 * Para assign_setting_to_vehicle: envia SOMENTE os campos mínimos (sem duplicatas, sem client_name, sem mtkn).
 */
function normalizeOutgoing(data: any) {
  const obj = tryJson(data);
  if (!obj || typeof obj !== "object") return { out: data, parsed: null, note: "" };

  const a = (obj as any).action;
  if (!a || typeof a !== "object") return { out: data, parsed: obj, note: "" };

  const params0 = a.parameters && typeof a.parameters === "object" ? { ...a.parameters } : {};

  const actionName =
    a._action_name ||
    a.name ||
    a.action_name ||
    (obj as any)._action_name ||
    (obj as any).action_name ||
    (params0 as any)._action_name ||
    (params0 as any).action_name;

  const session_token =
    a.session_token || (obj as any).session_token || (params0 as any).session_token;

  const tag = (obj as any).tag || a.tag || (params0 as any).tag || "loading_screen";

  // limpa tokens/ruído dentro dos params
  delete (params0 as any).mtkn;
  delete (params0 as any).session_token;
  delete (params0 as any)._action_name;
  delete (params0 as any).action_name;
  delete (params0 as any).tag;

  let outObj: any;

  if (actionName === "user_login") {
    outObj = { ...params0, tag, _action_name: "user_login" };
    // mtkn no login às vezes é usado, mas se vier dentro do wrapper, fica em params0
  } else if (actionName === "assign_setting_to_vehicle") {
    // PAYLOAD MÍNIMO (sem extras)
    const client_id = params0.client_id ?? params0.clientId;
    const vehicle_id = params0.vehicle_id ?? params0.vehicleId;
    const vehicle_setting_id = params0.vehicle_setting_id ?? params0.vehicleSettingId;
    const comment = params0.comment != null ? String(params0.comment) : "";

    outObj = {
      tag,
      _action_name: "assign_setting_to_vehicle",
      parameters: { client_id, vehicle_id, vehicle_setting_id, comment },
    };

    // para essa ação: NÃO manda mtkn (pode estar causando 400)
    if (session_token) outObj.session_token = session_token;
  } else {
    // default: mantém wrapper em parameters (genérico)
    const mtkn = a.mtkn || (obj as any).mtkn;
    outObj = { tag, _action_name: actionName, parameters: params0 };
    if (mtkn) outObj.mtkn = mtkn;
    if (session_token) outObj.session_token = session_token;
  }

  return { out: JSON.stringify(outObj), parsed: outObj, note: "normalized(minimal)" };
}

async function doConnect(): Promise<OpenWsResult> {
  const url = (process.env.MONITOR_WS_URL || "").trim();
  if (!url) throw new Error("MONITOR_WS_URL não definido.");

  const cookie = (process.env.MONITOR_WS_COOKIE || "").trim();
  const origin = (process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com").trim();

  if (!(process.env.MONITOR_SESSION_TOKEN || "").trim()) {
    refreshSessionTokenFromDisk();
  }

  const sessionToken = pickToken();
  const id = ++seq;

  const headers = cookie ? { Cookie: cookie } : undefined;

  const ws = new WebSocket(url, {
    headers,
    origin,
    handshakeTimeout: 15000,
    perMessageDeflate: false,
  });
  patchWsSendToFirefox(ws);

  const origSend = ws.send.bind(ws);
  (ws as any).send = (data: any, cb?: any) => {
    const norm = normalizeOutgoing(data);
    if (WS_DEBUG) {
      const p = norm.parsed || tryJson(norm.out);
      console.log(`[WS] (#${id}) SEND ${norm.note} action=${p?._action_name || ""} tag=${p?.tag || ""} payload=`, mask(p ?? {}));
    }
    return origSend(norm.out, cb);
  };

  if (WS_DEBUG) {
    ws.on("message", (buf: any) => {
      const j = tryJson(buf);
      if (j) console.log(`[WS] (#${id}) RECV payload=`, mask(j));
    });
  }

  return await new Promise<OpenWsResult>((resolve, reject) => {
    let opened = false;

    ws.once("open", () => {
      opened = true;
      console.log(`[WS] (#${id}) Conexão aberta.`);
      resolve({ socket: ws, ws, sessionToken });
    });

    ws.once("error", (err: any) => {
      console.log(`[WS] (#${id}) Erro:`, err?.message || String(err));
      if (!opened) reject(err);
    });

    ws.once("close", (code: number, reason: Buffer) => {
      const msg = reason ? reason.toString() : "";
      console.log(`[WS] (#${id}) Conexão fechada. code=${code} reason=${msg}`);
      if (cached?.ws === ws) cached = null;
      if (!opened) reject(new Error(`WS fechou antes do open. code=${code} reason=${msg}`));
    });
  });
}

export async function openMonitorWebSocket(): Promise<OpenWsResult> {
  if (cached && cached.ws.readyState === WebSocket.OPEN) return cached;
  if (connecting) return connecting;

  connecting = (async () => {
    const r = await doConnect();
    cached = r;
    return r;
  })().finally(() => {
    connecting = null;
  });

  return connecting;
}

export async function openWs(): Promise<OpenWsResult> {
  return openMonitorWebSocket();
}
