const fs = require("fs");
const WebSocket = require("ws");

const TRAFFILOG_API = process.env.TRAFFILOG_API_BASE_URL || process.env.MONITOR_API_BASE_URL || "";
const LOGIN_NAME = process.env.WS_LOGIN_NAME || process.env.MONITOR_LOGIN_NAME || "";
const PASSWORD   = process.env.WS_PASSWORD   || process.env.MONITOR_PASSWORD   || "";

if (!LOGIN_NAME || !PASSWORD) { console.error("faltam envs WS_LOGIN_NAME / WS_PASSWORD"); process.exit(1); }

async function freshLogin() {
  // pegar API base do env ou do arquivo de env do worker
  const envFile = fs.existsSync("/home/questar/monitor-backend-rewrite/worker_secrets_rw.env")
    ? fs.readFileSync("/home/questar/monitor-backend-rewrite/worker_secrets_rw.env","utf8")
    : "";
  const apiBase = (TRAFFILOG_API || envFile.match(/TRAFFILOG_API_BASE_URL=(.+)/)?.[1] || "").trim().replace(/\/+$/,"");
  console.log("apiBase:", apiBase);
  const res = await fetch(apiBase, { method:"POST", headers:{"content-type":"application/json"},
    body: JSON.stringify({ action:{ name:"user_login", parameters:{ login_name: LOGIN_NAME, password: PASSWORD }}})
  });
  const d = await res.json();
  return d?.response?.properties?.session_token || d?.response?.properties?.data?.[0]?.session_token;
}

(async () => {
  const tok = await freshLogin();
  if (!tok) { console.error("login falhou"); process.exit(1); }
  console.log("token ok:", tok.slice(0,20)+"...");

  const guid = Math.random().toString(36).slice(2,8);
  const url = `wss://websocket.traffilog.com:8182/${guid}/${tok}/json?defragment=1`;
  function makeMtkn(){ return Date.now() + String(Math.floor(Math.random()*1e12)).padStart(12,"0"); }
  function makeFlowId(){ return String(200000 + Math.floor(Math.random()*800000)); }

  const ws = new WebSocket(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache", "Pragma": "no-cache" },
    origin: "https://operation.traffilog.com",
    perMessageDeflate: { clientMaxWindowBits: 15 },
  });

  ws.on("message", (data) => {
    let txt = String(data);
    if (txt.startsWith("%7B")||txt.startsWith("%7b")) try{txt=decodeURIComponent(txt)}catch{}
    console.log("MSG:", txt.slice(0,400));
  });

  ws.on("open", () => {
    console.log("WS open");
    const mtkn = makeMtkn();
    const frame = { action: { flow_id: makeFlowId(), name: "get_vehicle_info",
      parameters: { tag:"loading_screen", vehicle_id:"1940478", _action_name:"get_vehicle_info", mtkn, session_token:tok },
      session_token: tok, mtkn }};
    ws.send(encodeURIComponent(JSON.stringify(frame)));
    setTimeout(() => { ws.close(); process.exit(0); }, 15000);
  });
  ws.on("error", e => console.error("WS error:", e.message));
  ws.on("close", (c,r) => console.log("closed:", c, String(r)));
})();
