"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/jobRoutes.ts
const express_1 = require("express");
const jobStore_1 = require("../jobs/jobStore");
const sessionTokenStore_1 = require("../services/sessionTokenStore");
const router = (0, express_1.Router)();
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
    const isHtml5 = String(type).toLowerCase().startsWith("html5_");
    if (!isHtml5) {
        // ✅ mantém comportamento atual: só libera job se houver token carregado
        const token = ((0, sessionTokenStore_1.getSessionToken)() || "").trim();
        if (!token)
            return res.status(503).json({ error: "missing session token (set via /api/admin/session-token)" });
        const job = (0, jobStore_1.getNextJob)(type, workerId);
        if (!job)
            return res.status(204).send();
        // ✅ injeta token apenas na resposta
        const out = JSON.parse(JSON.stringify(job));
        out.payload = out.payload || {};
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
