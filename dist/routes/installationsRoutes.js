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
        const payloadForJob = {
            installation_id: instId,
            installation_token: instTok,
            service: svc,
            plate: payload.plate || payload.placa || null,
            serial: payload.serial || payload.serie || payload.innerId || null,
            raw: payload,
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
        const out = await fn(id, req.body || {});
        return res.json(out);
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
