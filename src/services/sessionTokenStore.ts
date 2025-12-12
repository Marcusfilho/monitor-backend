import fs from "fs/promises";
import path from "path";

type TokenFile = { token: string; updatedAt: string };

let token: string | null = process.env.MONITOR_SESSION_TOKEN ?? null;
let updatedAt: string | null = null;

const tokenPath = process.env.SESSION_TOKEN_PATH || "";

async function fileExists(p: string) {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function ensureDirForFile(p: string) {
  const dir = path.dirname(p);
  await fs.mkdir(dir, { recursive: true });
}

function preview(t: string | null) {
  if (!t) return null;
  return `***${t.slice(-4)}`;
}

export async function refreshSessionTokenFromDisk() {
  if (!tokenPath) return;
  if (!(await fileExists(tokenPath))) return;

  const raw = await fs.readFile(tokenPath, "utf-8");
  const data = JSON.parse(raw) as TokenFile;

  if (data?.token) token = data.token;
  if (data?.updatedAt) updatedAt = data.updatedAt;
}

export async function initSessionTokenStore() {
  await refreshSessionTokenFromDisk();
}

export function getSessionToken() {
  return token;
}

export function getSessionTokenStatus() {
  return {
    hasToken: !!token,
    updatedAt,
    tokenPreview: preview(token),
    tokenPath: tokenPath || null,
  };
}

export async function setSessionToken(newToken: string) {
  if (!tokenPath) throw new Error("SESSION_TOKEN_PATH não configurado");
  if (!newToken || typeof newToken !== "string") throw new Error("token inválido");

  token = newToken;
  updatedAt = new Date().toISOString();

  await ensureDirForFile(tokenPath);

  const payload: TokenFile = { token: newToken, updatedAt };
  const tmp = `${tokenPath}.tmp`;

  await fs.writeFile(tmp, JSON.stringify(payload), { encoding: "utf-8" });
  await fs.rename(tmp, tokenPath);
}
EOF
