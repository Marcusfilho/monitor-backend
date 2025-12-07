"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignFirmware = assignFirmware;
// src/services/monitorService.ts
const monitorClient_1 = require("../clients/monitorClient");
/**
 * Envia comando de assign de firmware pro Monitor.
 * TODO: ajustar URL e body conforme o endpoint real que você sniffar.
 */
async function assignFirmware(payload) {
    // TODO: ajuste esta URL conforme o endpoint real do Monitor
    const url = "/api/firmware/assign"; // placeholder
    // TODO: ajuste o body conforme o formato real esperado pela API
    const body = {
        clientId: payload.clientId,
        vehicleId: payload.vehicleId,
        serial: payload.serial,
        firmwareId: payload.firmwareId,
        firmwareHex: payload.firmwareHex,
        requestedBy: payload.requestedBy ?? "MonitorBackend"
    };
    try {
        const response = await monitorClient_1.monitorApi.post(url, body);
        const data = response.data;
        // Aqui você interpreta a resposta real. Vou deixar algo genérico:
        return {
            status: "ok",
            message: "Comando de firmware enviado com sucesso.",
            details: data
        };
    }
    catch (err) {
        console.error("[assignFirmware] Erro ao chamar API do Monitor:", err?.message || err);
        return {
            status: "error",
            message: "Falha ao enviar comando de firmware ao Monitor.",
            details: err?.response?.data || err?.message || err
        };
    }
}
