"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshSessionTokenFromDisk = refreshSessionTokenFromDisk;
exports.initSessionTokenStore = initSessionTokenStore;
exports.getSessionToken = getSessionToken;
exports.getSessionTokenStatus = getSessionTokenStatus;
exports.setSessionToken = setSessionToken;
mkdir - p;
src / services;
cat > src / services / sessionTokenStore.ts << 'EOF';
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
let token = process.env.MONITOR_SESSION_TOKEN ?? null;
let updatedAt = null;
const tokenPath = process.env.SESSION_TOKEN_PATH || "";
async function fileExists(p) {
    try {
        await promises_1.default.stat(p);
        return true;
    }
    catch {
        return false;
    }
}
async function ensureDirForFile(p) {
    const dir = path_1.default.dirname(p);
    await promises_1.default.mkdir(dir, { recursive: true });
}
function preview(t) {
    if (!t)
        return null;
    return `***${t.slice(-4)}`;
}
async function refreshSessionTokenFromDisk() {
    if (!tokenPath)
        return;
    if (!(await fileExists(tokenPath)))
        return;
    const raw = await promises_1.default.readFile(tokenPath, "utf-8");
    const data = JSON.parse(raw);
    if (data?.token)
        token = data.token;
    if (data?.updatedAt)
        updatedAt = data.updatedAt;
}
async function initSessionTokenStore() {
    await refreshSessionTokenFromDisk();
}
function getSessionToken() {
    return token;
}
function getSessionTokenStatus() {
    return {
        hasToken: !!token,
        updatedAt,
        tokenPreview: preview(token),
        tokenPath: tokenPath || null,
    };
}
async function setSessionToken(newToken) {
    if (!tokenPath)
        throw new Error("SESSION_TOKEN_PATH não configurado");
    if (!newToken || typeof newToken !== "string")
        throw new Error("token inválido");
    token = newToken;
    updatedAt = new Date().toISOString();
    await ensureDirForFile(tokenPath);
    const payload = { token: newToken, updatedAt };
    const tmp = `${tokenPath}.tmp`;
    await promises_1.default.writeFile(tmp, JSON.stringify(payload), { encoding: "utf-8" });
    await promises_1.default.rename(tmp, tokenPath);
}
EOF;
