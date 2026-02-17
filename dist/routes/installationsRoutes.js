"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
// require(any) pra não travar por typings enquanto estabiliza V1
const installationsStore = require("../services/installationsStore");
const installationsEngine = require("../services/installationsEngine");
function pickFn(obj, names) {
    for (const n of names)
        if (obj && typeof obj[n] === "function")
            return obj[n].bind(obj);
    return null;
}
function loopbackBase() {
    const port = Number(process.env.PORT || 3000);
    return `http://127.0.0.1:${port}`;
}
function pickAdminKey() {
    return (process.env.ADMIN_API_KEY ||
        process.env.ADMIN_KEY ||
        process.env.X_ADMIN_KEY ||
        process.env.ADMIN_SECRET ||
        null);
}
function jobTypeFromService(svc) {
    const s = String(svc || "").toUpperCase();
    if (s === "MAINT_NO_SWAP")
        return "html5_maint_no_swap";
    if (s === "MAINT_WITH_SWAP")
        return "html5_maint_with_swap";
    if (s === "UNINSTALL")
        return "html5_uninstall";
    if (s === "CHANGE_COMPANY")
        return "html5_change_company";
    return "html5_install";
}
async function postJson(url, body, extraHeaders) {
    const f = globalThis.fetch;
    if (!f)
        throw new Error("globalThis.fetch not available");
    const res = await f(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(extraHeaders || {}),
        },
        body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    }
    catch {
        json = text;
    }
    return { status: res.status, json };
}
router.post("/", async (req, res) => {
    try {
        const payload = req.body || {};
        // 1) cria installation (prefer engine; fallback store)
        const create = pickFn(installationsEngine, ["createInstallation", "create", "createAndStart", "startInstallation"]) ||
            pickFn(installationsStore, ["createInstallation", "create"]);
        if (!create) {
            return res.status(500).json({ ok: false, error: "no createInstallation/create found in engine/store" });
        }
        const inst = await create(payload);
        const instId = inst?.installation_id || inst?.id || null;
        const instTok = inst?.installation_token || inst?.token || null;
        // 2) enqueue job inicial (via loopback /api/jobs)
        const svc = payload.service || inst?.service || null;
        const jobType = "html5_install"; // compat: worker busca html5_install; service decide o fluxo
        // normalize/allowlist: manter job pequeno, mas completo para INSTALL
        const plateReal = payload.plate_real ||
            payload.plateReal ||
            payload.plate ||
            payload.placa ||
            null;
        const plateLookup = payload.plate_lookup ||
            payload.plateLookup ||
            payload.plate ||
            payload.placa ||
            null;
        const serial = payload.serial ||
            payload.serie ||
            payload.innerId ||
            payload.inner_id ||
            null;
        const targetClientId = payload.target_client_id ||
            payload.targetClientId ||
            payload.client_id ||
            payload.clientId ||
            payload.CLIENT_ID ||
            null;
        const assetType = payload.assetType ||
            payload.asset_type ||
            payload.vehicle_type ||
            payload.vehicleType ||
            payload.ASSET_TYPE ||
            null;
        const installedBy = payload.installedBy ||
            payload.instalador ||
            payload.installer ||
            payload.INSTALLED_BY ||
            null;
        const comments = payload.comments ||
            payload.comment ||
            payload.observacoes ||
            payload.observations ||
            payload.COMMENTS ||
            null;
        const installationDate = payload.installationDate ||
            payload.installation_date ||
            payload.installDate ||
            payload.date ||
            payload.data ||
            payload.INSTALLATION_DATE ||
            null;
        const gsensor = payload.gsensor ||
            (payload.gsensor_command || payload.gsensorCommand || payload.GSENSOR_COMMAND
                ? {
                    label_pos: payload.label_pos || payload.labelPos || payload.LABEL_POS || null,
                    harness_pos: payload.harness_pos || payload.harnessPos || payload.HARNESS_POS || null,
                    command: payload.gsensor_command ||
                        payload.gsensorCommand ||
                        payload.GSENSOR_COMMAND ||
                        null,
                }
                : null);
        const payloadForJob = {
            installation_id: instId,
            installation_token: instTok,
            service: svc,
            // compat: worker já entende plate/serial
            plate: ((String(svc || "").trim().toUpperCase() === "INSTALL") ? (plateLookup || serial || plateReal) : plateReal),
            serial,
            // campos explícitos pro INSTALL
            plate_real: plateReal,
            plate_lookup: plateLookup,
            target_client_id: targetClientId,
            assetType,
            installedBy,
            comments,
            installationDate,
            gsensor,
        };
        const adminKey = pickAdminKey();
        const headers = {};
        if (adminKey)
            headers["x-admin-key"] = adminKey;
        headers["x-internal-call"] = "installationsRoutes";
        let enqueueDebug = { ok: false, method: "loopback:/api/jobs", type: jobType };
        try {
            const r = await postJson(`${loopbackBase()}/api/jobs`, { type: jobType, payload: payloadForJob }, headers);
            enqueueDebug.status = r.status;
            enqueueDebug.response = r.json;
            enqueueDebug.ok = r.status >= 200 && r.status < 300;
        }
        catch (e) {
            enqueueDebug.error = String(e?.stack || e?.message || e);
        }
        // 3) tenta anexar no objeto de retorno (debug)
        try {
            inst.enqueue = enqueueDebug;
        }
        catch (_) { }
        return res.status(201).json(inst);
    }
    catch (e) {
        console.error("[installationsRoutes] POST / error:", e && (e.stack || e.message || String(e)));
        return res.status(500).json({ ok: false, error: "Internal Server Error" });
    }
});
router.get("/:id", async (req, res) => {
    try {
        const id = String(req.params.id || "");
        const getOne = pickFn(installationsEngine, ["getInstallation", "getById", "read"]) ||
            pickFn(installationsStore, ["getInstallation", "getById", "read"]);
        if (!getOne)
            return res.status(500).json({ ok: false, error: "no getInstallation/getById/read found" });
        const inst = await getOne(id);
        if (!inst)
            return res.status(404).json({ ok: false, error: "not found" });
        return res.json(inst);
    }
    catch (e) {
        console.error("[installationsRoutes] GET /:id error:", e && (e.stack || e.message || String(e)));
        return res.status(500).json({ ok: false, error: "Internal Server Error" });
    }
});
router.post("/:id/actions/request-can-snapshot", async (req, res) => {
    try {
        const id = String(req.params.id || "");
        const fn = pickFn(installationsEngine, ["requestCanSnapshot", "request_can_snapshot"]);
        if (!fn)
            return res.status(501).json({ ok: false, error: "not implemented (engine missing requestCanSnapshot)" });
        const body = req.body || {};
        let vehicleId = body.vehicle_id || body.vehicleId || body.VEHICLE_ID || null;
        // fallback opcional: tenta achar vehicle_id na própria instalação
        if (!vehicleId) {
            const getOne = pickFn(installationsEngine, ["getInstallation", "getById", "read"]) ||
                pickFn(installationsStore, ["getInstallation", "getById", "read"]);
            if (getOne) {
                const inst = await getOne(String(id));
                vehicleId =
                    (inst && inst.resolved && (inst.resolved.vehicle_id || inst.resolved.vehicleId)) ||
                        (inst && inst.payload && (inst.payload.vehicle_id || inst.payload.vehicleId)) ||
                        (inst && (inst.vehicle_id || inst.vehicleId)) ||
                        null;
            }
        }
        if (!vehicleId) {
            try {
                res.set("x-reqcan-route", "reqcan_v3b");
            }
            catch (_) { }
            return res.status(400).json({
                ok: false,
                error: "missing vehicle_id for CAN snapshot",
                hint: "Send { vehicle_id } in request body (recommended for CAN_PROBE)."
            });
        }
        body.vehicle_id = vehicleId;
        const baseUrl = `${req.protocol}://${req.get("host")}`;
        body.baseUrl = baseUrl;
        // headers de prova (pra confirmar via curl que o Render pegou)
        try {
            res.set("x-reqcan-route", "reqcan_v3b");
        }
        catch (_) { }
        try {
            res.set("x-vehicle-id-used", String(vehicleId));
        }
        catch (_) { }
        try {
            const out = await fn(id, body);
            return res.json(out);
        }
        catch (e) {
            const raw = String((e?.stack || e?.message) || e);
            const detail = raw.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 900);
            console.error("[installationsRoutes] request-can-snapshot engine error:", raw);
            return res.status(500).json({
                ok: false,
                error: "Internal Server Error",
                where: "request-can-snapshot",
                detail
            });
        }
    }
    catch (e) {
        console.error("[installationsRoutes] request-can-snapshot error:", e && (e.stack || e.message || String(e)));
        return res.status(500).json({ ok: false, error: "Internal Server Error" });
    }
});
router.post("/:id/actions/approve-can", async (req, res) => {
    try {
        const id = String(req.params.id || "");
        const fn = pickFn(installationsEngine, ["approveCan", "approve_can"]);
        if (!fn)
            return res.status(501).json({ ok: false, error: "not implemented (engine missing approveCan)" });
        const out = await fn(id, req.body || {});
        return res.json(out);
    }
    catch (e) {
        console.error("[installationsRoutes] approve-can error:", e && (e.stack || e.message || String(e)));
        return res.status(500).json({ ok: false, error: "Internal Server Error" });
    }
});
exports.default = router;
