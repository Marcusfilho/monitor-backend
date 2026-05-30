/**
 * canWorker.ts — CAN Snapshot Worker (REWRITE)
 *
 * REFACTOR_CAN_V2: login HTTP próprio (igual schemeBuilderWorker)
 *   - Não depende de MONITOR_WS_URL no env (token muda a cada sessão)
 *   - Faz user_login via TRAFFILOG_API_BASE_URL + WS_LOGIN_NAME/WS_PASSWORD
 *   - Constrói URL WS com token no path: wss://websocket.traffilog.com:8182/{guid}/{token}/json
 *   - Cache de token em /tmp/.session_token_can (renovação automática em erro 401/expired)
 *
 * FIX_CAN_204_V1: trata 204 (sem job) antes de chamar res.json()
 * FIX_CAN_JOB_WRAP_V1: extrai job de { ok, job } (padrão do jobRoutes rw)
 */

import WebSocket from "ws";
import fs from "fs";
import { collectVehicleMonitorSnapshot } from "../../core/vehicleMonitorSnapshotService";

// ─── Env ──────────────────────────────────────────────────────────────────────

const BASE      = (process.env.API_BASE_URL          || "").replace(/\/$/, "");
const KEY       = (process.env.WORKER_KEY            || "").trim();
const WORKER_ID = process.env.WORKER_ID              || "can-rw";
const POLL_MS   = Number(process.env.POLL_INTERVAL_MS || "3000");

const TRAFFILOG_API_BASE_URL = (
  process.env.TRAFFILOG_API_BASE_URL ||
  process.env.TRAFFILOG_API_URL      ||
  "https://api-il.traffilog.com/appengine_3/5E1DCD81-5138-4A35-B271-E33D71FFFFD9/1/json"
).replace(/\/+$/, "");

const WS_LOGIN_NAME = (process.env.WS_LOGIN_NAME || "").trim();
const WS_PASSWORD   = (process.env.WS_PASSWORD   || "").trim();
const WS_GUID_BASE  = (process.env.MONITOR_WS_GUID || "").trim();
function makeGuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16).toUpperCase();
  });
}

const TOKEN_CACHE_PATH = "/tmp/.session_token_can";

if (!BASE) throw new Error("[can-rw] API_BASE_URL não definido");
if (!KEY)  throw new Error("[can-rw] WORKER_KEY não definido");

// ─── Session token (padrão portado do schemeBuilderWorker) ────────────────────

function loadCachedToken(): string {
  try { return (fs.readFileSync(TOKEN_CACHE_PATH, "utf8") || "").trim(); } catch { return ""; }
}

function saveCachedToken(token: string): void {
  try { fs.writeFileSync(TOKEN_CACHE_PATH, token, "utf8"); } catch {}
}

let _sessionToken = loadCachedToken();
let _tokenFetchedAt = 0; // FIX_CAN_TOKEN_TTL_V1: 0 força renovação no boot (ver ensureSessionToken)
const TOKEN_TTL_MS = 3 * 60 * 1000; // 3 minutos

async function fetchSessionToken(): Promise<string> {
  if (!WS_LOGIN_NAME || !WS_PASSWORD) {
    throw new Error("[can-rw] WS_LOGIN_NAME / WS_PASSWORD não definidos");
  }

  console.log("[can-rw] HTTP user_login...");
  const res = await fetch(TRAFFILOG_API_BASE_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: { name: "user_login", parameters: { login_name: WS_LOGIN_NAME, password: WS_PASSWORD } },
    }),
  });

  const data: any = await res.json();
  const token =
    data?.response?.properties?.session_token ||
    data?.response?.properties?.data?.[0]?.session_token;

  if (!token) throw new Error("[can-rw] user_login não retornou session_token");

  console.log(`[can-rw] user_login OK (token len=${token.length})`);
  saveCachedToken(token);
  _tokenFetchedAt = Date.now();
  return token;
}

async function ensureSessionToken(): Promise<string> {
  const expired = _tokenFetchedAt === 0 || (Date.now() - _tokenFetchedAt) > TOKEN_TTL_MS; // FIX_CAN_TOKEN_TTL_V1
  if (_sessionToken && !expired) return _sessionToken;
  if (expired) console.log("[can-rw] token expirado (TTL) — renovando");
  _sessionToken = await fetchSessionToken();
  return _sessionToken;
}

async function renewSessionToken(): Promise<string> {
  _sessionToken = "";
  saveCachedToken("");
  _sessionToken = await fetchSessionToken();
  return _sessionToken;
}

// ─── WS (padrão do schemeBuilderWorker) ──────────────────────────────────────

function buildWsUrl(sessionToken: string, guid?: string): string {
  const g = guid || WS_GUID_BASE || makeGuid();
  return `wss://websocket.traffilog.com:8182/${g}/${sessionToken}/json?defragment=1`;
}

async function openWs(sessionToken: string): Promise<WebSocket> {
  const url = buildWsUrl(sessionToken, WS_GUID_BASE || makeGuid()); // FIX_CAN_GUID_V2: usa GUID fixo do env igual ao SB
  const ws  = new WebSocket(url, {
    headers: {
      "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      "Accept-Language":  "pt-BR,pt;q=0.9",
      "Cache-Control":    "no-cache",
      "Pragma":           "no-cache",
    },
    origin:            "https://operation.traffilog.com",
    handshakeTimeout:  15000,
    perMessageDeflate: { clientMaxWindowBits: 15 },
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open",  () => resolve());
    ws.once("error", (err) => reject(err));
    ws.once("close", (code, reason) =>
      reject(new Error(`[can-rw] WS fechou antes do open code=${code} reason=${reason}`))
    );
  });

  return ws;
}

// ─── Job helpers ──────────────────────────────────────────────────────────────

async function completeJob(jobId: string, result: any): Promise<void> {
  await fetch(`${BASE}/api/jobs/${jobId}/complete`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ worker_key: KEY, result }),
  });
}

async function failJob(jobId: string, reason: string): Promise<void> {
  await fetch(`${BASE}/api/jobs/${jobId}/complete`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ worker_key: KEY, status: "error", result: { reason } }),
  });
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  const res = await fetch(`${BASE}/api/jobs/next`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ worker_key: KEY, worker_id: WORKER_ID, job_type: "monitor_can_snapshot" }),
  });

  // FIX_CAN_204_V1
  if (res.status === 204) return;

  if (!res.ok) {
    console.log(`[can-rw] poll HTTP ${res.status}`);
    return;
  }

  // FIX_CAN_JOB_WRAP_V1
  const data = await res.json() as any;
  const job  = data?.job ?? data;
  if (!job?.id) return;

  const jobId     = job.id;
  const vehicleId = Number(job.payload?.vehicle_id ?? job.payload?.vehicleId ?? 0);

  if (!vehicleId) {
    await failJob(jobId, "vehicle_id ausente no payload");
    return;
  }

  console.log(`[can-rw] job=${jobId} vehicle_id=${vehicleId} — iniciando snapshot`);

  // Tenta com token cacheado; renova automaticamente em caso de erro de auth
  let attempts = 0;
  while (attempts < 2) {
    attempts++;
    let sessionToken: string;
    try {
      sessionToken = attempts === 1 ? await ensureSessionToken() : await renewSessionToken();
    } catch (e: any) {
      await failJob(jobId, `login falhou: ${e?.message || e}`);
      return;
    }

    let ws: WebSocket | null = null;
    try {
      ws = await openWs(sessionToken);

      const snapshot = await collectVehicleMonitorSnapshot({
        ws,
        sessionToken,
        vehicleId,
        windowMs       : Number(process.env.VM_WINDOW_MS         || "5000"),
        waitAfterCmdMs : Number(process.env.VM_WAIT_AFTER_CMD_MS || "800"),
        urlEncode      : true,
        onPartialParams: (params, counts, header, moduleState) => {
          // FIX_CAN_PARTIAL_PUSH_V1 — envia parcial ao backend durante CAN_RUNNING
          fetch(`${BASE}/api/jobs/${jobId}/progress`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
              worker_key: KEY,
              progress:   Math.round((counts.withValue / Math.max(counts.total, 1)) * 100),
              message:    `params=${counts.total} withValue=${counts.withValue} events=${counts.events}`,
              partial: { params, header, moduleState },
            }),
          }).catch(() => { /* best-effort */ });
        },
      });

      try { ws.close(); } catch {}

      const paramsWithValue = snapshot.parameters.filter(p => (p.raw_value ?? "") !== "").length;
      const { can0_ok, can1_ok, j1708_ok } = snapshot.canSummary;

      console.log(
        `[can-rw] job=${jobId} snapshot ok` +
        ` params=${snapshot.parameters.length} withValue=${paramsWithValue}` +
        ` can0_ok=${can0_ok} can1_ok=${can1_ok} j1708_ok=${j1708_ok}`
      );

      await completeJob(jobId, {
        ok:     true,
        status: "captured",
        snapshot,
        meta: {
          params_total      : snapshot.parameters.length,
          params_with_value : paramsWithValue,
          module_total      : snapshot.moduleState.length,
          captured_at       : snapshot.capturedAt,
          can0_ok,
          can1_ok,
          j1708_ok,
        },
      });

      return; // sucesso — sai do loop

    } catch (err: any) {
      try { ws?.close(); } catch {}

      const msg = err?.message || String(err);
      const isAuthError = /401|unauthorized|session|expired|invalid.*token|404/i.test(msg);

      if (isAuthError && attempts === 1) {
        console.log(`[can-rw] job=${jobId} erro de auth — renovando token e retentando`);
        continue; // loop: tenta de novo com token novo
      }

      console.error(`[can-rw] job=${jobId} ERRO:`, msg);
      await failJob(jobId, msg);
      return;
    }
  }
}

// ─── Loop principal ───────────────────────────────────────────────────────────

async function loop(): Promise<void> {
  console.log(`[can-rw] iniciando poll BASE=${BASE} POLL_MS=${POLL_MS}`);

  // Warm-up: obtém token no boot para detectar problemas de credencial logo
  try {
    const tok = await ensureSessionToken();
    console.log(`[can-rw] session_token pronto no boot (len=${tok.length})`);
  } catch (e: any) {
    console.log(`[can-rw] aviso: falha no warm-up do token — ${e?.message || e}`);
  }

  while (true) {
    try {
      await pollOnce();
    } catch (err: any) {
      console.error("[can-rw] pollOnce erro:", err?.message || String(err));
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

loop();
