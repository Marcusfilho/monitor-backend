"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/jobRoutes.ts
const express_1 = require("express");
const jobStore_1 = require("../jobs/jobStore");
const sessionTokenStore_1 = require("../services/sessionTokenStore");
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
router.get("/next", (req, res) => {
    const type = req.query.type || "";
    const workerId = req.query.worker || "unknown-worker";
    if (!type)
        return res.status(400).json({ error: "Query param 'type' is required" });
    // ✅ HTML5 jobs não dependem de session token (são server-to-server via HTML5 cookie-jar)
    const typeLc = String(type).toLowerCase();
    const isHtml5 = typeLc.startsWith("html5_");
    const isSchemeBuilder = typeLc === "scheme_builder";
    if (!isHtml5) {
        // ✅ scheme_builder não depende de token global no Render (worker faz user_login local)
        // ✅ demais tipos mantêm o gating atual
        const token = ((0, sessionTokenStore_1.getSessionToken)() || "").trim();
        if (!isSchemeBuilder) {
            if (!token)
                return res.status(503).json({ error: "missing session token (set via /api/admin/session-token)" });
        }
        const job = (0, jobStore_1.getNextJob)(type, workerId);
        if (!job)
            return res.status(204).send();
        // ✅ injeta token apenas na resposta
        const out = JSON.parse(JSON.stringify(job));
        out.payload = out.payload || {};
        if (token)
            out.payload.sessionToken = token;
        return res.json({ job: out });
    }
    // ✅ HTML5: não injeta token
    const job = (0, jobStore_1.getNextJob)(type, workerId);
    if (!job)
        return res.status(204).send();
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
