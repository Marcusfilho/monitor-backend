// src/ws/wsClient.ts
import WebSocket from "ws";

export interface OpenWsResult {
  socket: WebSocket;
  sessionToken: string;
}

/**
 * Abre o WebSocket do Monitor e espera até receber um session_token em alguma mensagem.
 *
 * Requer:
 *  - MONITOR_WS_URL          = URL completa do WebSocket (copiada do DevTools)
 *  - MONITOR_WS_COOKIE (opt) = Cookie da sessão, se o servidor exigir
 */
export async function openMonitorWebSocket(): Promise<OpenWsResult> {
  const url = process.env.MONITOR_WS_URL;

  if (!url) {
    throw new Error("MONITOR_WS_URL não configurada nas variáveis de ambiente.");
  }

  const headers: Record<string, string> = {};
  if (process.env.MONITOR_WS_COOKIE) {
    headers["Cookie"] = process.env.MONITOR_WS_COOKIE;
  }

  console.log("[WS] Conectando ao Monitor em:", url);

  return new Promise<OpenWsResult>((resolve, reject) => {
    let resolved = false;

    const ws = new WebSocket(url, {
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
    });

    ws.on("message", (data) => {
      if (resolved) return;

      let text: string;
      if (typeof data === "string") {
        text = data;
      } else {
        text = data.toString("utf8");
      }

      if (text.startsWith("%7B")) {
        try {
          text = decodeURIComponent(text);
        } catch {
          /* ignore */
        }
      }

      if (!text.includes('"session_token"')) {
        return;
      }

      try {
        const obj = JSON.parse(text);

        const sessionToken =
          (obj.action && obj.action.session_token) ||
          (obj.response &&
            obj.response.properties &&
            obj.response.properties.session_token);

        if (sessionToken) {
          console.log("[WS] session_token detectado.");
          resolved = true;
          clearTimeout(timeout);
          resolve({ socket: ws, sessionToken });
        }
      } catch (err) {
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
