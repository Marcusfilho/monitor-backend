const fs = require("fs");
const WebSocket = require("ws");

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function decodeMaybe(s){
  if (typeof s === "string" && (s.startsWith("%7B") || s.startsWith("%7b"))) {
    try { return decodeURIComponent(s); } catch {}
  }
  return s;
}

function findSessionToken(obj){
  if (!obj || typeof obj !== "object") return null;

  if (typeof obj.session_token === "string" && obj.session_token) return obj.session_token;
  if (obj.action && typeof obj.action.session_token === "string" && obj.action.session_token) return obj.action.session_token;
  if (obj.response && obj.response.properties && typeof obj.response.properties.session_token === "string" && obj.response.properties.session_token) {
    return obj.response.properties.session_token;
  }

  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object") {
      const t = findSessionToken(v);
      if (t) return t;
    }
  }
  return null;
}

function regexToken(text){
  // aceita "session_token":"..." ou 'session_token':'...'
  let m = text.match(/["']session_token["']\s*:\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

function genFlowId(){ return String(200000 + Math.floor(Math.random()*800000)); }
function genMtkn(){
  const now = Date.now().toString();
  let rnd = Math.floor(Math.random()*1e12).toString();
  while (rnd.length < 12) rnd = "0"+rnd;
  return now + rnd;
}

function readPassword(){
  if (process.env.MONITOR_PASSWORD) return process.env.MONITOR_PASSWORD;
  const f = process.env.MONITOR_PASSWORD_FILE;
  if (f && fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  return "";
}

async function attempt({encode, wrapper}) {
  const url = process.env.MONITOR_WS_URL;
  const origin = process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com";
  const cookie = process.env.MONITOR_WS_COOKIE || "";
  const login = process.env.MONITOR_LOGIN_NAME || "Marcus_Prod";
  const pass = readPassword();
  const lang = process.env.MONITOR_LANGUAGE || "en";

  if (!url) throw new Error("Faltou MONITOR_WS_URL");
  if (!pass) throw new Error("Faltou MONITOR_PASSWORD ou MONITOR_PASSWORD_FILE");

  // IMPORTANTÍSSIMO: sem subprotocol (evita 'invalid subprotocol')
  const ws = new WebSocket(url, {
    headers: cookie ? { Cookie: cookie } : {},
    origin,
    handshakeTimeout: 15000,
    perMessageDeflate: false,
  });

  const lastMsgs = [];
  let found = null;

  ws.on("message", (data) => {
    const text = decodeMaybe(String(data));
    lastMsgs.push(text.slice(0, 400));
    if (lastMsgs.length > 8) lastMsgs.shift();

    // tenta regex primeiro
    const rt = regexToken(text);
    if (rt) found = rt;

    // tenta parse e busca profunda
    try {
      const obj = JSON.parse(text);
      const t = findSessionToken(obj);
      if (t) found = t;
    } catch {}
  });

  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });

  const mtkn = genMtkn();

  let payload;
  if (wrapper) {
    payload = {
      action: {
        flow_id: genFlowId(),
        name: "user_login",
        parameters: {
          tag: "loading_screen",
          login_name: String(login),
          password: String(pass),
          language: String(lang),
          _action_name: "user_login",
          mtkn: String(mtkn),
        },
        session_token: "",
        mtkn: String(mtkn),
      }
    };
  } else {
    payload = {
      tag: "loading_screen",
      login_name: String(login),
      password: String(pass),
      language: String(lang),
      _action_name: "user_login",
      mtkn: String(mtkn),
    };
  }

  const raw = JSON.stringify(payload);
  ws.send(encode ? encodeURIComponent(raw) : raw);

  for (let i=0; i<60; i++){
    if (found) break;
    await sleep(200);
  }

  try { ws.close(1000, "done"); } catch {}
  await sleep(150);

  return { found, lastMsgs };
}

(async () => {
  const outPath = process.env.SESSION_TOKEN_PATH || "/home/questar/monitor-backend/.session_token";

  const modes = [
    { encode:false, wrapper:false, label:"flat raw" },
    { encode:true,  wrapper:false, label:"flat encoded" },
    { encode:false, wrapper:true,  label:"wrapper raw" },
    { encode:true,  wrapper:true,  label:"wrapper encoded" },
  ];

  for (const m of modes) {
    try {
      const { found, lastMsgs } = await attempt(m);
      if (found) {
        fs.writeFileSync(outPath, found, "utf8");
        try { fs.chmodSync(outPath, 0o600); } catch {}
        console.log(`[token] OK (${m.label}) gravado em ${outPath} sufixo ${found.slice(-6)}`);
        process.exit(0);
      }

      console.log(`[token] modo ${m.label} não retornou session_token. Últimas msgs (amostra):`);
      for (const t of lastMsgs) console.log("  -", t.replace(/password[^,}]+/gi, "password:<redacted>"));
    } catch (e) {
      console.log(`[token] erro no modo ${m.label}:`, e.message || e);
    }
  }

  console.error("[token] NÃO consegui obter session_token. Próximo passo: precisamos ver o frame/retorno do user_login no browser (sniffer).");
  process.exit(2);
})();
