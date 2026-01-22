"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildEncodedWsFrame = buildEncodedWsFrame;
exports.buildEncodedWsFrameFromPayload = buildEncodedWsFrameFromPayload;
// src/ws/wsFrame.ts
function buildEncodedWsFrame(actionName, params, sessionToken, mtknOverride) {
    if (!actionName)
        throw new Error("actionName vazio.");
    const mtkn = (mtknOverride && String(mtknOverride)) || genMtkn();
    // ✅ Frame correto (sem action.action)
    const frame = {
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
    let f = frame;
    try {
        // 1) desfaz { action: { action: {...}, ... } } -> { action: {...} }
        const a = f?.action;
        if (a && a.action && typeof a.action === "object") {
            const inner = a.action;
            const outer = { ...a };
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
    }
    catch (_) { }
    return encodeURIComponent(JSON.stringify(f));
}
function buildEncodedWsFrameFromPayload(payload, sessionToken) {
    const actionName = payload?._action_name ?? payload?.action_name ?? payload?.actionName ?? "";
    const RESERVED = new Set([
        "tag", "_action_name", "action_name", "actionName",
        "session_token", "sessionToken", "mtkn",
        "parameters", "action_parameters", "action",
    ]);
    // pega chaves "flat" (ex.: login_name/password/language) sem engolir campos de controle
    const topLevel = {};
    if (payload && typeof payload === "object") {
        for (const [k, v] of Object.entries(payload)) {
            if (!RESERVED.has(k))
                topLevel[k] = v;
        }
    }
    const baseParams = payload?.parameters ?? payload?.action_parameters ?? topLevel;
    // se existir payload.parameters, mescla topLevel junto (pra não perder login_name etc.)
    const merged = (payload?.parameters || payload?.action_parameters)
        ? { ...topLevel, ...(baseParams || {}) }
        : { ...(baseParams || {}) };
    const params = payload?.tag ? { tag: payload.tag, ...merged } : { ...merged };
    const token = payload?.session_token ?? payload?.sessionToken ?? sessionToken ?? "";
    const mtkn = payload?.mtkn ??
        payload?.parameters?.mtkn ??
        payload?.action?.parameters?.mtkn ??
        payload?.action?.mtkn;
    return buildEncodedWsFrame(actionName, params, token, mtkn);
}
function genMtkn() {
    const rnd18 = () => Math.floor(Math.random() * 1e18).toString().padStart(18, "0");
    const t = Date.now().toString();
    return rnd18() + rnd18() + t;
}
