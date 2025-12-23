/**
 * Sniffer de token via Remote Agent (CDP compat) do Firefox/Chrome.
 * - Conecta no endpoint http://127.0.0.1:<port>/json/list
 * - Abre WebSocket Debugger de cada aba
 * - Escuta Network.webSocketCreated / webSocketWillSendHandshakeRequest
 * - Extrai token da URL .../<GUID>/<TOKEN>/json...
 * - Grava em .session_token (atomic write, chmod 600)
 *
 * Log NÃO imprime token, só len + hash curto.
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");
const WebSocket = require("ws");

const GUID = process.env.MONITOR_WS_GUID || "7E65FBE2-993A-489E-A445-13E9E5CBFF02";
const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9222";
const OUT = process.env.SESSION_TOKEN_OUT || (process.cwd() + "/.session_token");

const MATCH_HOST = process.env.MATCH_HOST || "websocket.traffilog.com:8182";

function sha8(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 8);
}

function extractToken(wsUrl) {
  wsUrl = String(wsUrl || "");
  const mark = `/${GUID}/`;
  const i = wsUrl.indexOf(mark);
  if (i < 0) return null;
  const rest = wsUrl.slice(i + mark.length);
  const j = rest.indexOf("/json");
  if (j < 0) return null;
  const tok = rest.slice(0, j);
  if (!tok || tok.length < 20 || tok.length > 200) return null;
  if (/\s/.test(tok)) return null;
  return tok;
}

function atomicWrite(path, content) {
  const tmp = path + ".tmp";
  fs.writeFileSync(tmp, content.trim() + "\n");
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, path);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0,200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
  });
}

let lastSaved = "";
function saveToken(tok, reason) {
  if (tok === lastSaved) return;
  lastSaved = tok;
  atomicWrite(OUT, tok);
  console.log(`[sniffer] token atualizado (${reason}) len=${tok.length} sha1_8=${sha8(tok)} out=${OUT}`);
}

async function listTargets() {
  // /json/list é padrão do endpoint estilo DevTools (CDP compat)
  return await getJson(`${CDP_HTTP}/json/list`);
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function cdpSend(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }));
}

function runOnTarget(target) {
  // Firefox Remote Agent costuma expor webSocketDebuggerUrl (CDP compat).
  const wsUrl = target.webSocketDebuggerUrl;
  if (!wsUrl) return null;

  const tag = `${target.title || target.url || "target"}`.slice(0, 60);

  return (async () => {
    const ws = await cdpConnect(wsUrl);
    let msgId = 1;

    ws.on("message", (buf) => {
      let m;
      try { m = JSON.parse(String(buf)); } catch { return; }
      const method = m.method || "";
      const params = m.params || {};

      // eventos mais úteis pra WS:
      if (method === "Network.webSocketCreated" && params.url) {
        if (String(params.url).includes(MATCH_HOST)) {
          const tok = extractToken(params.url);
          if (tok) saveToken(tok, "Network.webSocketCreated");
        }
      }
      if (method === "Network.webSocketWillSendHandshakeRequest" && params.request?.url) {
        const u = params.request.url;
        if (String(u).includes(MATCH_HOST)) {
          const tok = extractToken(u);
          if (tok) saveToken(tok, "Network.webSocketWillSendHandshakeRequest");
        }
      }
    });

    // habilitar Network
    cdpSend(ws, msgId++, "Network.enable", {});
    // às vezes ajuda habilitar Page
    cdpSend(ws, msgId++, "Page.enable", {});
    console.log(`[sniffer] anexado: ${tag}`);
    return ws;
  })().catch((e) => {
    console.log(`[sniffer] falha ao anexar ${tag}: ${e.message}`);
    return null;
  });
}

async function main() {
  console.log(`[sniffer] CDP_HTTP=${CDP_HTTP} GUID=${GUID} MATCH_HOST=${MATCH_HOST}`);
  console.log(`[sniffer] aguardando targets... (abra o Monitor nesse Firefox com remote-debugging)`);

  const attached = new Map();

  for (;;) {
    let targets = [];
    try {
      targets = await listTargets();
    } catch (e) {
      console.log(`[sniffer] ainda não pronto: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    for (const t of targets) {
      if (!t || !t.id) continue;
      if (attached.has(t.id)) continue;

      // só páginas (evita extensões / service workers quando aparecerem)
      if (t.type && t.type !== "page") continue;

      const ws = await runOnTarget(t);
      if (ws) attached.set(t.id, ws);
    }

    await new Promise(r => setTimeout(r, 1200));
  }
}

main().catch((e) => {
  console.error("[sniffer] erro fatal:", e);
  process.exit(1);
});
