"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startHeartbeat = startHeartbeat;
function startHeartbeat(opts) {
    const intervalMs = opts.intervalMs ?? 30000;
    if (!opts.baseUrl)
        throw new Error("HB: missing BASE_URL");
    if (!opts.workerKey)
        throw new Error("HB: missing WORKER_KEY");
    // evita problemas de typing em TS antigo
    const fetchFn = globalThis.fetch;
    if (!fetchFn)
        throw new Error("HB: fetch not available in this Node");
    async function sendOnce() {
        const payload = {
            worker_id: opts.workerId || "worker",
            ts: new Date().toISOString(),
            ...(opts.getState ? opts.getState() : { status: "running", checks: { backend_ok: true } }),
        };
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        try {
            const r = await fetchFn(`${opts.baseUrl}/api/worker/heartbeat`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-worker-key": opts.workerKey,
                },
                body: JSON.stringify(payload),
                signal: ctrl.signal,
            });
            if (!r.ok) {
                const txt = await r.text().catch(() => "");
                console.error("[hb] http", r.status, txt.slice(0, 200));
            }
        }
        catch (e) {
            console.error("[hb] fail:", e?.message || e);
        }
        finally {
            clearTimeout(t);
        }
    }
    sendOnce().catch(() => { });
    return setInterval(() => sendOnce().catch(() => { }), intervalMs);
}
