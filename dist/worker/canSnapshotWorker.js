/**
 * monitor-can-snapshot-worker
 * - Consome jobs do tipo monitor_can_snapshot
 * - Completa com result.meta.summary + result.meta.snapshot
 *
 * OBS: snapshot real do Monitor entra depois; aqui é o esqueleto oficial.
 */
const WORKER_ID = "can_snapshot";
const BASE = (process.env.JOB_SERVER_BASE_URL || process.env.BASE_URL || process.env.BACKEND_BASE_URL || "").replace(/\/$/, "");
const KEY  = (process.env.WORKER_KEY || "").trim();

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function fetchJsonOrText(url, opts){
  const r = await fetch(url, opts);
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { r, text: t, json: j };
}

async function pollOnce(){
  if(!BASE || !KEY){
    console.log("[ERRO] falta JOB_SERVER_BASE_URL ou WORKER_KEY no env (systemd EnvironmentFile).");
    await sleep(5000);
    return;
  }

  const nextUrl = `${BASE}/api/jobs/next?type=monitor_can_snapshot&worker=${encodeURIComponent(WORKER_ID)}`;
  const { r, json, text } = await fetchJsonOrText(nextUrl, {
    method: "GET",
    headers: { "x-worker-key": KEY, "accept": "application/json" },
  });

  if(r.status === 204){
    await sleep(2000);
    return;
  }
  if(!r.ok){
    console.log("[WARN] jobs/next HTTP", r.status, (text || "").slice(0, 200));
    await sleep(5000);
    return;
  }

  const job = json;
  if(!job || (!job.id && !job.job_id)){
    console.log("[WARN] jobs/next retornou formato inesperado:", (text || "").slice(0, 200));
    await sleep(3000);
    return;
  }

  const jobId = job.id || job.job_id;
  const p = job.payload || {};
  const installationId = p.installationId || p.installation_id || p.installation || null;
  const vehicleId = p.vehicleId || p.vehicle_id || null;

  // TODO: aqui entra o snapshot REAL do Monitor (Vehicle Monitor -> Parameters/Module State)
  const meta = {
    summary: { ok: true, source: "placeholder", installationId, vehicleId },
    snapshot: { captured_at: new Date().toISOString(), source: "placeholder", installationId, vehicleId }
  };

  const completeUrl = `${BASE}/api/jobs/${encodeURIComponent(String(jobId))}/complete`;
  const { r: rc, text: out } = await fetchJsonOrText(completeUrl, {
    method: "POST",
    headers: { "x-worker-key": KEY, "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify({ status: "completed", workerId: WORKER_ID, result: { meta } })
  });

  console.log("[INFO] complete", jobId, "HTTP", rc.status, (out || "").slice(0, 200));
  await sleep(200);
}

async function main(){
  console.log("[INFO] canSnapshotWorker start", { base: !!BASE, worker: WORKER_ID });
  while(true){
    try { await pollOnce(); }
    catch(e){
      console.log("[ERR]", e && e.stack ? e.stack.slice(0, 500) : String(e));
      await sleep(5000);
    }
  }
}

main();
