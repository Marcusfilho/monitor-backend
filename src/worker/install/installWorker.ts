/**
 * installWorker.ts — HTML5 Install Worker (REWRITE)
 *
 * Fluxo por job:
 *  1. Normaliza payload
 *  2. Resolve VEHICLE_ID via VHCLS (Caminho A: por placa | Caminho B: por serial)
 *  3. CHANGE_COMPANY se clientId do vehicle_id != clientId do cadastro (Caminho B)
 *  4. Verifica/libera serial CMDT
 *  5. Re-resolve VEHICLE_ID pós-CMDT se necessário
 *  6. Carrega baseline (GET_VHCL_ACTIVATION_DATA_NEW)
 *  7. SAVE_VHCL_ACTIVATION_NEW
 *  8. Postcheck: confirma DIAL_NUMBER aplicado
 *  9. Completa com { ok, flow, vehicle_id, serial, dial, vehicle_setting_id }
 *
 * Scheme Check (decidir se pula SB):
 *   O installWorker retorna `vehicle_setting_id` no resultado.
 *   O jobRoutes.ts usa esse valor ao enfileirar o job scheme_builder.
 *   A decisão de pular SB fica no schemeBuilderWorker (fora deste escopo).
 */

import fs from "fs";

import { configFromEnv }                    from "../../core/html5Session";
import { ensureVehicleId, resolveByPlate }  from "../../core/vhclsService";
import { checkAndFreeSerial }               from "../../core/cmdtService";
import { mwsLoadBaseline, mwsSave, mwsPostcheck, mwsExtractActivationAttrs } from "../../core/mwsService";
import { executeChangeCompany }             from "../../core/changeCompanyService";
import { getSelectedSchemeId }               from "../../services/schemeSelectionService";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE      = (process.env.API_BASE_URL || "").replace(/\/$/, "");
const KEY       = (process.env.WORKER_KEY   || "").trim();
const WORKER_ID = process.env.WORKER_ID     || "install-rw";
const POLL_MS   = Number(process.env.POLL_INTERVAL_MS || "4000");

if (!BASE) throw new Error("[installWorker] API_BASE_URL não definido");
if (!KEY)  throw new Error("[installWorker] WORKER_KEY não definido");

const cfg = configFromEnv();

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function pollNextJob(): Promise<any | null> {
  const res = await fetch(`${BASE}/api/jobs/next`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ worker_key: KEY, worker_id: WORKER_ID, job_type: "html5_install" }),
  });
  if (res.status === 204) return null;
  if (!res.ok) { console.log(`[install-rw] poll HTTP ${res.status}`); return null; }
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

  // plate aliases
  const rawPlate = p.plate ?? p.placa ?? p.license ?? p.licensePlate ?? p.LICENSE_NMBR ?? p.license_nmbr ?? "";
  if (!p.plate && rawPlate) p.plate = String(rawPlate);
  if (p.plate) p.plate = String(p.plate).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!p.license && p.plate) p.license = p.plate;

  // serial aliases
  const rawSerial = p.serial ?? p.serie ?? p.innerId ?? p.inner_id ?? p.INNER_ID ?? p.SERIAL ?? "";
  if (!p.serial && rawSerial) p.serial = String(rawSerial).trim();
  if (!p.inner_id && p.serial) p.inner_id = p.serial;
  if (!p.INNER_ID  && p.serial) p.INNER_ID = p.serial;

  // vehicle_id aliases
  const rawVid = p.vehicle_id ?? p.vehicleId ?? p.VEHICLE_ID ?? p.VEHICLEID ?? "";
  if (!p.vehicle_id && rawVid) p.vehicle_id = String(rawVid).trim();
  if (!p.VEHICLE_ID && p.vehicle_id) p.VEHICLE_ID = p.vehicle_id;

  // client aliases
  const rawClientId   = p.client_id   ?? p.clientId   ?? p.CLIENT_ID   ?? "";
  const rawClientDescr = p.client_descr ?? p.clientDescr ?? p.CLIENT_DESCR ?? "";
  if (!p.client_id    && rawClientId)    p.client_id    = String(rawClientId).trim();
  if (!p.client_descr && rawClientDescr) p.client_descr = String(rawClientDescr).trim();

  // vehicle_setting_id aliases (para Scheme Check — repassado ao resultado)
  const rawSettingId = p.vehicle_setting_id ?? p.vehicleSettingId ?? p.ASSIGNED_VEHICLE_SETTING_ID ?? "";
  if (!p.vehicle_setting_id && rawSettingId) p.vehicle_setting_id = String(rawSettingId).trim();

  if (!p.service) p.service = "INSTALL";

  return p;
}

// ---------------------------------------------------------------------------
// Resolve Caminho A ou B — retorna vehicle_id + se houve client_mismatch
//
// Caminho A: encontrou vehicle_id pela placa
// Caminho B: placa não encontrada → encontrou vehicle_id pelo serial
//
// client_mismatch: client_id do vehicle_id resolvido != client_id do cadastro
// (só relevante no Caminho B — gatilho para CHANGE_COMPANY)
// ---------------------------------------------------------------------------

interface ResolveResult {
  vehicleId     : number;
  resolvedBy    : "plate" | "serial";
  clientIdFound : number | null;   // client_id do vehicle_id no sistema
  clientMismatch: boolean;
}

async function resolveVehicleIdWithPath(
  payload: any,
  jobId  : string
): Promise<ResolveResult | null> {
  // Caminho A usa SEMPRE a placa real (plate_real/plateReal) — nunca o serial.
  // O frontend envia plate=serial para INSTALL, mas plate_real é a placa verdadeira.
  const plateReal = String(payload.plate_real || payload.plateReal || "").trim()
    .replace(/[^A-Z0-9_-]/gi, "").toUpperCase();
  const serial = String(payload.serial || "").trim();
  const clientIdCadastro = Number(payload.client_id || 0);

  // -- Tentativa 1: por placa real (Caminho A) --
  if (plateReal) {
    const payloadByPlate = { ...payload, service: "INSTALL" };
    // força busca pela placa real — sem serial para não contaminar
    payloadByPlate.plate    = plateReal;
    payloadByPlate.license  = plateReal;
    payloadByPlate.serial   = "";
    payloadByPlate.inner_id = "";
    payloadByPlate.INNER_ID = "";

    const vid = await ensureVehicleId(cfg, { jobId, log: console.log }, payloadByPlate);
    if (vid) {
      console.log(`[install-rw] job=${jobId} Caminho A: plateReal="${plateReal}" → vehicle_id=${vid}`);
      // client_mismatch não se aplica no Caminho A (CHANGE_COMPANY é exclusivo do B)
      return { vehicleId: vid, resolvedBy: "plate", clientIdFound: null, clientMismatch: false };
    }
    console.log(`[install-rw] job=${jobId} plateReal="${plateReal}" não encontrada → tentando Caminho B`);
  }

  // -- Tentativa 2: por serial (Caminho B) --
  // B-INNER: CMDT com INNER_ID=serial (plate="CMDT") — preferencial
  // B-LICENSE: CMDT com plate=serial e INNER_ID vazio — fallback
  if (serial) {
    const byInner = await resolveByPlate(cfg, serial, "PATH_B_INNER", jobId, true).catch(() => null);
    const byLicense = !byInner?.vehicleId
      ? await resolveByPlate(cfg, serial, "PATH_B_LICENSE", jobId, false).catch(() => null)
      : null;
    const match = byInner?.vehicleId ? byInner : byLicense;
    const vid = match?.vehicleId ?? null;

    if (vid) {
      const tag = byInner?.vehicleId ? "INNER_ID" : "LICENSE_NMBR";
      console.log(`[install-rw] job=${jobId} Caminho B (${tag}): serial="${serial}" → vehicle_id=${vid} plate="${match?.licensePlate||"?"}"`);

      // client_mismatch: CLIENT_ID da resposta VHCLS vs cliente do cadastro
      let clientIdFound = match?.clientId ? Number(match.clientId) : 0;
      if (!clientIdFound) {
        try {
          const snapFiles = fs.readdirSync("/tmp")
            .filter((f: string) => f.startsWith(`vhcls_raw_${jobId}_`) && f.endsWith(".xml"))
            .sort().reverse();
          if (snapFiles.length) {
            const xml = fs.readFileSync(`/tmp/${snapFiles[0]}`, "utf8");
            const m   = xml.match(/CLIENT_ID="(\d+)"/i);
            if (m) clientIdFound = Number(m[1]);
          }
        } catch { /* não bloqueia */ }
      }
      const clientMismatch = !!(clientIdCadastro && clientIdFound && clientIdFound !== clientIdCadastro);

      if (clientMismatch) {
        console.log(
          `[install-rw] job=${jobId} client_mismatch: vehicle_id=${vid} ` +
          `está no client_id=${clientIdFound}, cadastro usa client_id=${clientIdCadastro}`
        );
      }

      return { vehicleId: vid, resolvedBy: "serial", clientIdFound, clientMismatch };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Construção dos campos do SAVE
// ---------------------------------------------------------------------------

function buildInstallFields(payload: any): Record<string, string> {
  const serial = String(
    payload.serial || payload.serial_new || payload.SERIAL_NEW ||
    payload.DIAL_NUMBER || payload.INNER_ID || payload.inner_id || ""
  ).trim();

  const plate = String(
    payload.plate_real || payload.plateReal ||
    payload.license_real || payload.licenseReal ||
    payload.plate || payload.LICENSE_NMBR || ""
  ).trim();

  const installationDate =
    String(payload.installationDate || payload.INSTALLATION_DATE || "").trim() ||
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit", month: "2-digit", year: "numeric",
    }).format(new Date());

  const installedBy = String(
    payload.installedBy || payload.installed_by ||
    payload.technicianName || payload.technician || payload.tech_name ||
    payload.INSTALLED_BY || ""
  ).trim();

  const comments = String(
    payload.comments || payload.comment || payload.observations || payload.notes ||
    payload.LOGISTIC_COMMENTS || payload.ACCOSSORIES_COMMENTS || ""
  ).trim();

  const assetType = String(
    payload.assetType ?? payload.asset_type ?? payload.ASSET_TYPE ??
    payload.vehicle_type ?? payload.vehicleType ?? ""
  );

  const vehicleId = String(
    payload.vehicleId ?? payload.vehicle_id ?? payload.VEHICLE_ID ?? ""
  );

  const clientId = String(
    payload.target_client_id ?? payload.targetClientId ??
    payload.client_id ?? payload.clientId ?? payload.CLIENT_ID ?? ""
  );

  const fields: Record<string, string> = {
    VERSION_ID                  : "2",
    VEHICLE_ID                  : vehicleId,
    LICENSE_NMBR                : plate,
    INNER_ID                    : String(payload.INNER_ID || payload.inner_id || serial),
    DIAL_NUMBER                 : serial,
    SIM_NUMBER                  : String(payload.SIM_NUMBER ?? ""),
    ASSET_TYPE                  : assetType,
    CLIENT_ID                   : clientId,
    INSTALLATION_DATE           : installationDate,
    WARRANTY_START_DATE         : String(payload.WARRANTY_START_DATE || payload.warrantyStartDate || installationDate),
    WARRANTY_PERIOD_ID          : String(payload.WARRANTY_PERIOD_ID ?? 1),
    LOG_UNIT_DATA_UNTIL_DATE    : String(payload.LOG_UNIT_DATA_UNTIL_DATE || installationDate),
    MILAGE_SOURCE_ID            : String(payload.MILAGE_SOURCE_ID ?? 5067),
    UNIT_TYPE_ID                : String(payload.UNIT_TYPE_ID ?? 1),
    FIRMWARE_TYPE_ID            : String(payload.FIRMWARE_TYPE_ID ?? 2),
    INSTALLED_BY                : installedBy,
    INSTALLATION_PLACE          : String(payload.installationPlace || payload.INSTALLATION_PLACE || ""),
    ACCOSSORIES_COMMENTS        : comments,
    LOGISTIC_COMMENTS           : comments,
    FIELD_IDS                   : String(payload.fieldIds || payload.FIELD_IDS || ""),
    FIELD_VALUE                 : String(payload.fieldValue || payload.FIELD_VALUE || ""),
    ASSIGNED_VEHICLE_SETTING_ID : String(payload.ASSIGNED_VEHICLE_SETTING_ID ?? -1),
    LINK_AND_RUN                : String(payload.LINK_AND_RUN ?? 0),
    UPDATE_DRIVER_CODE          : String(payload.UPDATE_DRIVER_CODE ?? 0),
    SAFETY_GROUP_ID             : String(payload.SAFETY_GROUP_ID ?? -1),
    NICK_NAME                   : String(payload.NICK_NAME ?? ""),
    ID_DRIVER_ID                : String(payload.ID_DRIVER_ID ?? -1),
    ID_TEMP_SENSORS             : String(payload.ID_TEMP_SENSORS ?? -1),
    ID_D_MASS                   : String(payload.ID_D_MASS ?? -1),
    ID_TRAILER                  : String(payload.ID_TRAILER ?? -1),
    ID_DOORS                    : String(payload.ID_DOORS ?? -1),
    ID_MDT                      : String(payload.ID_MDT ?? -1),
    ID_MODEM                    : String(payload.ID_MODEM ?? -1),
    ID_TACHOGRAPH               : String(payload.ID_TACHOGRAPH ?? -1),
    DUPLICATE                   : String(payload.DUPLICATE ?? 0),
    DUPLICATE_VEHICLE           : String(payload.DUPLICATE_VEHICLE ?? -1),
    DUPLICATE_CLIENT            : String(payload.DUPLICATE_CLIENT ?? -1),
    SVR_ID                      : String(payload.SVR_ID ?? -1),
    BUILD_ID                    : String(payload.BUILD_ID ?? ""),
    iDRIVE_UNIT_SN              : String(payload.iDRIVE_UNIT_SN ?? ""),
    ORIG_ZOOM_ID                : String(payload.ORIG_ZOOM_ID ?? process.env.HTML5_ORIG_ZOOM_ID ?? -1),
    DUPLICATE_ZOOM_ID           : String(payload.DUPLICATE_ZOOM_ID ?? ""),
    ORIG_ZOOM_NUMBER            : String(payload.ORIG_ZOOM_NUMBER ?? ""),
    ORIG_ZOOM_DESCR             : String(payload.ORIG_ZOOM_DESCR ?? ""),
    DUPLICATE_ZOOM_NUMBER       : String(payload.DUPLICATE_ZOOM_NUMBER ?? ""),
    DUPLICATE_ZOOM_DESCR        : String(payload.DUPLICATE_ZOOM_DESCR ?? ""),
  };

  // extra fields do app
  const extra = payload.html5ExtraFields || payload.extraFields || null;
  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) fields[String(k)] = String(v ?? "");
    }
  }

  // limpa undefined/null literais
  for (const k of Object.keys(fields)) {
    const ss = String(fields[k] ?? "").trim().toLowerCase();
    if (ss === "undefined" || ss === "null") fields[k] = "";
  }

  // Reconstrói FIELD_VALUE com o serial quando baseline tem valores vazios (ex: "2:,6:")
  // Traffilog rejeita custom fields com valores em branco
  const fids = String(fields.FIELD_IDS || "");
  const fval = String(fields.FIELD_VALUE || "");
  if (fids && serial) {
    const ids = fids.split(",").map((s: string) => s.trim()).filter(Boolean);
    const allEmpty = !fval || ids.every(id => {
      const part = fval.split(",").find(p => p.startsWith(`${id}:`));
      return !part || part === `${id}:`;
    });
    if (allEmpty && ids.length) {
      fields.FIELD_VALUE = ids.map(id => `${id}:${serial}`).join(",");
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Processamento de um job
// ---------------------------------------------------------------------------

async function processJob(job: any): Promise<void> {
  const jobId   = String(job.id || job.jobId || job._id || "");
  const payload = normalizePayload(job.payload || {});

  console.log(`[install-rw] job=${jobId} plate=${payload.plate || "?"} serial=${payload.serial || "?"}`);

  // 1. Resolve VEHICLE_ID — detecta Caminho A ou B
  let vehicleId = Number(payload.vehicle_id || 0);
  let resolvedBy: "plate" | "serial" | "payload" = "payload";
  let clientIdFound: number | null = null;

  if (!vehicleId) {
    const resolved = await resolveVehicleIdWithPath(payload, jobId).catch((e: any) => {
      console.log(`[install-rw] job=${jobId} resolve falhou: ${e?.message || e}`);
      return null;
    });

    if (!resolved) {
      await failJob(jobId, "vehicle_id_not_found", {
        plate : payload.plate,
        serial: payload.serial,
      });
      return;
    }

    vehicleId   = resolved.vehicleId;
    resolvedBy  = resolved.resolvedBy;
    clientIdFound = resolved.clientIdFound ?? null;

    // CHANGE_COMPANY será executada APÓS o SAVE (ver etapa 8a abaixo)
    if (resolved.resolvedBy === "serial" && resolved.clientMismatch) {
      payload._needsChangeCompany = true;
      // Extrai campos do veículo do XML do VHCLS para o payload do ASSET_BASIC_SAVE
      try {
        const snapFiles = fs.readdirSync("/tmp")
          .filter((f: string) => f.startsWith(`vhcls_raw_${jobId}_`) && f.endsWith(".xml"))
          .sort().reverse();
        if (snapFiles.length) {
          const xml = fs.readFileSync(`/tmp/${snapFiles[0]}`, "utf8");
          const attrRe = /(\w+)="([^"]*)"/g;
          let m: RegExpExecArray | null;
          const vhclsData: Record<string, string> = {};
          while ((m = attrRe.exec(xml)) !== null) vhclsData[m[1]] = m[2];
          payload._vhclsData = vhclsData;
          console.log(`[install-rw] job=${jobId} vhclsData extraído: ASSET_TYPE=${vhclsData.ASSET_TYPE||"?"} FIRMWARE=${vhclsData.FIRMWARE||"?"}`);
        }
      } catch { /* não bloqueia */ }
    }
  }

  // Propaga vehicle_id no payload
  payload.vehicle_id = vehicleId;
  payload.VEHICLE_ID = vehicleId;
  payload.vehicleId  = vehicleId;

  // 3+4. Verifica serial CMDT e carrega baseline em paralelo (independentes — ambos só precisam de vehicleId)
  const serial = String(payload.serial || payload.inner_id || payload.INNER_ID || "").trim();
  const installerName = String(payload.installer_name || payload.installer || payload.INSTALLER_NAME || "installer");

  const [cmdtSettled, baselineSettled] = await Promise.allSettled([
    serial ? checkAndFreeSerial(cfg, serial, jobId, installerName) : Promise.resolve(null),
    mwsLoadBaseline(cfg, vehicleId, jobId),
  ]);

  // --- resultado CMDT ---
  if (serial) {
    if (cmdtSettled.status === "fulfilled" && cmdtSettled.value !== null) {
      const cr = cmdtSettled.value;
      if (cr.freed) {
        console.log(`[install-rw] job=${jobId} CMDT freed: serial=${serial} was in vid=${cr.vid_freed} plate="${cr.plate_freed}"`);
      } else if (cr.blocked) {
        await failJob(jobId, "serial_in_use", {
          detail: `serial already linked to vehicle_id=${cr.vid_blocked} plate="${cr.plate_blocked}"`,
        });
        return;
      } else if ("error" in cr && cr.error) {
        console.log(`[install-rw] job=${jobId} CMDT check failed (non-blocking): ${cr.error}`);
      }
    } else if (cmdtSettled.status === "rejected") {
      console.log(`[install-rw] job=${jobId} CMDT check exception (non-blocking): ${(cmdtSettled as any).reason?.message || (cmdtSettled as any).reason}`);
    }
  }

  if (!vehicleId) {
    await failJob(jobId, "vehicle_id_not_found_post_cmdt", {
      plate : payload.plate,
      serial: payload.serial,
    });
    return;
  }

  // --- resultado baseline ---
  let baselineRawText = "";
  if (baselineSettled.status === "fulfilled") {
    const baseline = baselineSettled.value;
    baselineRawText = baseline.rawText;

    const idsNow = String(payload.FIELD_IDS || payload.fieldIds || "").trim();
    const valNow = String(payload.FIELD_VALUE || payload.fieldValue || "").trim();
    if (!idsNow && baseline.fields.FIELD_IDS) {
      payload.FIELD_IDS  = baseline.fields.FIELD_IDS;
      payload.fieldIds   = baseline.fields.FIELD_IDS;
    }
    if (!valNow && baseline.fields.FIELD_VALUE) {
      payload.FIELD_VALUE = baseline.fields.FIELD_VALUE;
      payload.fieldValue  = baseline.fields.FIELD_VALUE;
    }
    console.log(`[install-rw] job=${jobId} baseline loaded keys=${Object.keys(baseline.fields).length}`);

    // SKIP_SB_V1: schemeId cadastrado == schemeId do cliente && asset_type cadastrado == asset_type do cadastro
    const assignedSchemeId  = String(baseline.fields.ASSIGNED_VEHICLE_SETTING_ID || "").trim();
    const assignedAssetType = String(baseline.fields.ASSET_TYPE || "").trim();
    const targetSchemeId    = getSelectedSchemeId(payload.client_id) ?? String(payload.vehicle_setting_id || payload.vehicleSettingId || "").trim();
    const targetAssetType   = String(payload.assetType ?? payload.asset_type ?? payload.ASSET_TYPE ?? "").trim();
    const schemeMatch = !!(assignedSchemeId && targetSchemeId && assignedSchemeId === targetSchemeId);
    const assetMatch  = !!(assignedAssetType && targetAssetType && assignedAssetType === targetAssetType);
    const skipSb = schemeMatch && assetMatch;

    console.log(
      `[install-rw] job=${jobId} SKIP_SB_CHECK` +
      ` assignedScheme=${assignedSchemeId} targetScheme=${targetSchemeId} schemeMatch=${schemeMatch}` +
      ` assignedAsset=${assignedAssetType} targetAsset=${targetAssetType} assetMatch=${assetMatch}` +
      ` → skip_sb=${skipSb}`
    );

    if (skipSb) payload._skip_sb = true;
  } else {
    console.log(`[install-rw] job=${jobId} baseline load failed (non-blocking): ${(baselineSettled as any).reason?.message || (baselineSettled as any).reason}`);
  }

  // 5. Constrói fields do SAVE
  const saveFields = buildInstallFields(payload);

  console.log(
    `[install-rw] SAVE_FIELDS job=${jobId}` +
    ` VEHICLE_ID=${saveFields.VEHICLE_ID}` +
    ` LICENSE_NMBR=${saveFields.LICENSE_NMBR}` +
    ` DIAL_NUMBER=${saveFields.DIAL_NUMBER}` +
    ` ASSET_TYPE=${saveFields.ASSET_TYPE}` +
    ` INSTALLATION_DATE=${saveFields.INSTALLATION_DATE}` +
    ` resolved_by=${resolvedBy}`
  );

  // 6. SAVE_VHCL_ACTIVATION_NEW
  console.log(`[install-rw] PRE_SAVE job=${jobId} FIELD_IDS=${saveFields.FIELD_IDS||"?"} FIELD_VALUE=${saveFields.FIELD_VALUE||"?"} serial=${saveFields.DIAL_NUMBER||"?"}`);
  const fakeBaseline = { fields: saveFields, rawText: baselineRawText };
  const doSave = () => mwsSave(
    cfg, jobId, vehicleId,
    saveFields.LICENSE_NMBR,
    saveFields.DIAL_NUMBER,
    fakeBaseline,
    { stripFields: payload.strip_fields === 1 || payload.strip_fields === "1" }
  );
  let saveResult;
  try {
    saveResult = await doSave();
  } catch (e: any) {
    const isFetchFailed = String(e?.message || "").includes("fetch failed");
    if (isFetchFailed) {
      // Conexão TCP stale — aguarda 2s e retenta uma vez
      console.log(`[install-rw] job=${jobId} mws_save fetch failed — retry em 2s`);
      await new Promise(r => setTimeout(r, 2000));
      try { saveResult = await doSave(); }
      catch (e2: any) {
        await failJob(jobId, "mws_save_exception", { detail: e2?.message || String(e2) });
        return;
      }
    } else {
      await failJob(jobId, "mws_save_exception", { detail: e?.message || String(e) });
      return;
    }
  }

  if (saveResult.hasError) {
    await failJob(jobId, "mws_save_action_error", {
      http: saveResult.status,
      head: String(saveResult.text || "").slice(0, 240),
    });
    return;
  }

  // 7. Postcheck
  let dial = saveFields.DIAL_NUMBER; // fallback se postcheck timeout
  let vehicleSettingIdFromPostcheck = "";
  try {
    const pc = await mwsPostcheck(cfg, vehicleId, saveFields.DIAL_NUMBER, jobId);
    dial = pc.dial;
    try {
      const attrs: any = mwsExtractActivationAttrs(pc.rawText) || {};
      vehicleSettingIdFromPostcheck = String(attrs.ASSIGNED_VEHICLE_SETTING_ID || attrs.VEHICLE_SETTING_ID || attrs.vehicle_setting_id || "").trim();
    } catch { /* ignora */ }
    if (!pc.applied) {
      await failJob(jobId, "mws_save_not_applied", {
        dial_expected: saveFields.DIAL_NUMBER,
        dial_found   : pc.dial || "<empty>",
      });
      return;
    }
  } catch (e: any) {
    const isTimeout = (e?.name === "AbortError") || String(e?.message || "").includes("This operation was aborted");
    if (isTimeout) {
      // Timeout de rede no postcheck — SAVE provavelmente aplicado, continuando com dial do payload
      console.log(`[install-rw] job=${jobId} mws_postcheck TIMEOUT (latência Traffilog) — assumindo SAVE OK, dial=${dial}`);
    } else {
      await failJob(jobId, "mws_postcheck_exception", { detail: e?.message || String(e) });
      return;
    }
  }

  // 8a. CHANGE_COMPANY — executada APÓS o SAVE para não ser desfeita pelo CMDT
  if (payload._needsChangeCompany) {
    const clientIdDest = String(payload.client_id || "");
    const clientDescr  = String(payload.client_descr || "");
    if (!clientIdDest || !clientDescr) {
      console.log(`[install-rw] job=${jobId} _needsChangeCompany mas client_id/client_descr ausentes — pulado`);
    } else {
      console.log(`[install-rw] job=${jobId} CHANGE_COMPANY pós-SAVE → executando`);
      const vhclsData = (payload._vhclsData && typeof payload._vhclsData === "object") ? payload._vhclsData as Record<string, string> : {};
      const ccResult = await executeChangeCompany(cfg, vehicleId, clientIdDest, clientDescr, jobId, vhclsData)
        .catch((e: any) => ({ ok: false as const, error: String(e?.message || e) }));
      if (!ccResult.ok) {
        await failJob(jobId, "change_company_failed", {
          vehicle_id : vehicleId,
          client_dest: clientIdDest,
          error      : ccResult.error,
        });
        return;
      }
      console.log(`[install-rw] job=${jobId} CHANGE_COMPANY pós-SAVE OK group_id=${ccResult.group_id}`);
    }
  }

  // 8. Sucesso
  // vehicle_setting_id é repassado ao resultado para o jobRoutes.ts usar no scheme_builder
  const vehicleSettingId = String(payload.vehicle_setting_id || payload.ASSIGNED_VEHICLE_SETTING_ID || vehicleSettingIdFromPostcheck || "");

  await completeJob(jobId, {
    ok                : true,
    flow              : "INSTALL",
    resolved_by       : resolvedBy,
    plate             : saveFields.LICENSE_NMBR,
    vehicle_id        : vehicleId,
    serial            : saveFields.DIAL_NUMBER,
    dial              : dial,
    http              : saveResult.status,
    vehicle_setting_id: vehicleSettingId,
    client_id_found   : clientIdFound,
    skip_sb           : payload._skip_sb === true,
  });

  console.log(`[install-rw] job=${jobId} INSTALL OK vehicle_id=${vehicleId} serial=${dial} resolved_by=${resolvedBy} skip_sb=${payload._skip_sb === true}`);
}

// ---------------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------------

async function loop(): Promise<void> {
  console.log(`[install-rw] iniciando poll BASE=${BASE} POLL_MS=${POLL_MS}`);
  while (true) {
    try {
      const job = await pollNextJob();
      if (job) {
        processJob(job).catch((err: any) => {
          console.error(`[install-rw] processJob unhandled: ${err?.message || String(err)}`);
        });
      }
    } catch (err: any) {
      console.error(`[install-rw] poll erro: ${err?.message || String(err)}`);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

loop();
