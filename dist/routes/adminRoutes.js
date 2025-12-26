"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const sessionTokenStore_1 = require("../services/sessionTokenStore");
const router = (0, express_1.Router)();
function requireAdminKey(req, res, next) {
    const expected = (process.env.SESSION_TOKEN_ADMIN_KEY || "").trim();
    const got = (req.header("x-admin-key") || req.header("X-Admin-Key") || "").trim();
    if (!expected) {
        return res.status(500).json({ error: "SESSION_TOKEN_ADMIN_KEY not set" });
    }
    if (!got || got !== expected) {
        return res.status(401).json({ error: "unauthorized" });
    }
    return next();
}
router.get("/session-token/status", requireAdminKey, (req, res) => {
    return res.json((0, sessionTokenStore_1.getSessionTokenStatus)());
});
router.post("/session-token", requireAdminKey, (req, res) => {
    const token = (req.body && (req.body.sessionToken || req.body.token)) ? String(req.body.sessionToken || req.body.token) : "";
    if (!token.trim()) {
        return res.status(400).json({ error: "missing token (body.token or body.sessionToken)" });
    }
    (0, sessionTokenStore_1.setSessionToken)(token);
    return res.json({ ok: true, ...(0, sessionTokenStore_1.getSessionTokenStatus)() });
});
exports.default = router;
