/**
 * tools/vm_snapshot_ws.js (v2)
 * Snapshot do Vehicle Monitor via WebSocket (operation.traffilog.com).
 *
 * Uso:
 *   node tools/vm_snapshot_ws.js <VEHICLE_ID>
 *
 * Requer:
 *   - MONITOR_WS_GUID
 *   - session_token (MONITOR_SESSION_TOKEN ou arquivo /tmp/.session_token)
 * Opcional:
 *   - MONITOR_WS_ORIGIN (default: https://operation.traffilog.com)
 *   - SESSION_TOKEN_PATH (default: /tmp/.session_token)
 *   - SB_SEND_ENCODE=1 (env já usado no seu worker; envia JSON via encodeURIComponent)
 */

const fs = require("fs");
const url = require("url");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readTokenFromFile(p) {
  try {
    const s = fs.readFileSync(p, "utf8").trim();
    return s || null;
  } catch { return null; }
}

function decodeStr(s) {
  if (s == null) return null;
  const str = String(s);
  try { return decodeURIComponent(str); } catch { return str; }
}

function decodeMaybe(s) {
  if (typeof s !== "string") return s;
  if (s.startsWith("%") || s.includes("%3A") || s.includes("%2B") || s.includes("%20") || s.includes("%23")) {
    try { return decodeURIComponent(s); } catch { return s; }
  }
  return s;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function mkMtkn() {
  const a = Date.now().toString();
  const b = Math.floor(Math.random() * 1e12).toString().padStart(12, "0");
  return a + b;
}

function pickActionName(msg) {
  return msg?.response?.properties?.action_name || null;
}

function pickMtkn(msg) {
  return msg?.response?.properties?.mtkn || null;
}

async function connectWs({ guid, token, origin }) {
  let Ws;
  try { Ws = require("ws"); } catch (e) {
    throw new Error("Falta dependência 'ws' no projeto. Rode: npm i ws (ou use o node do projeto que já tem).");
  }

  const wsUrl = `wss://websocket.traffilog.com:8182/${guid}/${token}/json?defragment=1`;

  const ws = new Ws(wsUrl, { headers: { Origin: origin } });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WS open timeout")), 15000);
    ws.on("open", () => { clearTimeout(t); resolve(); });
    ws.on("error", (err) => { clearTimeout(t); reject(err instanceof Error ? err : new Error(String(err))); });
  });

  return { ws, wsUrl };
}

async function wsSendAndWait(ws, { sessionToken, name, params }, timeoutMs = 15000) {
  const mtkn = mkMtkn();
  const flow_id = String(Math.floor(200000 + Math.random() * 700000));

  const frame = {
    action: {
      flow_id,
      name,
      parameters: {
        ...(params || {}),
        _action_name: name,
        mtkn,
      },
      session_token: sessionToken,
      mtkn,
    },
  };

  const wantEncode = String(process.env.SB_SEND_ENCODE || "0") === "1";
  const payload = JSON.stringify(frame);
  const wire = wantEncode ? encodeURIComponent(payload) : payload;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout aguardando resposta de ${name}`)), timeoutMs);

    function onMessage(data) {
      const raw = data?.toString?.("utf8") || String(data || "");
      const txt = decodeMaybe(raw);
      const j = safeJsonParse(txt);
      if (!j) return;

      const an = pickActionName(j);
      const m = pickMtkn(j);

      if (an === name && String(m || "") === String(mtkn)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(j);
      }
    }

    ws.on("message", onMessage);
    ws.send(wire);
  });
}

async function subscribeVehicle(ws, sessionToken, vehicleId) {
  // igual ao Monitor (v4): UNIT_MESSAGES, UNIT_CONFIG_STATUS, UNIT_PARAMETERS
  const subs = ["UNIT_MESSAGES", "UNIT_CONFIG_STATUS", "UNIT_PARAMETERS"];

  for (const ot of subs) {
    const params = { vehicle_id: String(vehicleId), object_type: ot };
    // alguns sub usam 'value': '' (não obrigatório), mas não atrapalha
    if (ot === "UNIT_CONFIG_STATUS") params.value = "";
    await wsSendAndWait(ws, { sessionToken, name: "vehicle_subscribe", params }, 15000);
    await sleep(60);
  }
}

async function unsubscribeVehicle(ws, sessionToken, vehicleId) {
  // no v4: object_type='' (unsubscribe geral)
  await wsSendAndWait(ws, {
    sessionToken,
    name: "vehicle_unsubscribe",
    params: { vehicle_id: String(vehicleId), object_type: "" },
  }, 15000);
}

async function collectRefresh(ws, msWindow = 3500) {
  const until = Date.now() + msWindow;
  const out = [];

  function onMsg(data) {
    const raw = data?.toString?.("utf8") || String(data || "");
    const txt = decodeMaybe(raw);
    const j = safeJsonParse(txt);
    if (!j) return;

    const props = j?.response?.properties || {};
    if (props.action_name !== "refresh") return;

    out.push(j);
  }

  ws.on("message", onMsg);

  while (Date.now() < until) await sleep(80);

  ws.off("message", onMsg);
  return out;
}

function indexUnitParamsFromRefresh(refreshList) {
  const map = new Map();

  for (const msg of refreshList) {
    const p = msg?.response?.properties;
    if (!p) continue;
    if (p.data_source !== "UNIT_PARAMETERS") continue;

    const rows = p.data || [];
    for (const r of rows) {
      const id = r?.id;
      if (!id) continue;

      map.set(String(id), {
        id: String(id),
        last_update: r?.orig_time || null,
        inner_id: r?.inner_id || null,
        unitType: r?.unitType || null,
        value_raw: r?.paramvalue ?? r?.param_value ?? null,
        source: r?.paramsource ?? null,
      });
    }
  }

  return map;
}

function lastUnitMessage(refreshList) {
  let last = null;

  for (const msg of refreshList) {
    const p = msg?.response?.properties;
    if (!p) continue;
    if (p.data_source !== "UNIT_MESSAGES") continue;

    const rows = p.data || [];
    for (const r of rows) last = r;
  }

  if (!last) return null;

  // decodifica campos mais comuns
  const out = { ...last };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === "string") out[k] = decodeMaybe(out[k]);
  }
  return out;
}

function buildParametersTab(oprResp, metaResp, latestById) {
  const oprRows = oprResp?.response?.properties?.data || [];
  const metaRows = metaResp?.response?.properties?.data || [];

  // metadados agrupados por id (p/ futuro: conversão)
  const metaById = new Map();
  for (const r of metaRows) {
    const id = r?.id;
    if (!id) continue;
    const arr = metaById.get(String(id)) || [];
    arr.push(r);
    metaById.set(String(id), arr);
  }

  const tab = oprRows.map(r => {
    const id = String(r.id);
    const last = latestById.get(id);

    return {
      index: r.index != null ? Number(r.index) : null,
      id,
      param_type: r.param_type != null ? Number(r.param_type) : null,
      name: decodeMaybe(r.param_type_descr || ""),
      last_update: last?.last_update || null,
      value_raw: last?.value_raw ?? null,
      source: last?.source ?? null,
      multiply_param: r.multiply_param ?? null,
      multiply_inner: r.multiply_inner ?? null,
      metadata_count: (metaById.get(id) || []).length,
    };
  });

  return { tab, metaByIdCount: metaById.size, oprCount: oprRows.length };
}

function pickModuleStatesAll(modResp) {
  const rows = modResp?.response?.properties?.data || [];
  // decodifica datas/campos encoded
  return rows.map(r => {
    const o = { ...r };
    for (const k of Object.keys(o)) {
      if (typeof o[k] === "string") o[k] = decodeMaybe(o[k]);
    }
    return o;
  });
}

function pickModuleRelevant(rowsAll) {
  // IDs relevantes (seu contexto): 8=CAN0, 9=CAN1, 15=J1708, 19=DALLAS, 20=RAMZOR
  const wantIds = ["8","9","15","19","20"];
  const foundById = new Map();

  for (const r of rowsAll) {
    const id = String(r.id);
    if (wantIds.includes(id)) foundById.set(id, r);
  }

  const out = wantIds.map(id => {
    const r = foundById.get(id);
    if (r) return r;
    return { id, missing: true, reason: "não retornou do get_monitor_module_state" };
  });

  return out;
}

async function getModuleStateRobust(ws, sessionToken, vehicleId) {
  // o Monitor chama várias vezes; fazemos 4 tentativas curtas
  let last = null;

  for (let i = 0; i < 4; i++) {
    const r = await wsSendAndWait(ws, {
      sessionToken,
      name: "get_monitor_module_state",
      params: { tag: "loading_screen", filter: "", vehicle_id: String(vehicleId) },
    }, 15000);

    const rows = r?.response?.properties?.data || [];
    if (rows.length > 0) {
      last = r;
      break;
    }
    last = r;
    await sleep(220);
  }

  return last;
}

async function main() {
  const argv = process.argv.slice(2);
  const vehicleId = argv[0];

  if (!vehicleId) {
    console.error("Uso: node tools/vm_snapshot_ws.js <VEHICLE_ID>");
    process.exit(2);
  }

  const guid = process.env.MONITOR_WS_GUID;
  if (!guid) throw new Error("Falta env MONITOR_WS_GUID");

  const origin = process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com";
  const tokenPath = process.env.SESSION_TOKEN_PATH || "/tmp/.session_token";
  const sessionToken = (process.env.MONITOR_SESSION_TOKEN || readTokenFromFile(tokenPath) || "").trim();

  if (!sessionToken || sessionToken.length < 20) {
    throw new Error(`Sem session_token. Defina MONITOR_SESSION_TOKEN ou crie ${tokenPath}`);
  }

  const { ws, wsUrl } = await connectWs({ guid, token: sessionToken, origin });

  // subscribe (pra receber refresh igual o Monitor)
  await subscribeVehicle(ws, sessionToken, vehicleId);

  // header base
  const rVehicleInfo = await wsSendAndWait(ws, {
    sessionToken,
    name: "get_vehicle_info",
    params: { tag: "loading_screen", vehicle_id: String(vehicleId) },
  }, 15000);

  const v0 = rVehicleInfo?.response?.properties?.data?.[0] || {};
  const unitKeyDecoded = decodeMaybe(v0.unit_key || null);

  // online status (redis)
  const rRedis = await wsSendAndWait(ws, {
    sessionToken,
    name: "get_vehicle_data_from_redis",
    params: { vehicle_id: String(vehicleId) },
  }, 15000);

  // definitions + metadata
  const rMeta = await wsSendAndWait(ws, {
    sessionToken,
    name: "get_unit_parameters_metadata",
    params: { filter: "", vehicle_id: String(vehicleId) },
  }, 15000);

  const rOpr = await wsSendAndWait(ws, {
    sessionToken,
    name: "get_unit_parameters_opr",
    params: { filter: "", vehicle_id: String(vehicleId) },
  }, 15000);

  // module state robust
  const rMod = await getModuleStateRobust(ws, sessionToken, vehicleId);

  // quick command (refresh online) — igual ao Monitor
  let rQuick = null;
  if (unitKeyDecoded) {
    rQuick = await wsSendAndWait(ws, {
      sessionToken,
      name: "send_quick_command",
      params: { unit_key: decodeMaybe(unitKeyDecoded), local_action_id: "5", cmd_id: "9", ack_needed: "0" },
    }, 15000);
  }

  // janela de refresh para coletar UNIT_MESSAGES + UNIT_PARAMETERS
  const refresh = await collectRefresh(ws, 4200);

  // junta parameters
  const latestById = indexUnitParamsFromRefresh(refresh);
  const paramsBuild = buildParametersTab(rOpr, rMeta, latestById);

  // pega última UNIT_MESSAGE (é o "header vivo" do Monitor)
  const lastMsg = lastUnitMessage(refresh);

  // module_state
  const modAll = pickModuleStatesAll(rMod);
  const modRelevant = pickModuleRelevant(modAll);

  // gps_last/gprs_last: do último UNIT_MESSAGES (orig_time / server_time)
  const gpsLast = lastMsg?.orig_time || decodeMaybe(v0.orig_time || null);
  const gprsLast = lastMsg?.server_time || decodeMaybe(v0.server_time || null);

  const out = {
    capturedAt: new Date().toISOString(),
    wsUrl,
    vehicleId: String(vehicleId),

    header: {
      client_id: decodeMaybe(v0.client_id || null),
      vehicle_id: decodeMaybe(v0.vehicle_id || null),
      license_nmbr: decodeMaybe(v0.license_nmbr || null),
      ignition: decodeMaybe(v0.ignition || null),

      inner_id: decodeMaybe(v0.inner_id || null),
      unit_key: unitKeyDecoded ? decodeMaybe(unitKeyDecoded).replace(/^SPT%3A/i, "SPT:") : null,
      unit_type: decodeMaybe(v0.unit_type || null),
      firmware: decodeMaybe(v0.unit_version || null),
      vcl_manufacturer: decodeMaybe(v0.vcl_manufacturer || null),
      vcl_model: decodeMaybe(v0.vcl_model || null),

      // “last updated” (pra validar se CAN está atual)
      gps_last: gpsLast ? decodeMaybe(gpsLast) : null,
      gprs_last: gprsLast ? decodeMaybe(gprsLast) : null,

      // infos necessárias p/ validação
      driver_code: decodeMaybe(lastMsg?.driver_code ?? v0.driver_code ?? null),
      mileage: decodeMaybe(lastMsg?.mileage ?? v0.mileage ?? null),
      fuel_used: decodeMaybe(lastMsg?.fuel_used ?? v0.fuel_used ?? null),
      speed: decodeMaybe(lastMsg?.speed ?? v0.speed ?? null),
      engine_hours: decodeMaybe(lastMsg?.engine_hours ?? v0.engine_hours ?? null),

      latitude: decodeMaybe(lastMsg?.latitude ?? v0.latitude ?? null),
      longitude: decodeMaybe(lastMsg?.longitude ?? v0.longitude ?? null),
      satellites: decodeMaybe(lastMsg?.satellites ?? null),
      gps_quality: decodeMaybe(lastMsg?.gps ?? null),
    },

    redis: rRedis?.response?.properties?.data?.[0] || null,

    unit_messages: {
      last: lastMsg,
      refresh_count: refresh.filter(m => m?.response?.properties?.data_source === "UNIT_MESSAGES").length,
    },

    module_state: {
      relevant: modRelevant,
      total_records: modAll.length,
      all: modAll,
    },

    parameters_tab: {
      count_opr: paramsBuild.oprCount,
      count_metadata_ids: paramsBuild.metaByIdCount,
      count_with_value: Array.from(latestById.values()).length,
      rows: paramsBuild.tab,
    },

    raw: {
      get_vehicle_info: rVehicleInfo,
      get_vehicle_data_from_redis: rRedis,
      get_unit_parameters_metadata: rMeta,
      get_unit_parameters_opr: rOpr,
      get_monitor_module_state: rMod,
      send_quick_command: rQuick,
      refresh: refresh, // mantém pro diagnóstico
    },
  };

  // unsubscribe + close
  try { await unsubscribeVehicle(ws, sessionToken, vehicleId); } catch {}
  try { ws.close(); } catch {}

  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("[vm_snapshot_ws] ERRO:", e?.message || String(e));
  process.exit(1);
});
