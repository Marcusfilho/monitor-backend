"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
mkdir - p;
src / routes;
cat > src / routes / adminRoutes.ts << 'EOF';
const express_1 = require("express");
const sessionTokenStore_1 = require("../services/sessionTokenStore");
const router = (0, express_1.Router)();
function requireAdminKey(req, res, next) {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey)
        return res.status(503).json({ ok: false, error: "ADMIN_KEY não configurado" });
    const got = req.header("X-Admin-Key");
    if (!got || got !== adminKey)
        return res.status(401).json({ ok: false, error: "unauthorized" });
    next();
}
router.get("/admin/session-token/status", requireAdminKey, (_req, res) => {
    res.json({ ok: true, ...(0, sessionTokenStore_1.getSessionTokenStatus)() });
});
router.post("/admin/session-token", requireAdminKey, async (req, res) => {
    const token = req.body?.token;
    if (!token || typeof token !== "string" || token.length < 20) {
        return res.status(400).json({ ok: false, error: "token inválido" });
    }
    await (0, sessionTokenStore_1.setSessionToken)(token);
    res.json({ ok: true, ...(0, sessionTokenStore_1.getSessionTokenStatus)() });
});
exports.default = router;
EOF;
