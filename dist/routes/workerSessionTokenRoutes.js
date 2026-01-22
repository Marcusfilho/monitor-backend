"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const router = express_1.default.Router();
function requireWorkerKey(req, res, next) {
    const expected = (process.env.WORKER_KEY || "").trim();
    if (!expected)
        return res.status(500).json({ ok: false, error: "WORKER_KEY_not_set" });
    const got = (req.header("x-worker-key") || req.header("X-Worker-Key") || "").trim();
    if (!got || got !== expected)
        return res.status(401).json({ ok: false, error: "unauthorized" });
    next();
}
const TOKEN_PATH = process.env.SESSION_TOKEN_PATH || path_1.default.join(process.cwd(), ".session_token");
router.get("/session-token", requireWorkerKey, (_req, res) => {
    let token = "";
    try {
        token = fs_1.default.readFileSync(TOKEN_PATH, "utf8").trim();
    }
    catch { }
    res.json({ ok: true, hasToken: !!token, tokenLen: token.length, token, path: TOKEN_PATH });
});
exports.default = router;
