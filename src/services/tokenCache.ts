// src/services/tokenCache.ts
import { fetchNewTraffiToken, TraffiTokenResponse } from "./authService";

interface CachedToken {
  value: string;
  // timestamp em ms de quando expira
  expiresAt: number;
  raw: any;
}

let cachedToken: CachedToken | null = null;

/**
 * Retorna um token válido.
 * Se o cache estiver vazio ou perto de expirar, busca um novo.
 */
export async function getTraffiToken(): Promise<TraffiTokenResponse> {
  const now = Date.now();

  // margem de segurança de 60s antes de expirar
  const safetyMarginMs = 60 * 1000;

  if (cachedToken && cachedToken.expiresAt - safetyMarginMs > now) {
    return {
      accessToken: cachedToken.value,
      // aproximação do tempo restante em segundos
      expiresInSeconds: Math.max(
        0,
        Math.floor((cachedToken.expiresAt - now) / 1000)
      ),
      raw: cachedToken.raw
    };
  }

  // cache vazio ou vencido → buscar novo
  const fresh = await fetchNewTraffiToken();

  const expiresAt =
    now + fresh.expiresInSeconds * 1000 || now + 3600 * 1000; // fallback 1h

  cachedToken = {
    value: fresh.accessToken,
    expiresAt,
    raw: fresh.raw
  };

  return fresh;
}
