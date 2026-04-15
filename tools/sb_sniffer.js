#!/usr/bin/env node
// sb_sniffer.js — Sniffer WS do Monitor Traffilog
// Uso: node tools/sb_sniffer.js <vehicleId> <clientId>
// Grava tudo em /tmp/sb_sniffer_<vehicleId>_<ts>.txt
// Ctrl+C para encerrar.

const WebSocket = require("ws");
const fs = require("fs");

const vehicleId = process.argv[2] || "1940478";
const clientId  = process.argv[3] || "219007";
const outFile   = `/tmp/sb_sniffer_${vehicleId}_${Date.now()}.txt`;
const MAX_MS    = 30 * 60 * 1000;

function genFlowId() { return String(200000 + Math.floor(Math.random() * 800000)); }
function genMtkn() {
  const now = Date.now().toString();
  let rnd = Math.floor(Math.random() * 1e12).toString();
  while (rnd.length < 12) rnd = "0" + rnd;
  return now + rnd;
}
function decodeMaybe(s) {
  if (typeof s === "string" && (s.startsWith("%7B") || s.startsWith("%7b"))) {
    try { return decodeURIComponent(s); } catch {}
  }
  return s;
}

let sessionToken = (process.env.MONITOR_SESSION_TOKEN || "").trim();
if (!sessionToken) {
  try { sessionToken = fs.readFileSync("/tmp/.session_token", "utf8").trim(); } catch {}
}
if (!sessionToken) { console.error("ERRO: sem token"); process.exit(1); }
console.log(`Token: len=${sessionToken.length} prefix=${sessionToken.slice(0,8)}...`);

const logStream = fs.createWriteStream(outFile, { flags: "a" });
function log(line) {
  const ts = new Date().toISOString();
  const full = `[${ts}] ${line}`;
  console.log(full);
  logStream.write(full + "\n");
}

log(`=== sb_sniffer | vehicleId=${vehicleId} clientId=${clientId} | arquivo=${outFile} ===`);
log("Inicie o SB manualmente no Monitor agora. Ctrl+C para encerrar.");

function makeGuidLike() {
  const hex = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `${hex()}-${hex().slice(0,4)}-${hex().slice(0,4)}-${hex().slice(0,4)}-${hex()}${hex().slice(0,4)}`.toUpperCase();
}

let wsUrl = (process.env.MONITOR_WS_URL || "").trim();
if (!wsUrl) {
  const guid = makeGuidLike();
  wsUrl = `wss://websocket.traffilog.com:8182/${guid}/${sessionToken}/json?defragment=1`;
}
const origin = process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com";
log(`WS URL: ${wsUrl.slice(0, 60)}...`);

const ws = new WebSocket(wsUrl, {
  headers: { Origin: origin },
  handshakeTimeout: 15000,
  perMessageDeflate: false,
});

function sendFrame(name, params) {
  const mtkn = genMtkn();
  const frame = {
    action: {
      flow_id: genFlowId(),
      name,
      parameters: { ...params, _action_name: name, mtkn: String(mtkn) },
      session_token: String(sessionToken),
      mtkn: String(mtkn),
    },
  };
  ws.send(JSON.stringify(frame)); // JSON puro — igual sb_run_vm
  log(`>> SENT: ${name} mtkn=${mtkn}`);
  return mtkn;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

ws.on("open", async () => {
  log("WS aberta. Enviando sequência...");

  sendFrame("get_client_vehicles_opr", {
    vcls_from_previous_process: "0", is_checked: "0", last_ignition_status: "0",
    license_nmbr: "", inner_id: "", vehicle_id: String(vehicleId), vin_nmbr: "",
    client_group: "", vehicle_type_descr: "", is_last_SB_error: "0",
    LAST_SB_STATUS_ID: "", client_id: String(clientId), client_name: "",
  });
  await sleep(1000);

  sendFrame("vcls_check_opr", { vehicle_id: String(vehicleId), client_id: String(clientId), is_checked: "1" });
  await sleep(1000);

  sendFrame("get_vehicle_info", { tag: "loading_screen", vehicle_id: String(vehicleId) });
  await sleep(1500);

  sendFrame("vehicle_unsubscribe", { vehicle_id: String(vehicleId), object_type: "" });
  await sleep(500);
  sendFrame("vehicle_subscribe", { vehicle_id: String(vehicleId), object_type: "UNIT_MESSAGES" });
  await sleep(300);
  sendFrame("vehicle_subscribe", { vehicle_id: String(vehicleId), object_type: "UNIT_CONFIG_STATUS", value: "" });
  await sleep(300);
  sendFrame("vehicle_subscribe", { vehicle_id: String(vehicleId), object_type: "UNIT_PARAMETERS" });

  log("=== Sequência enviada. Escutando... ===");

  const pollInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      sendFrame("get_vehicle_info", { tag: "loading_screen", vehicle_id: String(vehicleId) });
    }
  }, 20000);

  setTimeout(() => {
    clearInterval(pollInterval);
    log("=== Timeout. Encerrando. ===");
    ws.close(1000, "done");
  }, MAX_MS);
});

ws.on("message", (data) => {
  const text = decodeMaybe(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  try {
    const obj = JSON.parse(text);
    const props = obj?.response?.properties || {};
    const an  = props.action_name || obj?.action_name || obj?.message || "";
    const av  = String(props.action_value ?? obj?.action_value ?? "");
    const hasAv = "action_value" in props || "action_value" in obj;

    if (!hasAv) {
      log(`<< PUSH action="${an}" | ${text.slice(0, 800)}`);
    } else if (an === "get_vehicle_info") {
      const d0 = props.data?.[0] || {};
      log(`<< RESP get_vehicle_info | cfg_status="${d0.configuration_status}" progress="${d0.progress}" key_db="${d0.configuration_key_db}" key_unit="${d0.configuration_key_unit}" color="${d0.configuration_key_db_color}"`);
    } else {
      log(`<< RESP action="${an}" av="${av}"`);
    }
  } catch {
    log(`<< RAW | ${text.slice(0, 400)}`);
  }
});

ws.on("close", (code, reason) => {
  log(`WS fechada: code=${code} reason=${String(reason || "")}`);
  logStream.end();
  process.exit(0);
});

ws.on("error", (e) => log(`WS erro: ${e?.message || e}`));

process.on("SIGINT", () => {
  log("=== Interrompido ===");
  try { ws.close(1000, "done"); } catch {}
});
