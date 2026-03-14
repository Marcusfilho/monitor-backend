"use strict";


// reqcan: fallback enqueue via in-process jobStore (avoids HTTP + missing injection)
let __createJob = null;
try { __createJob = require("../jobs/jobStore").createJob; } catch (_) {}

const catalogs = require("./catalogs");
const CAN_SNAPSHOT_DEFAULT_CYCLES = Number(process.env.CAN_SNAPSHOT_CYCLES || "12");
const CAN_SNAPSHOT_DEFAULT_INTERVAL_MS = Number(process.env.CAN_SNAPSHOT_INTERVAL_MS || "12000");
const store = require("./installationsStore");

// ============================================================
// SB_SKIP: verifica ASSIGNED_VEHICLE_SETTING_ID atual no HTML5
// POST https://html5.traffilog.com/AppEngine_2_1/default.aspx
// Retorna o ID atual ou null em caso de falha.
// ============================================================
const _HTML5_ACTION_URL = (process.env.HTML5_ACTION_URL || "https://html5.traffilog.com/AppEngine_2_1/default.aspx").trim();
const SB_SKIP_TIMEOUT_MS = Number(process.env.SB_SKIP_TIMEOUT_MS || "8000");

async function _getAssignedVehicleSettingId(vehicleId, clientId) {
  return new Promise((resolve) => {
    try {
      const https = require("https");
      const { URL } = require("url");
      const u = new URL(_HTML5_ACTION_URL);
      const body = Buffer.from(
        `VEHICLE_ID=${encodeURIComponent(String(vehicleId))}&CLIENT_ID=${encodeURIComponent(String(clientId))}&action=GET_ASSIGNED_VEHICLE_SETTING&VERSION_ID=2`,
        "utf8"
      );
      const req = https.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port ? Number(u.port) : 443,
        path: (u.pathname || "/") + (u.search || ""),
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "content-length": String(body.length),
          "accept": "*/*",
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          try {
            const txt = Buffer.concat(chunks).toString("utf8");
            // Resposta: <DATA ASSIGNED_VEHICLE_SETTING_ID="5592" ... />
            const m = txt.match(/ASSIGNED_VEHICLE_SETTING_ID\s*=\s*"(\d+)"/i);
            resolve(m ? Number(m[1]) : null);
          } catch (_) { resolve(null); }
        });
      });
      req.setTimeout(SB_SKIP_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
      req.write(body);
      req.end();
    } catch (_) { resolve(null); }
  });
}
// ============================================================

// IMPORTANTE: você JÁ tem /api/jobs (enqueue). Vamos chamar a mesma função que essa rota usa.
// Aqui eu deixo um adaptador: você pluga seu "enqueueJob" real em 1 lugar.
let enqueueJob = null;

function setEnqueueJob(fn) { enqueueJob = fn; }

function mustEnqueue() {
  if (typeof enqueueJob === "function") return;

  let js = null;
  try { js = require("../jobs/jobStore"); } catch (_) { js = null; }

  const createJob =
    js && (typeof js.createJob === "function" ? js.createJob :
          (typeof js.enqueueJob === "function" ? js.enqueueJob : null));

  if (typeof createJob === "function") {
    enqueueJob = async (jobOrType, maybePayload) => {
      // aceita enqueueJob({type,payload}) OU enqueueJob(type,payload)
      if (jobOrType && typeof jobOrType === "object") {
        const job = jobOrType;
        try { return await createJob(job); }
        catch (e1) { return await createJob(job.type, job.payload); }
      }
      return await createJob(jobOrType, maybePayload);
    };
    return;
  }

  const e = new Error("enqueueJob_not_wired");
  e.code = "enqueueJob_not_wired";
  throw e;
}

function _clientName(clientId) {
  const c = catalogs.getClient(clientId);
  return (c && c.clientName) ? String(c.clientName) : String(clientId || "");
}

async function startPipeline(installation) {
  mustEnqueue();
  const id = installation.installation_id;

  // primeiro job sempre HTML5 (usa payload.service)
  const j1 = await enqueueJob({
    type: "html5_install",
    payload: Object.assign({}, installation.payload, {
      installation_id: id,
      confirm_asset_load: false  // evita step de confirmação pós-CHANGE_COMPANY que causa timeout
    })
  });

  store.pushJob(id, { type: "html5_install", job_id: j1.id || j1.job_id || j1.jobId || null, status: "queued" });
  store.patchInstallation(id, { status: "HTML5_RUNNING" });

  return store.getInstallation(id);
}

async function onJobCompleted(job, result) {
  // job.payload.installation_id é a cola
  const payload = (job && job.payload) || {};
  const installationId = payload.installation_id || payload.installationId;
  if (!installationId) return;

  const inst = store.getInstallation(installationId);
  if (!inst) return;

  const service = String(inst.service || "").toUpperCase();

  // registra job no histórico
  store.pushJob(installationId, {
    type: String(job.type || job.job_type || ""),
    job_id: job.id || job.job_id || null,
    status: "completed",
    ok: !!(result && (result.ok === true || result.status === "success")),
    meta: (result && result.meta) ? result.meta : null
  });

  // best-effort resolve vehicle/client
  const meta = (result && result.meta) ? result.meta : {};
  const vehicle_id = Number(meta.vehicle_id || meta.VEHICLE_ID || result.vehicle_id || 0) || null;
  const current_client_id = Number(meta.client_id || meta.CLIENT_ID || result.client_id || 0) || null;

  if (vehicle_id || current_client_id) {
    store.setResolved(installationId, { vehicle_id, current_client_id });
  }

  // UNINSTALL: acabou no HTML5
  if (service === "UNINSTALL") {
    store.patchInstallation(installationId, { status: "COMPLETED" });
    return;
  }

  // Após HTML5_DONE, enfileira SB (MNS/MWS/INSTALL)
  if (String(job.type) === "html5_install") {
    store.patchInstallation(installationId, { status: "HTML5_DONE" });

    // resolve vehicleSettingId via catalogs (V1)
    const target_client_id = (inst.resolved && inst.resolved.target_client_id) || Number(inst.payload.target_client_id || 0) || null;
    const vid = (inst.resolved && inst.resolved.vehicle_id) || vehicle_id;

    const vehicleSettingId = catalogs.resolveVehicleSettingId({
      target_client_id,
      client_id: current_client_id,
      vehicleSettingId: inst.payload.vehicleSettingId,
      vehicle: inst.payload.vehicle
    });

    if (!vid) {
      store.patchInstallation(installationId, { status: "ERROR", error: { code: "NO_VEHICLE_ID_AFTER_HTML5" } });
      return;
    }
    if (!vehicleSettingId) {
      store.patchInstallation(installationId, { status: "ERROR", error: { code: "VEHICLE_SETTING_NOT_CONFIGURED", target_client_id } });
      return;
    }

    // SB_SKIP: verifica se o equipamento já está com o vehicleSettingId correto.
    // Se sim, pula o SB e vai direto para CAN (economiza ~2-3 min por instalação).
    const _sbSkipEnabled = (process.env.SB_SKIP_ENABLED || "1") !== "0";
    if (_sbSkipEnabled) {
      let _currentSettingId = null;
      try {
        _currentSettingId = await _getAssignedVehicleSettingId(vid, target_client_id || current_client_id);
        console.log(`[engine] SB_SKIP check vehicleId=${vid} currentSettingId=${_currentSettingId} expectedSettingId=${vehicleSettingId}`);
      } catch (_e) {
        console.log(`[engine] SB_SKIP check falhou (ignora e segue com SB):`, _e && _e.message);
      }

      if (_currentSettingId !== null && _currentSettingId === vehicleSettingId) {
        // Equipamento já está com o setting correto → pula SB
        console.log(`[engine] SB_SKIP: SKIP! vehicleId=${vid} já tem settingId=${vehicleSettingId}. Pulando SB, indo direto para CAN.`);
        store.patchInstallation(installationId, {
          status: "SB_DONE",
          sb: { skipped: true, reason: "already_configured", currentSettingId: _currentSettingId, expectedSettingId: vehicleSettingId }
        });

        if (service === "MAINT_NO_SWAP") {
          store.patchInstallation(installationId, { status: "COMPLETED" });
          return;
        }

        mustEnqueue();
        const canJobSkip = await enqueueJob({
          type: "monitor_can_snapshot",
          payload: { installation_id: installationId, vehicleId: vid, cycles: CAN_SNAPSHOT_DEFAULT_CYCLES, interval_ms: CAN_SNAPSHOT_DEFAULT_INTERVAL_MS }
        });
        store.pushJob(installationId, { type: "monitor_can_snapshot", job_id: canJobSkip.id || canJobSkip.job_id || null, status: "queued" });
        store.patchInstallation(installationId, { status: "CAN_RUNNING" });
        return;
      }
    }

    // enqueue monitor SB
    mustEnqueue();
    // REGRA SB: comentário = campo do app, ou data de instalação (dd/mm/aaaa) se vazio
    const _sbCommentBase = String(inst.payload.comment || "").trim();
    const _sbInstDate = (() => {
      try {
        const d = new Date();
        const dd = String(d.getDate()).padStart(2,"0");
        const mm = String(d.getMonth()+1).padStart(2,"0");
        const yy = String(d.getFullYear());
        return `${dd}/${mm}/${yy}`;
      } catch(_) { return ""; }
    })();
    const _sbComment = _sbCommentBase || _sbInstDate;
    const sbJob = await enqueueJob({
      type: "monitor_sb",
      payload: {
        installation_id: installationId,
        clientId: target_client_id || current_client_id,
        clientName: _clientName(target_client_id || current_client_id),
        vehicleId: vid,
        vehicleSettingId,
        comment: _sbComment
      }
    });

    store.pushJob(installationId, { type: "monitor_sb", job_id: sbJob.id || sbJob.job_id || null, status: "queued" });
    store.patchInstallation(installationId, { status: "SB_RUNNING" });
    return;
  }

  // Quando SB termina:
  if (String(job.type) === "monitor_sb") {
    store.patchInstallation(installationId, { status: "SB_DONE" });

    if (service === "MAINT_NO_SWAP") {
      store.patchInstallation(installationId, { status: "COMPLETED" });
      return;
    }

    // INSTALL + MAINT_WITH_SWAP => CAN snapshots
    mustEnqueue();
    const vid = (store.getInstallation(installationId).resolved || {}).vehicle_id;
    const canJob = await enqueueJob({
      type: "monitor_can_snapshot",
      payload: { installation_id: installationId, vehicleId: vid, cycles: CAN_SNAPSHOT_DEFAULT_CYCLES, interval_ms: CAN_SNAPSHOT_DEFAULT_INTERVAL_MS }
    });

    store.pushJob(installationId, { type: "monitor_can_snapshot", job_id: canJob.id || canJob.job_id || null, status: "queued" });
    store.patchInstallation(installationId, { status: "CAN_RUNNING" });
    return;
  }

  // Quando CAN snapshot termina:
  if (String(job.type) === "monitor_can_snapshot") {
    const meta = (result && result.meta && typeof result.meta === "object") ? result.meta : {};
    const topSummary =
      (meta && meta.summary && typeof meta.summary === "object" && !Array.isArray(meta.summary)) ? meta.summary :
      (result && result.summary && typeof result.summary === "object" ? result.summary : null);

    let incomingSnaps = [];
    if (Array.isArray(meta.snapshots)) {
      incomingSnaps = meta.snapshots.filter(Boolean);
    } else if (Array.isArray(result?.can_snapshot)) {
      incomingSnaps = result.can_snapshot.filter(Boolean);
    } else if (Array.isArray(result?.result?.snapshots)) {
      incomingSnaps = result.result.snapshots.filter(Boolean);
    } else if (result?.can_snapshot_latest && typeof result.can_snapshot_latest === "object") {
      incomingSnaps = [ result.can_snapshot_latest ];
    } else if (result?.can_snapshot && typeof result.can_snapshot === "object" && !Array.isArray(result.can_snapshot)) {
      incomingSnaps = [ result.can_snapshot ];
    } else if (result?.result?.snapshot && typeof result.result.snapshot === "object") {
      incomingSnaps = [ result.result.snapshot ];
    }

    const bestSnap = incomingSnaps[0] || null;
    const prevSnaps = Array.isArray(inst.can?.snapshots) ? inst.can.snapshots : [];
    const mergedSnaps = [...incomingSnaps, ...prevSnaps].filter(Boolean).slice(0, 12);

    const canPatch = {
      can: {
        requested_at: inst.can?.requested_at || new Date().toISOString(),
        summary: topSummary || inst.can?.summary || null,
        snapshots: mergedSnaps,
        status: (result && result.ok === false) ? "error" : "ready"
      },
      status: ((job && job.ok === false) || (result && result.ok === false) || !bestSnap) ? "CAN_SNAPSHOT_ERROR" : "CAN_SNAPSHOT_READY"
    };

    if (bestSnap) {
      canPatch.can_snapshot_latest = bestSnap;
      canPatch.can_snapshot = bestSnap;
    }
    if (Array.isArray(meta.errors) && meta.errors.length) {
      canPatch.can_errors = meta.errors.slice(0, 10);
    }

    store.patchInstallation(installationId, canPatch);
    return;
  }
  // Quando GS termina:
  if (String(job.type) === "monitor_gs") {
    store.patchInstallation(installationId, { status: "COMPLETED" });
    return;
  }
}

async function requestCanSnapshot(installationId) {
  const payload = (arguments.length > 1 && arguments[1] && typeof arguments[1] === "object") ? arguments[1] : {};
  // PATCH reqcan_v3: rota passa (installationId, body). Captura body como payload.

  mustEnqueue((payload && (payload.baseUrl || payload.base_url)) || null);
  const inst = store.getInstallation(installationId);
  if (!inst) throw Object.assign(new Error("not_found"), { code: "not_found" });
  const vid = (Number(payload.vehicle_id || payload.vehicleId || payload.VEHICLE_ID || 0) ||
              Number((inst && inst.resolved || {}).vehicle_id || 0) ||
              null);

  if (!vid) throw Object.assign(new Error("no_vehicle_id"), { code: "no_vehicle_id" });

  const _n = (v) => Number(v);
  const _clamp = (n, min, max, defv) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : defv);

  const reqCycles = _n(payload.cycles ?? payload.CYCLES);
  const reqInterval = _n(payload.interval_ms ?? payload.intervalMs);
  const reqEarlyTotal = _n(payload.early_stop_min_total ?? payload.earlyStopMinTotal);
  const reqEarlyWith = _n(payload.early_stop_min_with ?? payload.earlyStopMinWith);

  const cycles = _clamp(reqCycles, 1, 180, CAN_SNAPSHOT_DEFAULT_CYCLES);
  const interval_ms = _clamp(reqInterval, 2000, 60000, CAN_SNAPSHOT_DEFAULT_INTERVAL_MS);

  const canPayload = Object.assign(
    { installation_id: installationId, vehicleId: vid, cycles, interval_ms },
    Number.isFinite(reqEarlyTotal) ? { early_stop_min_total: Math.max(0, Math.trunc(reqEarlyTotal)) } : {},
    Number.isFinite(reqEarlyWith) ? { early_stop_min_with: Math.max(0, Math.trunc(reqEarlyWith)) } : {}
  );

  const canJob = await enqueueJob({
    type: "monitor_can_snapshot",
    payload: canPayload
  });

  store.pushJob(installationId, { type: "monitor_can_snapshot", job_id: canJob.id || canJob.job_id || null, status: "queued" });
  store.patchInstallation(installationId, { status: "CAN_RUNNING" });
  return store.getInstallation(installationId);
}

function _pickSnapForAudit(inst){
  const can = inst && inst.can && typeof inst.can === "object" ? inst.can : null;
  const snap =
    (inst && inst.can_snapshot_latest && typeof inst.can_snapshot_latest === "object") ? inst.can_snapshot_latest :
    (inst && inst.can_snapshot && typeof inst.can_snapshot === "object" && !Array.isArray(inst.can_snapshot)) ? inst.can_snapshot :
    (can && Array.isArray(can.snapshots) && can.snapshots.length ? can.snapshots[0] : null);
  return (snap && typeof snap === "object") ? snap : null;
}

function _pickProgressFromSnap(snap){
  try {
    const raw = snap && snap.header && snap.header.raw;
    const cand = [
      raw && (raw.configuration_progress ?? raw.configurationProgress ?? raw.progress ?? raw.config_progress),
      snap && snap.header && (snap.header.configuration_progress ?? snap.header.progress),
      snap && (snap.configuration_progress ?? snap.progress)
    ].filter(v => v !== undefined && v !== null);
    if (!cand.length) return null;
    const n = Number(cand[0]);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

function _pickPacketTsFromSnap(snap){
  try {
    const raw = snap && snap.header && snap.header.raw;
    const cand = [
      raw && (raw.gprs_last ?? raw.gprs_last_date ?? raw.gprsLast ?? raw.gps_last ?? raw.gpsLast),
      snap && snap.header && (snap.header.gprs_last ?? snap.header.gps_last)
    ].filter(v => v !== undefined && v !== null);
    return cand.length ? String(cand[0]) : null;
  } catch { return null; }
}

async function approveCan(installationId, { override, reason }) {
  mustEnqueue();
  const inst = store.getInstallation(installationId);
  if (!inst) throw Object.assign(new Error("not_found"), { code: "not_found" });

  const service = String(inst.service || "").toUpperCase();
  if (service === "MAINT_NO_SWAP" || service === "UNINSTALL") {
    store.patchInstallation(installationId, { status: "COMPLETED" });
    return store.getInstallation(installationId);
  }

  const now = new Date().toISOString();
  const overrideBool = !!override;

  // Auditoria (snapshot final pré-validação) — idempotente
  try {
    const canPrev = (inst.can && typeof inst.can === "object") ? inst.can : {};
    const auditPrev = (canPrev.audit && typeof canPrev.audit === "object") ? canPrev.audit : {};
    if (!auditPrev.pre_approval) {
      const snap = _pickSnapForAudit(inst);
      auditPrev.pre_approval = {
        schema_version: 1,
        captured_at: now,
        override: overrideBool,
        reason: reason || null,
        packet_ts: _pickPacketTsFromSnap(snap),
        sb_progress_at_capture: _pickProgressFromSnap(snap),
        snapshot: snap || null,
      };
    }

    const canPatched = Object.assign({}, canPrev, {
      audit: auditPrev,
      stop_requested_at: canPrev.stop_requested_at || now,
      approved_at: canPrev.approved_at || now,
      approved_override: overrideBool,
      approved_reason: reason || null,
    });

    store.patchInstallation(installationId, {
      status: overrideBool ? "CAN_APPROVED_OVERRIDE" : "CAN_APPROVED",
      can: canPatched,
    });
  } catch (_e) {}

  // evita duplicar GS se o técnico clicar 2x
  try {
    const cur = store.getInstallation(installationId);
    if (cur && Array.isArray(cur.jobs) && cur.jobs.some(j => String(j?.type||"") === "monitor_gs" && String(j?.status||"") !== "error")) {
      return store.getInstallation(installationId);
    }
  } catch (_e) {}

  // enfileira GS
  const gs = catalogs.resolveGsCommand({
    label_pos: inst.payload?.gsensor?.label_pos,
    harness_pos: inst.payload?.gsensor?.harness_pos
  });
  if (!gs) {
    store.patchInstallation(installationId, { status: "ERROR", error: { code: "GS_COMMAND_NOT_CONFIGURED" } });
    return store.getInstallation(installationId);
  }

  const vid = (inst.resolved || {}).vehicle_id;
  const target_client_id = (inst.resolved && inst.resolved.target_client_id) || Number(inst.payload.target_client_id || 0) || null;
  const vehicleSettingId = catalogs.resolveVehicleSettingId({
    target_client_id,
    client_id: (inst.resolved || {}).current_client_id,
    vehicleSettingId: inst.payload.vehicleSettingId,
    vehicle: inst.payload.vehicle
  });

  const clientName = _clientName(target_client_id);
  // REGRA GS: comentário OBRIGATORIAMENTE inclui o comando enviado (ex: G-Sensor: FRONT-LEFT)
  const _gsLabelPos  = String(inst.payload?.gsensor?.label_pos  || gs.label   || "").trim().toUpperCase();
  const _gsHarnessPos = String(inst.payload?.gsensor?.harness_pos || gs.harness || "").trim().toUpperCase();
  const _gsCommandLabel = (_gsLabelPos && _gsHarnessPos) ? `${_gsLabelPos}-${_gsHarnessPos}` : (_gsLabelPos || _gsHarnessPos || "");
  const _gsCommentBase = ""; // GS ignora texto do app — usa só G-Sensor: LABEL-HARNESS
  const _gsComment = _gsCommandLabel
    ? (_gsCommentBase ? `${_gsCommentBase} | G-Sensor: ${_gsCommandLabel}` : `G-Sensor: ${_gsCommandLabel}`)
    : (_gsCommentBase || ("APP GS " + service));
  const gsJob = await enqueueJob({
    type: "monitor_gs",
    payload: {
      installation_id: installationId,
      clientId: target_client_id,
      clientName,
      vehicleId: vid,
      vehicleSettingId,
      GS_ACTION_ID: gs.GS_ACTION_ID,
      GS_COMMAND_SYNTAX: gs.GS_COMMAND_SYNTAX,
      comment: _gsComment,
      canApproved: true,
      override: overrideBool,
      reason: reason || null
    }
  });

  store.pushJob(installationId, { type: "monitor_gs", job_id: gsJob.id || gsJob.job_id || null, status: "queued" });
  return store.getInstallation(installationId);
}

module.exports = {
  setEnqueueJob,
  startPipeline,
  onJobCompleted,
  requestCanSnapshot,
  approveCan
};
