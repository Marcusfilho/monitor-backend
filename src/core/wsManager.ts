// src/ws/wsManager.ts
import WebSocket from "ws";
import { openMonitorWebSocket, OpenWsResult } from "./wsClient";

export type Conn = {
  ws: WebSocket;
  sessionToken: string;
};

let current: Conn | null = null;
let connecting: Promise<Conn> | null = null;

function normalizeConn(r: OpenWsResult): Conn {
  const ws = (r.ws || r.socket) as WebSocket;
  const sessionToken = (r.sessionToken || "").trim(); // sempre string
  return { ws, sessionToken };
}

export function getConn(): Promise<Conn> {
  if (current) return Promise.resolve(current);
  if (connecting) return connecting;

  const p = (async () => {
    const r = await openMonitorWebSocket();
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

export async function getWs(): Promise<WebSocket> {
  const c = await getConn();
  return c.ws;
}

export function dropConn(): void {
  try { current?.ws?.close(); } catch {}
  current = null;
  connecting = null;
}

/** Compat: nome antigo usado por services */
export function getWsConn(): Promise<Conn> {
  return getConn();
}
