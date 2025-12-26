"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSessionTokenStore = initSessionTokenStore;
exports.refreshSessionTokenFromDisk = refreshSessionTokenFromDisk;
exports.getSessionToken = getSessionToken;
exports.setSessionToken = setSessionToken;
exports.getSessionTokenStatus = getSessionTokenStatus;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const DEFAULT_PATH = path_1.default.join(process.cwd(), ".session_token");
const SESSION_TOKEN_PATH = process.env.SESSION_TOKEN_PATH || DEFAULT_PATH;
let sessionToken = "";
/** Carrega o token do disco (se existir) para memória. */
function initSessionTokenStore() {
    try {
        const raw = fs_1.default.readFileSync(SESSION_TOKEN_PATH, "utf8");
        sessionToken = (raw || "").trim();
    }
    catch {
        sessionToken = "";
    }
}
/**
 * Recarrega do disco, mas NÃO zera o token em caso de erro.
 * Retorna true se o token mudou.
 */
function refreshSessionTokenFromDisk() {
    try {
        const raw = fs_1.default.readFileSync(SESSION_TOKEN_PATH, "utf8");
        const t = (raw || "").trim();
        const changed = t !== sessionToken;
        sessionToken = t;
        return changed;
    }
    catch {
        return false;
    }
}
function getSessionToken() {
    return sessionToken;
}
/** Salva token em memória e persiste em disco. */
function setSessionToken(token) {
    const t = (token || "").trim();
    sessionToken = t;
    // Não persiste vazio
    if (!t)
        return;
    // Garante pasta existente
    try {
        fs_1.default.mkdirSync(path_1.default.dirname(SESSION_TOKEN_PATH), { recursive: true });
    }
    catch { }
    fs_1.default.writeFileSync(SESSION_TOKEN_PATH, t, "utf8");
}
/** Status seguro (não vaza token). */
function getSessionTokenStatus() {
    return {
        hasToken: !!sessionToken,
        tokenLen: sessionToken.length,
        path: SESSION_TOKEN_PATH,
    };
}
