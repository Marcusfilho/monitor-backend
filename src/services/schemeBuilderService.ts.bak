// src/services/schemeBuilderService.ts
import WebSocket, { RawData } from "ws";
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
  processId?: string;
  details?: any;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function genMtkn(): string {
  return (
    Date.now().toString() +
    Math.floor(Math.random() * 1e15).toString() +
    Math.floor(Math.random() * 1e15).toString()
  );
}

function genFlowId(): string {
  return Math.floor(Math.random() * 1e12).toString();
}

function buildActionPayload(
  sessionToken: string,
  actionName: string,
  params: Record<string, any>
) {
  const mtkn = genMtkn();

  const parameters: Record<string, any> = {};
  for (const k of Object.keys(params)) {
    parameters[k] = params[k];
  }
  parameters._action_name = actionName;
  parameters.mtkn = mtkn;

  const payload = {
    action: {
      flow_id: genFlowId(),
      name: actionName,
      parameters,
      session_token: sessionToken,
      mtkn,
    },
  };

  return { payload, mtkn };
}

function decodeWsText(data: RawData): string {
  let text =
    typeof data === "string" ? data : (data as Buffer).toString("utf8");

  if (text.startsWith("%7B")) {
    try {
      text = decodeURIComponent(text);
    } catch {
      /* ignore */
    }
  }
  return text;
}

async function wsSendActionFire(
  ws: WebSocket,
  sessionToken: string,
  actionName: string,
  params: Record<string, any>
): Promise<string> {
  const { payload, mtkn } = buildActionPayload(sessionToken, actionName, params);
  console.log("[SchemeBuilder][WS] >>", actionName, payload);
  ws.send(JSON.stringify(payload));
  return mtkn;
}


async function wsSendActionRow(
  ws: WebSocket,
  sessionToken: string,
  actionName: string,
  params: Record<string, string>,
  timeoutMs = 8000
): Promise<any> {
  const { payload, mtkn } = buildActionPayload(sessionToken, actionName, params);

  console.log("[SchemeBuilder][WS] >> (aguardando row)", actionName, payload);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Timeout aguardando resposta para " + actionName));
    }, timeoutMs);

    function onMessage(data: RawData) {
      let text = decodeWsText(data);

      if (text.startsWith("%7B")) {
        try {
          text = decodeURIComponent(text);
        } catch {
          /* ignore */
        }
      }

      if (!text.includes(mtkn)) return;

      console.log(
        "[SchemeBuilder][WS][ROW RAW]",
        text.slice(0, 200) + (text.length > 200 ? "..." : "")
      );

      try {
        const obj = JSON.parse(text);

        // >>> CÓPIA DO COMPORTAMENTO DO TAMPERMONKEY <<<
        // Só resolvemos quando NÃO tiver "response" no topo.
        if (obj && !(obj as any).response) {
          clearTimeout(timeout);
          ws.off("message", onMessage);
          console.log("[SchemeBuilder][WS] <<", actionName, obj);
          resolve(obj);
        } else {
          // Tem "response"? Ignora e continua esperando o push.
          return;
        }
      } catch {
        // JSON inválido? Ignora.
        return;
      }
    }

    ws.on("message", onMessage);
    ws.send(JSON.stringify(payload));
  });
}


/**
 * Implementação back-end do fluxo de Scheme Builder.
 */
export async function runSchemeBuilderBackend(
  params: SchemeBuilderParams
): Promise<SchemeBuilderResult> {
  const { clientId, clientName, vehicleId, vehicleSettingId } = params;
  const comment = params.comment || "Comentario via backend";

  if (!clientId || !clientName || !vehicleId || !vehicleSettingId) {
    return {
      status: "error",
      message:
        "Parâmetros obrigatórios faltando: clientId, clientName, vehicleId, vehicleSettingId.",
    };
  }

  let ws: WebSocket | null = null;

  try {
    const { socket, sessionToken } = await openMonitorWebSocket();
    ws = socket;

    console.log("[SchemeBuilder] session_token:", sessionToken);

    // 1) Marca veículo
    await wsSendActionFire(ws!, sessionToken, "vcls_check_opr", {
      client_id: String(clientId),
      vehicle_id: String(vehicleId),
      client_name: String(clientName),
      is_checked: "1",
    });
    await sleep(300);

    // 2) Prepara Assign Setting (call_num = 0)
    await wsSendActionFire(ws!, sessionToken, "associate_vehicles_actions_opr", {
      tag: "loading_screen",
      client_id: String(clientId),
      client_name: String(clientName),
      action_source: "0",
      action_id: "1",
      call_num: "0",
    });
    await sleep(300);

    // 3) Define vehicle_setting_id (call_num = 1)
    await wsSendActionFire(ws!, sessionToken, "associate_vehicles_actions_opr", {
      client_id: String(clientId),
      client_name: String(clientName),
      vehicle_setting_id: String(vehicleSettingId),
      action_source: "0",
      action_id: "1",
      call_num: "1",
    });
    await sleep(500);

    // 4) review_process_attributes
    await wsSendActionFire(ws!, sessionToken, "review_process_attributes", {
      client_id: String(clientId),
    });
    await sleep(200);

    // 5) Busca process_id
    const reviewRow = await wsSendActionRow(
      ws!,
      sessionToken,
      "get_vcls_action_review_opr",
      {
        client_id: String(clientId),
        client_name: String(clientName),
        action_source: "0",
      }
    );

    const processId = reviewRow && reviewRow.process_id;
    if (!processId) {
      console.error(
        "[SchemeBuilder] Não consegui obter process_id. Resposta:",
        reviewRow
      );
      return {
        status: "error",
        message: "Não consegui obter process_id do Monitor.",
        sessionToken,
        details: reviewRow,
      };
    }

    console.log("[SchemeBuilder] process_id detectado:", processId);

    // 6) Executa ação com Scheme builder ligado
    await wsSendActionFire(ws!, sessionToken, "execute_action_opr", {
      tag: "loading_screen",
      client_id: String(clientId),
      action_source: "0",
      process_id: String(processId),
      comment,
      toggle_check: "1",
    });

    console.log("[SchemeBuilder] Comando enviado. Acompanhe o processo na tela.");

    return {
      status: "ok",
      message: "Scheme Builder disparado com sucesso.",
      sessionToken,
      processId: String(processId),
      details: { reviewRow },
    };
  } catch (err: any) {
    console.error("[runSchemeBuilderBackend] Erro:", err?.message || err);
    return {
      status: "error",
      message:
        "Falha ao executar o fluxo de Scheme Builder via WebSocket no Monitor.",
      details: err?.message || err,
    };
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }
}
