/**
 * schemeBuilderWorker.ts — Scheme Builder Worker (REWRITE v2)
 *
 * REWRITE_SB_NATIVE_V1: elimina subprocess (sb_run_vm.js) completamente.
 * Executa o fluxo WS diretamente em TypeScript, idêntico ao settingsService.ts
 * do Internal Tools (validado em sessão 13 com equipamento real).
 *
 * Fluxo:
 *   1. vcls_check_opr
 *   2. associate_vehicles_actions_opr call_num=0
 *   3. associate_vehicles_actions_opr call_num=1 (com vehicle_setting_id)
 *   4. review_process_attributes
 *   5. get_vcls_action_review_opr → process_id
 *   6. vehicle_subscribe UNIT_CONFIG_STATUS (ANTES do execute)
 *   7. execute_action_opr (toggle_check=1)
 *   8. waitSbCompleted: pushes UNIT_CONFIG_STATUS + resubscrição a cada 15s
 *      + silence watchdog + timeout 12min
 *
 * FIX_SB_PIPELINE_V1: silence timeout agora completa o job (em vez de falhar)
 *   para avançar o pipeline para monitor_can_snapshot.
 * FIX_SB_RAW_LOG_V1: log raw de todos os pushes recebidos após execute
 *   para diagnosticar UNIT_CONFIG_STATUS.
 */

import WebSocket from "ws";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE      = (process.env.API_BASE_URL || "").replace(/\/$/, "");
const KEY       = (process.env.WORKER_KEY   || "").trim();
const WORKER_ID = process.env.WORKER_ID     || "sb-rw";
const POLL_MS   = Number(process.env.POLL_INTERVAL_MS || "4000");

const TRAFFILOG_API_BASE_URL = (
  process.env.TRAFFILOG_API_BASE_URL ||
  process.env.TRAFFILOG_API_URL      ||
  process.env.MONITOR_API_BASE_URL   || ""
).trim();

const WS_LOGIN_NAME = (process.env.WS_LOGIN_NAME || process.env.MONITOR_LOGIN_NAME || "").trim();
const WS_PASSWORD   = (process.env.WS_PASSWORD   || process.env.MONITOR_PASSWORD   || "").trim();
const WS_ORIGIN     = (process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com").trim();


if (!BASE) throw new Error("[sb-rw] API_BASE_URL não definido");
if (!KEY)  throw new Error("[sb-rw] WORKER_KEY não definido");
import { getTrafflogToken, invalidateTrafflogToken } from "../../core/traffilogAuth.js";

// ---------------------------------------------------------------------------
// Session token — obtido via HTTP por job (getTrafflogToken)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WS helpers (padrão openRawWs do wsClient.ts)
// ---------------------------------------------------------------------------

function makeGuid(): string {
  const h = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `${h()}-${h().slice(0,4)}-${h().slice(0,4)}-${h().slice(0,4)}-${h()}${h().slice(0,4)}`.toUpperCase();
}

async function openRawWs(sessionToken: string): Promise<WebSocket> {
  const guid = (process.env.MONITOR_WS_GUID || makeGuid()).trim();
  const url  = `wss://websocket.traffilog.com:8182/${guid}/${sessionToken}/json?defragment=1`;

  const ws = new WebSocket(url, {
    headers: {
      "Pragma"          : "no-cache",
      "Cache-Control"   : "no-cache",
      "User-Agent"      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      "Accept-Language" : "pt-BR,pt;q=0.9",
    },
    origin             : WS_ORIGIN,
    handshakeTimeout   : 15000,
    perMessageDeflate  : { clientMaxWindowBits: 15 },
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open",  () => resolve());
    ws.once("error", reject);
    ws.once("close", (code, reason) =>
      reject(new Error(`WS fechou antes do open. code=${code} reason=${reason}`))
    );
  });

  return ws;
}

function genFlowId(): string {
  return String(200000 + Math.floor(Math.random() * 800000));
}
function genMtkn(): string {
  const now = Date.now().toString();
  let rnd = Math.floor(Math.random() * 1e12).toString();
  while (rnd.length < 12) rnd = "0" + rnd;
  return now + rnd;
}
function decodeMaybe(s: string): string {
  if (s.startsWith("%7B") || s.startsWith("%7b")) {
    try { return decodeURIComponent(s); } catch {}
  }
  return s;
}

function buildSendFrame(
  actionName: string,
  params: Record<string, unknown>,
  sessionToken: string
): { mtkn: string; json: string } {
  const mtkn = genMtkn();
  const frame = {
    action: {
      flow_id  : genFlowId(),
      name     : actionName,
      parameters: { ...params, _action_name: actionName, mtkn: String(mtkn) },
      session_token: String(sessionToken),
      mtkn     : String(mtkn),
    }
  };
  return { mtkn, json: JSON.stringify(frame) };
}

// ---------------------------------------------------------------------------
// Fluxo SB nativo
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function findFirstKey(obj: any, keys: string[]): any {
  const seen = new Set();
  function walk(x: any): any {
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

async function runSbFlow(params: {
  clientId       : string;
  clientName     : string;
  vehicleId      : string;
  vehicleSettingId: string;
  comment        : string;
  sessionToken   : string;
  jobId          : string;
}): Promise<void> {
  const { clientId, clientName, vehicleId, vehicleSettingId, comment, sessionToken, jobId } = params;

  const ws = await openRawWs(sessionToken);

  // Função de envio local com log
  function sendFrame(actionName: string, frameParams: Record<string, unknown>): string {
    const { mtkn, json } = buildSendFrame(actionName, frameParams, sessionToken);
    ws.send(json);
    console.log(`[sb-rw] job=${jobId} >> ${actionName} mtkn=${mtkn} frame=${json.slice(0, 200)}`);
    return mtkn;
  }

  // Aguarda resposta correlacionada por mtkn
  function waitRowByMtkn(mtkn: string, timeoutMs = 20000): Promise<any> {
    const want = String(mtkn);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        ws.removeListener("message", onMsg);
        reject(new Error(`Timeout esperando mtkn=${want}`));
      }, timeoutMs);

      function onMsg(data: any) {
        const text = decodeMaybe(String(data));
        try {
          const obj = JSON.parse(text);
          if (!obj) return;

          // 1. Correlaciona por mtkn PRIMEIRO — ignora mensagens de outras operações
          const mt = obj?.mtkn ?? obj?.response?.properties?.mtkn ?? obj?.response?.mtkn ?? obj?.action?.mtkn;
          if (mt != null && String(mt) !== want && String(mt) !== "") return;

          // 2. Só agora verifica action_value — garante que é a resposta correta
          const av  = String(obj?.action_value ?? obj?.response?.properties?.action_value ?? "");
          const err = String(obj?.error_description ?? obj?.response?.properties?.error_description ?? "");

          const ERROR_AV = ["400","403","404","500"];
          if (av && ERROR_AV.includes(av)) {
            clearTimeout(t);
            ws.removeListener("message", onMsg);
            console.log(`[sb-rw] waitRowByMtkn REJECT RAW=${JSON.stringify(obj).slice(0,600)}`);
            reject(new Error(`action_value=${av}${err ? ` err=${err}` : ""}`));
            return;
          }

          if (obj.process_id || !obj.response || obj?.response?.properties) {
            clearTimeout(t);
            ws.removeListener("message", onMsg);
            resolve(obj);
          }
        } catch {}
      }
      ws.on("message", onMsg);
    });
  }

  // Aguarda conclusão via pushes UNIT_CONFIG_STATUS (resubscrição + silence watchdog)
  function waitSbCompleted(): Promise<{ status: string; progress: string }> {
    const SB_MAX_WAIT_MS         = 720000; // 12min
    const SB_SILENCE_TIMEOUT_MS  = 30000;  // 30s sem frame → silence
    const SB_SILENCE_MAX_WAIT_MS = 90000;  // espera até 90s (veículo offline: evita 5min de espera)
    const SB_DISCONNECTED = ["Disconnected Unit", "Disconnected", "Retry", "Batch Timeout", "Internal Timeout"];

    return new Promise((resolve, reject) => {
      let lastStatus   = "";
      let lastProgress = "";
      let lastPacketAt = Date.now();
      let silenceAlerted  = false;
      let silenceDeadline = 0;
      let resolved = false;

      function cleanup() {
        clearInterval(resubInterval);
        clearInterval(silenceWatchdog);
        clearTimeout(globalTimeout);
        ws.removeListener("message", onMsg);
      }

      // Resubscrição keepalive a cada 15s
      const resubInterval = setInterval(() => {
        if (resolved) return;
        sendFrame("vehicle_subscribe", {
          vehicle_id : String(vehicleId),
          object_type: "UNIT_CONFIG_STATUS",
        });
        console.log(`[sb-rw] job=${jobId} SB_WAIT resubscribe keepalive`);
      }, 15000);

      // Watchdog de silêncio
      const silenceWatchdog = setInterval(() => {
        if (resolved) return;
        const silentMs = Date.now() - lastPacketAt;

        if (!silenceAlerted && silentMs > SB_SILENCE_TIMEOUT_MS) {
          silenceAlerted  = true;
          silenceDeadline = Date.now() + SB_SILENCE_MAX_WAIT_MS;
          console.log(`[sb-rw] job=${jobId} SB_SILENCE: ${Math.round(silentMs / 1000)}s sem pacote (progress=${lastProgress}%) — aguardando reconexão por até ${SB_SILENCE_MAX_WAIT_MS / 1000}s`);
        }

        if (silenceAlerted && Date.now() > silenceDeadline) {
          resolved = true;
          cleanup();
          reject(new Error(`SB silence timeout — equipamento não retornou após ${SB_SILENCE_MAX_WAIT_MS / 1000}s (progress=${lastProgress}%)`));
        }
      }, 5000);

      // Timeout global
      const globalTimeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new Error(`SB timeout após ${SB_MAX_WAIT_MS / 1000}s — último status="${lastStatus}" progress="${lastProgress}%"`));
      }, SB_MAX_WAIT_MS);

      function onMsg(data: any) {
        const text = decodeMaybe(String(data));

        // FIX_SB_RAW_LOG_V1: loga TUDO que chega após o execute para diagnóstico
        // Remove este bloco após confirmar que os pushes chegam corretamente
        try {
          const obj = JSON.parse(text);
          const rp  = obj?.response?.properties;
          if (rp) {
            console.log(`[sb-rw] job=${jobId} SB_RAW action_name="${rp.action_name ?? ""}" data_source="${rp.data_source ?? ""}" data=${JSON.stringify(rp.data ?? []).slice(0, 300)}`);
          }
        } catch {}

        try {
          const obj = JSON.parse(text);
          const rp  = obj?.response?.properties;
          if (!rp) return;
          if (rp.action_name !== "refresh") return;
          if (rp.data_source !== "UNIT_CONFIG_STATUS") return;

          const push = Array.isArray(rp.data) ? rp.data[0] : null;
          if (!push) return;

          lastPacketAt = Date.now();
          if (silenceAlerted) {
            silenceAlerted  = false;
            silenceDeadline = 0;
            console.log(`[sb-rw] job=${jobId} SB_SILENCE_RESOLVED equipamento reconectou (progress=${lastProgress}%)`);
          }

          const status   = String(push.status   ?? "").trim();
          const progress = String(push.progress  ?? "").trim();
          const type     = String(push.type      ?? "").trim();
          const error    = String(push.error     ?? "").trim();

          if (`${status}|${progress}` !== `${lastStatus}|${lastProgress}`) {
            lastStatus   = status;
            lastProgress = progress;
            console.log(`[sb-rw] job=${jobId} SB_WAIT status="${status}" progress="${progress}%" type="${type}" error="${error}"`);

            // FIX_SB_PROGRESS_RT_V1: reporta progresso ao backend para o frontend atualizar a barra em tempo real.
            // Fire-and-forget de propósito: sem await e com .catch vazio, para NÃO bloquear o processamento dos pushes.
            fetch(`${BASE}/api/jobs/${jobId}/progress`, {
              method : "POST",
              headers: { "Content-Type": "application/json" },
              body   : JSON.stringify({
                worker_key: KEY,
                progress  : parseFloat(progress) || 0,
                status,
                message   : status,
              }),
            }).catch(() => {});
          }

          const pct            = parseFloat(progress) || 0;
          const isDone         = status === "Completed" || status === "Done" || pct >= 99.9;
          const isError        = status === "error" || status === "Error" || (error.length > 0 && error.trim() !== "");
          const isDisconnected = SB_DISCONNECTED.some(s => status.includes(s));

          if ((isDone || isError || isDisconnected) && !resolved) {
            resolved = true;
            cleanup();
            if (isDisconnected) {
              reject(new Error(`SB disconnected: status="${status}" progress="${progress}"`));
            } else if (isError && !isDone) {
              reject(new Error(`SB error: status="${status}" error="${error}"`));
            } else {
              resolve({ status, progress });
            }
          }
        } catch {}
      }
      ws.on("message", onMsg);
    });
  }

  try {
    // 1. vcls_check_opr
    sendFrame("vcls_check_opr", {
      client_id  : String(clientId),
      vehicle_id : String(vehicleId),
      client_name: String(clientName),
      is_checked : "1",
    });
    await sleep(300);  // reduzido: gap necessário para o servidor registrar vcls_check

    // 2. associate — dois fire-and-forget (igual monolito)
    // call_num=0: prepara assign setting (sem vehicle_id, sem vehicle_setting_id)
    sendFrame("associate_vehicles_actions_opr", {
      tag          : "loading_screen",
      client_id    : String(clientId),
      client_name  : String(clientName),
      action_source: "0",
      action_id    : "1",
      call_num     : "0",
    });
    await sleep(500);  // reduzido: gap necessário entre associate call_num=0 e call_num=1
    // call_num=1: aguardar resposta antes de ir pro review
    const mtAssoc1 = sendFrame("associate_vehicles_actions_opr", {
      client_id          : String(clientId),
      client_name        : String(clientName),
      vehicle_setting_id : String(vehicleSettingId),
      action_source      : "0",
      action_id          : "1",
      call_num           : "1",
    });
    const assoc1Row = await waitRowByMtkn(mtAssoc1, 20000);
    const avAssoc1 = String(findFirstKey(assoc1Row, ["action_value"]) ?? "");
    console.log(`[sb-rw] job=${jobId} associate call_num=1 av=${avAssoc1}`);
    await sleep(300);

    // 3. review_process_attributes — igual monolito: só client_id
    await sleep(100);
    let processId = "";
    const mt2 = sendFrame("review_process_attributes", {
      client_id: String(clientId),
    });
    const r2  = await waitRowByMtkn(mt2, 20000);
    const av2 = String(findFirstKey(r2, ["action_value"]) ?? "");
    console.log(`[sb-rw] job=${jobId} review RAW=${JSON.stringify(r2).slice(0,400)}`);
    if (av2 === "403") throw new Error("403 action forbidden (review_process_attributes)");
    processId = String(findFirstKey(r2, ["process_id", "processId"]) ?? "");
    console.log(`[sb-rw] job=${jobId} review OK av=${av2} processId=${processId}`);

    const mt3 = sendFrame("get_vcls_action_review_opr", {
      client_id    : String(clientId),
      client_name  : String(clientName),
      action_source: "0",
    });
    const reviewRow = await waitRowByMtkn(mt3, 20000);
    const av3 = String(findFirstKey(reviewRow, ["action_value"]) ?? "");
    if (av3 === "403") throw new Error("403 action forbidden (get_vcls)");
    if (av3 === "404") throw new Error("404 get_vcls — process_id não encontrado no Traffilog");
    processId = processId || String(findFirstKey(reviewRow, ["process_id", "processId"]) ?? "");
    console.log(`[sb-rw] job=${jobId} get_vcls OK av=${av3} processId=${processId}`);
    if (!processId) {
      if (avAssoc1 === "1") {
        // av=1 = scheme já estava associado (retentativa); sem processo pendente = já aplicado
        console.log(`[sb-rw] job=${jobId} av_assoc=1 + sem process_id → scheme já aplicado, avançando para CAN`);
        try { ws.close(); } catch {}
        return;
      }
      throw new Error("process_id nao retornado pelo Traffilog — abortando SB");
    }

    // 6a. get_vehicle_info — registra contexto no servidor (necessário para receber pushes)
    sendFrame("get_vehicle_info", {
      vehicle_id: String(vehicleId),
      client_id : String(clientId),
    });
    await sleep(300);

    // 6b. vehicle_subscribe UNIT_MESSAGES — servidor exige para liberar UNIT_CONFIG_STATUS
    sendFrame("vehicle_subscribe", {
      vehicle_id : String(vehicleId),
      object_type: "UNIT_MESSAGES",
    });
    await sleep(200);

    // 6c. vehicle_subscribe UNIT_CONFIG_STATUS — CRÍTICO: ANTES do execute
    sendFrame("vehicle_subscribe", {
      vehicle_id : String(vehicleId),
      object_type: "UNIT_CONFIG_STATUS",
    });
    await sleep(200);

    // 7. execute_action_opr
    const mtExec = sendFrame("execute_action_opr", {
      tag          : "loading_screen",
      client_id    : String(clientId),
      action_source: "0",
      process_id   : String(processId),
      comment      : String(comment),
      toggle_check : "1",
    });
    await waitRowByMtkn(mtExec);
    console.log(`[sb-rw] job=${jobId} execute_action_opr OK — aguardando push UNIT_CONFIG_STATUS...`);

    // 8. Aguarda conclusão real via pushes UNIT_CONFIG_STATUS
    const result = await waitSbCompleted();
    console.log(`[sb-rw] job=${jobId} SB concluído status="${result.status}" progress="${result.progress}%"`);

  } finally {
    try { ws.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function pollNextJob(): Promise<any | null> {
  const res = await fetch(`${BASE}/api/jobs/next`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ worker_key: KEY, worker_id: WORKER_ID, job_type: "scheme_builder" }),
  });
  if (res.status === 204) return null;
  if (!res.ok) { console.log(`[sb-rw] poll HTTP ${res.status}`); return null; }
  const data = await res.json() as any;
  const job  = data?.job ?? data;
  return job?.id ? job : null;
}

async function completeJob(jobId: string, result: any): Promise<void> {
  await fetch(`${BASE}/api/jobs/${jobId}/complete`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ worker_key: KEY, result }),
  });
}

async function failJob(jobId: string, reason: string, detail?: any): Promise<void> {
  await fetch(`${BASE}/api/jobs/${jobId}/complete`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ worker_key: KEY, status: "error", result: { reason, detail } }),
  });
}

// ---------------------------------------------------------------------------
// Processamento de job
// ---------------------------------------------------------------------------

async function processJob(job: any): Promise<void> {
  const jobId   = String(job.id || "");
  const payload = job.payload || {};

  const vehicleId         = String(payload.vehicleId        ?? payload.vehicle_id         ?? "");
  const vehicleSettingId  = String(payload.vehicleSettingId ?? payload.vehicle_setting_id ?? "");
  const clientId          = String(payload.clientId         ?? payload.client_id          ?? "");
  const clientName        = String(payload.clientName       ?? payload.client_name        ?? payload.client_descr       ?? "");
  const comment           = String(payload.comment          ?? "");

  console.log(`[sb-rw] job=${jobId} vehicleId=${vehicleId} clientId=${clientId} settingId=${vehicleSettingId}`);

  if (!vehicleId)        { await failJob(jobId, "vehicle_id_ausente");          return; }
  if (!vehicleSettingId) { await failJob(jobId, "vehicle_setting_id_ausente");  return; }
  if (!clientId)         { await failJob(jobId, "client_id_ausente");           return; }

  // Garante session token
  let sessionToken = String(payload.sessionToken ?? payload.session_token ?? "").trim();

  // TOKEN_SANITIZE_V1: remove prefixo timestamp: se vier do payload
  if (sessionToken.includes(":") && sessionToken.indexOf(":") < 20) {
    sessionToken = sessionToken.slice(sessionToken.indexOf(":") + 1).trim();
  }

  if (!sessionToken) {
    // até 3 tentativas com backoff para absorver falhas transitórias de rede
    for (let t = 1; t <= 3 && !sessionToken; t++) {
      try { sessionToken = await getTrafflogToken(); }
      catch (e: any) {
        console.log(`[sb-rw] falha ao obter session_token tentativa ${t}/3: ${e?.message || e}`);
        if (t < 3) await new Promise(r => setTimeout(r, 8000 * t));
      }
    }
  }

  if (!sessionToken) {
    // falha transitória de autenticação — reseta para pending em vez de error permanente
    console.log(`[sb-rw] job=${jobId} session_token_unavailable → resetando para pending (retry automático)`);
    await fetch(`${BASE}/api/jobs/${jobId}/retry`, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ worker_key: KEY }),
    }).catch(() => {});
    return;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await runSbFlow({ clientId, clientName, vehicleId, vehicleSettingId, comment, sessionToken, jobId });
      await completeJob(jobId, { ok: true, status: "ok" });
      console.log(`[sb-rw] job=${jobId} SB OK`);
      return;
    } catch (e: any) {
      const msg = String(e?.message || e);
      console.log(`[sb-rw] job=${jobId} tentativa ${attempt}/2 FALHOU: ${msg}`);

      // Handshake timeout: WS não abriu — retry com token fresco
      const isHandshakeTimeout = msg.includes("handshake") || msg.includes("timed out");
      if (isHandshakeTimeout && attempt === 1) {
        console.log(`[sb-rw] job=${jobId} WS handshake timeout → token fresco + retry em 5s`);
        invalidateTrafflogToken();
        try { sessionToken = await getTrafflogToken(); } catch {}
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const isDisconnected = msg.includes("disconnected") || msg.includes("silence timeout");
      const isTimeout      = msg.includes("timeout") && !isDisconnected && !isHandshakeTimeout;
      const isWsOpen       = msg.includes("WS fechou") || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND");

      if (isWsOpen || isHandshakeTimeout) invalidateTrafflogToken();

      if (isDisconnected) {
        // SB provavelmente rodou no equipamento — completa o job para avançar pipeline para CAN.
        console.log(`[sb-rw] job=${jobId} SB_DISCONNECTED → completando como ok (avança para CAN)`);
        await completeJob(jobId, { ok: true, status: "completed_no_push", detail: msg });
      } else if (isTimeout) {
        await failJob(jobId, "sb_timeout", msg);
      } else {
        await failJob(jobId, "sb_flow_error", msg);
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------------

async function loop(): Promise<void> {
  console.log(`[sb-rw] iniciando poll BASE=${BASE} POLL_MS=${POLL_MS} (REWRITE_SB_NATIVE_V1)`);
  // [MIGRADO] warm-up removido — token obtido por job via getTrafflogToken()

  while (true) {
    try {
      const job = await pollNextJob();
      if (job) {
        processJob(job).catch((err: any) =>
          console.error(`[sb-rw] processJob unhandled: ${err?.message || String(err)}`)
        );
      }
    } catch (err: any) {
      console.error("[sb-rw] poll erro:", err?.message || String(err));
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

async function runForever(): Promise<void> {
  while (true) {
    try { await loop(); }
    catch (e) { console.error("[sb-rw] loop caiu:", e); await new Promise(r => setTimeout(r, 15000)); }
  }
}


runForever().catch(e => console.error("[sb-rw] fatal:", e));
