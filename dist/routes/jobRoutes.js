"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/jobRoutes.ts
const express_1 = require("express");
const jobStore_1 = require("../jobs/jobStore");
const sessionTokenStore_1 = require("../services/sessionTokenStore");
function pickCanSnapshotFromCompleteBody(body){
  const root = body || {};
  const looks = (o) => {
    if (!o || typeof o !== "object") return false;
    if (Array.isArray(o.parameters)) return true;
    if (Array.isArray(o.moduleState)) return true;
    if (o.counts && typeof o.counts === "object") return true;
    return false;
  };
  const first = (v) => Array.isArray(v) ? (v.length ? v[v.length-1] : null) : v;

  const cand = [
    root.snapshot,
    root.best,
    root.bestSnapshot,
    root.best_snapshot,
    root.can_snapshot_latest,
    root.canSnapshotLatest,
    root.snapshot_best,
    root.can_snapshot_best,
    first(root.snapshots),
    first(root.can_snapshot),
    first(root.canSnapshot),
    (root.can && first(root.can.snapshots)),
    (root.result && (root.result.snapshot || root.result.can_snapshot_latest || root.result.canSnapshotLatest ||
      root.result.best || root.result.bestSnapshot || root.result.best_snapshot || first(root.result.snapshots) ||
      first(root.result.can_snapshot) || first(root.result.canSnapshot) || (root.result.can && first(root.result.can.snapshots)))),
    root,
  ];

  for (const c of cand){
    const v = first(c);
    if (looks(v)) return v;
  }
  return null;
}

const router = (0, express_1.Router)();
// === PIPELINE_AUTO_SB_V1 (encadear Monitor após HTML5 sem workaround) ===
// Nota: services/* vivem em dist/ (JS). Em dev (ts-node), esse require pode falhar — por isso é best-effort.
const installationsStore = (() => { try {
    return require("../services/installationsStore");
}
catch {
    return null;
} })();
const catalogs = (() => { try {
    return require("../services/catalogs");
}
catch {
    return null;
} })();
function _num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}
function _upper(v) { return String(v || "").trim().toUpperCase(); }
function _getInstallationId(job) {
    const id = job?.payload?.installation_id ?? job?.payload?.installationId ?? null;
    return id ? String(id) : null;
}
function _resultOk(result) {
    if (!result || typeof result !== "object")
        return false;
    if (result.ok === true)
        return true;
    const st = String(result.status || "").toLowerCase();
    return st === "ok" || st === "success" || st === "done" || st === "completed";
}
function _pickVehicleId(job, result) {
    const meta = (result && typeof result === "object") ? result.meta : null;
    return _num(meta?.vehicle_id ?? meta?.VEHICLE_ID ?? result?.vehicle_id ?? result?.VEHICLE_ID);
}
function _pickClientId(inst, job, result) {
    return _num(inst?.payload?.target_client_id ??
        job?.payload?.target_client_id ??
        inst?.payload?.client_id ??
        job?.payload?.client_id ??
        (result?.meta ? result.meta.target_client_id : null));
}
function _pickVehicleSettingId(inst, job, result) {
    const meta = result?.meta || null;
    return _num(meta?.vehicleSettingId ??
        meta?.vehicle_setting_id ??
        inst?.payload?.vehicleSettingId ??
        inst?.payload?.vehicle_setting_id ??
        job?.payload?.vehicleSettingId ??
        job?.payload?.vehicle_setting_id);
}
function _alreadyHasSb(installationId) {
    try {
        return (0, jobStore_1.listJobs)().some((j) => j?.type === "scheme_builder" &&
            String(j?.payload?.installation_id ?? j?.payload?.installationId ?? "") === String(installationId) &&
            j?.status !== "error");
    }
    catch {
        return false;
    }
}
function _handleCanSnapshotComplete(job, result, jobId) {
    try {
        if (!installationsStore?.getInstallation || !installationsStore?.patchInstallation)
            return;
        if (!job || String(job.type || "") !== "monitor_can_snapshot")
            return;
        const installationId = _getInstallationId(job);
        if (!installationId)
            return;
        const inst = installationsStore.getInstallation(installationId);
        if (!inst)
            return;
        const meta = (result && typeof result === "object") ? result.meta : null;
        const can = inst.can && typeof inst.can === "object" ? inst.can : {};
        const prev = Array.isArray(can.snapshots) ? can.snapshots : [];
        let incoming = [];
        if (meta) {
            if (Array.isArray(meta.snapshots))
                incoming = meta.snapshots;
            else if (meta.snapshot != null)
                incoming = [meta.snapshot];
            can.last_snapshot_at = new Date().toISOString();
            if (meta.summary !== undefined)
                can.summary = meta.summary;
            else
                can.summary = can.summary || meta || null;
        }
        else {
            can.summary = can.summary || null;
        }
        const merged = incoming.concat(prev).filter((v) => v != null);
        can.snapshots = merged.slice(0, 5);
        try {
            const __snap = pickCanSnapshotFromCompleteBody(result);
            const __summary = (__snap && __snap.counts) ? __snap.counts : null;
            const __canPatched = Object.assign({}, (can && typeof can === "object") ? can : {}, {
                snapshots: __snap ? [__snap] : ((can && can.snapshots) ? can.snapshots : []),
                summary: __summary || ((can && can.summary) ? can.summary : null),
                last_snapshot_at: (__snap && (__snap.captured_at || __snap.capturedAt)) || ((can && (can.last_snapshot_at || can.lastSnapshotAt)) ? (can.last_snapshot_at || can.lastSnapshotAt) : null),
            });
            installationsStore.patchInstallation(installationId, { can: __canPatched,
    can_snapshot_latest: (__snap || null),
    can_snapshot: (__snap || null), status: "CAN_SNAPSHOT_READY" });
        }
        catch { }
        try {
            const metaSmall = meta && meta.summary !== undefined ? meta.summary : null;
            installationsStore.pushJob && installationsStore.pushJob(installationId, {
                type: "monitor_can_snapshot",
                job_id: String(jobId || job?.id || ""),
                status: "completed",
                ok: _resultOk(result),
                meta: metaSmall,
            });
        }
        catch { }
    }
    catch (e) {
        console.log("[jobs] handle CAN snapshot failed:", e && (e.message || String(e)));
    }
}
function _enqueueSchemeBuilderAfterHtml5(job, result) {
    try {
        if (!job || String(job.type || "") !== "html5_install")
            return;
        if (!_resultOk(result))
            return;
        const installationId = _getInstallationId(job);
        if (!installationId)
            return;
        const service = _upper(job?.payload?.service ?? job?.payload?.servico);
        if (!service)
            return;
        const mskip = result?.meta ? result.meta.monitor_skip : null;
        if (mskip === 1 || mskip === "1" || mskip === true)
            return;
        if (!["INSTALL", "MAINT_NO_SWAP", "MAINT_WITH_SWAP"].includes(service))
            return;
        if (_alreadyHasSb(installationId))
            return;
        const inst = installationsStore?.getInstallation ? installationsStore.getInstallation(installationId) : null;
        const vehicleId = _pickVehicleId(job, result);
        const clientId = _pickClientId(inst, job, result);
        const vehicleSettingId = _pickVehicleSettingId(inst, job, result);
        if (vehicleId) {
            try {
                installationsStore?.setResolved && installationsStore.setResolved(installationId, { vehicle_id: vehicleId });
            }
            catch { }
        }
        if (!vehicleId || !clientId || !vehicleSettingId) {
            try {
                installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "HTML5_DONE" });
            }
            catch { }
            console.log(`[jobs] [PIPELINE] skip SB: missing fields installation=${installationId} service=${service} vehicleId=${vehicleId} clientId=${clientId} vehicleSettingId=${vehicleSettingId}`);
            return;
        }
        const c = catalogs?.getClient ? catalogs.getClient(clientId) : null;
        const clientName = String((c && c.clientName) ? c.clientName : clientId);
        const sb = (0, jobStore_1.createJob)("scheme_builder", {
            installation_id: installationId,
            service,
            clientId: String(clientId),
            clientName,
            vehicleId: String(vehicleId),
            vehicleSettingId: Number(vehicleSettingId),
            comment: `APP ${service} inst=${installationId}`
        });
        try {
            installationsStore?.pushJob && installationsStore.pushJob(installationId, { type: "scheme_builder", job_id: sb.id, status: "queued" });
        }
        catch { }
        try {
            installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "SB_QUEUED" });
        }
        catch { }
        console.log(`[jobs] [PIPELINE] enqueued scheme_builder job=${sb.id} installation=${installationId} vehicleId=${vehicleId} vehicleSettingId=${vehicleSettingId}`);
    }
    catch (e) {
        console.log("[jobs] [PIPELINE] enqueue SB failed:", e && (e.message || String(e)));
    }
}
// === /PIPELINE_AUTO_SB_V1 ===
/** POST /api/jobs */
router.post("/", (req, res) => {
    const { type, payload } = req.body || {};
    if (!type)
        return res.status(400).json({ error: "Field 'type' is required" });
    const job = (0, jobStore_1.createJob)(type, payload);
    return res.status(201).json({ job });
});
/** GET /api/jobs/next?type=scheme_builder&worker=vm-worker-01 */
/** GET /api/jobs/next?type=scheme_builder&worker=vm-worker-01 */
/** GET /api/jobs/next?type=...&worker=... */
router.get("/next", (req, res) => {
    const type = String((req.query || {}).type || "");
    const workerId = String((req.query || {}).worker || "unknown-worker");
    if (!type)
        return res.status(400).json({ error: "Query param 'type' is required" });
    const typeLc = type.toLowerCase();
    const isHtml5 = typeLc.startsWith("html5_");
    const token = String(((0, sessionTokenStore_1.getSessionToken)() || "")).trim();
    // Gate disabled: jobs/next não deve depender de session token global
    res.setHeader("x-jobsnext-gate", token ? "present" : "missing_allowed_v4");
    const job = (0, jobStore_1.getNextJob)(type, workerId);
    if (!job)
        return res.status(204).send();
    // Injeta token só em jobs não-HTML5 (HTML5 usa cookie-jar / fluxo próprio)
    if (!isHtml5 && token) {
        const out = JSON.parse(JSON.stringify(job));
        out.payload = out.payload || {};
        if (!out.payload.sessionToken)
            out.payload.sessionToken = token;
        return res.json({ job: out });
    }
    return res.json({ job });
});
/** POST /api/jobs/:id/complete */
// POST /api/jobs/:id/progress  body: { percent: 0..100, stage?: string, detail?: string }
// POST /api/jobs/:id/progress  body: { percent: 0..100, stage?: string, detail?: string }
router.post("/:id/progress", (req, res) => {
    const jobId = String(req.params?.id || "");
    const id = jobId; // compat: alguns lookups usam "id"
    const body = req.body || {};
    const p = Number(body.percent);
    if (!Number.isFinite(p) || p < 0 || p > 100) {
        return res.status(400).json({ error: "percent must be 0..100" });
    }
    const job = (0, jobStore_1.getJob)(id);
    if (!job)
        return res.status(404).json({ error: "job not found" });
    job.progressPercent = Math.round(p);
    job.progressStage = (typeof body.stage === "string") ? body.stage : null;
    job.progressDetail = (typeof body.detail === "string") ? body.detail : null;
    job.lastProgressAt = new Date().toISOString();
    return res.json({ ok: true });
});
router.post("/:id/complete", (req, res) => {
    const { id } = req.params;
    const { status, result, workerId } = req.body || {};
    if (!status)
        return res.status(400).json({ error: "Field 'status' is required" });
    const rawStatus = String(status || "").toLowerCase();
    // worker pode mandar status=success; também aceitamos done/completed/complete.
    // além disso, se result.ok === true, consideramos completed.
    const okFlag = rawStatus === "ok" ||
        rawStatus === "success" ||
        rawStatus === "done" ||
        rawStatus === "completed" ||
        rawStatus === "complete" ||
        (req.body?.ok === true) ||
        (result?.ok === true);
    const finalStatus = okFlag ? "completed" : "error";
    const job = (0, jobStore_1.completeJob)(id, finalStatus, result, workerId);
    if (!job)
        return res.status(404).json({ error: "Job not found" });
    // dispara encadeamento para Monitor (SB) após HTML5
    if (finalStatus === "completed") {
        _enqueueSchemeBuilderAfterHtml5(job, result);
        _handleCanSnapshotComplete(job, result, id);
    }
    return res.json({ job });
});
router.get("/:id", (req, res) => {
    const { id } = req.params;
    const job = (0, jobStore_1.getJob)(id);
    if (!job)
        return res.status(404).json({ error: "Job not found" });
    return res.json({ job });
});
router.get("/", (_req, res) => res.json({ jobs: (0, jobStore_1.listJobs)() }));
exports.default = router;
