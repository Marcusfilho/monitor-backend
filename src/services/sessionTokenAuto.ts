import { getSessionToken, refreshSessionTokenFromDisk } from "./sessionTokenStore";

let inFlight: Promise<string | null> | null = null;
let lastFailAt = 0;

const FAIL_THROTTLE_MS = 60_000; // 60s

function now() { return Date.now(); }
function enabled() { return (process.env.AUTO_SESSION_TOKEN || "").trim() === "1"; }

/**
 * Opção A (fase 1 - ultra segura):
 * - Só tenta quando AUTO_SESSION_TOKEN=1
 * - Não faz login (ainda). Apenas recarrega token do disco.
 * - Lock + throttle para não martelar.
 */
export async function ensureSessionTokenAuto(): Promise<string | null> {
  const cur = (getSessionToken() || "").trim();
  if (cur) return cur;

  if (!enabled()) return null;

  if (lastFailAt && (now() - lastFailAt) < FAIL_THROTTLE_MS) return null;

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      refreshSessionTokenFromDisk();
const t = (getSessionToken() || "").trim();
if (t) return t;
      lastFailAt = now();
      return null;
    } catch {
      lastFailAt = now();
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
