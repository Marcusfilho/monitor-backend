#!/usr/bin/env node
// html5_heartbeat.js — heartbeat independente para o html5InstallWorker
// Roda como serviço separado, não toca no worker principal
// Variáveis lidas do ambiente (mesmas do worker):
//   JOB_SERVER_BASE_URL, WORKER_KEY, WORKER_ID, SESSION_TOKEN_PATH
//   HEARTBEAT_INTERVAL_MS (padrão: 30000)

"use strict";

const https  = require("https");
const http   = require("http");
const fs     = require("fs");

const BASE        = (process.env.JOB_SERVER_BASE_URL || "").replace(/\/+$/, "");
const WORKER_KEY  = (process.env.WORKER_KEY  || "").trim();
const WORKER_ID   = (process.env.WORKER_ID   || "vm-tunel-01").trim();
const TOK_PATH    = process.env.SESSION_TOKEN_PATH || "/tmp/.session_token";
const INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 30000);
const START_S     = Math.floor(Date.now() / 1000);

if (!BASE)       { console.error("[hb] JOB_SERVER_BASE_URL não definido"); process.exit(1); }
if (!WORKER_KEY) { console.error("[hb] WORKER_KEY não definido");           process.exit(1); }

console.log(`[hb] iniciado — base=${BASE} worker=${WORKER_ID} interval=${INTERVAL_MS}ms`);

function getSessionOk() {
  try {
    const tok = fs.readFileSync(TOK_PATH, "utf8").trim();
    return tok.length >= 20;
  } catch { return false; }
}

function sendHeartbeat() {
  const session_ok = getSessionOk();
  const uptime_s   = Math.floor(Date.now() / 1000) - START_S;

  const payload = JSON.stringify({
    worker_id: WORKER_ID,
    ts:        new Date().toISOString(),
    status:    "running",
    checks:    { backend_ok: true, session_ok },
    meta:      { uptime_s, source: "heartbeat_sidecar" },
  });

  const url  = new URL(BASE + "/api/worker/heartbeat");
  const lib  = url.protocol === "https:" ? https : http;
  const buf  = Buffer.from(payload, "utf8");

  const req = lib.request(
    {
      hostname: url.hostname,
      port:     url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname,
      method:   "POST",
      headers:  {
        "content-type":   "application/json",
        "content-length": String(buf.length),
        "x-worker-key":   WORKER_KEY,
      },
    },
    (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          console.error(`[hb] http ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 100)}`);
        } else {
          console.log(`[hb] ok session_ok=${session_ok} uptime=${uptime_s}s`);
        }
      });
    }
  );

  req.setTimeout(10000, () => { req.destroy(); console.error("[hb] timeout"); });
  req.on("error", e => console.error("[hb] erro:", e.message));
  req.write(buf);
  req.end();
}

// Bate imediatamente e depois a cada INTERVAL_MS
sendHeartbeat();
setInterval(sendHeartbeat, INTERVAL_MS);
