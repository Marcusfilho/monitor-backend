"use strict";


// reqcan: fallback enqueue via in-process jobStore (avoids HTTP + missing injection)
let __createJob = null;
try { __createJob = require("../jobs/jobStore").createJob; } catch (_) {}

const catalogs = require("./catalogs");
const store = require("./installationsStore");

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
    payload: Object.assign({}, installation.payload, { installation_id: id })
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

    // enqueue monitor SB
    mustEnqueue();
    const sbJob = await enqueueJob({
      type: "monitor_sb",
      payload: {
        installation_id: installationId,
        clientId: target_client_id || current_client_id,
        clientName: _clientName(target_client_id || current_client_id),
        vehicleId: vid,
        vehicleSettingId,
        comment: inst.payload.comment || ("APP " + service)
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
      payload: { installation_id: installationId, vehicleId: vid, cycles: 8, interval_ms: 12000 }
    });

    store.pushJob(installationId, { type: "monitor_can_snapshot", job_id: canJob.id || canJob.job_id || null, status: "queued" });
    store.patchInstallation(installationId, { status: "CAN_RUNNING" });
    return;
  }

  // Quando CAN snapshot termina:
  if (String(job.type) === "monitor_can_snapshot") {
    // guarda summary se existir
    const meta = (result && result.meta) ? result.meta : null;
    if (meta) {
      const inst2 = store.getInstallation(installationId);
      inst2.can = inst2.can || {};
      inst2.can.last_snapshot_at = new Date().toISOString();
      inst2.can.summary = meta.summary || meta;
      store.patchInstallation(installationId, { can: inst2.can, status: "CAN_SNAPSHOT_READY" });
    } else {
      store.patchInstallation(installationId, { status: "CAN_SNAPSHOT_READY" });
    }
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

  const canJob = await enqueueJob({
    type: "monitor_can_snapshot",
    payload: { installation_id: installationId, vehicleId: vid, cycles: 8, interval_ms: 12000 }
  });

  store.pushJob(installationId, { type: "monitor_can_snapshot", job_id: canJob.id || canJob.job_id || null, status: "queued" });
  store.patchInstallation(installationId, { status: "CAN_RUNNING" });
  return store.getInstallation(installationId);
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

  const gsJob = await enqueueJob({
    type: "monitor_gs",
    payload: {
      installation_id: installationId,
      clientId: target_client_id,
      vehicleId: vid,
      vehicleSettingId,
      GS_ACTION_ID: gs.GS_ACTION_ID,
      GS_COMMAND_SYNTAX: gs.GS_COMMAND_SYNTAX,
      comment: inst.payload.comment || ("APP GS " + service),
      canApproved: true,
      override: !!override,
      reason: reason || null
    }
  });

  store.pushJob(installationId, { type: "monitor_gs", job_id: gsJob.id || gsJob.job_id || null, status: "queued" });
  store.patchInstallation(installationId, { status: "GS_RUNNING" });
  return store.getInstallation(installationId);
}

module.exports = {
  setEnqueueJob,
  startPipeline,
  onJobCompleted,
  requestCanSnapshot,
  approveCan
};
