"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectVehicleMonitorSnapshot = collectVehicleMonitorSnapshot;
exports.summarizeCanFromModuleState = summarizeCanFromModuleState;
const crypto_1 = __importDefault(require("crypto"));
function safeDecodeURIComponent(s) {
    try {
        return decodeURIComponent(s);
    }
    catch {
        return s;
    }
}
function makeMtkn() {
    const hex = crypto_1.default.randomBytes(16).toString("hex");
    return BigInt("0x" + hex).toString(10);
}
function makeFlowId() {
    return String(Math.floor(100000 + Math.random() * 900000));
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function asBool01(v) {
    return String(v) === "1";
}
class TraffilogWsMux {
    constructor(ws, sessionToken, urlEncode = true) {
        this.pending = new Map();
        this.refreshHandlers = new Set();
        this.ws = ws;
        this.sessionToken = sessionToken;
        this.urlEncode = urlEncode;
        this.ws.on("message", (data) => {
            const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
            let msg = null;
            try {
                msg = JSON.parse(text);
            }
            catch {
                return;
            }
            const props = msg?.response?.properties;
            if (!props)
                return;
            const actionName = props.action_name;
            const token = props.mtkn;
            if (token && this.pending.has(token)) {
                const p = this.pending.get(token);
                clearTimeout(p.t);
                this.pending.delete(token);
                p.resolve(props);
                return;
            }
            if (actionName === "refresh") {
                for (const h of this.refreshHandlers) {
                    try {
                        h(props);
                    }
                    catch { }
                }
            }
        });
    }
    onRefresh(handler) {
        this.refreshHandlers.add(handler);
        return () => this.refreshHandlers.delete(handler);
    }
    sendAction(name, parameters, timeoutMs = 15000) {
        const token = makeMtkn();
        const frame = {
            action: {
                flow_id: makeFlowId(),
                name,
                parameters: { ...parameters, _action_name: name, mtkn: token },
                session_token: this.sessionToken,
                mtkn: token,
            },
        };
        const payloadJson = JSON.stringify(frame);
        const payload = this.urlEncode ? encodeURIComponent(payloadJson) : payloadJson;
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                this.pending.delete(token);
                reject(new Error(`[vm] timeout mtkn=${token} action=${name}`));
            }, timeoutMs);
            this.pending.set(token, { resolve, reject, t });
            this.ws.send(payload);
        });
    }
}
async function collectVehicleMonitorSnapshot(opts) {
    // PERF: janela padrão reduzida de 8s → 5s. Veículos respondem rápido; 8s era conservador demais.
    const windowMs = opts.windowMs ?? 5000;
    const waitAfterCmdMs = opts.waitAfterCmdMs ?? 800;
    const mux = new TraffilogWsMux(opts.ws, opts.sessionToken, opts.urlEncode ?? true);
    // Header
    const vehicleInfo = await mux.sendAction("get_vehicle_info", {
        tag: "loading_screen",
        vehicle_id: String(opts.vehicleId),
    });
    const vi = (vehicleInfo?.data?.[0] ?? {});
    const unitKey = safeDecodeURIComponent(String(vi.unit_key ?? ""));
    const header = {
        vehicle_id: Number(vi.vehicle_id ?? opts.vehicleId),
        client_id: vi.client_id != null ? Number(vi.client_id) : null,
        inner_id: vi.inner_id != null ? String(vi.inner_id) : null,
        unit_key: unitKey || null,
        license_nmbr: vi.license_nmbr != null ? String(vi.license_nmbr) : null,
        unit_type: vi.unit_type != null ? String(vi.unit_type) : null,
        unit_version: vi.unit_version != null ? String(vi.unit_version) : null,
        configuration_key_db: vi.configuration_key_db != null ? String(vi.configuration_key_db) : null,
        configuration_key_unit: vi.configuration_key_unit != null ? String(vi.configuration_key_unit) : null,
        raw: vi,
    };
    // Redis (no seu log: is_connected = "2")
    const redis = await mux.sendAction("get_vehicle_data_from_redis", {
        vehicle_id: String(opts.vehicleId),
    });
    const isConnectedRaw = redis?.data?.[0]?.is_connected;
    const isConnected = isConnectedRaw == null ? null : Number(isConnectedRaw);
    // Subs (igual monitor)
    await mux.sendAction("vehicle_unsubscribe", { vehicle_id: String(opts.vehicleId), object_type: "" });
    await mux.sendAction("vehicle_subscribe", { vehicle_id: String(opts.vehicleId), object_type: "UNIT_MESSAGES" });
    await mux.sendAction("vehicle_subscribe", { vehicle_id: String(opts.vehicleId), object_type: "UNIT_CONFIG_STATUS", value: "" });
    await mux.sendAction("vehicle_subscribe", { vehicle_id: String(opts.vehicleId), object_type: "UNIT_PARAMETERS" });
    // Param list (id -> name)
    const opr = await mux.sendAction("get_unit_parameters_opr", {
        filter: "",
        vehicle_id: String(opts.vehicleId),
    });
    const idToName = new Map();
    for (const row of (opr?.data ?? [])) {
        const id = String(row?.id ?? "");
        const name = safeDecodeURIComponent(String(row?.param_type_descr ?? ""));
        if (id)
            idToName.set(id, name);
    }
    // Metadata (monitor chama; aqui é opcional — mantemos pela simetria)
    await mux.sendAction("get_unit_parameters_metadata", {
        filter: "",
        vehicle_id: String(opts.vehicleId),
    }).catch(() => { });
    if (!header.unit_key)
        throw new Error("[vm] unit_key ausente no get_vehicle_info");
    // Buscar moduleState ANTES da janela — disponível desde o primeiro pacote parcial
    let earlyModuleState = [];
    try {
        const msEarly = await mux.sendAction("get_monitor_module_state", {
            tag: "loading_screen", filter: "", vehicle_id: String(opts.vehicleId),
        });
        earlyModuleState = (msEarly?.data ?? []).map((r) => ({
            id: String(r?.id ?? ""),
            module: String(r?.module_descr ?? ""),
            sub: String(r?.sub_module_descr ?? ""),
            name: String(r?.module_descr ?? ""),
            last_update_date: r?.last_update_date ? safeDecodeURIComponent(String(r.last_update_date)) : null,
            active: asBool01(r?.active),
            was_ok: asBool01(r?.was_ok),
            ok: asBool01(r?.ok),
            error: asBool01(r?.error),
            error_descr: r?.error_descr != null ? String(r.error_descr) : null,
        }));
    } catch(_e_ms) { /* best-effort — moduleState é opcional no parcial */ }
    // Captura refresh UNIT_PARAMETERS por janela
    const latest = new Map();
    let unitParametersEvents = 0;
    let unitMessagesEvents = 0;
    let unitConnEvents = 0;
    const off = mux.onRefresh((props) => {
        const ds = String(props?.data_source ?? "");
        if (ds === "UNIT_PARAMETERS") {
            unitParametersEvents++;
            const rows = Array.isArray(props?.data) ? props.data : (props?.data ? [props.data] : []);
            for (const row of rows) {
                const id = String(row?.id ?? row?.param_id ?? "");
                if (!id)
                    continue;
                const rawValue = row?.param_value != null ? String(row.param_value) :
                    (row?.paramvalue != null ? String(row.paramvalue) :
                        (row?.raw_value != null ? String(row.raw_value) :
                            (row?.value != null ? String(row.value) : null)));
                const lastUpdate = row?.orig_time != null ? String(row.orig_time) :
                    (row?.last_update != null ? String(row.last_update) :
                        (row?.last_update_date != null ? String(row.last_update_date) : null));
                const prev = latest.get(id);
                latest.set(id, {
                    id,
                    name: idToName.get(id) ?? (row?.param_type_descr != null ? safeDecodeURIComponent(String(row.param_type_descr)) : prev?.name ?? null),
                    raw_value: rawValue ?? prev?.raw_value ?? null,
                    value: rawValue ?? prev?.value ?? null,
                    source: row?.paramsource != null ? String(row.paramsource) : (row?.source != null ? String(row.source) : prev?.source ?? null),
                    orig_time: lastUpdate ?? prev?.orig_time ?? null,
                    last_update: lastUpdate ?? prev?.last_update ?? null,
                    inner_id: row?.inner_id != null ? String(row.inner_id) : prev?.inner_id ?? null,
                });
            }
            // STREAMING PROGRESSIVO: notifica caller com snapshot parcial a cada pacote
            // Passa header e moduleState já disponíveis — worker usa no partialSnap
            if (opts.onPartialParams) {
                try {
                    const allParams = Array.from(latest.values());
                    const withValue = allParams.filter(p => (p.raw_value ?? "") !== "").length;
                    opts.onPartialParams(allParams, { total: allParams.length, withValue, events: unitParametersEvents }, header, earlyModuleState);
                }
                catch { /* best-effort */ }
            }
            return;
        }
        if (ds === "UNIT_MESSAGES") {
            unitMessagesEvents++;
            // Capturar driverCode do frame UNIT_MESSAGES
            // O Monitor envia driverCode em cada frame de posição
            const rows = Array.isArray(props?.data) ? props.data : (props?.data ? [props.data] : []);
            for (const row of rows) {
                const dc = row?.driverCode ?? row?.driver_code ?? row?.DriverCode ?? null;
                if (dc != null && String(dc).trim() !== "") {
                    header.driver_code = String(dc).trim();
                }
            }
            return;
        }
        if (ds === "unit_connection_status") {
            unitConnEvents++;
            return;
        }
    });
    // Monitor dispara cmd_id=9 pra gerar a “rajada”
    await mux.sendAction("send_quick_command", {
        unit_key: header.unit_key,
        local_action_id: "5",
        cmd_id: "9",
        ack_needed: "0",
    });
    await sleep(waitAfterCmdMs);
    await sleep(windowMs);
    off();
    // Module State (regra robusta: NÃO confiar em id fixo, usar module/sub)
    const ms = await mux.sendAction("get_monitor_module_state", {
        tag: "loading_screen",
        filter: "",
        vehicle_id: String(opts.vehicleId),
    });
    const moduleState = (ms?.data ?? []).map((r) => ({
        id: String(r?.id ?? ""),
        module: String(r?.module_descr ?? ""),
        sub: String(r?.sub_module_descr ?? ""),
        last_update_date: r?.last_update_date ? safeDecodeURIComponent(String(r.last_update_date)) : null,
        active: asBool01(r?.active),
        was_ok: asBool01(r?.was_ok),
        ok: asBool01(r?.ok),
        error: asBool01(r?.error),
        error_descr: r?.error_descr != null ? String(r.error_descr) : null,
    }));
    await mux.sendAction("vehicle_unsubscribe", { vehicle_id: String(opts.vehicleId), object_type: "" }).catch(() => { });
    return {
        capturedAt: new Date().toISOString(),
        vehicleId: opts.vehicleId,
        isConnected,
        header,
        parameters: Array.from(latest.values()),
        moduleState,
        rawCounts: { unitParametersEvents, unitMessagesEvents, unitConnEvents },
    };
}
function summarizeCanFromModuleState(moduleState) {
    const pick = (module, sub) => moduleState.find((r) => r.module === module && r.sub === sub) ?? null;
    const can0 = pick("CAN", "CAN0");
    const can1 = pick("CAN", "CAN1");
    const j1708 = moduleState.find((r) => r.module === "J1708") ?? null;
    return {
        can0,
        can1,
        j1708,
        can0_ok: !!(can0 && can0.ok && can0.active),
        can1_ok: !!(can1 && can1.ok && can1.active),
        j1708_ok: !!(j1708 && j1708.ok && j1708.active),
    };
}
