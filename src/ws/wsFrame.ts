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

  let f: any = frame;
  try {
    // 1) desfaz { action: { action: {...}, ... } } -> { action: {...} }
    const a: any = f?.action;
    if (a && a.action && typeof a.action === "object") {
      const inner: any = a.action;
      const outer: any = { ...a };
      delete outer.action;
      f = { ...f, action: { ...inner, ...outer } };
    }

    // 2) _action_name -> name (nosso payload interno)
    if (f?.action?._action_name && !f.action.name) {
      f.action.name = f.action._action_name;
      delete f.action._action_name;
    }

    // 3) action_name/action_parameters -> name/parameters (estilo do monitor)
    if (f?.action?.action_name && f?.action?.action_parameters && !f.action.name) {
      f.action.name = f.action.action_name;
      f.action.parameters = f.action.action_parameters;
      delete f.action.action_name;
      delete f.action.action_parameters;
    }
  } catch (_) {}

  return encodeURIComponent(JSON.stringify(f));
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
