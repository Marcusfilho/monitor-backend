#!/usr/bin/env node
/**
 * tools/vm_snapshot_ws_v4.js (v4.7.2 require param values + explicit refresh)
 * - mantém v4.7 (adaptive refresh + ignition/config waits + stream tolerant)
 * - parameters: NÃO para enquanto não houver valores (refresh ou value em row)
 * - tenta action "refresh" (data_source UNIT_PARAMETERS) se valores não chegam
 * - debug: sample maior via WS_DEBUG_SAMPLE_LEN (default 1200)
 */
const fs = require("fs");
const https = require("https");
const { spawnSync } = require("child_process");
const WS = require("ws");

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function nowIso(){ return new Date().toISOString(); }
function ts(){ return Date.now(); }

function mustEnv(name){
  const v = process.env[name];
  if (!v) throw new Error(`Falta env: ${name}`);
  return v;
}

function readEnvFromFile(file){
  try{
    const txt = fs.readFileSync(file,"utf8");
    const out = {};
    for (const line of txt.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1,-1);
      out[m[1]] = val;
    }
    return out;
  } catch { return {}; }
}

function resolveApiBase(){
  if (process.env.TRAFFILOG_API_BASE_URL) return process.env.TRAFFILOG_API_BASE_URL.trim();
  const candidates = [ process.cwd()+"/worker_secrets.env", "/home/questar/monitor-backend/worker_secrets.env" ];
  for (const f of candidates){
    const envs = readEnvFromFile(f);
    if (envs.TRAFFILOG_API_BASE_URL) return String(envs.TRAFFILOG_API_BASE_URL).trim();
  }
  throw new Error("Não achei TRAFFILOG_API_BASE_URL (env ou worker_secrets.env)");
}

function httpPostJson(urlStr, bodyObj, timeoutMs=15000){
  const body = JSON.stringify(bodyObj);
  const u = new URL(urlStr);
  return new Promise((resolve,reject)=>{
    const req = https.request({
      method:"POST",
      hostname:u.hostname,
      path:u.pathname+(u.search||""),
      headers:{
        "content-type":"application/json",
        "accept":"application/json",
        "content-length": Buffer.byteLength(body),
      }
    }, (res)=>{
      const chunks=[];
      res.on("data",(d)=>chunks.push(d));
      res.on("end",()=>{
        const txt = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${txt.slice(0,200)}`));
        try { resolve(JSON.parse(txt)); }
        catch { reject(new Error(`Resposta não-JSON: ${txt.slice(0,200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, ()=>{ try{ req.destroy(new Error("timeout")); }catch{} });
    req.write(body);
    req.end();
  });
}

async function loginFreshToken(){
  const login = (process.env.VM_LOGIN_NAME || process.env.WS_LOGIN_NAME || "").trim();
  const pass  = (process.env.VM_PASSWORD   || process.env.WS_PASSWORD   || "").trim();
  if (!login || !pass) throw new Error("Faltam envs: VM_LOGIN_NAME/VM_PASSWORD (ou WS_LOGIN_NAME/WS_PASSWORD)");

  const apiBase = resolveApiBase();
  const payload = { action:{ name:"user_login", parameters:{ login_name: login, password: pass } } };
  const j = await httpPostJson(apiBase, payload, Number(process.env.SESSION_TOKEN_PULL_TIMEOUT_MS || 15000));

  const props = j?.response?.properties || {};
  const tok = props.session_token || props?.data?.[0]?.session_token || null;
  if (!tok || String(tok).trim().length < 20) throw new Error("user_login não retornou session_token");
  return String(tok).trim();
}

function buildWsUrl(sessionToken){
  const guid = mustEnv("MONITOR_WS_GUID");
  return `wss://websocket.traffilog.com:8182/${guid}/${sessionToken}/json?defragment=1`;
}

// default: encode ON (igual ao Monitor). Desliga só se SB_SEND_ENCODE=0/false/no
function encodeIfNeeded(s){
  const flag = (process.env.SB_SEND_ENCODE || "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "no") return s;
  return encodeURIComponent(s);
}
function tryDecodeMaybe(s){
  if (typeof s !== "string") return s;
  if (s.startsWith("%")) { try { return decodeURIComponent(s); } catch {} }
  return s;
}
function decodeSafe(s){
  if (typeof s !== "string") return s;
  if (!s.includes("%")) return s;
  try { return decodeURIComponent(s); } catch { return s; }
}

function extractActionName(obj){
  return (
    obj?.response?.properties?.action_name ||
    obj?.response?.properties?.actionName ||
    obj?.properties?.action_name ||
    obj?.properties?.actionName ||
    obj?.action_name ||
    obj?.actionName ||
    null
  );
}

function findArrayOfObjectsDeep(root, wantKeysAny, depth=0){
  if (!root || depth>7) return null;
  if (Array.isArray(root)){
    if (root.length && typeof root[0]==="object" && root[0]!==null){
      const kset = new Set(Object.keys(root[0]));
      for (const k of wantKeysAny) if (kset.has(k)) return root;
    }
    for (const v of root){
      const hit = findArrayOfObjectsDeep(v, wantKeysAny, depth+1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof root==="object"){
    for (const v of Object.values(root)){
      const hit = findArrayOfObjectsDeep(v, wantKeysAny, depth+1);
      if (hit) return hit;
    }
  }
  return null;
}

function pickRowsHeuristic(resp, kind){
  const props = resp?.response?.properties || resp?.properties || resp || {};
  if (Array.isArray(props.data)) return props.data;
  if (Array.isArray(props.rows)) return props.rows;

  const want = (kind==="module")
    ? ["module_descr","sub_module_descr","moduleDescr","subModuleDescr","ok","active","id","sub_module_id","module_id","last_update_date","lastUpdateDate"]
    : ["param_id","paramId","id","name","param_name","paramName","param_value","value_raw","raw_value","value","display_value","source","last_update","lastUpdate","last_update_date","lastUpdateDate"];

  const deep = findArrayOfObjectsDeep(resp, want);
  return Array.isArray(deep) ? deep : [];
}

function getAnyValue(row){
  const keys=[
    "param_value","paramValue",
    "value_raw","raw_value","value","display_value",
    "param_value_raw","param_value_hex",
    "raw","val",
    "valueRaw","rawValue","displayValue"
  ];
  for (const k of keys){
    if (row && Object.prototype.hasOwnProperty.call(row,k)){
      const v=row[k];
      if (v==null) continue;
      if (typeof v==="string" && v.trim()==="") continue;
      return v;
    }
  }
  if (row && typeof row==="object"){
    for (const [k,v] of Object.entries(row)){
      if (!/value|raw|val/i.test(k)) continue;
      if (v==null) continue;
      if (typeof v==="string" && v.trim()==="") continue;
      return v;
    }
  }
  return null;
}

function inferKindFromRow(row){
  if (!row || typeof row !== "object") return null;
  const ks = Object.keys(row);
  const kset = new Set(ks);
  if (kset.has("module_descr") || kset.has("sub_module_descr") || kset.has("moduleDescr") || kset.has("subModuleDescr")) return "module";
  if (kset.has("param_id") || kset.has("paramId") || kset.has("param_value") || kset.has("param_value_raw") || kset.has("param_value_hex")) return "params";
  if (kset.has("name") && (kset.has("value") || kset.has("value_raw") || kset.has("raw_value"))) return "params";
  return null;
}

function parseDateMaybe(v){
  if (!v) return null;
  if (typeof v === "number") return new Date(v);
  if (typeof v !== "string") return null;
  const s = decodeSafe(v).trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}
function diffSec(a,b){
  if (!a || !b) return null;
  const da = (a instanceof Date) ? a : parseDateMaybe(a);
  const db = (b instanceof Date) ? b : parseDateMaybe(b);
  if (!da || !db) return null;
  return Math.abs((da.getTime()-db.getTime())/1000);
}

function getHeaderTime(header){
  const cand = [ header?.gprs_last, header?.gprsLast, header?.gps_last, header?.gpsLast ];
  for (const c of cand){
    const d = parseDateMaybe(c);
    if (d) return d;
  }
  return null;
}

function isIgnitionOn(header){
  const cand = [header?.ignition, header?.ignition_on, header?.ignitionOn, header?.ignition_state, header?.ignitionState];
  for (const v of cand){
    if (v === 1 || v === true) return true;
    if (typeof v === "string"){
      const s=v.trim().toLowerCase();
      if (s==="1" || s==="true" || s==="on" || s==="yes") return true;
    }
  }
  return false;
}

function findMaxUpdateFromRows(rows, keys){
  let best = null;
  for (const r of rows||[]){
    if (!r || typeof r !== "object") continue;
    for (const k of keys){
      const d = parseDateMaybe(r[k]);
      if (!d) continue;
      if (!best || d > best) best = d;
    }
  }
  return best;
}

function moduleFreshness(rows, targetTime, toleranceSec){
  const wantIds = new Set(["8","9","15","19","20",8,9,15,19,20].map(String));
  const rel = [];
  for (const r of rows||[]){
    const id = r?.id ?? r?.sub_module_id ?? r?.subModuleId ?? null;
    if (id==null) continue;
    if (wantIds.has(String(id))) rel.push(r);
  }
  const maxRel = findMaxUpdateFromRows(rel, ["last_update_date","lastUpdateDate","last_update","lastUpdate"]);
  const maxAll = findMaxUpdateFromRows(rows, ["last_update_date","lastUpdateDate","last_update","lastUpdate"]);
  const maxUse = maxRel || maxAll;
  const ds = diffSec(maxUse, targetTime);
  const ok = (ds!=null && ds <= toleranceSec);
  return { ok, diff_sec: ds, max_update: maxUse ? maxUse.toISOString() : null, used_relevant: !!maxRel };
}

function paramsFreshness(rows, targetTime, toleranceSec){
  const maxUse = findMaxUpdateFromRows(rows, ["last_update","lastUpdate","last_update_date","lastUpdateDate"]);
  const ds = diffSec(maxUse, targetTime);
  const ok = (ds!=null && ds <= toleranceSec);
  return { ok, diff_sec: ds, max_update: maxUse ? maxUse.toISOString() : null };
}

function buildParamsTab(resp, refreshById){
  const rows=pickRowsHeuristic(resp,"params");
  const mapped=rows.map(r=>{
    const id = r.id ?? r.param_id ?? r.paramId ?? null;
    let value_raw = getAnyValue(r);
    if (value_raw==null && id!=null && refreshById && refreshById.has(String(id))) value_raw = refreshById.get(String(id));
    return ({
      id,
      name: r.name ?? r.param_name ?? r.paramName ?? null,
      value_raw,
      last_update: r.last_update ?? r.lastUpdate ?? r.last_update_date ?? r.lastUpdateDate ?? null,
      source: r.source ?? r.param_source ?? r.paramSource ?? null,
    });
  });

  const count_with_value=mapped.filter(x=>x.value_raw!==null).length;

  const interesting=/sys_param|can|engine|fuel|mileage|speed|rpm|hour|odometer|j1939|j1708/i;
  let preview=mapped.filter(x=>x.value_raw!==null).slice(0,60);
  if (preview.length<20) preview=preview.concat(mapped.filter(x=>interesting.test(String(x.name||""))).slice(0,60-preview.length));
  if (!preview.length) preview=mapped.slice(0,12);

  return {count_opr:mapped.length,count_with_value,preview,rows:mapped};
}

function buildModuleRelevant(resp){
  const rows=pickRowsHeuristic(resp,"module");
  const norm=x=>(x==null?"":String(x));
  const rules=[
    {key:"CAN0",find:r=>/CAN/i.test(norm(r.module_descr ?? r.moduleDescr)) && /CAN0/i.test(norm(r.sub_module_descr ?? r.subModuleDescr))},
    {key:"CAN1",find:r=>/CAN/i.test(norm(r.module_descr ?? r.moduleDescr)) && /CAN1/i.test(norm(r.sub_module_descr ?? r.subModuleDescr))},
    {key:"J1708",find:r=>/J1708/i.test(norm(r.module_descr ?? r.moduleDescr)) || /J1708/i.test(norm(r.sub_module_descr ?? r.subModuleDescr))},
    {key:"KEYPAD_DALLAS_IBUTTON",find:r=>/KEYPAD/i.test(norm(r.module_descr ?? r.moduleDescr)) && /(DALLAS|IBUTTON|I-?BUTTON)/i.test(norm(r.sub_module_descr ?? r.subModuleDescr))},
    {key:"KEYPAD_RAMZOR",find:r=>/KEYPAD/i.test(norm(r.module_descr ?? r.moduleDescr)) && /RAMZOR/i.test(norm(r.sub_module_descr ?? r.subModuleDescr))},
  ];
  const relevant=[];
  for (const rule of rules){
    const hit = rows.find(rule.find) || null;
    if (hit) relevant.push({key:rule.key,missing:false,...hit});
    else relevant.push({key:rule.key,missing:true,id:null,module_descr:null,sub_module_descr:null,active:null,ok:null,message:null});
  }
  return {rows,relevant};
}

function makeCollector(){
  const listeners = new Set();
  const streams = new Map(); // mtkn -> {rows:[]}
  const refreshById = new Map(); // param_id -> value
  const metrics = {parsed_ok:0, parsed_fail:0, stream_rows:0, stream_starts:0, refresh_params:0, events:0};

  function emit(ev){
    metrics.events++;
    for (const fn of listeners){ try{ fn(ev); } catch {} }
  }

  function addListener(fn){
    listeners.add(fn);
    return ()=>listeners.delete(fn);
  }

  function cleanLeadingCommas(s){
    return s.replace(/^\s*,+/, "").trim();
  }

  function tryParseJson(s){
    try { return JSON.parse(s); } catch { return null; }
  }

  function parseMaybeMultipleObjects(s){
    const t = cleanLeadingCommas(s);
    if (!t) return null;

    let obj = tryParseJson(t);
    if (obj != null) return obj;

    if (!t.startsWith("[") && t.includes("},{")){
      const wrapped = "[" + t + "]";
      obj = tryParseJson(wrapped);
      if (obj != null) return obj;
    }
    return null;
  }

  function ensureStream(mtkn){
    const k = String(mtkn||"").trim();
    if (!k) return null;
    if (!streams.has(k)){
      streams.set(k, { mtkn:k, rows:[] });
      metrics.stream_starts++;
      emit({type:"stream_start", mtkn:k});
    }
    return streams.get(k);
  }

  function pushStreamRow(mtkn, row){
    const st = ensureStream(mtkn);
    if (!st) return;
    st.rows.push(row);
    metrics.stream_rows++;
    emit({type:"stream_row", mtkn: st.mtkn, row});
  }

  function captureRefreshParams(obj){
    const an = extractActionName(obj);
    const props = obj?.response?.properties || {};
    const ds0 = props.data_source || props.dataSource || "";
    const ds = decodeSafe(String(ds0||""));
    if (!String(an||"").toLowerCase().includes("refresh")) return;
    if (!/UNIT_PARAM/i.test(ds)) return;

    const data = props.data;
    if (!Array.isArray(data)) return;
    for (const r of data){
      if (!r || typeof r !== "object") continue;
      const id = r.id ?? r.param_id ?? r.paramId ?? r.parameter_id ?? r.parameterId ?? null;
      const val = r.param_value ?? r.value ?? r.value_raw ?? r.raw_value ?? r.param_value_raw ?? r.param_value_hex ?? null;
      if (id==null || val==null) continue;
      const sid = String(id);
      if (typeof val === "string" && val.trim()==="") continue;
      refreshById.set(sid, val);
      metrics.refresh_params++;
    }
    emit({type:"refresh_captured", count: refreshById.size});
  }

  function feed(txt){
    const raw = String(txt||"");
    const t = raw.trim();
    if (!t) return;

    const obj = parseMaybeMultipleObjects(t);
    if (obj != null){
      metrics.parsed_ok++;
      const arr = Array.isArray(obj) ? obj : [obj];
      for (const one of arr){
        if (!one || typeof one !== "object") continue;

        captureRefreshParams(one);

        emit({type:"response", actionName: extractActionName(one), obj: one, raw});

        const mtkn = one?.mtkn || one?.response?.properties?.mtkn || one?.properties?.mtkn || null;
        if (mtkn && !one?.response){
          pushStreamRow(mtkn, one);
        }
      }
      return;
    }

    metrics.parsed_fail++;

    // stream header truncado: extrai mtkn por regex
    const mMk = t.match(/"mtkn"\s*:\s*"([^"]+)"/);
    if (mMk && mMk[1]){
      ensureStream(mMk[1]);
    }

    // chunk com vírgula: tenta parse após limpar
    const t2 = cleanLeadingCommas(t);
    if (t2.startsWith("{")){
      const o2 = parseMaybeMultipleObjects(t2);
      if (o2 != null){
        metrics.parsed_ok++;
        const arr = Array.isArray(o2) ? o2 : [o2];
        for (const one of arr){
          if (!one || typeof one !== "object") continue;
          captureRefreshParams(one);
          const mtkn = one?.mtkn || one?.response?.properties?.mtkn || one?.properties?.mtkn || null;
          if (mtkn && !one?.response) pushStreamRow(mtkn, one);
        }
      }
    }
  }

  return { addListener, feed, streams, refreshById, metrics };
}

async function connectWs(wsUrl, debugBuf, collector){
  const origin=process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com";
  const timeoutMs=Number(process.env.WS_HANDSHAKE_TIMEOUT_MS||15000);
  const sampleLen=Number(process.env.WS_DEBUG_SAMPLE_LEN||1200);
  const maxEntries=Number(process.env.WS_DEBUG_MAX||250);

  return await new Promise((resolve,reject)=>{
    const ws=new WS(wsUrl,{headers:{Origin:origin}});
    const t=setTimeout(()=>{ try{ws.terminate();}catch{} reject(new Error(`WS handshake timeout (${timeoutMs}ms)`)); }, timeoutMs);
    ws.on("open",()=>{clearTimeout(t); resolve(ws);});
    ws.on("error",(e)=>{clearTimeout(t); reject(e);});
    ws.on("message",(data)=>{
      try{
        const raw=(typeof data==="string")?data:data.toString("utf8");
        const txt=tryDecodeMaybe(raw);

        const entry={t:nowIso(),dir:"in",len:txt.length,sample:txt.slice(0,sampleLen)};
        // se tiver pistas de refresh, guarda mais para facilitar diagnóstico
        if (/data_source|dataSource|\"action_name\"\s*:\s*\"refresh\"/i.test(txt)){
          entry.sample = txt.slice(0, Math.max(sampleLen, 4000));
        }

        debugBuf.push(entry);
        if (debugBuf.length>maxEntries) debugBuf.shift();

        if (collector) collector.feed(txt);
      }catch{}
    });
  });
}

function makeMtkn(){ return `${Date.now()}_${Math.random().toString(16).slice(2)}`; }
function makeFlowId(){ return String(200000 + Math.floor(Math.random()*9000)); }

async function wsFire(ws, frameObj, debugBuf){
  const payload = encodeIfNeeded(JSON.stringify(frameObj));
  debugBuf.push({t:nowIso(),dir:"out",len:payload.length,sample:String(frameObj?.action?.name||"")});
  if (debugBuf.length>Number(process.env.WS_DEBUG_MAX||250)) debugBuf.shift();
  ws.send(payload);
}

function buildSyntheticResponse(actionName, mtkn, rows){
  return { response:{ properties:{ action_name: actionName, mtkn, data: rows } } };
}

async function wsRequest(ws, sessionToken, collector, actionName, parameters, options, debugBuf){
  const mtkn=makeMtkn();
  const flow_id=makeFlowId();
  const frame={action:{flow_id,name:actionName,parameters:{...(parameters||{}),_action_name:actionName,mtkn},session_token:sessionToken,mtkn}};
  const payload=encodeIfNeeded(JSON.stringify(frame));
  const waitMs=Number(process.env.WS_WAIT_TIMEOUT_MS||15000);
  const debounceMs = Number(process.env.WS_STREAM_DEBOUNCE_MS||700);

  const kind = options?.kind || null;
  const rx   = options?.actionRegex || null;

  return await new Promise((resolve,reject)=>{
    let bestObj=null;
    let done=false;
    let debounceT=null;

    const tmain=setTimeout(()=>{
      const st = collector && collector.streams ? collector.streams.get(String(mtkn)) : null;
      if (st && st.rows && st.rows.length){
        cleanup();
        return resolve(buildSyntheticResponse(actionName, mtkn, st.rows));
      }
      if (bestObj){
        cleanup();
        return resolve(bestObj);
      }
      cleanup();
      return reject(new Error(`timeout mtkn=${mtkn} action=${actionName}`));
    }, waitMs);

    const cleanup=()=>{
      if (done) return;
      done=true;
      if (debounceT) { clearTimeout(debounceT); debounceT=null; }
      if (unsub) unsub();
      clearTimeout(tmain);
    };

    const onEvent=(ev)=>{
      if (done) return;

      if (ev && ev.type==="stream_row" && String(ev.mtkn)===String(mtkn)){
        if (debounceT) clearTimeout(debounceT);
        debounceT = setTimeout(()=>{
          const st2 = collector.streams.get(String(mtkn));
          if (st2 && st2.rows && st2.rows.length){
            cleanup();
            return resolve(buildSyntheticResponse(actionName, mtkn, st2.rows));
          }
        }, debounceMs);
        return;
      }

      if (ev && ev.type==="response" && ev.obj){
        const an = ev.actionName || extractActionName(ev.obj);
        const raw = ev.raw || "";
        let ok=false;

        if (raw && raw.includes(mtkn)) ok=true;
        if (!ok && an && String(an)===String(actionName)) ok=true;
        if (!ok && an && rx && rx.test(String(an))) ok=true;

        if (!ok && kind){
          const rows = pickRowsHeuristic(ev.obj, kind);
          if (rows && rows.length) ok=true;
        }

        if (!ok) return;

        bestObj = ev.obj;
        if (kind){
          const rows = pickRowsHeuristic(ev.obj, kind);
          if (rows && rows.length){
            cleanup();
            return resolve(ev.obj);
          }
        }
      }
    };

    const unsub = collector ? collector.addListener(onEvent) : null;

    debugBuf.push({t:nowIso(),dir:"out",len:payload.length,sample:`REQ:${actionName}`});
    if (debugBuf.length>Number(process.env.WS_DEBUG_MAX||250)) debugBuf.shift();
    ws.send(payload);
  });
}

function runBaseSnapshot(vehicleId, sessionToken, wsUrlFresh){
  const base=spawnSync("node",["tools/vm_snapshot_ws.js",String(vehicleId)],{
    encoding:"utf8",
    env:{...process.env, MONITOR_SESSION_TOKEN: sessionToken, MONITOR_WS_URL: wsUrlFresh}
  });
  if (base.status!==0){
    const out = (base.stdout||"") + "\n" + (base.stderr||"");
    throw new Error("vm_snapshot_ws.js falhou: " + out.slice(0,400));
  }
  return JSON.parse(base.stdout);
}

async function waitForIgnitionOn(vehicleId, sessionToken, wsUrlFresh, baseJson0){
  const maxMs = Number(process.env.VM_IGN_WAIT_MS||60000);
  const pollMs = Number(process.env.VM_IGN_POLL_MS||5000);

  let baseJson = baseJson0;
  const t0 = Date.now();
  while (Date.now()-t0 < maxMs){
    const h = baseJson?.header || {};
    if (isIgnitionOn(h)) return {baseJson, waited_ms: Date.now()-t0, ign_on:true};
    await sleep(pollMs);
    baseJson = runBaseSnapshot(vehicleId, sessionToken, wsUrlFresh);
  }
  return {baseJson, waited_ms: Date.now()-t0, ign_on:isIgnitionOn(baseJson?.header||{})};
}

function nextDelayMs(attempt, minMs, maxMs){
  const x = minMs + Math.min(maxMs-minMs, attempt*250);
  return Math.min(maxMs, x);
}

async function refreshModuleAdaptive(ws, sessionToken, collector, vehicleId, targetTime, maxAttempts, tolSec, debugBuf){
  const minDelay = Number(process.env.VM_REFRESH_DELAY_MS_MIN||700);
  const maxDelay = Number(process.env.VM_REFRESH_DELAY_MS_MAX||2000);

  let lastResp=null;
  let reason="max_attempts";
  let lastFresh=null;

  for (let i=1;i<=maxAttempts;i++){
    try{
      const resp = await wsRequest(ws,sessionToken,collector,"get_monitor_module_state",
        {tag:"loading_screen",filter:"",vehicle_id:String(vehicleId)},
        {kind:"module", actionRegex:/module_state|monitor_module/i},
        debugBuf
      );
      lastResp = resp;
      const rows = pickRowsHeuristic(resp,"module");
      const fresh = moduleFreshness(rows, targetTime, tolSec);
      lastFresh = fresh;

      if (rows.length && fresh.ok){
        reason = `fresh(diff_sec=${fresh.diff_sec})`;
        break;
      }
    } catch {}

    await sleep(nextDelayMs(i, minDelay, maxDelay));
  }

  return {resp:lastResp, reason, freshness:lastFresh};
}

function rowsHaveAnyValue(rows){
  for (const r of (rows||[])){
    if (!r || typeof r!=="object") continue;
    const v = getAnyValue(r);
    if (v!=null) return true;
  }
  return false;
}

async function requestRefreshUnitParams(ws, sessionToken, collector, vehicleId, unitKey, debugBuf){
  // tentativa explícita: action refresh (se o backend suportar, ele devolve data_source UNIT_PARAMETERS)
  const params = { data_source:"UNIT_PARAMETERS", vehicle_id:String(vehicleId) };
  if (unitKey) params.unit_key = String(unitKey);

  try{
    await wsRequest(ws, sessionToken, collector, "refresh", params, {kind:null, actionRegex:/refresh/i}, debugBuf);
  } catch {}
}

async function refreshParamsAdaptive(ws, sessionToken, collector, vehicleId, unitKey, targetTime, maxAttempts, tolSec, ignitionOn, debugBuf){
  const minDelay = Number(process.env.VM_REFRESH_DELAY_MS_MIN||700);
  const maxDelay = Number(process.env.VM_REFRESH_DELAY_MS_MAX||2000);

  let lastResp=null;
  let reason="max_attempts";
  let lastFresh=null;

  const attempts = ignitionOn ? maxAttempts : Math.min(1, maxAttempts);

  for (let i=1;i<=attempts;i++){
    try{
      const resp = await wsRequest(ws,sessionToken,collector,"get_unit_parameters_opr",
        {filter:"",vehicle_id:String(vehicleId)},
        {kind:"params", actionRegex:/unit_parameters/i},
        debugBuf
      );
      lastResp = resp;

      const rows = pickRowsHeuristic(resp,"params");
      const fresh = paramsFreshness(rows, targetTime, tolSec);
      lastFresh = fresh;

      // deixa chegar refresh/push
      await sleep(700);

      const hasRefresh = (collector && collector.refreshById && collector.refreshById.size>0);
      const hasRowValue = rowsHaveAnyValue(rows);

      if (rows.length && (hasRefresh || hasRowValue)){
        if (fresh.ok) reason = `fresh(diff_sec=${fresh.diff_sec})`;
        else reason = hasRefresh ? "has_refresh_values" : "has_row_values";
        break;
      }

      // se tem rows mas sem valores -> tenta refresh explícito e continua
      if (rows.length && !hasRefresh && !hasRowValue){
        reason = "rows_no_values";
        await requestRefreshUnitParams(ws, sessionToken, collector, vehicleId, unitKey, debugBuf);
        await sleep(900);
      } else {
        reason = rows.length ? "rows_no_values" : "no_rows";
      }

    } catch {}

    await sleep(nextDelayMs(i, minDelay, maxDelay));
  }

  return {resp:lastResp, reason, freshness:lastFresh};
}

async function main(){
  const vehicleId=process.argv[2];
  if (!vehicleId){ console.error("Uso: node tools/vm_snapshot_ws_v4.js <VEHICLE_ID>"); process.exit(2); }

  const debugBuf=[];
  const debugPath = `/tmp/vm_ws_debug_${vehicleId}_${ts()}.json`;

  try{
    const sessionToken = await loginFreshToken();
    const wsUrlFresh = buildWsUrl(sessionToken);

    let baseJson = runBaseSnapshot(vehicleId, sessionToken, wsUrlFresh);

    const ignWait = await waitForIgnitionOn(vehicleId, sessionToken, wsUrlFresh, baseJson);
    baseJson = ignWait.baseJson;

    const header = baseJson?.header || {};
    const ignitionOn = isIgnitionOn(header);
    const unitKey = header?.unit_key || header?.unitKey || null;

    const targetTime = getHeaderTime(header) || new Date();
    const tolSec = Number(process.env.VM_REFRESH_TOLERANCE_SEC||180);
    const maxAttempts = Number(process.env.VM_REFRESH_MAX_ATTEMPTS||10);

    const collector = makeCollector();
    const ws=await connectWs(wsUrlFresh, debugBuf, collector);

    let modResp=null, parResp=null;
    let modInfo=null, parInfo=null;

    try{
      // subscribe (fire)
      {
        const mtkn=makeMtkn();
        const flow_id=makeFlowId();
        const frame={action:{flow_id,name:"vehicle_subscribe",parameters:{vehicle_id:String(vehicleId),object_type:"UNIT_PARAMETERS",_action_name:"vehicle_subscribe",mtkn},session_token:sessionToken,mtkn}};
        await wsFire(ws, frame, debugBuf);
      }
      await sleep(300);

      // quick command (fire)
      if (unitKey){
        const mtkn=makeMtkn();
        const flow_id=makeFlowId();
        const frame={action:{flow_id,name:"send_quick_command",parameters:{unit_key:String(unitKey),local_action_id:"5",cmd_id:"9",ack_needed:"0",_action_name:"send_quick_command",mtkn},session_token:sessionToken,mtkn}};
        await wsFire(ws, frame, debugBuf);
      }

      modInfo = await refreshModuleAdaptive(ws, sessionToken, collector, vehicleId, targetTime, ignitionOn ? maxAttempts : Math.min(2,maxAttempts), tolSec, debugBuf);
      modResp = modInfo.resp;

      parInfo = await refreshParamsAdaptive(ws, sessionToken, collector, vehicleId, unitKey, targetTime, maxAttempts, tolSec, ignitionOn, debugBuf);
      parResp = parInfo.resp;

    } finally {
      try{ ws.close(1000); }catch{}
    }

    const mod=buildModuleRelevant(modResp||{});
    const tab=buildParamsTab(parResp||{}, collector.refreshById);

    const out={
      meta:{at:nowIso(),vehicle_id:Number(vehicleId),unit_key:unitKey,note:"v4.7.2 require param values + explicit refresh"},
      header: baseJson.header || null,
      header_raw: baseJson.header_raw || null,
      module_state: { relevant: mod.relevant, rows: mod.rows },
      parameters_tab: { count_opr: tab.count_opr, count_with_value: tab.count_with_value, preview: tab.preview, rows: tab.rows, refresh_values: collector.refreshById.size },
      debug: {
        ws_debug_path: debugPath,
        ws_wait_timeout_ms: Number(process.env.WS_WAIT_TIMEOUT_MS||15000),
        ws_stream_debounce_ms: Number(process.env.WS_STREAM_DEBOUNCE_MS||700),
        ws_debug_sample_len: Number(process.env.WS_DEBUG_SAMPLE_LEN||1200),
        ignition_on: ignitionOn,
        ignition_wait: { waited_ms: ignWait.waited_ms, ign_on: ignWait.ign_on },
        target_time: targetTime ? targetTime.toISOString() : null,
        tolerance_sec: tolSec,
        max_attempts: maxAttempts,
        module_refresh: modInfo ? { reason: modInfo.reason, freshness: modInfo.freshness } : null,
        params_refresh: parInfo ? { reason: parInfo.reason, freshness: parInfo.freshness } : null,
        module_rows_found: mod.rows.length,
        params_rows_found: tab.count_opr,
        refresh_values: collector.refreshById.size,
        collector_metrics: collector.metrics,
        stream_keys: Array.from(collector.streams.keys()).slice(0,12)
      }
    };

    fs.writeFileSync(debugPath, JSON.stringify(debugBuf,null,2));
    process.stdout.write(JSON.stringify(out,null,2));
  } catch (e){
    try{ fs.writeFileSync(debugPath, JSON.stringify(debugBuf,null,2)); }catch{}
    console.error("[vm_snapshot_ws_v4] ERROR:", e?.message||String(e));
    console.error("[vm_snapshot_ws_v4] debug:", debugPath);
    process.exit(1);
  }
}

main();
