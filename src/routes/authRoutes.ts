// src/routes/authRoutes.ts
// POST /api/auth/html5-login  — autentica usuário no HTML5 e retorna token de sessão
// GET  /api/auth/session       — valida se um token ainda está ativo

import { Router } from "express";
import { randomUUID } from "crypto";
import * as https from "https";
import * as http from "http";

const router = Router();

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const HTML5_ACTION_URL = (
  process.env.HTML5_ACTION_URL ||
  "https://html5.traffilog.com/AppEngine_2_1/default.aspx"
).trim();

const HTML5_INDEX_URL = "https://html5.traffilog.com/appv2/index.htm";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 horas

// ---------------------------------------------------------------------------
// Map de sessões em memória: token → { clients, username, expiresAt }
// ---------------------------------------------------------------------------

interface SessionEntry {
  clients: ClientRecord[];
  username: string;
  expiresAt: number;
}

export const sessionMap = new Map<string, SessionEntry>();

// Limpeza periódica de sessões expiradas (a cada 30 min)
setInterval(() => {
  const now = Date.now();
  let purged = 0;
  for (const [token, s] of sessionMap.entries()) {
    if (s.expiresAt < now) { sessionMap.delete(token); purged++; }
  }
  if (purged > 0) console.log(`[auth] ${purged} sessões expiradas removidas`);
}, 30 * 60 * 1000);

// ---------------------------------------------------------------------------
// Helpers HTTP (sem node-fetch — usa https nativo igual ao restante do projeto)
// ---------------------------------------------------------------------------

interface HttpResult {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

function httpGet(url: string, reqHeaders: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = (lib as typeof https).request(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: { accept: "text/html", ...reqHeaders },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[]>,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
        res.on("error", reject);
      }
    );
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("GET timeout")); });
    req.on("error", reject);
    req.end();
  });
}

function httpPost(
  url: string,
  body: string,
  reqHeaders: Record<string, string> = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const buf = Buffer.from(body, "utf8");

    const req = (lib as typeof https).request(
      {
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
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[]>,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
        res.on("error", reject);
      }
    );
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
function extractSetCookie(headers: Record<string, string | string[]>): string {
  const raw = headers["set-cookie"];
  if (!raw) return "";
  const list = Array.isArray(raw) ? raw : [raw];
  // Pega apenas "Nome=Valor" de cada diretiva (ignora Path, Domain, etc.)
  return list
    .map((s) => s.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

/** Faz merge de dois strings de cookie, última ocorrência de cada chave ganha */
function mergeCookies(base: string, incoming: string): string {
  const map = new Map<string, string>();
  const parse = (s: string) => {
    for (const part of s.split(";")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) {
        map.set(trimmed, "");
      } else {
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

async function loginUserToHtml5(
  username: string,
  password: string
): Promise<string | null> {
  // 1. Bootstrap: GET index.htm para obter ASP.NET_SessionId
  const bootstrap = await httpGet(HTML5_INDEX_URL, {
    referer: HTML5_INDEX_URL,
  });
  let cookie = extractSetCookie(bootstrap.headers);

  // 2. APPLICATION_LOGIN com credenciais do usuário
  const bodyParams = new URLSearchParams({
    username,
    password,
    language:        process.env.HTML5_LANGUAGE || "0",
    BOL_SAVE_COOKIE: "1",
    action:          "APPLICATION_LOGIN",
    VERSION_ID:      "2",
  });

  const loginResp = await httpPost(
    HTML5_ACTION_URL,
    bodyParams.toString(),
    { cookie }
  );

  cookie = mergeCookies(cookie, extractSetCookie(loginResp.headers));
  const text = loginResp.body;

  // Sucesso: HTML5 retorna REDIRECT com node=-2, ou o cookie TFL_SESSION aparece
  const isOk =
    /REDIRECT[^>]*node=-2/i.test(text) ||
    cookie.includes("TFL_SESSION");

  if (!isOk) {
    console.log(`[auth] loginUserToHtml5 falhou para "${username}" — resposta: ${text.slice(0, 200)}`);
    return null;
  }

  return cookie;
}

// ---------------------------------------------------------------------------
// Tipo local (espelha ClientRecord de html5Client.ts)
// ---------------------------------------------------------------------------

interface ClientRecord {
  client_id: number;
  client_descr: string;
  default_group_name: string;
}

// ---------------------------------------------------------------------------
// clientsQueryWithCookie — chama CLIENTS com o cookie do próprio usuário
// Retorna apenas os clientes que o usuário tem acesso (sem depender do cookiejar admin)
// ---------------------------------------------------------------------------

async function clientsQueryWithCookie(userCookie: string): Promise<ClientRecord[]> {
  const bodyParams = new URLSearchParams({
    REFRESH_FLG: "1",
    action:      "CLIENTS",
    VERSION_ID:  "2",
  });

  const resp = await httpPost(HTML5_ACTION_URL, bodyParams.toString(), {
    cookie: userCookie,
  });

  const xml = resp.body;
  console.log(`[auth] CLIENTS raw (${xml.length} chars): ${xml.slice(0, 200)}`);

  const records: ClientRecord[] = [];
  const re = /<CLIENT\s([^>]*?)\/>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const attr = (name: string) => {
      const hit = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
      return hit ? hit[1].trim() : "";
    };
    const clientId = Number(attr("CLIENT_ID"));
    if (!clientId) continue;
    records.push({
      client_id:          clientId,
      client_descr:       attr("CLIENT_DESCR"),
      default_group_name: attr("DEFAULT_GROUP_NAME"),
    });
  }

  console.log(`[auth] CLIENTS encontrados: ${records.length}`);
  return records;
}

// ---------------------------------------------------------------------------
// getUserGroups — chama LOGIN_USER_GROUPS com o cookie do usuário
// ---------------------------------------------------------------------------

async function getUserGroups(userCookie: string): Promise<string[]> {
  const bodyParams = new URLSearchParams({
    action:     "LOGIN_USER_GROUPS",
    VERSION_ID: "2",
  });

  const resp = await httpPost(HTML5_ACTION_URL, bodyParams.toString(), {
    cookie: userCookie,
  });

  const xml = resp.body;
  console.log(`[auth] LOGIN_USER_GROUPS raw (${xml.length} chars): ${xml.slice(0, 400)}`);

  // Extrai CLIENT_DESCR de cada <GROUP CLIENT_DESCR="..." />
  const descrs: string[] = [];
  const re = /CLIENT_DESCR="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const d = m[1].toUpperCase().trim();
    if (d && !descrs.includes(d)) descrs.push(d);
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

  try {
    // 1. Login do usuário no HTML5
    const userCookie = await loginUserToHtml5(String(username), String(password));
    if (!userCookie) {
      return res.status(401).json({ ok: false, error: "Credenciais inválidas" });
    }

    // 2. CLIENTS com o cookie do próprio usuário — retorna só o que ele tem acesso
    const filtered = await clientsQueryWithCookie(userCookie);

    if (filtered.length === 0) {
      return res.status(403).json({
        ok: false,
        error: "Usuário sem clientes habilitados no sistema",
      });
    }

    // 4. Gera token de sessão
    const token = randomUUID();
    sessionMap.set(token, {
      clients:   filtered,
      username:  String(username),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    console.log(
      `[auth] ✅ login ok user="${username}" ` +
      `clients=${filtered.length} token=${token.slice(0, 8)}...`
    );

    return res.json({
      ok:            true,
      session_token: token,
      username:      String(username),
      clients:       filtered,
    });

  } catch (err: any) {
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
  if (!token) return res.status(400).json({ ok: false, error: "token obrigatório" });

  const session = sessionMap.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessionMap.delete(token);
    return res.status(401).json({ ok: false, reason: "expired_or_invalid" });
  }

  return res.json({ ok: true, username: session.username });
});

export default router;
