"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
// mesmos serviços usados no installationsRoutes
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
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}
/**
 * POST /api/can-probes
 * - cria installation “CAN_PROBE_STANDALONE”
 * - NÃO enfileira html5_install (isso é o que quebra no /api/installations)
 */
router.post("/", async (req, res) => {
    try {
        const payload = req.body || {};
        payload.service = "CAN_PROBE_STANDALONE";
        payload.service = "CAN_PROBE_STANDALONE";
        const create = pickFn(installationsStore, ["createInstallation", "create", "createAndStart", "startInstallation"]) ||
            pickFn(installationsEngine, ["createInstallation", "create"]);
        if (!create) {
            return res.status(500).json({ ok: false, error: "no createInstallation/create found in engine/store" });
        }
        const inst = await create(payload);
        // PATCH_ASSERT_CAN_PROBE: garantir que o GET encontre a instalação
        try {
            const instId = inst?.installation_id || inst?.id || null;
            const has = instId && installationsStore?.getInstallation ? installationsStore.getInstallation(instId) : null;
            if (instId && !has && installationsStore?.patchInstallation) {
                installationsStore.patchInstallation(instId, inst);
            }
        }
        catch { }
        // opcional: status inicial “neutro”
        try {
            const id = inst?.installation_id || inst?.id;
            installationsStore?.patchInstallation && id && installationsStore.patchInstallation(id, { status: "PROBE_CREATED" });
        }
        catch { }
        return res.status(201).json(inst);
    }
    catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
/** GET /api/can-probes/:id */
router.get("/:id", async (req, res) => {
    try {
        const id = String(req.params.id || "");
        const inst = installationsStore?.getInstallation ? installationsStore.getInstallation(id) : null;
        if (!inst)
            return res.status(404).json({ ok: false, error: "not_found" });
        return res.json(inst);
    }
    catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
/**
 * POST /api/can-probes/:id/actions/request-can-snapshot
 * - enfileira monitor_can_snapshot via POST /api/jobs
 */
router.post("/:id/actions/request-can-snapshot", async (req, res) => {
    try {
        const id = String(req.params.id || "");
        const inst = installationsStore?.getInstallation ? installationsStore.getInstallation(id) : null;
        if (!inst)
            return res.status(404).json({ ok: false, error: "not_found" });
        const body = req.body || {};
        const vehicleId = num(body.vehicleId) ||
            num(body.vehicle_id) ||
            num(inst?.payload?.vehicleId) ||
            num(inst?.payload?.vehicle_id);
        if (!vehicleId)
            return res.status(400).json({ ok: false, error: "missing_vehicle_id" });
        const cycles = num(body.cycles) ?? 12;
        const interval_ms = num(body.interval_ms) ?? 12000;
        const headers = {};
        const k = pickAdminKey();
        if (k)
            headers["x-admin-key"] = k;
        // jobRoutes espera { type, payload } (e costuma responder {job:{...}} com 201)
        const jobReq = {
            type: "monitor_can_snapshot",
            payload: {
                installation_id: id,
                service: "CAN_PROBE_STANDALONE",
                vehicleId: String(vehicleId),
                cycles,
                interval_ms,
                mode: "probe",
            },
        };
        const r = await postJson(`${loopbackBase()}/api/jobs`, jobReq, headers);
        if (r.status >= 400) {
            return res.status(r.status).json({ ok: false, error: "enqueue_failed", details: r.json });
        }
        const jobId = r?.json?.job?.id || r?.json?.id || null;
        try {
            installationsStore?.pushJob && installationsStore.pushJob(id, {
                type: "monitor_can_snapshot",
                job_id: jobId,
                status: "queued",
            });
        }
        catch { }
        try {
            installationsStore?.patchInstallation && installationsStore.patchInstallation(id, { status: "CAN_SNAPSHOT_QUEUED" });
        }
        catch { }
        return res.json({ ok: true, job: r.json });
    }
    catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
exports.default = router;
