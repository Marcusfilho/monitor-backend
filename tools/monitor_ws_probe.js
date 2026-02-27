"use strict";

const crypto = require("crypto");
const wsMod = require("ws");
const WebSocketCtor = wsMod?.default || wsMod;

const VEHICLE_ID = process.argv[2] || process.env.VEHICLE_ID || "1940478";
const ORIGIN = String(process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com");

const WS_LOGIN_NAME = process.env.WS_LOGIN_NAME;
const WS_PASSWORD   = process.env.WS_PASSWORD;
const API_BASE      = String(process.env.TRAFFILOG_LOGIN_URL || process.env.TRAFFILOG_API_BASE_URL || "").replace(/\/+$/g, "");

function makeGuidLike(){
  const b = crypto.randomBytes(16).toString("hex").toUpperCase();
  return `${b.slice(0,8)}-${b.slice(8,12)}-${b.slice(12,16)}-${b.slice(16,20)}-${b.slice(20,32)}`;
}

function makeMtknSafe(){
  // <= 2^48-1
  return String(crypto.randomBytes(6).readUIntBE(0,6));
}

function mask(s){
  return String(s || "")
    .replace(/[A-Za-z0-9_=-]{20,}/g, m => m.slice(0,4)+"…"+m.slice(-4))
    .slice(0, 260);
}

async function login(){
  if(!WS_LOGIN_NAME || !WS_PASSWORD) throw new Error("Faltam envs WS_LOGIN_NAME/WS_PASSWORD");
  if(!API_BASE) throw new Error("Falta env TRAFFILOG_API_BASE_URL (…/1/json) ou TRAFFILOG_LOGIN_URL");

  const payload = { action:{ name:"user_login", parameters:{ login_name:WS_LOGIN_NAME, password:WS_PASSWORD } } };
  const r = await fetch(API_BASE, {
    method:"POST",
    headers:{ "content-type":"application/json", "accept":"application/json" },
    body: JSON.stringify(payload),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  const tok = j?.response?.properties?.session_token || j?.response?.properties?.token || j?.session_token || null;
  if(!tok) throw new Error("Não achei session_token no user_login. Resp: "+mask(t));
  return String(tok);
}

function buildFrames(sessionToken, actionName){
  const mtkn = makeMtknSafe();
  const wrapped = {
    action: {
      flow_id: makeMtknSafe(),
      name: actionName,
      parameters: { tag:"loading_screen", vehicle_id:String(VEHICLE_ID), _action_name: actionName, mtkn },
      session_token: sessionToken,
      mtkn
    }
  };
  const flat = {
    action_name: actionName,
    parameters: { tag:"loading_screen", vehicle_id:String(VEHICLE_ID), mtkn },
    session_token: sessionToken,
    mtkn
  };
  const w = JSON.stringify(wrapped);
  const f = JSON.stringify(flat);

  return [
    { label:"wrapped+encoded", payload: encodeURIComponent(w) },
    { label:"wrapped+raw",     payload: w },
    { label:"flat+encoded",    payload: encodeURIComponent(f) },
    { label:"flat+raw",        payload: f },
  ];
}

(async () => {
  const sessionToken = await login();
  const guid = makeGuidLike();
  const url = `wss://websocket.traffilog.com:8182/${guid}/${sessionToken}/json?defragment=1`;

  console.log("[probe] vehicle_id=", VEHICLE_ID);
  console.log("[probe] origin=", ORIGIN);
  console.log("[probe] ws_url=", mask(url));

  const ws = new WebSocketCtor(url, { headers: { Origin: ORIGIN } });

  let rxAny = 0;
  ws.on("open", async () => {
    console.log("[probe] OPEN");

    const action = "get_vehicle_info";
    const frames = buildFrames(sessionToken, action);

    for (const fr of frames){
      console.log("[probe] SEND", fr.label, "len=", fr.payload.length);
      ws.send(fr.payload);
      await new Promise(r => setTimeout(r, 1200));
    }

    // espera um pouco e fecha
    setTimeout(() => {
      console.log("[probe] done, rxAny=", rxAny, "closing...");
      try{ ws.close(); } catch(_){}
    }, 12000);
  });

  ws.on("message", (data) => {
    rxAny++;
    const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
    console.log("[probe] RX#", rxAny, "len=", raw.length, "prefix=", mask(raw));
  });

  ws.on("close", (code, reason) => {
    console.log("[probe] CLOSE code=", code, "reason=", mask(reason));
    process.exit(0);
  });

  ws.on("error", (e) => {
    console.log("[probe] ERROR", e?.message || String(e));
  });

})();
