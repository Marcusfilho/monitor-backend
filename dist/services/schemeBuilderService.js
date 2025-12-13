"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildActionPayload = buildActionPayload;
exports.wsSendActionRow = wsSendActionRow;
exports.wsSendActionFire = wsSendActionFire;
exports.runSchemeBuilder = runSchemeBuilder;
exports.runSchemeBuilderBackend = runSchemeBuilderBackend;
// src/services/schemeBuilderService.ts
const ws_1 = __importDefault(require("ws"));
const wsClient_1 = require("../ws/wsClient");
const wsManager_1 = require("../ws/wsManager");
function pickWs(conn) {
    if (!conn)
        return null;
    // caso getWsConn() retorne o próprio WebSocket
    if (typeof conn === "object" && typeof conn.send === "function" && typeof conn.on === "function") {
        return conn;
    }
    // caso retorne { ws: WebSocket, ... }
    if (conn.ws && typeof conn.ws.send === "function" && typeof conn.ws.on === "function") {
        return conn.ws;
    }
    return null;
}
function pickSessionToken(conn) {
    if (!conn)
        return null;
    // padrões comuns
    const candidates = [
        conn.sessionToken,
        conn.session_token,
        conn.token,
        conn?.auth?.sessionToken,
        conn?.auth?.session_token,
    ].filter(Boolean);
    if (candidates.length > 0)
        return String(candidates[0]);
    // às vezes o token fica “anexado” no ws
    const ws = pickWs(conn);
    if (ws) {
        const anyWs = ws;
        if (anyWs.sessionToken)
            return String(anyWs.sessionToken);
        if (anyWs.session_token)
            return String(anyWs.session_token);
    }
    return null;
}
function isWsOpen(ws) {
    return !!ws && ws.readyState === ws_1.default.OPEN;
}
async function ensureWsConn() {
    const existing = (0, wsManager_1.getWsConn)?.();
    const wsExisting = pickWs(existing);
    if (isWsOpen(wsExisting)) {
        const token = pickSessionToken(existing);
        if (!token) {
            throw new Error("[WS] conexão existe, mas sessionToken não foi encontrado em getWsConn()");
        }
        return { ws: wsExisting, sessionToken: token };
    }
    const opened = await Promise.resolve((0, wsClient_1.openMonitorWebSocket)?.());
    const wsOpened = pickWs(opened);
    if (!isWsOpen(wsOpened)) {
        throw new Error("[WS] falha ao abrir conexão (openMonitorWebSocket não retornou WS OPEN)");
    }
    const token = pickSessionToken(opened);
    if (!token) {
        throw new Error("[WS] conexão aberta, mas sessionToken não foi encontrado no retorno do openMonitorWebSocket()");
    }
    return { ws: wsOpened, sessionToken: token };
}
function genFlowId() {
    // simples e suficiente: timestamp + aleatório
    return `flow_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
function genMtkn() {
    return `mtkn_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
function buildActionPayload(sessionToken, actionName, params) {
    const mtkn = genMtkn();
    const parameters = { ...params };
    parameters._action_name = actionName;
    parameters.mtkn = mtkn;
    return {
        action: {
            flow_id: genFlowId(),
            name: actionName,
            parameters,
            session_token: sessionToken,
            mtkn,
        },
    };
}
/**
 * Compat: aceita dois jeitos de chamada:
 *   - wsSendActionRow(actionRow, timeoutMs?)
 *   - wsSendActionRow(ws, actionRow, timeoutMs?)
 */
async function wsSendActionRow(a, b, c) {
    let ws;
    let actionRow;
    let timeoutMs;
    // detecta assinatura
    if (a && typeof a.send === "function" && typeof a.on === "function") {
        ws = a;
        actionRow = b;
        timeoutMs = typeof c === "number" ? c : 25000;
    }
    else {
        const conn = await ensureWsConn();
        ws = conn.ws;
        actionRow = a;
        timeoutMs = typeof b === "number" ? b : 25000;
    }
    if (!actionRow) {
        throw new Error("[WS] actionRow ausente em wsSendActionRow()");
    }
    if (ws.readyState !== ws_1.default.OPEN) {
        throw new Error(`[WS] conexão não está OPEN (readyState=${ws.readyState})`);
    }
    const expected = {
        mtkn: actionRow?.action?.mtkn ?? actionRow?.action?.parameters?.mtkn,
        flowId: actionRow?.action?.flow_id,
        actionName: actionRow?.action?.name,
    };
    return await new Promise((resolve, reject) => {
        let done = false;
        let timeout;
        // helper compatível (Node 16 tem .off; fallback removeListener)
        const wsOff = (event, fn) => {
            const anyWs = ws;
            if (typeof anyWs.off === "function")
                anyWs.off(event, fn);
            else
                anyWs.removeListener(event, fn);
        };
        const cleanup = () => {
            if (timeout)
                clearTimeout(timeout);
            wsOff("message", onMessage);
            wsOff("close", onClose);
            wsOff("error", onError);
        };
        const finish = (err, data) => {
            // --- PATCH: cleanup listeners + timeout (anti vazamento) ---
            if (timeout)
                clearTimeout(timeout);
            // remove listeners deste request (message/close/error)
            ws.off?.("message", onMessage);
            ws.removeListener?.("message", onMessage);
            ws.off?.("close", onClose);
            ws.removeListener?.("close", onClose);
            ws.off?.("error", onError);
            ws.removeListener?.("error", onError);
            // --- /PATCH ---
            if (done)
                return;
            done = true;
            cleanup();
            if (err)
                reject(err);
            else
                resolve(data);
        };
        const matches = (msg) => {
            const props = msg?.response?.properties ?? msg?.properties ?? {};
            const mtkn = props?.mtkn ?? msg?.mtkn;
            const flowId = props?.flow_id ?? msg?.flow_id;
            const actionName = props?.action_name ??
                props?.actionName ??
                msg?.action_name ??
                msg?.actionName;
            // regra: se eu tiver mtkn, ele manda; senão flowId; senão actionName
            if (expected.mtkn != null)
                return mtkn === expected.mtkn;
            if (expected.flowId != null)
                return flowId === expected.flowId;
            if (expected.actionName != null)
                return actionName === expected.actionName;
            return true;
        };
        const onMessage = (raw) => {
            let text;
            try {
                if (typeof raw === "string")
                    text = raw;
                else if (Buffer.isBuffer(raw))
                    text = raw.toString("utf8");
                else if (Array.isArray(raw))
                    text = Buffer.concat(raw).toString("utf8");
                else
                    text = Buffer.from(raw).toString("utf8");
            }
            catch {
                return; // payload estranho, ignora
            }
            let msg;
            try {
                msg = JSON.parse(text);
            }
            catch {
                // JSON inválido, ignora
                return;
            }
            if (!matches(msg)) {
                // -> ignorar e seguir esperando.
                return;
            }
            const props = msg?.response?.properties ?? msg?.properties ?? {};
            const errMsg = props?.error_msg ??
                props?.error ??
                msg?.error_msg ??
                msg?.error ??
                (props?.status &&
                    String(props.status).toLowerCase().includes("error")
                    ? String(props.status)
                    : null);
            if (errMsg) {
                finish(new Error(`[WS] erro na resposta: ${errMsg}`), msg);
                return;
            }
            finish(undefined, msg);
        };
        const onClose = (code, reason) => {
            const r = reason ? reason.toString("utf8") : "";
            finish(new Error(`[WS] close code=${code} reason=${r}`));
        };
        const onError = (err) => {
            finish(err instanceof Error ? err : new Error(String(err)));
        };
        // 1) arma listeners primeiro (pra não perder resposta rápida)
        ws.on("message", onMessage);
        ws.once("close", onClose);
        ws.once("error", onError);
        // 2) timeout único
        timeout = setTimeout(() => {
            finish(new Error(`[WS] timeout ${timeoutMs}ms aguardando resposta (action=${expected.actionName ?? "?"}, flow=${expected.flowId ?? "?"}, mtkn=${expected.mtkn ?? "?"})`));
        }, timeoutMs);
        // 3) envia depois de armar listeners
        try {
            ws.send(JSON.stringify(actionRow), (err) => {
                if (err)
                    finish(err);
            });
        }
        catch (e) {
            finish(e);
        }
    });
}
/**
 * Fire-and-forget (não espera resposta).
 * Compat: wsSendActionFire(actionRow) ou wsSendActionFire(ws, actionRow)
 */
async function wsSendActionFire(a, b) {
    let ws;
    let actionRow;
    if (a && typeof a.send === "function" && typeof a.on === "function") {
        ws = a;
        actionRow = b;
    }
    else {
        const conn = await ensureWsConn();
        ws = conn.ws;
        actionRow = a;
    }
    if (!actionRow)
        throw new Error("[WS] actionRow ausente em wsSendActionFire()");
    if (ws.readyState !== ws_1.default.OPEN) {
        throw new Error(`[WS] conexão não está OPEN (readyState=${ws.readyState})`);
    }
    ws.send(JSON.stringify(actionRow));
}
/**
 * Fluxo principal: Assign Setting + Scheme Builder
 * (Se os nomes de action forem diferentes no seu Monitor, ajuste aqui.)
 */
async function runSchemeBuilder(params) {
    try {
        const { ws, sessionToken } = await ensureWsConn();
        // ⚠️ Ajuste os nomes se necessário:
        const ACTION_ASSIGN_SETTING = "assign_setting_to_vehicle";
        const ACTION_SCHEME_BUILDER = "scheme_builder";
        const responses = [];
        // 1) Assign Setting
        const action1 = buildActionPayload(sessionToken, ACTION_ASSIGN_SETTING, {
            client_id: params.clientId,
            client_name: params.clientName,
            vehicle_id: params.vehicleId,
            vehicle_setting_id: params.vehicleSettingId,
            comment: params.comment ?? "",
        });
        responses.push(await wsSendActionRow(ws, action1, 30000));
        // 2) Scheme Builder
        const action2 = buildActionPayload(sessionToken, ACTION_SCHEME_BUILDER, {
            client_id: params.clientId,
            client_name: params.clientName,
            vehicle_id: params.vehicleId,
            vehicle_setting_id: params.vehicleSettingId,
            comment: params.comment ?? "",
        });
        responses.push(await wsSendActionRow(ws, action2, 60000));
        return { status: "ok", responses };
    }
    catch (err) {
        return {
            status: "error",
            message: err?.message ? String(err.message) : String(err),
            details: err,
        };
    }
}
// Alias para manter compatibilidade com imports antigos:
async function runSchemeBuilderBackend(params) {
    return runSchemeBuilder(params);
}
