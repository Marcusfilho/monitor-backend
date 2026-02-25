"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDbPool = exports.pool = void 0;
exports.getPool = getPool;
const pg_1 = require("pg");
let _pool = null;
function needsSsl(host) {
    return host.endsWith(".render.com") || host.includes("-postgres.render.com");
}
/**
 * Single source of truth for DB connection.
 * IMPORTANT: Prefer DATABASE_URL connectionString so PGHOST/PG* injected by platforms won't override host.
 * Logs are SAFE: only host + ssl flag.
 */
function getPool() {
    if (_pool)
        return _pool;
    const cs = (process.env.DATABASE_URL || "").trim();
    if (!cs)
        throw new Error("DATABASE_URL is not set");
    let ssl = undefined;
    try {
        const host = new URL(cs).hostname;
        if (needsSsl(host))
            ssl = { rejectUnauthorized: false };
        console.log(`[db] using DATABASE_URL host=${host} ssl=${!!ssl}`);
    }
    catch {
        console.log("[db] using DATABASE_URL (host parse failed) ssl=unknown");
    }
    _pool = new pg_1.Pool({ connectionString: cs, ssl });
    return _pool;
}
// compat: some modules may import { pool }
exports.pool = getPool();
// Backward-compatible alias (older code imports getDbPool)
exports.getDbPool = getPool;
