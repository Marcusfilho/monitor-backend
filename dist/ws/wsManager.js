"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConn = getConn;
exports.getWs = getWs;
exports.dropConn = dropConn;
exports.getWsConn = getWsConn;
const wsClient_1 = require("./wsClient");
let current = null;
let connecting = null;
function normalizeConn(r) {
    const ws = (r.ws || r.socket);
    const sessionToken = (r.sessionToken || "").trim(); // sempre string
    return { ws, sessionToken };
}
function getConn() {
    if (current)
        return Promise.resolve(current);
    if (connecting)
        return connecting;
    const p = (async () => {
        const r = await (0, wsClient_1.openMonitorWebSocket)();
        const conn = normalizeConn(r);
        current = conn;
        // quando fechar, invalida o cache
        conn.ws.once("close", () => {
            current = null;
        });
        return conn;
    })().finally(() => {
        connecting = null;
    });
    connecting = p;
    return p; // <- nunca null
}
async function getWs() {
    const c = await getConn();
    return c.ws;
}
function dropConn() {
    try {
        current?.ws?.close();
    }
    catch { }
    current = null;
    connecting = null;
}
/** Compat: nome antigo usado por services */
function getWsConn() {
    return getConn();
}
