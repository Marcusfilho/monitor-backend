"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jobStore_1 = require("../jobs/jobStore");
const router = (0, express_1.Router)();
/**
 * POST /api/scheme-builder/start
 * Cria um job de Scheme Builder na fila
 */
router.post("/start", (req, res) => {
    const { clientId, clientName, vehicleId, vehicleSettingId, comment, } = req.body || {};
    if (!vehicleId || !vehicleSettingId) {
        return res
            .status(400)
            .json({ error: "Campos 'vehicleId' e 'vehicleSettingId' são obrigatórios." });
    }
    const payload = {
        clientId: clientId ?? null,
        clientName: clientName ?? null,
        vehicleId,
        vehicleSettingId,
        comment: comment ?? null,
    };
    const job = (0, jobStore_1.createJob)("scheme_builder", payload);
    return res.status(201).json({
        jobId: job.id,
        job,
    });
});
/**
 * GET /api/scheme-builder/:id
 * Consulta status/resultado de um job
 */
router.get("/:id", (req, res) => {
    const { id } = req.params;
    const job = (0, jobStore_1.getJob)(id);
    if (!job) {
        return res.status(404).json({ error: "Job não encontrado." });
    }
    return res.json({ job });
});
exports.default = router;
