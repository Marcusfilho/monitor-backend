import { Pool } from "pg";

let _pool: Pool | null = null;

function needsSsl(host: string) {
  return host.endsWith(".render.com") || host.includes("-postgres.render.com");
}

/**
 * Single source of truth for DB connection.
 * IMPORTANT: Prefer DATABASE_URL connectionString so PGHOST/PG* injected by platforms won't override host.
 * Logs are SAFE: only host + ssl flag.
 */
export function getPool(): Pool {
  if (_pool) return _pool;

  const cs = (process.env.DATABASE_URL || "").trim();
  if (!cs) throw new Error("DATABASE_URL is not set");

  let ssl: any = undefined;
  try {
    const host = new URL(cs).hostname;
    if (needsSsl(host)) ssl = { rejectUnauthorized: false };
    console.log(`[db] using DATABASE_URL host=${host} ssl=${!!ssl}`);
  } catch {
    console.log("[db] using DATABASE_URL (host parse failed) ssl=unknown");
  }

  _pool = new Pool({ connectionString: cs, ssl });
  return _pool;
}

// compat: some modules may import { pool }
export const pool = getPool();

// Backward-compatible alias (older code imports getDbPool)
export const getDbPool = getPool;
