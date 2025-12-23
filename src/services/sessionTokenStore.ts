import fs from "fs";
import path from "path";

const DEFAULT_PATH = path.join(process.cwd(), ".session_token");
const SESSION_TOKEN_PATH = process.env.SESSION_TOKEN_PATH || DEFAULT_PATH;

let sessionToken = "";

/** Carrega o token do disco (se existir) para memória. */
export function initSessionTokenStore(): void {
  try {
    const raw = fs.readFileSync(SESSION_TOKEN_PATH, "utf8");
    sessionToken = (raw || "").trim();
  } catch {
    sessionToken = "";
  }
}

export function getSessionToken(): string {
  return sessionToken;
}

/** Salva token em memória e persiste em disco. */
export function setSessionToken(token: string): void {
  const t = (token || "").trim();
  sessionToken = t;

  // Não persiste vazio
  if (!t) return;

  // Garante pasta existente
  try {
    fs.mkdirSync(path.dirname(SESSION_TOKEN_PATH), { recursive: true });
  } catch {}

  fs.writeFileSync(SESSION_TOKEN_PATH, t, "utf8");
}

/** Status seguro (não vaza token). */
export function getSessionTokenStatus(): {
  hasToken: boolean;
  tokenLen: number;
  path: string;
} {
  return {
    hasToken: !!sessionToken,
    tokenLen: sessionToken.length,
    path: SESSION_TOKEN_PATH,
  };
}
