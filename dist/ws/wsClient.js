"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.openMonitorWebSocket = openMonitorWebSocket;
// src/ws/wsClient.ts
const ws_1 = __importDefault(require("ws"));
/**
 * Abre o WebSocket do Monitor e espera até receber um session_token em alguma mensagem.
 */
async function openMonitorWebSocket() {
    const url = process.env.MONITOR_WS_URL;
    if (!url) {
        throw new Error("MONITOR_WS_URL não configurada nas variáveis de ambiente.");
    }
    return new Promise((resolve, reject) => {
        let resolved = false;
        let sessionToken = null;
        const ws = new ws_1.default(url);
        const timeoutMs = 15000; // 15s pra achar um session_token
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                try {
                    ws.close();
                }
                catch {
                    // ignore
                }
                reject(new Error("Timeout esperando session_token no WebSocket."));
            }
        }, timeoutMs);
        ws.on("open", () => {
            console.log("[WS] Conectado ao Monitor:", url);
        });
        ws.on("message", (data) => {
            if (resolved)
                return;
            try {
                const text = typeof data === "string" ? data : data.toString("utf8");
                // console.log("[WS] msg:", text); // se quiser debugar
                const json = JSON.parse(text);
                const tokenFromResponse = json?.response?.properties?.session_token;
                const tokenFromAction = json?.action?.session_token;
                const token = tokenFromResponse || tokenFromAction;
                if (token) {
                    sessionToken = token;
                    resolved = true;
                    clearTimeout(timeout);
                    console.log("[WS] session_token capturado:", token);
                    return resolve({ socket: ws, sessionToken: token });
                }
            }
            catch (e) {
                // Mensagens que não forem JSON, ignoramos silenciosamente
                // console.warn("[WS] Mensagem não-JSON:", e);
            }
        });
        ws.on("error", (err) => {
            console.error("[WS] Erro:", err);
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                reject(err);
            }
        });
        ws.on("close", () => {
            console.log("[WS] Conexão fechada.");
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                reject(new Error("WS fechado antes de obter session_token."));
            }
        });
    });
}
