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
    const windowMs = opts.windowMs ?? 8000;
    const waitAfterCmdMs = opts.waitAfterCmdMs ?? 1000;
    const mux = new TraffilogWsMux(opts.ws, opts.sessionToken);
    const latest = new Map();
    const idToName = new Map();
    const refreshCounts = { UNIT_PARAMETERS: 0, UNIT_CONFIG_STATUS: 0, UNIT_MESSAGES: 0, unit_connection_status: 0 };
    const refreshEventsSample = [];
    let configStatusLast = null;

    const toRows = (props) => {
        if (!props) return [];
        if (Array.isArray(props.data)) return props.data.filter((x) => x && typeof x === "object");
        if (props.data && typeof props.data === "object") return [props.data];
        if (Array.isArray(props.rows)) return props.rows.filter((x) => x && typeof x === "object");
        if (props.row && typeof props.row === "object") return [props.row];
        return [];
    };

    const onRefresh = (msg) => {
        try {
            const props = (msg?.response?.properties) || {};
            const ds = String(props.data_source || props.data_set || "").trim();
            if (ds) refreshCounts[ds] = (refreshCounts[ds] || 0) + 1;

            const rows = toRows(props);

            if (refreshEventsSample.length < 20) {
                const r0 = rows[0];
                refreshEventsSample.push({
                    ts: new Date().toISOString(),
                    ds: ds || null,
                    row_count: rows.length,
                    row_keys: r0 && typeof r0 === "object" ? Object.keys(r0).slice(0, 15) : [],
                    props_keys: Object.keys(props).slice(0, 15),
                });
            }

            if (ds === "UNIT_PARAMETERS") {
                for (const row of rows) {
                    const id = row?.id;
                    if (id == null) continue;
                    const key = String(id);
                    const prev = latest.get(key) || {};
                    const merged = { ...prev, ...row };
                    const meta = idToName.get(key);
                    if (meta) {
                        if (!merged.name) merged.name = meta.name || null;
                        if (!merged.param_type) merged.param_type = meta.param_type || null;
                    }
                    latest.set(key, merged);
                }
            } else if (ds === "UNIT_CONFIG_STATUS") {
                configStatusLast = rows[0] || { ...(configStatusLast || {}), ...props };
            }
        } catch (_e) {}
    };

    mux.onRefresh(onRefresh);

    let header = { vehicle_id: opts.vehicleId };
    let redisRow = null;
    let isConnected = null;

    try {
        const paramsMeta = await mux.requestRows({
            action_name: "get_monitor_params",
            req: { action_name: "get_monitor_params", vehicle_id: opts.vehicleId },
            timeoutMs: 5000,
        });
        for (const r of (paramsMeta || [])) {
            if (r?.id == null) continue;
            idToName.set(String(r.id), { name: r.name || null, param_type: r.param_type || null });
        }
    } catch (_e) {}

    try {
        const vinfo = await mux.requestRows({
            action_name: "get_vehicle_info",
            req: { action_name: "get_vehicle_info", vehicle_id: opts.vehicleId },
            timeoutMs: 5000,
        });
        header = { ...header, ...(vinfo[0] || {}) };
    } catch (_e) {}

    try {
        const vredis = await mux.requestRows({
            action_name: "get_vehicle_data_from_redis",
            req: { action_name: "get_vehicle_data_from_redis", vehicle_id: opts.vehicleId },
            timeoutMs: 5000,
        });
        redisRow = (vredis[0] || null);
        isConnected = (redisRow?.is_connected === 1 || redisRow?.is_connected === "1");
    } catch (_e) {}

    try {
        await mux.sendAction({
            action_name: "send_quick_command",
            req: {
                action_name: "send_quick_command",
                command: opts.urlEncode ? encodeURIComponent(opts.commandHex) : opts.commandHex,
                cmd_id: 9,
                vehicle_id: opts.vehicleId,
            },
        });
    } catch (_e) {}

    await new Promise((r) => setTimeout(r, waitAfterCmdMs));

    try {
        await mux.sendAction({ action_name: "get_data_table_refresh", req: { action_name: "get_data_table_refresh", vehicle_id: opts.vehicleId, data_source: "UNIT_PARAMETERS" } });
        await mux.sendAction({ action_name: "get_data_table_refresh", req: { action_name: "get_data_table_refresh", vehicle_id: opts.vehicleId, data_source: "UNIT_CONFIG_STATUS" } });
        await mux.sendAction({ action_name: "get_data_table_refresh", req: { action_name: "get_data_table_refresh", vehicle_id: opts.vehicleId, data_source: "UNIT_MESSAGES" } });
        await mux.sendAction({ action_name: "get_data_table_refresh", req: { action_name: "get_data_table_refresh", vehicle_id: opts.vehicleId, data_source: "unit_connection_status" } });
    } catch (_e) {}

    await new Promise((r) => setTimeout(r, windowMs));

    try { mux.offRefresh(onRefresh); } catch (_e) {}

    let moduleState = [];
    try {
        const mrows = await mux.requestRows({
            action_name: "get_monitor_module_state",
            req: { action_name: "get_monitor_module_state", vehicle_id: opts.vehicleId },
            timeoutMs: 5000,
        });
        moduleState = (mrows || []).map((r) => ({
            id: Number(r.id),
            module: r.module || null,
            sub: r.sub || null,
            active: asBool01(r.active),
            ok: asBool01(r.ok),
            error: asBool01(r.error),
            error_descr: r.error_descr || null,
            last_update_date: r.last_update_date || null,
            raw: r,
        }));
    } catch (_e) {}

    const pick = (...vals) => {
        for (const v of vals) {
            if (v === 0 || v === false) return v;
            if (v == null) continue;
            const t = String(v).trim();
            if (t) return v;
        }
        return null;
    };

    const headerRaw = { ...header };
    header = {
        ...header,
        raw: headerRaw,
        redis_raw: redisRow || null,
        config_status_raw: configStatusLast || null,

        inner_id: pick(header.inner_id, header.innerId, header.serial, redisRow?.inner_id, redisRow?.innerId),
        license_nmbr: pick(header.license_nmbr, header.license_number, header.license, redisRow?.license_nmbr, redisRow?.license_number, redisRow?.license),
        license_number: pick(header.license_number, header.license_nmbr, header.license, redisRow?.license_number, redisRow?.license_nmbr, redisRow?.license),

        server_time: pick(redisRow?.server_time, redisRow?.serverTime, header.server_time, header.serverTime),
        communication: pick(header.communication, redisRow?.server_time, redisRow?.serverTime),

        driver_code: pick(header.driver_code, header.driverCode, redisRow?.driver_code, redisRow?.driverCode),

        client: pick(header.client, header.client_name, header.client_description, header.vcl_client_description),
        model: pick(header.model, header.vcl_model),
        manufacturer: pick(header.manufacturer, header.vcl_manufacturer),

        progress: pick(header.progress, configStatusLast?.progress, configStatusLast?.configuration_progress),
        configuration_status: pick(header.configuration_status, configStatusLast?.status, configStatusLast?.configuration_status),
        configuration_type: pick(header.configuration_type, configStatusLast?.type, configStatusLast?.configuration_type),
        configuration_progress: pick(header.configuration_progress, configStatusLast?.progress, configStatusLast?.configuration_progress),
        configuration_error: pick(header.configuration_error, configStatusLast?.error, configStatusLast?.configuration_error),
        configuration_retries: pick(header.configuration_retries, configStatusLast?.retries, configStatusLast?.configuration_retries),

        gps: pick(header.gps, redisRow?.gps, redisRow?.gps_time),
        fuel: pick(header.fuel, redisRow?.fuel, redisRow?.fuel_level),
        speed: pick(header.speed, header.speed_kmh, redisRow?.speed, redisRow?.speed_kmh),
        engine_hours: pick(header.engine_hours, redisRow?.engine_hours, redisRow?.engineHours),
        mileage: pick(header.mileage, header.mileage_km, redisRow?.mileage, redisRow?.mileage_km),
    };

    return {
        capturedAt: new Date().toISOString(),
        vehicleId: opts.vehicleId,
        isConnected,
        header,
        parameters: Array.from(latest.values()).sort((a, b) => Number(a.id || 0) - Number(b.id || 0)),
        moduleState,
        rawCounts: {
            ...refreshCounts,
            refresh_total: Object.values(refreshCounts).reduce((n, v) => n + Number(v || 0), 0),
            params_total: latest.size,
            modules_total: moduleState.length,
        },
        debug: {
            refresh_events_sample: refreshEventsSample,
            config_status_last: configStatusLast || null,
        },
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
