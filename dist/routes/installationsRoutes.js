"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const requireWorkerKey_1 = require("../middleware/requireWorkerKey");
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
// ===============================
// Worker internal endpoints (x-worker-key)
// - usados para publicar progresso/snapshot parcial durante baterias longas
// - payload é snapshot já resumido pelo worker
// ===============================
// PATCH genérico (status/can/sb/resolved) — allowlist
router.post("/:id/_worker/patch", requireWorkerKey_1.requireWorkerKey, async (req, res) => {
    try {
        const id = String(req.params.id || "");
        const inst = installationsStore.getInstallation(id);
        if (!inst)
            return res.status(404).json({ ok: false, error: "not found" });
        const body = (req.body && typeof req.body === "object") ? req.body : {};
        const patch = (body.patch && typeof body.patch === "object") ? body.patch : body;
        const out = {};
        if (patch.status != null)
            out.status = String(patch.status);
        if (patch.sb && typeof patch.sb === "object") {
            out.sb = Object.assign({}, (inst.sb && typeof inst.sb === "object") ? inst.sb : {}, patch.sb);
        }
        if (patch.can && typeof patch.can === "object") {
            out.can = Object.assign({}, (inst.can && typeof inst.can === "object") ? inst.can : {}, patch.can);
        }
        if (patch.resolved && typeof patch.resolved === "object") {
            out.resolved = Object.assign({}, (inst.resolved && typeof inst.resolved === "object") ? inst.resolved : {}, patch.resolved);
        }
        // nada permitido? idempotente
        if (!Object.keys(out).length)
            return res.json({ ok: true, skipped: true });
        const updated = installationsStore.patchInstallation(id, out);
        return res.json({ ok: true, installation_id: id, status: updated?.status || null });
    }
    catch (e) {
        console.error("[installationsRoutes] _worker/patch error:", e && (e.stack || e.message || String(e)));
        return res.status(500).json({ ok: false, error: "Internal Server Error" });
    }
});
// Publicar snapshot CAN parcial (já resumido) a cada ciclo
router.post("/:id/_worker/can-snapshot", requireWorkerKey_1.requireWorkerKey, async (req, res) => {
    try {
        const id = String(req.params.id || "");
        const inst = installationsStore.getInstallation(id);
        if (!inst)
            return res.status(404).json({ ok: false, error: "not found" });
        const body = (req.body && typeof req.body === "object") ? req.body : {};
        const snap = (body.snapshot && typeof body.snapshot === "object") ? body.snapshot : null;
        if (!snap)
            return res.status(400).json({ ok: false, error: "missing snapshot" });
        const now = new Date().toISOString();
        if (!snap.captured_at && !snap.capturedAt)
            snap.captured_at = now;
        const canPrev = (inst.can && typeof inst.can === "object") ? inst.can : {};
        const prevSnaps = Array.isArray(canPrev.snapshots) ? canPrev.snapshots : [];
        const mergedSnaps = [snap, ...prevSnaps].filter(Boolean).slice(0, 12);
        const counts = snap.counts || {};
        const hasData = Number(counts.params_total || counts.paramsTotal || 0) > 0 ||
            Number(counts.module_total || counts.moduleTotal || 0) > 0 ||
            (Array.isArray(snap.parameters) && snap.parameters.length > 0) ||
            (Array.isArray(snap.moduleState) && snap.moduleState.length > 0) ||
            (Array.isArray(snap.module_state) && snap.module_state.length > 0);
        const phase = (body.phase != null) ? String(body.phase) : null;
        const sb_progress = (body.sb_progress != null && isFinite(Number(body.sb_progress))) ? Number(body.sb_progress) : null;
        const packet_ts = (body.packet_ts != null) ? String(body.packet_ts) : null;
        const canPatched = Object.assign({}, canPrev, {
            last_snapshot_at: snap.captured_at || now,
            snapshots: mergedSnaps,
            phase: phase || canPrev.phase || null,
            summary: snap.counts || canPrev.summary || null,
        });
        const topPatch = {
            can: canPatched,
            can_snapshot_latest: snap,
            can_snapshot: hasData ? snap : null,
        };
        // opcional: status vindo do worker
        if (body.status != null)
            topPatch.status = String(body.status);
        if (sb_progress != null || packet_ts != null) {
            const sbPrev = (inst.sb && typeof inst.sb === "object") ? inst.sb : {};
            topPatch.sb = Object.assign({}, sbPrev, {
                progress: (sb_progress != null) ? sb_progress : (sbPrev.progress ?? null),
                packet_ts: packet_ts || (sbPrev.packet_ts ?? null),
                updated_at: now,
            });
        }
        const updated = installationsStore.patchInstallation(id, topPatch);
        return res.json({ ok: true, installation_id: id, status: updated?.status || null });
    }
    catch (e) {
        console.error("[installationsRoutes] _worker/can-snapshot error:", e && (e.stack || e.message || String(e)));
        return res.status(500).json({ ok: false, error: "Internal Server Error" });
    }
});
router.post("/:id/actions/retry-html5", async (req, res) => {
    try {
        const id = String(req.params.id || "");
        const getOne = pickFn(installationsEngine, ["getInstallation", "getById", "read"]) ||
            pickFn(installationsStore, ["getInstallation", "getById", "read"]);
        if (!getOne)
            return res.status(500).json({ ok: false, error: "no getInstallation/getById/read found" });
        const inst = await getOne(id);
        if (!inst)
            return res.status(404).json({ ok: false, error: "not found" });
        // auth: exige token do app
        const tok = String(req.get("x-installation-token") || "").trim();
        if (!tok)
            return res.status(401).json({ ok: false, error: "missing_token" });
        const requireTokenFn = pickFn(installationsStore, ["requireToken"]);
        if (requireTokenFn) {
            const okTok = !!requireTokenFn(inst, tok);
            if (!okTok)
                return res.status(401).json({ ok: false, error: "invalid_token" });
        }
        else {
            const recTok = String(inst.installation_token || inst.token || "").trim();
            if (recTok && tok !== recTok)
                return res.status(401).json({ ok: false, error: "invalid_token" });
        }
        const payload = (inst.payload && typeof inst.payload === "object") ? inst.payload : {};
        const service = String(payload.service || inst.service || "").trim().toUpperCase();
        const plateReal = payload.plate_real ||
            payload.plateReal ||
            payload.plate ||
            payload.placa ||
            null;
        const serial = payload.serial ||
            payload.serie ||
            payload.innerId ||
            payload.inner_id ||
            null;
        let plateLookup = payload.plate_lookup ||
            payload.plateLookup ||
            payload.lookup_license ||
            payload.lookupLicense ||
            null;
        if (!plateLookup)
            plateLookup = (service === "INSTALL") ? serial : plateReal;
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
        const vehicleSettingId = payload.vehicleSettingId ||
            payload.vehicle_setting_id ||
            payload.vehicleSettingID ||
            payload.VEHICLE_SETTING_ID ||
            null;
        const gsensor = payload.gsensor || payload.gSensor || payload.g_sensor || null;
        const recTok = String(inst.installation_token || inst.token || tok).trim();
        const payloadForJob = {
            installation_id: id,
            installation_token: recTok,
            service,
            plate_real: plateReal,
            plateReal: plateReal,
            plate_lookup: plateLookup,
            plateLookup: plateLookup,
            lookup_license: plateLookup,
            plate: plateLookup, // compat
            serial,
            target_client_id: targetClientId,
            assetType,
            vehicleSettingId,
            gsensor,
        };
        // enqueue job (via loopback /api/jobs)
        const adminKey = pickAdminKey();
        const headers = {};
        if (adminKey)
            headers["x-admin-key"] = adminKey;
        headers["x-internal-call"] = "installationsRoutes";
        const jobType = "html5_install";
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
        // marca status para refletir retry no app (e limpa last_error)
        try {
            installationsStore.patchInstallation && installationsStore.patchInstallation(id, { status: "HTML5_QUEUED", last_error: null });
        }
        catch { }
        return res.json({ ok: true, installation_id: id, status: "HTML5_QUEUED", enqueue: enqueueDebug });
    }
    catch (e) {
        console.error("[installationsRoutes] retry-html5 error:", e && (e.stack || e.message || String(e)));
        return res.status(500).json({ ok: false, error: "Internal Server Error" });
    }
});
router.post("/:id/actions/request-can-snapshot", async (req, res) => {
    try {
        const id = req.params.id;
        const body = (req.body && typeof req.body === "object") ? req.body : {};
        const vehicleIdRaw = (body.vehicle_id != null ? body.vehicle_id :
            (body.vehicleId != null ? body.vehicleId :
                (body.VEHICLE_ID != null ? body.VEHICLE_ID : null)));
        let vehicle_id = vehicleIdRaw != null ? Number(vehicleIdRaw) : NaN;
        // Para o app oficial: vehicle_id pode vir omitido, desde que a instalação já tenha resolved.vehicle_id.
        if (!Number.isFinite(vehicle_id) || vehicle_id <= 0) {
            try {
                const inst = installationsStore.getInstallation(String(id));
                const resolved = Number(inst?.resolved?.vehicle_id || 0);
                if (Number.isFinite(resolved) && resolved > 0)
                    vehicle_id = resolved;
            }
            catch { }
        }
        if (!Number.isFinite(vehicle_id) || vehicle_id <= 0) {
            return res.status(400).json({
                error: "missing_vehicle_id",
                detail: "body.vehicle_id (number) é obrigatório (ou resolved.vehicle_id precisa existir)"
            });
        }
        const baseUrl = body.baseUrl ||
            body.base_url ||
            process.env.PUBLIC_BASE_URL ||
            process.env.RENDER_EXTERNAL_URL ||
            `${req.protocol}://${req.get("host")}`;
        // headers de evidência
        res.setHeader("x-reqcan-route", "reqcan_v4");
        res.setHeader("x-vehicle-id-used", String(vehicle_id));
        res.setHeader("x-base-url-used", String(baseUrl));
        // chama o engine (a correção do engine está no passo 2 abaixo)
        const engineFn = pickFn(installationsEngine, ["requestCanSnapshot", "request_can_snapshot"]);
        const out = await engineFn(String(id), { vehicle_id, baseUrl });
        return res.json(out || { ok: true, installation_id: String(id), vehicle_id, status: "QUEUED" });
    }
    catch (err) {
        const msg = (err && err.message) ? String(err.message) : String(err);
        return res.status(500).json({ error: "reqcan_failed", detail: msg });
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
