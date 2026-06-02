/**
 * gsWorker.ts — G-Sensor Calibration Worker (REWRITE)
 *
 * GS_WORKER_V1
 * Consome jobs "gs_calibration" da API do rewrite.
 * Envia o comando o2w via WebSocket (mesmo fluxo do commandService do Internal Tools).
 *
 * Campos obrigatórios no payload:
 *   - clientId        : ID do cliente no Traffilog
 *   - clientName      : nome do cliente
 *   - vehicleId       : ID do veículo
 *   - GS_COMMAND_SYNTAX: comando o2w (ex: "(o2w,44,C614FC00...)")
 *   - GS_ACTION_ID    : identificador semântico (ex: "GS_UP_BACK") — usado só em log
 *   - plate           : placa (para log)
 */

import WebSocket from "ws";
import * as fs from "fs";
import { getTrafflogToken } from "../../core/traffilogAuth.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE      = (process.env.API_BASE_URL || "").replace(/\/$/, "");
const KEY       = (process.env.WORKER_KEY   || "").trim();
const WORKER_ID = process.env.WORKER_ID     || "gs-rw";
const POLL_MS   = Number(process.env.POLL_INTERVAL_MS || "4000");
const MAX_IDLE  = Number(process.env.GS_MAX_IDLE_MS   || "60000");
const BACKOFF   = 1.6;

const TRAFFILOG_API_BASE_URL = (
  process.env.TRAFFILOG_API_BASE_URL ||
  process.env.TRAFFILOG_API_URL      ||
  process.env.MONITOR_API_BASE_URL   || ""
).trim();

const WS_ORIGIN = (process.env.MONITOR_WS_ORIGIN || "https://operation.traffilog.com").trim();


if (!BASE) throw new Error("[gs-rw] API_BASE_URL não definido");
if (!KEY)  throw new Error("[gs-rw] WORKER_KEY não definido");

// ---------------------------------------------------------------------------
// Session token — obtido via HTTP por job (getTrafflogToken)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WebSocket helpers (mesmo padrão do sbWorker)
// ---------------------------------------------------------------------------

function makeGuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function openRawWs(sessionToken: string): Promise<WebSocket> {
  const guid = (process.env.MONITOR_WS_GUID || makeGuid()).trim();
  const url  = `wss://websocket.traffilog.com:8182/${guid}/${sessionToken}/json?defragment=1`;
  const ws = new WebSocket(url, {
    headers: {
      "Pragma"         : "no-cache",
      "Cache-Control"  : "no-cache",
      "User-Agent"     : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      "Accept-Language": "pt-BR,pt;q=0.9",
    },
    origin            : WS_ORIGIN,
    handshakeTimeout  : 15000,
    perMessageDeflate : { clientMaxWindowBits: 15 },
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
      flow_id      : genFlowId(),
      name         : actionName,
      parameters   : { ...params, _action_name: actionName, mtkn: String(mtkn) },
      session_token: String(sessionToken),
      mtkn         : String(mtkn),
    }
  };
  return { mtkn, json: JSON.stringify(frame) };
}

// ---------------------------------------------------------------------------
// Fluxo GS — baseado no commandService.ts do Internal Tools
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function runGsFlow(params: {
  clientId      : string;
  clientName    : string;
  vehicleId     : string;
  commandSyntax : string;
  actionId      : string;
  comment       : string;
  sessionToken  : string;
  jobId         : string;
}): Promise<void> {
  const { clientId, clientName, vehicleId, commandSyntax, actionId, comment, sessionToken, jobId } = params;

  const ws = await openRawWs(sessionToken);

  function sendFrame(actionName: string, frameParams: Record<string, unknown>): string {
    const { mtkn, json } = buildSendFrame(actionName, frameParams, sessionToken);
    ws.send(json);
    console.log(`[gs-rw] job=${jobId} >> ${actionName} mtkn=${mtkn}`);
    return mtkn;
  }

  function waitRowByMtkn(mtkn: string, timeoutMs = 20000): Promise<any> {
    const want = String(mtkn);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        ws.removeListener("message", onMsg);
        reject(new Error(`Timeout esperando mtkn=${want}`));
      }, timeoutMs);

      function onMsg(data: any) {
        const text = decodeMaybe(String(data));
        if (!text.includes(want) && !text.includes('"response"')) return;
        try {
          const obj = JSON.parse(text);
          if (!obj) return;
          const av0  = String(obj?.action_value ?? obj?.response?.properties?.action_value ?? "");
          const err0 = String(obj?.error_description ?? obj?.response?.properties?.error_description ?? "");
          if (av0 && av0 !== "0" && av0 !== "403" && !obj?.response) { // FIX_GS_403_IGNORE_V1
            clearTimeout(t);
            ws.removeListener("message", onMsg);
            reject(new Error(`action_value=${av0}${err0 ? ` err=${err0}` : ""}`));
            return;
          }
          const mt = obj?.mtkn ?? obj?.response?.properties?.mtkn ?? obj?.response?.mtkn ?? obj?.action?.mtkn;
          if (mt != null && String(mt) !== want && String(mt) !== "") return;
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

  try {
    // 1. vcls_check_opr
    sendFrame("vcls_check_opr", {
      client_id  : String(clientId),
      vehicle_id : String(vehicleId),
      client_name: String(clientName),
      is_checked : "1",
    });
    await sleep(300);

    // 2. associate call_num=0 (action_id=5 = Command)
    sendFrame("associate_vehicles_actions_opr", {
      client_id  : String(clientId),
      client_name: String(clientName),
      action_source: "0",
      action_id  : "5",
      call_num   : "0",
    });
    await sleep(300);

    // 3. get_custom_command
    const mtGetCmd = sendFrame("get_custom_command", {
      client_id: String(clientId),
    });
    await waitRowByMtkn(mtGetCmd);

    // 4. add_remove_custom_command — registra o comando o2w
    const mtAdd = sendFrame("add_remove_custom_command", {
      client_id        : String(clientId),
      acknowledge_needed: "1",
      command_syntax   : String(commandSyntax),
      action_value     : "0",
    });
    await waitRowByMtkn(mtAdd);

    // 5. associate call_num=1
    sendFrame("associate_vehicles_actions_opr", {
      client_id    : String(clientId),
      client_name  : String(clientName),
      action_source: "0",
      action_id    : "5",
      call_num     : "1",
      keep_priority: "true",
      comment      : comment,
    });
    await sleep(300);

    // 6. review_process_attributes
    sendFrame("review_process_attributes", {
      client_id: String(clientId),
    });
    await sleep(200);

    // 7. get_vcls_action_review_opr → process_id
    const mtReview = sendFrame("get_vcls_action_review_opr", {
      client_id    : String(clientId),
      client_name  : String(clientName),
      action_source: "0",
    });
    const reviewRow = await waitRowByMtkn(mtReview);

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
      throw new Error(
        `process_id não encontrado. reviewRow=${JSON.stringify(reviewRow).slice(0, 400)}`
      );
    }

    // 8. execute_action_opr
    const mtExec = sendFrame("execute_action_opr", {
      client_id    : String(clientId),
      action_source: "0",
      process_id   : String(processId),
      comment      : String(comment || ""),
      toggle_check : "0",
    });
    await waitRowByMtkn(mtExec);

    console.log(`[gs-rw] job=${jobId} GS OK action=${actionId} process_id=${processId}`);
  } finally {
    try { ws.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// API helpers (job queue)
// ---------------------------------------------------------------------------

async function pollNextJob(): Promise<any | null> {
  const res = await fetch(`${BASE}/api/jobs/next`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ worker_key: KEY, worker_id: WORKER_ID, job_type: "gs_calibration" }),
  });
  if (res.status === 204) return null;
  if (!res.ok) { console.log(`[gs-rw] poll HTTP ${res.status}`); return null; }
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
// Processamento
// ---------------------------------------------------------------------------

async function processJob(job: any): Promise<void> {
  const jobId = String(job.id || "");
  const p     = job.payload || {};

  const clientId      = String(p.clientId      ?? p.client_id      ?? "");
  const clientName    = String(p.clientName    ?? p.client_name    ?? "");
  const vehicleId     = String(p.vehicleId     ?? p.vehicle_id     ?? "");
  const commandSyntax = String(p.GS_COMMAND_SYNTAX ?? p.gs_command_syntax ?? "");
  const actionId      = String(p.GS_ACTION_ID      ?? p.gs_action_id      ?? "GS_UNKNOWN");
  const comment       = String(p.GS_COMMENT ?? `GSensor: ${actionId}`);
  const plate         = String(p.plate ?? "?");

  console.log(
    `[gs-rw] job=${jobId}` +
    ` plate=${plate}` +
    ` action=${actionId}` +
    ` clientId=${clientId}` +
    ` vehicleId=${vehicleId}`
  );

  if (!clientId || !vehicleId || !commandSyntax) {
    const missing = [
      !clientId       && "clientId",
      !vehicleId      && "vehicleId",
      !commandSyntax  && "GS_COMMAND_SYNTAX",
    ].filter(Boolean).join(", ");
    console.error(`[gs-rw] job=${jobId} campos faltando: ${missing}`);
    await failJob(jobId, "missing_fields", { missing });
    return;
  }

  try {
    const sessionToken = await getTrafflogToken();
    await runGsFlow({ clientId, clientName, vehicleId, commandSyntax, actionId, comment, sessionToken, jobId });
    await completeJob(jobId, { ok: true, action_id: actionId });
  } catch (e: any) {
    console.error(`[gs-rw] job=${jobId} ERRO:`, e?.message || e);
    await failJob(jobId, "gs_error", { message: e?.message || String(e) });
  }
}

// ---------------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------------

async function loop(): Promise<void> {
  console.log(`[gs-rw] iniciando poll BASE=${BASE} POLL_MS=${POLL_MS}`);
  let pollMs = POLL_MS;
  while (true) {
    try {
      const job = await pollNextJob();
      if (job) {
        pollMs = POLL_MS;
        await processJob(job);
      } else {
        pollMs = Math.min(MAX_IDLE, Math.round(pollMs * BACKOFF));
      }
    } catch (err: any) {
      console.error("[gs-rw] poll erro:", err?.message || String(err));
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

async function runForever(): Promise<void> {
  while (true) {
    try { await loop(); }
    catch (e) { console.error("[gs-rw] loop caiu:", e); await new Promise(r => setTimeout(r, 15000)); }
  }
}

runForever().catch(e => console.error("[gs-rw] fatal:", e));
