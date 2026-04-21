"use strict";
// src/routes/authRoutes.ts
// POST /api/auth/html5-login  — autentica usuário no HTML5 e retorna token de sessão
// GET  /api/auth/session       — valida se um token ainda está ativo
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionMap = void 0;
const express_1 = require("express");
const crypto_1 = require("crypto");
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const router = (0, express_1.Router)();
// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const HTML5_ACTION_URL = (process.env.HTML5_ACTION_URL ||
    "https://html5.traffilog.com/AppEngine_2_1/default.aspx").trim();
const HTML5_INDEX_URL = "https://html5.traffilog.com/appv2/index.htm";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 horas
exports.sessionMap = new Map();
// Limpeza periódica de sessões expiradas (a cada 30 min)
setInterval(() => {
    const now = Date.now();
    let purged = 0;
    for (const [token, s] of exports.sessionMap.entries()) {
        if (s.expiresAt < now) {
            exports.sessionMap.delete(token);
            purged++;
        }
    }
    if (purged > 0)
        console.log(`[auth] ${purged} sessões expiradas removidas`);
}, 30 * 60 * 1000);
function httpGet(url, reqHeaders = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === "https:" ? https : http;
        const req = lib.request({
            hostname: u.hostname,
            port: u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80),
            path: u.pathname + u.search,
            method: "GET",
            headers: { accept: "text/html", ...reqHeaders },
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString("utf8"),
            }));
            res.on("error", reject);
        });
        req.setTimeout(12000, () => { req.destroy(); reject(new Error("GET timeout")); });
        req.on("error", reject);
        req.end();
    });
}
function httpPost(url, body, reqHeaders = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === "https:" ? https : http;
        const buf = Buffer.from(body, "utf8");
        const req = lib.request({
            hostname: u.hostname,
            port: u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80),
            path: u.pathname + u.search,
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                "content-length": String(buf.length),
                accept: "*/*",
                origin: "https://html5.traffilog.com",
                referer: HTML5_INDEX_URL,
                ...reqHeaders,
            },
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString("utf8"),
            }));
            res.on("error", reject);
        });
        req.setTimeout(12000, () => { req.destroy(); reject(new Error("POST timeout")); });
        req.on("error", reject);
        req.write(buf);
        req.end();
    });
}
// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------
/** Extrai cookies do header set-cookie e retorna como string "k=v; k2=v2" */
function extractSetCookie(headers) {
    const raw = headers["set-cookie"];
    if (!raw)
        return "";
    const list = Array.isArray(raw) ? raw : [raw];
    // Pega apenas "Nome=Valor" de cada diretiva (ignora Path, Domain, etc.)
    return list
        .map((s) => s.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
}
/** Faz merge de dois strings de cookie, última ocorrência de cada chave ganha */
function mergeCookies(base, incoming) {
    const map = new Map();
    const parse = (s) => {
        for (const part of s.split(";")) {
            const trimmed = part.trim();
            if (!trimmed)
                continue;
            const idx = trimmed.indexOf("=");
            if (idx === -1) {
                map.set(trimmed, "");
            }
            else {
                map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
            }
        }
    };
    parse(base);
    parse(incoming);
    return [...map.entries()]
        .map(([k, v]) => (v ? `${k}=${v}` : k))
        .join("; ");
}
// ---------------------------------------------------------------------------
// loginUserToHtml5 — faz bootstrap + APPLICATION_LOGIN e retorna cookie do usuário
// ---------------------------------------------------------------------------
async function loginUserToHtml5(username, password) {
    // 1. Bootstrap: GET index.htm para obter ASP.NET_SessionId
    const bootstrap = await httpGet(HTML5_INDEX_URL, {
        referer: HTML5_INDEX_URL,
    });
    let cookie = extractSetCookie(bootstrap.headers);
    // 2. APPLICATION_LOGIN com credenciais do usuário
    const bodyParams = new URLSearchParams({
        username,
        password,
        language: process.env.HTML5_LANGUAGE || "0",
        BOL_SAVE_COOKIE: "1",
        action: "APPLICATION_LOGIN",
        VERSION_ID: "2",
    });
    const loginResp = await httpPost(HTML5_ACTION_URL, bodyParams.toString(), { cookie });
    cookie = mergeCookies(cookie, extractSetCookie(loginResp.headers));
    const text = loginResp.body;
    // Sucesso: HTML5 retorna REDIRECT com node=-2, ou o cookie TFL_SESSION aparece
    const isOk = /REDIRECT[^>]*node=-2/i.test(text) ||
        cookie.includes("TFL_SESSION");
    if (!isOk) {
        console.log(`[auth] loginUserToHtml5 falhou para "${username}" — resposta: ${text.slice(0, 200)}`);
        return null;
    }
    return cookie;
}
// ---------------------------------------------------------------------------
// clientsQueryWithCookie — chama CLIENTS com o cookie do próprio usuário
// Retorna apenas os clientes que o usuário tem acesso (sem depender do cookiejar admin)
// ---------------------------------------------------------------------------
async function clientsQueryWithCookie(userCookie) {
    const bodyParams = new URLSearchParams({
        REFRESH_FLG: "1",
        action: "CLIENTS",
        VERSION_ID: "2",
    });
    const resp = await httpPost(HTML5_ACTION_URL, bodyParams.toString(), {
        cookie: userCookie,
    });
    const xml = resp.body;
    console.log(`[auth] CLIENTS raw (${xml.length} chars): ${xml.slice(0, 200)}`);
    const records = [];
    const re = /<CLIENT\s([^>]*?)\/>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const attrs = m[1];
        const attr = (name) => {
            const hit = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
            return hit ? hit[1].trim() : "";
        };
        const clientId = Number(attr("CLIENT_ID"));
        if (!clientId)
            continue;
        records.push({
            client_id: clientId,
            client_descr: attr("CLIENT_DESCR"),
            default_group_name: attr("DEFAULT_GROUP_NAME"),
        });
    }
    console.log(`[auth] CLIENTS encontrados: ${records.length}`);
    return records;
}
// ---------------------------------------------------------------------------
// getUserGroups — chama LOGIN_USER_GROUPS com o cookie do usuário
// ---------------------------------------------------------------------------
async function getUserGroups(userCookie) {
    const bodyParams = new URLSearchParams({
        action: "LOGIN_USER_GROUPS",
        VERSION_ID: "2",
    });
    const resp = await httpPost(HTML5_ACTION_URL, bodyParams.toString(), {
        cookie: userCookie,
    });
    const xml = resp.body;
    console.log(`[auth] LOGIN_USER_GROUPS raw (${xml.length} chars): ${xml.slice(0, 400)}`);
    // Extrai CLIENT_DESCR de cada <GROUP CLIENT_DESCR="..." />
    const descrs = [];
    const re = /CLIENT_DESCR="([^"]+)"/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const d = m[1].toUpperCase().trim();
        if (d && !descrs.includes(d))
            descrs.push(d);
    }
    console.log(`[auth] grupos encontrados: [${descrs.join(", ")}]`);
    return descrs;
}
// ---------------------------------------------------------------------------
// POST /api/auth/html5-login
// ---------------------------------------------------------------------------
router.post("/html5-login", async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({
            ok: false,
            error: "username e password são obrigatórios",
        });
    }
    // Credenciais admin lidas do ambiente (mesmo padrão do warmup worker)
    const adminName = (process.env.HTML5_LOGIN_NAME || "").trim();
    const adminPass = (process.env.HTML5_PASSWORD || "").trim();
    if (!adminName || !adminPass) {
        console.error("[auth] HTML5_LOGIN_NAME / HTML5_PASSWORD não definidos");
        return res.status(500).json({ ok: false, error: "Configuração do servidor incompleta" });
    }
    try {
        // 1. Login do usuário — valida credenciais e obtém cookie para LOGIN_USER_GROUPS
        const userCookie = await loginUserToHtml5(String(username), String(password));
        if (!userCookie) {
            return res.status(401).json({ ok: false, error: "Credenciais inválidas" });
        }
        // 2. Em paralelo: grupos do usuário + login admin para buscar lista completa
        const [allowedDescrs, adminCookie] = await Promise.all([
            getUserGroups(userCookie),
            loginUserToHtml5(adminName, adminPass),
        ]);
        if (allowedDescrs.length === 0) {
            return res.status(403).json({
                ok: false,
                error: "Usuário sem clientes habilitados no sistema",
            });
        }
        if (!adminCookie) {
            console.error("[auth] login admin falhou — verifique HTML5_LOGIN_NAME/HTML5_PASSWORD");
            return res.status(502).json({ ok: false, error: "Falha no login administrativo" });
        }
        // 3. CLIENTS com cookie admin — lista completa
        const allClients = await clientsQueryWithCookie(adminCookie);
        if (allClients.length === 0) {
            return res.status(502).json({ ok: false, error: "Lista de clientes vazia no servidor HTML5" });
        }
        // 4. Cruzamento por CLIENT_DESCR (case-insensitive)
        const allowedSet = new Set(allowedDescrs.map(d => d.toUpperCase().trim()));
        const filtered = allClients.filter(c => allowedSet.has((c.client_descr || "").toUpperCase().trim()));
        // 5. Gera token de sessão
        const token = (0, crypto_1.randomUUID)();
        exports.sessionMap.set(token, {
            clients: filtered,
            username: String(username),
            expiresAt: Date.now() + SESSION_TTL_MS,
        });
        console.log(`[auth] ✅ login ok user="${username}" ` +
            `groups=${allowedDescrs.length} allClients=${allClients.length} ` +
            `filtered=${filtered.length} token=${token.slice(0, 8)}...`);
        return res.json({
            ok: true,
            session_token: token,
            username: String(username),
            clients: filtered,
        });
    }
    catch (err) {
        console.error("[auth] html5-login error:", err?.message);
        return res.status(502).json({
            ok: false,
            error: "Falha na comunicação com o servidor HTML5",
        });
    }
});
// ---------------------------------------------------------------------------
// GET /api/auth/session?token=<token>
// ---------------------------------------------------------------------------
router.get("/session", (req, res) => {
    const token = String(req.query.token || "").trim();
    if (!token)
        return res.status(400).json({ ok: false, error: "token obrigatório" });
    const session = exports.sessionMap.get(token);
    if (!session || session.expiresAt < Date.now()) {
        exports.sessionMap.delete(token);
        return res.status(401).json({ ok: false, reason: "expired_or_invalid" });
    }
    return res.json({ ok: true, username: session.username });
});
exports.default = router;
