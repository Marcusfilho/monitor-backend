"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.openMonitorWebSocket = openMonitorWebSocket;
// src/ws/wsClient.ts
const ws_1 = __importDefault(require("ws"));
const sessionTokenStore_1 = require("../services/sessionTokenStore");
/**
 * Abre o WebSocket do Monitor.
 *
 * Estratégia:
 *  - Se MONITOR_SESSION_TOKEN estiver definido: usa esse token direto, assim que a conexão abrir.
 *  - Caso contrário: tenta extrair session_token de alguma mensagem recebida.
 *
 * Requer:
 *  - MONITOR_WS_URL          = URL completa do WebSocket (copiada do DevTools)
 *  - MONITOR_WS_COOKIE (opt) = Cookie da sessão, se o servidor exigir
 *  - MONITOR_SESSION_TOKEN (opt) = session_token lido do tráfego WS do browser
 */
async function openMonitorWebSocket() {
    const url = process.env.MONITOR_WS_URL;
    await (0, sessionTokenStore_1.refreshSessionTokenFromDisk)().catch(() => { });
    const configuredToken = (0, sessionTokenStore_1.getSessionToken)();
    if (!url) {
        throw new Error("MONITOR_WS_URL não configurada nas variáveis de ambiente.");
    }
    const headers = {};
    if (process.env.MONITOR_WS_COOKIE) {
        headers["Cookie"] = process.env.MONITOR_WS_COOKIE;
    }
    console.log("[WS] Usando session token do store (SESSION_TOKEN_PATH).");
    return new Promise((resolve, reject) => {
        let resolved = false;
        const ws = new ws_1.default(url, {
            headers: Object.keys(headers).length ? headers : undefined,
        });
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                ws.close();
                reject(new Error("Timeout ao conectar ao WebSocket ou obter session_token."));
            }
        }, 15000);
        ws.on("open", () => {
            console.log("[WS] Conexão aberta.");
            // Se já temos um session_token configurado no ambiente, usamos ele direto
            if (configuredToken && !resolved) {
                console.log("[WS] Usando MONITOR_SESSION_TOKEN vindo do ambiente.");
                resolved = true;
                clearTimeout(timeout);
                resolve({ socket: ws, sessionToken: configuredToken });
            }
        });
        ws.on("message", async (data) => {
            let text;
            if (typeof data === "string") {
                text = data;
            }
            else {
                text = data.toString("utf8");
            }
            // Log de debug (pode comentar depois se ficar verboso)
            if (process.env.WS_DEBUG === "1") {
                console.log("[WS] Mensagem recebida:", text.slice(0, 200));
            }
            if (resolved)
                return;
            if (text.startsWith("%7B")) {
                try {
                    text = decodeURIComponent(text);
                }
                catch {
                    /* ignore */
                }
            }
            if (!text.includes('"session_token"')) {
                return;
            }
            try {
                const obj = JSON.parse(text);
                const sessionToken = (obj.action && obj.action.session_token) ||
                    (obj.response &&
                        obj.response.properties &&
                        obj.response.properties.session_token);
                if (sessionToken) {
                    console.log("[WS] session_token detectado da mensagem. Salvando no store...");
                    try {
                        // salva no disco pra sobreviver a restart
                        await (0, sessionTokenStore_1.setSessionToken)(sessionToken);
                    }
                    catch (e) {
                        console.error("[WS] Falha ao salvar session_token no store:", e);
                    }
                    resolved = true;
                    clearTimeout(timeout);
                    resolve({ socket: ws, sessionToken });
                }
            }
            catch (err) {
                console.error("[WS] Erro ao parsear mensagem com session_token:", err);
            }
        });
        ws.on("error", (err) => {
            console.error("[WS] Erro na conexão:", err);
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
