"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireWorkerKey = requireWorkerKey;
function requireWorkerKey(req, res, next) {
    const want = (process.env.WORKER_KEY || "").trim();
    if (!want)
        return res.status(500).json({ ok: false, error: "WORKER_KEY_NOT_SET" });
    const got = String(req.header("x-worker-key") || "").trim();
    if (!got || got !== want)
        return res.status(401).json({ ok: false, error: "WORKER_KEY_INVALID" });
    next();
}
