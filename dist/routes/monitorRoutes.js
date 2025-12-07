"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/monitorRoutes.ts
const express_1 = require("express");
const monitorService_1 = require("../services/monitorService");
const schemeBuilderService_1 = require("../services/schemeBuilderService");
const router = (0, express_1.Router)();
/**
 * POST /api/monitor/assign-firmware
 */
router.post("/assign-firmware", async (req, res) => {
    const body = req.body;
    if (!body.clientId || !body.vehicleId || !body.firmwareId) {
        return res.status(400).json({
            status: "error",
            message: "Campos obrigatórios: clientId, vehicleId, firmwareId (serial e firmwareHex opcionais)."
        });
    }
    try {
        const result = await (0, monitorService_1.assignFirmware)(body);
        const httpStatus = result.status === "ok" ? 200 : 502;
        res.status(httpStatus).json(result);
    }
    catch (err) {
        console.error("[POST /api/monitor/assign-firmware] Erro inesperado:", err);
        res.status(500).json({
            status: "error",
            message: "Erro interno ao processar comando de firmware."
        });
    }
});
/**
 * POST /api/monitor/scheme-builder
 * Exemplo de body:
 * {
 *   "clientId": 218572,
 *   "clientName": "TRANSLIMA",
 *   "vehicleId": 1940478,
 *   "vehicleSettingId": 5592,
 *   "comment": "Comentário opcional"
 * }
 */
router.post("/scheme-builder", async (req, res) => {
    const body = req.body;
    if (!body.clientId ||
        !body.clientName ||
        !body.vehicleId ||
        !body.vehicleSettingId) {
        return res.status(400).json({
            status: "error",
            message: "Campos obrigatórios: clientId, clientName, vehicleId, vehicleSettingId."
        });
    }
    try {
        const result = await (0, schemeBuilderService_1.runSchemeBuilderBackend)(body);
        const httpStatus = result.status === "ok" ? 200 : 502;
        res.status(httpStatus).json(result);
    }
    catch (err) {
        console.error("[POST /api/monitor/scheme-builder] Erro inesperado:", err);
        res.status(500).json({
            status: "error",
            message: "Erro interno ao executar SchemeBuilder no backend."
        });
    }
});
exports.default = router;
