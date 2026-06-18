/**
 * uninstallWorker.ts — HTML5 Uninstall Worker (REWRITE)
 *
 * Fluxo por job:
 *  1. Normaliza payload (aliases de placa/vehicle_id)
 *  2. Resolve VEHICLE_ID via VHCLS (se não vier no payload)
 *  3. DEACTIVATE_VEHICLE_HIST — libera o serial da placa
 *  4. ORDER_SAVE — cria novo vehicle_id no estoque
 *  5. VHCLS por CLIENT_DESCR — localiza o novo vehicle_id via ORDERS_LIST (retry 3x)
 *  6. SAVE_VHCL_ACTIVATION_NEW — vincula serial ao novo vehicle_id com placa "CMDT"
 *  7. Completa com { ok, flow, plate, vehicle_id, serial_old, html5Ok }
 *
 * O jobRoutes.ts enfileira save_snapshot quando recebe html5Ok=true.
 */

import { configFromEnv, ensureHtml5Session, readJarCookie, ensureCookieDefaults } from "../../core/html5Session";
import { ensureVehicleId } from "../../core/vhclsService";
import { mwsLoadBaseline, mwsSave } from "../../core/mwsService";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE      = (process.env.API_BASE_URL || "").replace(/\/$/, "");
const KEY       = (process.env.WORKER_KEY   || "").trim();
const WORKER_ID = process.env.WORKER_ID     || "uninstall-rw";
const POLL_MS   = Number(process.env.POLL_INTERVAL_MS || "4000");

if (!BASE) throw new Error("[uninstallWorker] API_BASE_URL não definido");
if (!KEY)  throw new Error("[uninstallWorker] WORKER_KEY não definido");

const cfg = configFromEnv();

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function pollNextJob(): Promise<any | null> {
  const res = await fetch(`${BASE}/api/jobs/next`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ worker_key: KEY, worker_id: WORKER_ID, job_type: "html5_uninstall" }),
  });
  if (res.status === 204) return null;
  if (!res.ok) { console.log(`[uninstall-rw] poll HTTP ${res.status}`); return null; }
  const job = await res.json() as any;
  const j = job?.job ?? job; return j?.id ? j : null;
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
// Normalização do payload
// ---------------------------------------------------------------------------

function normalizePayload(raw: any): any {
  const p = { ...raw };

  const rawPlate = p.plate ?? p.placa ?? p.license ?? p.licensePlate ?? p.LICENSE_NMBR ?? p.license_nmbr ?? "";
  if (!p.plate && rawPlate) p.plate = String(rawPlate);
  if (p.plate) p.plate = String(p.plate).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!p.license && p.plate) p.license = p.plate;

  const rawVid = p.vehicle_id ?? p.vehicleId ?? p.VEHICLE_ID ?? p.VEHICLEID ?? "";
  if (!p.vehicle_id && rawVid) p.vehicle_id = String(rawVid).trim();
  if (!p.VEHICLE_ID && p.vehicle_id) p.VEHICLE_ID = p.vehicle_id;

  const rawClientId   = p.client_id   ?? p.clientId   ?? p.CLIENT_ID   ?? "";
  const rawClientDescr = p.client_descr ?? p.clientDescr ?? p.CLIENT_DESCR ?? "";
  if (!p.client_id    && rawClientId)    p.client_id    = String(rawClientId).trim();
  if (!p.client_descr && rawClientDescr) p.client_descr = String(rawClientDescr).trim();

  if (!p.service) p.service = "UNINSTALL";

  return p;
}

// ---------------------------------------------------------------------------
// HTTP helper — AppEngine POST com cookie admin do jar
// ---------------------------------------------------------------------------

async function appenginePost(
  tag    : string,
  action : string,
  fields : Record<string, string>
): Promise<{ status: number; text: string; loginNeg: boolean }> {
  await ensureHtml5Session(cfg, tag).catch(() => {});

  const cookieHeader = ensureCookieDefaults(readJarCookie(cfg.cookieJarPath));

  const params = new URLSearchParams();
  params.set("action", action);
  for (const [k, v] of Object.entries(fields)) params.set(k, String(v ?? ""));

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), cfg.httpTimeoutMs);

  try {
    const res = await fetch(cfg.actionUrl, {
      method : "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "accept"      : "*/*",
        "origin"      : "https://html5.traffilog.com",
        "referer"     : "https://html5.traffilog.com/appv2/index.htm",
        "user-agent"  : "monitor-backend-html5-worker/rw",
        "cookie"      : cookieHeader,
      },
      body  : params.toString(),
      signal: controller.signal,
    });
    const text     = await res.text().catch(() => "");
    const loginNeg = /login\s*=\s*"-1"/i.test(text) || /<!DOCTYPE\s+html/i.test(text);
    console.log(`[uninstall-rw] [${tag}] action=${action} http=${res.status} len=${text.length} loginNeg=${loginNeg ? 1 : 0}`);
    return { status: res.status, text, loginNeg };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Passo 3: DEACTIVATE_VEHICLE_HIST — libera serial da placa
// ---------------------------------------------------------------------------

async function deactivate(
  jobId    : string,
  vehicleId: number,
  plate    : string,
  payload  : any
): Promise<{ status: number; text: string; loginNeg: boolean }> {
  const installer   = String(payload.installer_name || payload.installer || payload.INSTALLER_NAME || "installer");
  const comments    = String(payload.comments || payload.comment || payload.notes || payload.COMMENTS || "uninstall");
  const reasonCode  = String(payload.reason_code  || payload.REASON_CODE  || "5501");
  const deliverCode = String(payload.deliver_code || payload.DELIVER_CODE || "5511");

  return appenginePost("UNINSTALL_DEACTIVATE", "DEACTIVATE_VEHICLE_HIST", {
    VERSION_ID    : "2",
    VEHICLE_ID    : String(vehicleId),
    LICENSE_NMBR  : plate,
    INSTALLER_NAME: installer,
    COMMENTS      : comments,
    REASON_CODE   : reasonCode,
    DELIVER_CODE  : deliverCode,
  });
}

function deactivateHasError(text: string): boolean {
  if (!text) return false;
  if (/<TEXT>\s*Action:\s*DEACTIVATE_VEHICLE_HIST\s*error/i.test(text)) return true;
  if (/DEACTIVATE_VEHICLE_HIST\s*error/i.test(text)) return true;
  if (/<ERROR\b/i.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Passo 4: ORDER_SAVE — cria novo vehicle_id no estoque do cliente
// Retorna ORDER_ID para localizar o vehicle_id criado via VHCLS
// ---------------------------------------------------------------------------

function isoNoZ(): string {
  return new Date().toISOString().replace("Z", "");
}

function dateBR(): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit", year: "numeric",
  }).format(new Date());
}

async function orderSave(
  jobId   : string,
  clientId: string,
  payload : any
): Promise<{ orderId: string; error?: string }> {
  const r = await appenginePost("UNINSTALL_ORDER_SAVE", "ORDER_SAVE", {
    ORDERID            : "-1",
    ORDER_DATE         : isoNoZ(),
    USER_NAME          : String(payload.installer_name || payload.installer || "installer"),
    CLIENT_ID          : clientId,
    CLIENT_DESCR       : "",
    EXTERNAL_ORDER     : "",
    INSTALLATION_DATE  : dateBR(),
    INSTALLATION_PLACE : "",
    REMARKS            : "",
    QUANTITY           : "1",
    STC_ID             : "",
    SALES_PRODUCT_ID   : "27",
    VERSION_ID         : "2",
  });

  if (r.loginNeg) return { orderId: "", error: "order_save_loginneg" };

  // Resposta: <DATA ORDER_ID="123" ... /> ou ORDER="123"
  const match = r.text.match(/ORDER(?:_ID)?\s*=\s*"(\d+)"/i);
  if (!match) {
    console.log(`[uninstall-rw] job=${jobId} ORDER_SAVE sem ORDER_ID. head=${r.text.slice(0, 200)}`);
    return { orderId: "", error: "order_save_no_order_id" };
  }

  const orderId = match[1];
  console.log(`[uninstall-rw] job=${jobId} ORDER_SAVE ok — orderId=${orderId}`);
  return { orderId };
}

// ---------------------------------------------------------------------------
// Passo 5: VHCLS por CLIENT_DESCR — localiza novo vehicle_id via ORDERS_LIST
// Retry 3x com 1s de intervalo (latência entre ORDER_SAVE e VHCLS)
// ---------------------------------------------------------------------------

function extractAttr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1].trim() : "";
}

async function findVehicleIdByOrderId(
  jobId       : string,
  orderId     : string,
  clientDescr : string,
  clientId    : string
): Promise<number | null> {
  const MAX_ATTEMPTS = 3;
  const RETRY_MS     = 1000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.log(`[uninstall-rw] job=${jobId} VHCLS tentativa ${attempt}/${MAX_ATTEMPTS} aguardando ${RETRY_MS}ms`);
      await new Promise(r => setTimeout(r, RETRY_MS));
    }

    // Busca por CLIENT_DESCR (igual ao Internal Tools)
    const r = await appenginePost("UNINSTALL_VHCLS_ORDER", "VHCLS", {
      REFRESH_FLG : "1",
      LICENSE_NMBR: "",
      CLIENT_DESCR: clientDescr,
      CLIENT_ID   : clientId,
      OWNER_DESCR : "",
      DIAL_NMBR   : "",
      INNER_ID    : "",
      VERSION_ID  : "2",
    });

    if (r.loginNeg) {
      console.log(`[uninstall-rw] job=${jobId} VHCLS loginNeg na tentativa ${attempt}`);
      continue;
    }

    const dataTags = r.text.match(/<DATA\b[^>]*\/>/gi) || [];

    for (const tag of dataTags) {
      const ordersList = extractAttr(tag, "ORDERS_LIST");
      const vehicleId  = extractAttr(tag, "VEHICLE_ID");

      if (!vehicleId || !ordersList) continue;

      // ORDERS_LIST pode conter múltiplos IDs separados por vírgula
      const orders = ordersList.split(",").map(s => s.trim());
      if (orders.includes(orderId)) {
        const vid = Number(vehicleId);
        if (vid > 0) {
          console.log(`[uninstall-rw] job=${jobId} novo vehicle_id=${vid} encontrado via ORDERS_LIST=${ordersList}`);
          return vid;
        }
      }
    }

    console.log(`[uninstall-rw] job=${jobId} VHCLS tentativa ${attempt}: orderId=${orderId} não encontrado em ${dataTags.length} registros`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Passo 6: SAVE_VHCL_ACTIVATION_NEW com placa CMDT
// Reutiliza mwsSave do mwsService — baseline do novo vehicle_id
// ---------------------------------------------------------------------------

async function saveCmdt(
  jobId         : string,
  newVehicleId  : number,
  serialOld     : string,
  clientId      : string,
  payload       : any,
  origFields    : Record<string, string> = {}
): Promise<{ ok: boolean; error?: string }> {
  // Carrega baseline do novo vehicle_id
  let baseline;
  try {
    baseline = await mwsLoadBaseline(cfg, newVehicleId, `${jobId}_cmdt`);
    console.log(`[uninstall-rw] job=${jobId} baseline CMDT loaded keys=${Object.keys(baseline.fields).length}`);
  } catch (e: any) {
    console.log(`[uninstall-rw] job=${jobId} baseline CMDT load failed (non-blocking): ${e?.message || e}`);
    baseline = { fields: {}, rawText: "" };
  }

  // Sobrescreve campos dinâmicos para a placa CMDT
  baseline.fields.LICENSE_NMBR    = "CMDT";
  baseline.fields.INNER_ID        = serialOld;
  baseline.fields.DIAL_NUMBER     = serialOld;
  baseline.fields.CLIENT_ID       = clientId;
  baseline.fields.VEHICLE_ID      = String(newVehicleId);
  // campos obrigatórios que o vehicle novo (vazio) não tem preenchidos
  baseline.fields.MILAGE_SOURCE_ID  = "5067";
  baseline.fields.WARRANTY_PERIOD_ID = "1";

  // herda FIELD_IDS/ASSET_TYPE/etc. do veículo original (se capturado com sucesso)
  if (origFields.FIELD_IDS)        baseline.fields.FIELD_IDS        = origFields.FIELD_IDS;
  if (origFields.ASSET_TYPE)       baseline.fields.ASSET_TYPE       = origFields.ASSET_TYPE;
  if (origFields.UNIT_TYPE_ID)     baseline.fields.UNIT_TYPE_ID     = origFields.UNIT_TYPE_ID;
  if (origFields.FIRMWARE_TYPE_ID) baseline.fields.FIRMWARE_TYPE_ID = origFields.FIRMWARE_TYPE_ID;
  if (origFields.GROUP_ID)         baseline.fields.GROUP_ID         = origFields.GROUP_ID;

  // SEMPRE reconstrói FIELD_VALUE com o serial antigo — usa FIELD_IDS de origFields
  // ou do baseline do novo veículo (o cliente já provisiona FIELD_IDS no veículo de estoque)
  const fids = origFields.FIELD_IDS || baseline.fields.FIELD_IDS || "";
  if (fids) {
    const ids = fids.split(",").map((s: string) => s.trim()).filter(Boolean);
    if (ids.length) {
      baseline.fields.FIELD_IDS   = fids;
      baseline.fields.FIELD_VALUE = ids.map(id => `${id}:${serialOld}`).join(",");
    }
  }

  console.log(
    `[uninstall-rw] job=${jobId} CMDT fields:` +
    ` FIELD_IDS=${baseline.fields.FIELD_IDS||"?"} FIELD_VALUE=${baseline.fields.FIELD_VALUE||"?"}` +
    ` ASSET_TYPE=${baseline.fields.ASSET_TYPE||"?"}`
  );

  const saveResult = await mwsSave(
    cfg,
    `${jobId}_cmdt`,
    newVehicleId,
    "CMDT",
    serialOld,
    baseline
  );

  if (saveResult.hasError) {
    console.log(`[uninstall-rw] job=${jobId} SAVE CMDT action_error http=${saveResult.status} head=${saveResult.text.slice(0, 200)}`);
    return { ok: false, error: "save_cmdt_action_error" };
  }

  console.log(`[uninstall-rw] job=${jobId} SAVE CMDT OK newVehicleId=${newVehicleId} serial=${serialOld}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Processamento de um job
// ---------------------------------------------------------------------------

async function processJob(job: any): Promise<void> {
  const jobId   = String(job.id || job.jobId || job._id || "");
  const payload = normalizePayload(job.payload || {});

  console.log(`[uninstall-rw] job=${jobId} plate=${payload.plate || "?"}`);

  const ctx = {
    log  : (m: string) => console.log(m),
    jobId,
    cookieJarPath: cfg.cookieJarPath,
  };

  // 1. Resolve VEHICLE_ID
  let vehicleId = Number(payload.vehicle_id || 0);
  if (!vehicleId) {
    try {
      const resolved = await ensureVehicleId(cfg, ctx, payload);
      if (resolved) vehicleId = resolved;
    } catch (e: any) {
      console.log(`[uninstall-rw] job=${jobId} VHCLS resolve failed: ${e?.message || e}`);
    }
  }

  if (!vehicleId) {
    await failJob(jobId, "vehicle_id_not_found", { plate: payload.plate });
    return;
  }

  const plate = String(
    payload.plate_real || payload.plateReal ||
    payload.plate || payload.LICENSE_NMBR || ""
  ).trim();

  // Captura serial antes do DEACTIVATE (innerId atual da placa)
  const serialOld = String(
    payload.serial_old || payload.serialOld ||
    payload.serial     || payload.inner_id  || payload.INNER_ID || ""
  ).trim();

  const clientId   = String(payload.client_id   || payload.CLIENT_ID   || "").trim();
  const clientDescr = String(payload.client_descr || payload.CLIENT_DESCR || "").trim();

  // 2a. Carrega baseline do veículo original para herdar FIELD_IDS/FIELD_VALUE/ASSET_TYPE
  //     Deve ocorrer ANTES do DEACTIVATE — após a desativação os dados podem não estar acessíveis
  const origFields: Record<string, string> = {};
  try {
    const origBaseline = await mwsLoadBaseline(cfg, vehicleId, `${jobId}_orig`);
    for (const k of ["FIELD_IDS","FIELD_VALUE","ASSET_TYPE","UNIT_TYPE_ID","FIRMWARE_TYPE_ID","GROUP_ID"]) {
      const v = String(origBaseline.fields[k] || "").trim();
      if (v) origFields[k] = v;
    }
    console.log(`[uninstall-rw] job=${jobId} origFields: ASSET_TYPE=${origFields.ASSET_TYPE||"?"} FIELD_IDS=${origFields.FIELD_IDS||"?"}`);
  } catch (e: any) {
    console.log(`[uninstall-rw] job=${jobId} baseline orig load failed (non-blocking): ${e?.message || e}`);
  }

  // 2b. DEACTIVATE_VEHICLE_HIST
  let deResult;
  try {
    deResult = await deactivate(jobId, vehicleId, plate, payload);
  } catch (e: any) {
    await failJob(jobId, "deactivate_exception", { detail: e?.message || String(e) });
    return;
  }

  if (deResult.loginNeg) {
    await failJob(jobId, "deactivate_session_expired", { http: deResult.status });
    return;
  }

  if (deactivateHasError(deResult.text)) {
    await failJob(jobId, "deactivate_action_error", {
      http: deResult.status,
      head: String(deResult.text || "").slice(0, 240),
    });
    return;
  }

  console.log(`[uninstall-rw] job=${jobId} DEACTIVATE OK vehicle_id=${vehicleId} plate=${plate}`);

  // Se não temos serial_old ou client_id, não podemos fazer ORDER_SAVE → CMDT
  // Completa parcialmente (comportamento anterior) — não falha o job
  if (!serialOld || !clientId || !clientDescr) {
    console.log(
      `[uninstall-rw] job=${jobId} AVISO: serial_old="${serialOld}" client_id="${clientId}" client_descr="${clientDescr}" ` +
      `— pulando ORDER_SAVE + CMDT (dados insuficientes no payload)`
    );
    await completeJob(jobId, {
      ok        : true,
      flow      : "UNINSTALL",
      plate,
      vehicle_id: vehicleId,
      serial_old: serialOld,
      http      : deResult.status,
      html5Ok   : true,
      cmdt_skip : true,
      cmdt_reason: "missing serial_old or client_id or client_descr",
    });
    return;
  }

  // 3. ORDER_SAVE — cria novo vehicle_id no estoque
  const orderResult = await orderSave(jobId, clientId, payload);
  if (orderResult.error || !orderResult.orderId) {
    await failJob(jobId, "order_save_failed", {
      error     : orderResult.error,
      plate,
      vehicle_id: vehicleId,
      serial_old: serialOld,
    });
    return;
  }

  // 4. VHCLS — localiza novo vehicle_id pelo ORDERS_LIST
  const newVehicleId = await findVehicleIdByOrderId(jobId, orderResult.orderId, clientDescr, clientId);
  if (!newVehicleId) {
    await failJob(jobId, "new_vehicle_id_not_found", {
      order_id  : orderResult.orderId,
      client_id : clientId,
      plate,
      vehicle_id: vehicleId,
      serial_old: serialOld,
    });
    return;
  }

  // 5. SAVE_VHCL_ACTIVATION_NEW — serial volta para estoque com placa CMDT
  const cmdtResult = await saveCmdt(jobId, newVehicleId, serialOld, clientId, payload, origFields);
  if (!cmdtResult.ok) {
    await failJob(jobId, "save_cmdt_failed", {
      new_vehicle_id: newVehicleId,
      serial_old    : serialOld,
      error         : cmdtResult.error,
    });
    return;
  }

  // 6. Sucesso
  await completeJob(jobId, {
    ok            : true,
    flow          : "UNINSTALL",
    plate,
    vehicle_id    : vehicleId,
    serial_old    : serialOld,
    new_vehicle_id: newVehicleId,
    order_id      : orderResult.orderId,
    http          : deResult.status,
    html5Ok       : true,  // jobRoutes.ts enfileira save_snapshot
  });

  console.log(
    `[uninstall-rw] job=${jobId} UNINSTALL OK ` +
    `vehicle_id=${vehicleId} → CMDT vehicle_id=${newVehicleId} serial=${serialOld}`
  );
}

// ---------------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------------

async function loop(): Promise<void> {
  console.log(`[uninstall-rw] iniciando poll BASE=${BASE} POLL_MS=${POLL_MS}`);
  while (true) {
    try {
      const job = await pollNextJob();
      if (job) {
        processJob(job).catch((err: any) => {
          console.error(`[uninstall-rw] processJob unhandled: ${err?.message || String(err)}`);
        });
      }
    } catch (err: any) {
      console.error(`[uninstall-rw] poll erro: ${err?.message || String(err)}`);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

loop();
