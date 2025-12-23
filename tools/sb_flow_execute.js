#!/usr/bin/env node
"use strict";

const WebSocket = require("ws");
const fs = require("fs");

function readCookie() {
  if (process.env.MONITOR_WS_COOKIE) return process.env.MONITOR_WS_COOKIE.trim();
  const p = process.env.MONITOR_WS_COOKIE_FILE;
  if (!p) return "";
  try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; }
}

function nowMtkn() {
  return String(Date.now()) + String(Math.floor(Math.random() * 1e12)).padStart(12, "0");
}

function findFirstKey(obj, keys) {
  const seen = new Set();
  function walk(x) {
    if (!x || typeof x !== "object") return null;
    if (seen.has(x)) return null;
    seen.add(x);
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(x, k) && x[k] != null) return x[k];
    }
    for (const v of Object.values(x)) {
      const r = walk(v);
      if (r != null) return r;
    }
    return null;
  }
  return walk(obj);
}

async function main() {
  const [clientId, clientName, vehicleId, vehicleSettingId, ...commentParts] = process.argv.slice(2);
  const comment = (commentParts.join(" ") || "").trim();

  const url = process.env.MONITOR_WS_URL;
  const origin = process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com";
  const sessionToken = process.env.MONITOR_SESSION_TOKEN;

  if (!url) throw new Error("Faltou MONITOR_WS_URL no env");
  if (!sessionToken) throw new Error("Faltou MONITOR_SESSION_TOKEN no env");
  if (!clientId || !clientName || !vehicleId || !vehicleSettingId) {
    throw new Error("Uso: node tools/sb_flow_execute.js <clientId> <clientName> <vehicleId> <vehicleSettingId> <comment...>");
  }

  const cookie = readCookie();
  const headers = {};
  if (cookie) headers["Cookie"] = cookie;

  const ws = new WebSocket(url, {
    origin,
    headers,
    handshakeTimeout: 15000,
    perMessageDeflate: false,
  });

  const pending = new Map(); // mtkn -> {resolve,reject,timer}

  function armTimeout(mtkn, ms) {
    return setTimeout(() => {
      const p = pending.get(mtkn);
      if (p) {
        pending.delete(mtkn);
        p.reject(new Error("Timeout esperando mtkn=" + mtkn));
      }
    }, ms);
  }

  function sendWait(action, parameters, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const mtkn = nowMtkn();
      const msg = {
        tag: "loading_screen",
        _action_name: action,
        parameters: parameters || {},
        mtkn,
        session_token: sessionToken,
      };
      const timer = armTimeout(mtkn, timeoutMs);
      pending.set(mtkn, { resolve, reject, timer });
      ws.send(JSON.stringify(msg));
    });
  }

  ws.on("message", (buf) => {
    const txt = buf.toString("utf8");
    let data;
    try { data = JSON.parse(txt); } catch { return; }

    const arr = Array.isArray(data) ? data : [data];
    for (const item of arr) {
      const mtkn = item?.mtkn ?? item?.payload?.mtkn ?? item?.parameters?.mtkn;
      if (!mtkn) continue;
      const p = pending.get(String(mtkn));
      if (!p) continue;
      clearTimeout(p.timer);
      pending.delete(String(mtkn));
      p.resolve(item);
    }
  });

  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });

  // Fluxo mínimo: associate -> (review) -> (review_opr) -> execute
  const baseParams = {
    client_id: Number(clientId),
    client_name: String(clientName),
    vehicle_id: Number(vehicleId),
    vehicle_setting_id: Number(vehicleSettingId),
    comment: comment || "sb via execute_action_opr",
  };

  const r1 = await sendWait("associate_vehicles_actions_opr", baseParams);
  const av1 = findFirstKey(r1, ["action_value"]);
  if (String(av1) === "403") throw new Error("403 action forbidden (cookie/auth)");
  if (String(av1) === "400") throw new Error("400 (associate_vehicles_actions_opr)");

  // tentar achar process_id em qualquer resposta
  let processId = findFirstKey(r1, ["process_id", "processId"]);

  // alguns ambientes só devolvem process_id depois do review
  const r2 = await sendWait("review_process_attributes", { ...baseParams, process_id: processId ?? undefined });
  const av2 = findFirstKey(r2, ["action_value"]);
  if (String(av2) === "403") throw new Error("403 action forbidden (cookie/auth)");
  processId = processId ?? findFirstKey(r2, ["process_id", "processId"]);

  const r3 = await sendWait("get_vcls_action_review_opr", { ...baseParams, process_id: processId ?? undefined });
  const av3 = findFirstKey(r3, ["action_value"]);
  if (String(av3) === "403") throw new Error("403 action forbidden (cookie/auth)");
  processId = processId ?? findFirstKey(r3, ["process_id", "processId"]);

  if (!processId) throw new Error("Não consegui extrair process_id das respostas.");

  const r4 = await sendWait("execute_action_opr", { ...baseParams, process_id: Number(processId) });
  const av4 = findFirstKey(r4, ["action_value"]);
  if (String(av4) === "403") throw new Error("403 action forbidden (cookie/auth)");

  console.log("process_id =", processId);
  ws.close();
}

main().catch((e) => {
  console.error("[sb_exec] ERRO:", e?.message || e);
  process.exit(2);
});
