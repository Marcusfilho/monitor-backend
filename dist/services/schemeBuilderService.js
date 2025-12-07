"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSchemeBuilderBackend = runSchemeBuilderBackend;
// src/services/schemeBuilderService.ts
const wsClient_1 = require("../ws/wsClient");
/**
 * Versão inicial: apenas abre o WS, captura o session_token e fecha.
 * Depois vamos evoluir pra enviar as actions do SchemeBuilder aqui dentro.
 */
async function runSchemeBuilderBackend(_params) {
    try {
        const { socket, sessionToken } = await (0, wsClient_1.openMonitorWebSocket)();
        // Por enquanto, só vamos fechar a conexão logo depois de pegar o token.
        socket.close();
        return {
            status: "ok",
            message: "WebSocket conectado e session_token capturado com sucesso.",
            sessionToken
        };
    }
    catch (err) {
        console.error("[runSchemeBuilderBackend] Erro:", err?.message || err);
        return {
            status: "error",
            message: "Falha ao conectar ao WebSocket do Monitor ou capturar session_token.",
            details: err?.message || err
        };
    }
}
