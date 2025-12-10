"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/jobRoutes.ts
const express_1 = require("express");
const jobStore_1 = require("../jobs/jobStore");
const router = (0, express_1.Router)();
/**
 * POST /api/jobs
 * Cria um job novo
 */
router.post("/", (req, res) => {
    const { type, payload } = req.body || {};
    if (!type) {
        return res.status(400).json({ error: "Field 'type' is required" });
    }
    const job = (0, jobStore_1.createJob)(type, payload);
    return res.status(201).json({ job });
});
/**
 * GET /api/jobs/next?type=scheme_builder&worker=vm-worker-01
 * Usado pelo worker na VM
 */
router.get("/next", (req, res) => {
    const type = req.query.type || "";
    const workerId = req.query.worker || "unknown-worker";
    if (!type) {
        return res
            .status(400)
            .json({ error: "Query param 'type' is required" });
    }
    const job = (0, jobStore_1.getNextJob)(type, workerId);
    if (!job) {
        return res.status(204).send();
    }
    return res.json({ job });
});
/**
 * POST /api/jobs/:id/complete
 * Worker marca job como concluído
 */
router.post("/:id/complete", (req, res) => {
    const { id } = req.params;
    const { status, result, workerId } = req.body || {};
    if (!status) {
        return res
            .status(400)
            .json({ error: "Field 'status' is required" });
    }
    const finalStatus = status === "ok" ? "completed" : "error";
    const job = (0, jobStore_1.completeJob)(id, finalStatus, result, workerId);
    if (!job) {
        return res.status(404).json({ error: "Job not found" });
    }
    return res.json({ job });
});
/**
 * GET /api/jobs/:id
 * Consultar status de um job
 */
router.get("/:id", (req, res) => {
    const { id } = req.params;
    const job = (0, jobStore_1.getJob)(id);
    if (!job) {
        return res.status(404).json({ error: "Job not found" });
    }
    return res.json({ job });
});
/**
 * GET /api/jobs
 * Lista jobs (debug)
 */
router.get("/", (_req, res) => {
    return res.json({ jobs: (0, jobStore_1.listJobs)() });
});
exports.default = router;
