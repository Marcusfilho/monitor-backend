// src/ws/wsFrame.ts
export function buildEncodedWsFrame(
  actionName: string,
  params: Record<string, any>,
  sessionToken: string
): string {
  if (!actionName) throw new Error("actionName vazio.");

  const mtkn = genMtkn();

  // ✅ Frame correto (sem action.action)
  const frame: any = {
    action: {
      name: actionName,
      parameters: { ...(params || {}), _action_name: actionName, mtkn },
    },
    mtkn,
  };

  // ✅ No user_login NÃO manda session_token
  if (sessionToken && actionName !== "user_login") {
    frame.session_token = sessionToken;
  }

  return encodeURIComponent(JSON.stringify(frame));
}


export function buildEncodedWsFrameFromPayload(payload: any, sessionToken: string): string {
  const actionName =
    payload?._action_name ?? payload?.action_name ?? payload?.actionName ?? "";

  const baseParams =
    payload?.parameters ?? payload?.action_parameters ?? {};

  const params =
    payload?.tag ? { tag: payload.tag, ...baseParams } : { ...baseParams };

  const token =
    payload?.session_token ?? payload?.sessionToken ?? sessionToken ?? "";

  return buildEncodedWsFrame(actionName, params, token);
}

function genMtkn(): string {
  const rnd18 = () => Math.floor(Math.random() * 1e18).toString().padStart(18, "0");
  const t = Date.now().toString();
  return rnd18() + rnd18() + t;
}
