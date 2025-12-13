"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWsConn = getWsConn;
// src/ws/wsManager.ts
const ws_1 = __importDefault(require("ws"));
const wsClient_1 = require("./wsClient");
let current = null;
let connecting = null;
const PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS ?? 30000);
const RECONNECT_MIN_MS = Number(process.env.WS_RECONNECT_MIN_MS ?? 600000); // 10 min
let lastFailAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function attachKeepAlive(ws) {
    const t = setInterval(() => {
        if (ws.readyState === ws_1.default.OPEN) {
            try {
                ws.ping();
            }
            catch { }
        }
    }, PING_INTERVAL_MS);
    ws.on("close", () => clearInterval(t));
}
async function getWsConn() {
    if (current && current.socket.readyState === ws_1.default.OPEN)
        return current;
    if (connecting)
        return connecting;
    const now = Date.now();
    const wait = Math.max(0, RECONNECT_MIN_MS - (now - lastFailAt));
    if (wait)
        await sleep(wait);
    connecting = (async () => {
        try {
            const conn = await (0, wsClient_1.openMonitorWebSocket)();
            attachKeepAlive(conn.socket);
            current = conn;
            return conn;
        }
        catch (e) {
            lastFailAt = Date.now();
            current = null;
            throw e;
        }
        finally {
            connecting = null;
        }
    })();
    return connecting;
}
