// src/ws/wsManager.ts
import WebSocket from "ws";
import { openMonitorWebSocket } from "./wsClient";

type Conn = { socket: WebSocket; sessionToken: string };

let current: Conn | null = null;
let connecting: Promise<Conn> | null = null;

const PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS ?? 30000);
const RECONNECT_MIN_MS = Number(process.env.WS_RECONNECT_MIN_MS ?? 600000); // 10 min

let lastFailAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function attachKeepAlive(ws: WebSocket) {
  const t = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.ping(); } catch {}
    }
  }, PING_INTERVAL_MS);

  ws.on("close", () => clearInterval(t));
}

export async function getWsConn(): Promise<Conn> {
  if (current && current.socket.readyState === WebSocket.OPEN) return current;
  if (connecting) return connecting;

  const now = Date.now();
  const wait = Math.max(0, RECONNECT_MIN_MS - (now - lastFailAt));
  if (wait) await sleep(wait);

  connecting = (async () => {
    try {
      const conn = await openMonitorWebSocket();
      attachKeepAlive(conn.socket);
      current = conn;
      return conn;
    } catch (e) {
      lastFailAt = Date.now();
      current = null;
      throw e;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

