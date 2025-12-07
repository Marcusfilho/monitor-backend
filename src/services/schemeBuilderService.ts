// src/services/schemeBuilderService.ts
import { openMonitorWebSocket } from "../ws/wsClient";

export interface SchemeBuilderParams {
  clientId: number;
  clientName: string;
  vehicleId: number;
  vehicleSettingId: number;
  comment?: string;
}

export interface SchemeBuilderResult {
  status: "ok" | "error";
  message: string;
  sessionToken?: string;
  details?: any;
}

/**
 * Versão inicial: apenas abre o WS, captura o session_token e fecha.
 * Depois vamos evoluir pra enviar as actions do SchemeBuilder aqui dentro.
 */
export async function runSchemeBuilderBackend(
  _params: SchemeBuilderParams
): Promise<SchemeBuilderResult> {
  try {
    const { socket, sessionToken } = await openMonitorWebSocket();

    // Por enquanto, só vamos fechar a conexão logo depois de pegar o token.
    socket.close();

    return {
      status: "ok",
      message: "WebSocket conectado e session_token capturado com sucesso.",
      sessionToken
    };
  } catch (err: any) {
    console.error("[runSchemeBuilderBackend] Erro:", err?.message || err);

    return {
      status: "error",
      message: "Falha ao conectar ao WebSocket do Monitor ou capturar session_token.",
      details: err?.message || err
    };
  }
}
