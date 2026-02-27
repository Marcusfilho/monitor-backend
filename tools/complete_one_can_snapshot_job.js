const fs = require("fs");
function pickEnvFile(paths){ for(const p of paths) if(fs.existsSync(p)) return p; return null; }
function loadEnvFile(p){
  if(!p) return;
  const txt = fs.readFileSync(p,"utf8");
  for(const line of txt.split(/\r?\n/)){
    if(!line || /^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if(!m) continue;
    let v=m[2];
    if((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v=v.slice(1,-1);
    if(process.env[m[1]] == null) process.env[m[1]] = v;
  }
}
async function main(){
  loadEnvFile(pickEnvFile(["/etc/monitor-backend/worker.env","/etc/monitor-backend/backend.env"]));
  loadEnvFile(pickEnvFile(["/home/questar/monitor-backend/worker_secrets.env","/etc/monitor-backend/worker_secrets.env"]));

  const base = (process.env.JOB_SERVER_BASE_URL || process.env.BASE_URL || process.env.BACKEND_BASE_URL || "").replace(/\/$/,"");
  const key  = (process.env.WORKER_KEY || "").trim();
  const workerId = "can_once";
  if(!base || !key){ console.log("[ERRO] faltou JOB_SERVER_BASE_URL ou WORKER_KEY"); return; }

  const nextUrl = `${base}/api/jobs/next?type=monitor_can_snapshot&worker=${encodeURIComponent(workerId)}`;
  const r = await fetch(nextUrl, { method:"GET", headers:{ "x-worker-key": key, "accept":"application/json" }});
  console.log("[INFO] next HTTP", r.status);
  if(r.status === 204){ console.log("[OK] fila vazia"); return; }
  const job = await r.json();
  const id = job.id || job.job_id;
  console.log("[OK] job:", id);

  const meta = {
    summary: { ok:true, source:"placeholder", note:"smoke test" },
    snapshot: { captured_at: new Date().toISOString(), source:"placeholder" }
  };

  const cUrl = `${base}/api/jobs/${encodeURIComponent(String(id))}/complete`;
  const rc = await fetch(cUrl, {
    method:"POST",
    headers:{ "x-worker-key": key, "content-type":"application/json", "accept":"application/json" },
    body: JSON.stringify({ status:"completed", workerId, result:{ meta } })
  });
  console.log("[INFO] complete HTTP", rc.status);
  console.log((await rc.text()).slice(0,800));
}
main().catch(e=>console.log("[FATAL]", e && e.stack || e));
