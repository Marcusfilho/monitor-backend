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

  // worker id “fixo” só pra lock do next
  const workerId = "can_once";

  if(!base){ console.log("[ERRO] JOB_SERVER_BASE_URL não definido"); return; }
  if(!key){ console.log("[ERRO] WORKER_KEY não definido"); return; }

  const nextUrl = `${base}/api/jobs/next?type=monitor_can_snapshot&worker=${encodeURIComponent(workerId)}`;
  console.log("[INFO] next:", nextUrl);

  const r = await fetch(nextUrl, { method:"GET", headers:{ "x-worker-key": key, "accept":"application/json" } });
  console.log("[INFO] next HTTP", r.status);

  if(r.status === 204){
    console.log("[OK] fila vazia (204).");
    return;
  }
  const txt = await r.text();
  if(!r.ok){
    console.log("[ERRO] next not-ok:", txt.slice(0,600));
    return;
  }

  let job=null;
  try{ job = JSON.parse(txt); } catch(e){}

  if(!job || !job.id){
    console.log("[OK] resposta sem job (formato diferente):", txt.slice(0,400));
    return;
  }

  const jobId = job.id;
  console.log("[OK] job:", jobId, "type:", job.type);

  // meta “fake” só pra validar pipeline de storage no engine
  const result = {
    meta: {
      summary: { ok:true, note:"smoke-test", vehicleId: (job.payload||{}).vehicleId || (job.payload||{}).vehicle_id || null },
      snapshot: { ts: new Date().toISOString(), note:"fake snapshot", vehicleId: (job.payload||{}).vehicleId || (job.payload||{}).vehicle_id || null }
    }
  };

  const completeUrl = `${base}/api/jobs/${encodeURIComponent(String(jobId))}/complete`;
  console.log("[INFO] complete:", completeUrl);

  const rc = await fetch(completeUrl, {
    method:"POST",
    headers:{ "x-worker-key": key, "content-type":"application/json", "accept":"application/json" },
    body: JSON.stringify({ status:"completed", result, workerId })
  });
  console.log("[INFO] complete HTTP", rc.status);
  const out = await rc.text();
  console.log(out.slice(0,800));
}

main().catch(e => console.log("[FATAL]", e && e.stack || e));
