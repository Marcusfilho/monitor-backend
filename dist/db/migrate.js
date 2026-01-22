"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateIfNeeded = migrateIfNeeded;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const pool_1 = require("./pool");
async function migrateIfNeeded() {
    const pool = (0, pool_1.getDbPool)();
    const client = await pool.connect();
    try {
        await client.query(`
      create table if not exists schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      );
    `);
        const dir = path_1.default.join(process.cwd(), "db", "migrations");
        if (!fs_1.default.existsSync(dir)) {
            console.log("[db] migrations dir not found:", dir);
            return;
        }
        const files = fs_1.default.readdirSync(dir)
            .filter(f => /^\d+_.*\.sql$/i.test(f))
            .sort();
        const applied = new Set((await client.query("select id from schema_migrations")).rows.map(r => r.id));
        for (const f of files) {
            if (applied.has(f))
                continue;
            const full = path_1.default.join(dir, f);
            const sql = fs_1.default.readFileSync(full, "utf8");
            console.log("[db] applying migration:", f);
            await client.query("begin");
            try {
                await client.query(sql);
                await client.query("insert into schema_migrations(id) values ($1)", [f]);
                await client.query("commit");
            }
            catch (e) {
                await client.query("rollback");
                throw e;
            }
        }
        console.log("[db] migrations OK");
    }
    finally {
        client.release();
        await pool.end().catch(() => { });
    }
}
