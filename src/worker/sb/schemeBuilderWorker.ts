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

const MONITOR_SESSION_TOKEN_PATH = (
  process.env.SESSION_TOKEN_PATH         ||
  process.env.MONITOR_SESSION_TOKEN_PATH ||
  "/tmp/.session_token"
);
const TOKEN_TTL_MS = Number(process.env.MONITOR_SESSION_TOKEN_TTL_MS || "21600000"); // 6h

if (!BASE) throw new Error("[sb-rw] API_BASE_URL não definido");
if (!KEY)  throw new Error("[sb-rw] WORKER_KEY não definido");

// ---------------------------------------------------------------------------
// Session token (mesmo padrão do monolito: timestamp:token)
// ---------------------------------------------------------------------------

function readTokenIfFresh(): string | null {
  try {
    const raw = String(fs.readFileSync(MONITOR_SESSION_TOKEN_PATH, "utf8") || "").trim();
    if (!raw) return null;
    const colonIdx = raw.indexOf(":");
    if (colonIdx > 0) {
      const ts  = Number(raw.slice(0, colonIdx));
      const tok = raw.slice(colonIdx + 1).trim();
      if (!isNaN(ts) && tok.length >= 20) {
        if (Date.now() - ts > TOKEN_TTL_MS) {
          console.log(`[sb-rw] session_token expirado — renovando`);
          return null;
        }
        return tok;
      }
    }
    return null;
  } catch { return null; }
}

async function userLoginAndGetToken(): Promise<string> {
  if (!WS_LOGIN_NAME || !WS_PASSWORD)
    throw new Error("[sb-rw] faltam envs: WS_LOGIN_NAME / WS_PASSWORD");
  const base = TRAFFILOG_API_BASE_URL.replace(/\/+$/, "");
  if (!base) throw new Error("[sb-rw] falta env: TRAFFILOG_API_BASE_URL");

  const res = await fetch(base, {
    method : "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body   : JSON.stringify({
      action: { name: "user_login", parameters: { login_name: WS_LOGIN_NAME, password: WS_PASSWORD } },
    }),
    signal: AbortSignal.timeout(20000),
  });

  const data: any = await res.json();
  const tok =
    data?.response?.properties?.session_token ||
    data?.response?.properties?.data?.[0]?.session_token;

  if (!tok || String(tok).trim().length < 20)
    throw new Error("[sb-rw] user_login não retornou session_token");
  return String(tok).trim();
}

async function ensureSessionToken(): Promise<string> {
  const cached = readTokenIfFresh();
  if (cached) { process.env.MONITOR_SESSION_TOKEN = cached; return cached; }
  const tok = await userLoginAndGetToken();
  try { fs.writeFileSync(MONITOR_SESSION_TOKEN_PATH, `${Date.now()}:${tok}\n`, { mode: 0o600 }); } catch {}
  process.env.MONITOR_SESSION_TOKEN = tok;
  return tok;
}

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
        // LOG DIAGNÓSTICO — remover após confirmar funcionamento

        try {
          const obj = JSON.parse(text);
          if (!obj) return;

          // 1. Correlaciona por mtkn PRIMEIRO — ignora mensagens de outras operações
          const mt = obj?.mtkn ?? obj?.response?.properties?.mtkn ?? obj?.response?.mtkn ?? obj?.action?.mtkn;
          if (mt != null && String(mt) !== want && String(mt) !== "") return;

          // 2. Só agora verifica action_value — garante que é a resposta correta
          const av  = String(obj?.action_value ?? obj?.response?.properties?.action_value ?? "");
          const err = String(obj?.error_description ?? obj?.response?.properties?.error_description ?? "");

          if (av && av !== "0" && !obj?.response) {
            clearTimeout(t);
            ws.removeListener("message", onMsg);
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
    const SB_SILENCE_MAX_WAIT_MS = 300000; // espera até 5min pelo retorno
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
    await sleep(500);

    // 2. associate call_num=0
    sendFrame("associate_vehicles_actions_opr", {
      client_id    : String(clientId),
      client_name  : String(clientName),
      action_source: "0",
      action_id    : "1",
      call_num     : "0",
      tag          : "loading_screen",
    });
    await sleep(500);

    // 3. associate call_num=1 (com vehicle_setting_id)
    sendFrame("associate_vehicles_actions_opr", {
      client_id         : String(clientId),
      client_name       : String(clientName),
      vehicle_setting_id: String(vehicleSettingId),
      action_source     : "0",
      action_id         : "1",
      call_num          : "1",
    });
    await sleep(500);

    // 4. review_process_attributes
    sendFrame("review_process_attributes", {
      client_id: String(clientId),
    });
    await sleep(3000); // aguarda Traffilog processar o associate antes do get_vcls

    // 5. get_vcls_action_review_opr → process_id (retry até 3x se 404)
    let reviewRow: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await sleep(3000); // backoff entre tentativas
      const mtReview = sendFrame("get_vcls_action_review_opr", {
        client_id    : String(clientId),
        client_name  : String(clientName),
        action_source: "0",
      });
      try {
        reviewRow = await waitRowByMtkn(mtReview, 20000);
        break;
      } catch (e: any) {
        const is404 = String(e?.message || "").includes("action_value=404");
        if (is404 && attempt < 3) {
          console.log(`[sb-rw] job=${jobId} get_vcls 404 tentativa ${attempt}/3 — retry em 3s`);
          continue;
        }
        throw e;
      }
    }

    let processId = String(reviewRow?.process_id ?? "");
    if (!processId) {
      const d = reviewRow?.response?.properties?.data;
      if (Array.isArray(d)) {
        for (const it of d) {
          const pid = it?.process_id ?? it?.processId ?? it?.processID ?? it?.properties?.process_id;
          if (pid) { processId = String(pid); break; }
        }
      }
    }
    if (!processId) {
      // Não falha — SB pode já estar rodando, waitSbCompleted detecta via UNIT_CONFIG_STATUS
      console.log(`[sb-rw] job=${jobId} WARN: process_id não veio — reviewRow RAW=` +
        JSON.stringify(reviewRow).slice(0, 400));
      console.log(`[sb-rw] job=${jobId} continuando sem process_id — waitSbCompleted detecta via push`);
    } else {
      console.log(`[sb-rw] job=${jobId} process_id=${processId}`);
    }

    // 6a. get_vehicle_info — registra contexto no servidor (necessário para receber pushes)
    sendFrame("get_vehicle_info", {
      vehicle_id: String(vehicleId),
      client_id : String(clientId),
    });
    await sleep(800);

    // 6b. vehicle_subscribe UNIT_MESSAGES — servidor exige para liberar UNIT_CONFIG_STATUS
    sendFrame("vehicle_subscribe", {
      vehicle_id : String(vehicleId),
      object_type: "UNIT_MESSAGES",
    });
    await sleep(500);

    // 6c. vehicle_subscribe UNIT_CONFIG_STATUS — CRÍTICO: ANTES do execute
    sendFrame("vehicle_subscribe", {
      vehicle_id : String(vehicleId),
      object_type: "UNIT_CONFIG_STATUS",
    });
    await sleep(500);

    // 7. execute_action_opr
    const mtExec = sendFrame("execute_action_opr", {
      client_id    : String(clientId),
      client_name  : String(clientName),
      vehicle_id   : String(vehicleId),
      process_id   : Number(processId),
      action_source: "0",
      tag          : "loading_screen",
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
  const clientName        = String(payload.clientName       ?? payload.client_name        ?? "");
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
    try { sessionToken = await ensureSessionToken(); }
    catch (e: any) { console.log(`[sb-rw] falha ao obter session_token: ${e?.message || e}`); }
  }

  if (!sessionToken) { await failJob(jobId, "session_token_unavailable"); return; }

  try {
    await runSbFlow({ clientId, clientName, vehicleId, vehicleSettingId, comment, sessionToken, jobId });
    await completeJob(jobId, { ok: true, status: "ok" });
    console.log(`[sb-rw] job=${jobId} SB OK`);
  } catch (e: any) {
    const msg = String(e?.message || e);
    console.log(`[sb-rw] job=${jobId} FALHOU: ${msg}`);

    const isDisconnected = msg.includes("disconnected") || msg.includes("silence timeout");
    const isTimeout      = msg.includes("timeout") && !isDisconnected;

    if (isDisconnected) {
      await failJob(jobId, "sb_disconnected", msg);
    } else if (isTimeout) {
      await failJob(jobId, "sb_timeout", msg);
    } else {
      await failJob(jobId, "sb_flow_error", msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------------

async function loop(): Promise<void> {
  console.log(`[sb-rw] iniciando poll BASE=${BASE} POLL_MS=${POLL_MS} (REWRITE_SB_NATIVE_V1)`);
  try {
    const tok = await ensureSessionToken();
    console.log(`[sb-rw] session_token pronto no boot (len=${tok.length})`);
  } catch (e: any) {
    console.error("[sb-rw] AVISO: falha ao renovar token no boot:", e?.message || e);
  }

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
