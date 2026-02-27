"use strict";

const { spawn } = require("child_process");

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function baseUrl() {
  const b = process.env.JOB_SERVER_BASE_URL || process.env.BASE_URL || process.env.BASE;
  if (!b) throw new Error("MISS_ENV: JOB_SERVER_BASE_URL (ou BASE_URL/BASE)");
  return String(b).replace(/\/+$/, "");
}

function workerId() {
  return process.env.WORKER_ID || "tunel";
}

function headers() {
  const h = { "accept": "application/json" };
  if (process.env.WORKER_KEY) h["x-worker-key"] = process.env.WORKER_KEY;
  return h;
}

async function httpJson(path, { method="GET", query=null, body=null, timeoutMs=20000 } = {}) {
  const u = new URL(baseUrl() + path);
  if (query) for (const [k,v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  let res, text;
  try {
    res = await fetch(u.toString(), {
      method,
      headers: { ...headers(), ...(body ? {"content-type":"application/json"} : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal
    });
    text = await res.text();
  } finally {
    clearTimeout(t);
  }

  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}

  return { status: res.status, ok: res.ok, json, text };
}

function runSnapshot(vid) {
  return new Promise((resolve) => {
    const env = { ...process.env, WS_DEBUG: process.env.WS_DEBUG || "0" };
    const p = spawn(process.execPath, ["tools/vm_snapshot_ws_v4.js", String(vid)], { env, stdio: ["ignore","pipe","pipe"] });

    let out = "";
    let err = "";
    p.stdout.on("data", d => out += d.toString("utf8"));
    p.stderr.on("data", d => err += d.toString("utf8"));

    const timeoutMs = Number(process.env.SNAPSHOT_TIMEOUT_MS || 120000);
    const t = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch(_) {}
      resolve({ ok:false, code:null, out, err: (err + "\nSNAPSHOT_TIMEOUT").slice(-4000) });
    }, timeoutMs);

    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, code, out, err: err.slice(-4000) });
    });
  });
}

function pickVehicleId(job) {
  const p = (job && job.payload) || {};
  return p.vehicleId || p.vehicle_id || p.vehicle || p.vid || null;
}

function buildSummary(vid, snapJson) {
  // Mantém só o necessário pro app + debug de refresh
  const debug = (snapJson && snapJson.debug) || {};
  return {
    captured_at: (snapJson && (snapJson.captured_at || snapJson.ts)) || new Date().toISOString(),
    vehicle_id: vid ? String(vid) : null,
    header: snapJson ? (snapJson.header || null) : null,
    parameters_tab: snapJson ? (snapJson.parameters_tab || null) : null,
    module_state_tab: snapJson ? (snapJson.module_state_tab || null) : null,
    params_refresh: debug.params_refresh || null
  };
}

async function main() {
  const wid = workerId();
  console.log(`[INFO] monitor_can_snapshot one-shot | worker=${wid} | base=${baseUrl()}`);

  // 1) pegar 1 job
  const next = await httpJson("/api/jobs/next", { query: { type: "monitor_can_snapshot", worker: wid }, timeoutMs: 20000 });
  if (next.status === 204 || !next.json) {
    console.log("[INFO] nenhum job monitor_can_snapshot disponível (204/empty).");
    return;
  }

  const job = next.json.job || next.json;
  const jobId = job && (job.id || job.job_id);
  if (!jobId) {
    console.log("[ERRO] não consegui ler job.id no /api/jobs/next");
    console.log(next.text.slice(0, 500));
    return;
  }

  const vid = pickVehicleId(job);
  console.log(`[INFO] peguei job=${jobId} vid=${vid}`);

  if (!vid) {
    const result = { meta: { summary: { error: "NO_VEHICLE_ID_IN_JOB", jobId } } };
    await httpJson(`/api/jobs/${encodeURIComponent(String(jobId))}/complete`, { method:"POST", body: { status: "error", result }, timeoutMs: 20000 });
    console.log("[OK] complete error (no vehicle id).");
    return;
  }

  // 2) snapshot real (Vehicle Monitor)
  console.log("[INFO] rodando vm_snapshot_ws_v4...");
  const snap = await runSnapshot(vid);

  let snapJson = null;
  try { snapJson = snap.out ? JSON.parse(snap.out) : null; } catch (_) {}

  if (!snap.ok || !snapJson) {
    const result = {
      meta: { summary: { error: "SNAPSHOT_FAILED", vehicle_id: String(vid), exitCode: snap.code, stderr_tail: snap.err } }
    };
    await httpJson(`/api/jobs/${encodeURIComponent(String(jobId))}/complete`, { method:"POST", body: { status: "error", result }, timeoutMs: 20000 });
    console.log("[OK] complete error (snapshot failed). Veja stderr_tail no job.");
    return;
  }

  // 3) completar job com summary (dados reais)
  const summary = buildSummary(vid, snapJson);
  const result = { meta: { summary } };

  await httpJson(`/api/jobs/${encodeURIComponent(String(jobId))}/complete`, { method:"POST", body: { status: "ok", result }, timeoutMs: 20000 });
  console.log("[OK] job completo com snapshot real. Agora o GET da instalação deve mostrar can.summary.");
}

main().catch(err => {
  console.log("[FATAL]", String(err && err.stack || err));
});
