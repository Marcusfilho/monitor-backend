"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSessionToken = getSessionToken;
exports.refreshSessionTokenFromDisk = refreshSessionTokenFromDisk;
exports.setSessionToken = setSessionToken;
exports.initSessionTokenStore = initSessionTokenStore;
exports.getSessionTokenStatus = getSessionTokenStatus;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const DEFAULT_PATH = path_1.default.join(process.cwd(), ".session_token");
const TOKEN_PATH = (process.env.SESSION_TOKEN_PATH || DEFAULT_PATH).trim();
let _token = "";
function getSessionToken() {
    return _token;
}
async function refreshSessionTokenFromDisk() {
    try {
        _token = fs_1.default.readFileSync(TOKEN_PATH, "utf8").trim();
    }
    catch {
        // ok: arquivo pode não existir
    }
    return _token;
}
let writeLock = Promise.resolve();
/** grava token em disco de forma serializada (sem .tmp/rename) */
async function setSessionToken(token) {
    _token = (token || "").trim();
    if (!_token)
        return;
    writeLock = writeLock.then(async () => {
        try {
            fs_1.default.writeFileSync(TOKEN_PATH, _token, "utf8");
        }
        catch (e) {
            console.log("[token] falha ao gravar SESSION_TOKEN_PATH:", e?.message || String(e));
        }
    });
    await writeLock;
}
function maskToken(token) {
    const t = (token || "").trim();
    if (!t)
        return "";
    if (t.length <= 8)
        return "****";
    return `${t.slice(0, 4)}…${t.slice(-4)}`;
}
async function initSessionTokenStore() {
    const cur = (getSessionToken?.() || "").trim();
    if (cur)
        return;
    try {
        // Não assumimos assinatura; cast para evitar erro se exigir argumento
        await refreshSessionTokenFromDisk();
    }
    catch (err) {
        console.warn("[tokenStore] initSessionTokenStore: falha ao carregar token do disco:", err);
    }
}
function getSessionTokenStatus() {
    const token = (getSessionToken?.() || "").trim();
    return {
        hasToken: !!token,
        tokenMasked: token ? maskToken(token) : null,
        tokenLength: token.length,
    };
}
