import fs from "fs";
import path from "path";

const DEFAULT_PATH = path.join(process.cwd(), ".session_token");
const TOKEN_PATH = (process.env.SESSION_TOKEN_PATH || DEFAULT_PATH).trim();

let _token = "";

export function getSessionToken(): string {
  return _token;
}

export async function refreshSessionTokenFromDisk(): Promise<string> {
  try {
    _token = fs.readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    // ok: arquivo pode não existir
  }
  return _token;
}

let writeLock: Promise<void> = Promise.resolve();

/** grava token em disco de forma serializada (sem .tmp/rename) */
export async function setSessionToken(token: string): Promise<void> {
  _token = (token || "").trim();
  if (!_token) return;

  writeLock = writeLock.then(async () => {
    try {
      fs.writeFileSync(TOKEN_PATH, _token, "utf8");
    } catch (e: any) {
      console.log("[token] falha ao gravar SESSION_TOKEN_PATH:", e?.message || String(e));
    }
  });

  await writeLock;
}

/**
 * Compatibilidade (imports antigos):
 * - initSessionTokenStore(): inicializa o store (tenta carregar do disco se estiver vazio)
 * - getSessionTokenStatus(): status do token (sem expor o token completo)
 */

export type SessionTokenStatus = {
  hasToken: boolean;
  tokenMasked: string | null;
  tokenLength: number;
};

function maskToken(token: string): string {
  const t = (token || "").trim();
  if (!t) return "";
  if (t.length <= 8) return "****";
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

export async function initSessionTokenStore(): Promise<void> {
  const cur = (getSessionToken?.() || "").trim();
  if (cur) return;

  try {
    // Não assumimos assinatura; cast para evitar erro se exigir argumento
    await (refreshSessionTokenFromDisk as any)();
  } catch (err) {
    console.warn("[tokenStore] initSessionTokenStore: falha ao carregar token do disco:", err);
  }
}

export function getSessionTokenStatus(): SessionTokenStatus {
  const token = (getSessionToken?.() || "").trim();
  return {
    hasToken: !!token,
    tokenMasked: token ? maskToken(token) : null,
    tokenLength: token.length,
  };
}
