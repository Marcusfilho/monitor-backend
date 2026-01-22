import { Pool } from "pg";

function wantSSL(): boolean {
  const v = (process.env.PGSSL || process.env.DATABASE_SSL || "").toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes";
}

export function getDbPool(): Pool {
  const cs = (process.env.DATABASE_URL || "").trim();
  if (!cs) throw new Error("DATABASE_URL is not set");

  // SSL: por padrão OFF; se precisar, setar PGSSL=1 no Render.
  const ssl = wantSSL() ? { rejectUnauthorized: false } : undefined;

  return new Pool({
    connectionString: cs,
    ssl,
    max: Number(process.env.PGPOOL_MAX || 5),
    idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_MS || 30_000),
    connectionTimeoutMillis: Number(process.env.PGPOOL_CONN_TIMEOUT_MS || 10_000),
  });
}
