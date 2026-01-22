import fs from "fs";
import path from "path";
import { getDbPool } from "./pool";

type MigRow = { id: string };

export async function migrateIfNeeded(): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      );
    `);

    const dir = path.join(process.cwd(), "db", "migrations");
    if (!fs.existsSync(dir)) {
      console.log("[db] migrations dir not found:", dir);
      return;
    }

    const files = fs.readdirSync(dir)
      .filter(f => /^\d+_.*\.sql$/i.test(f))
      .sort();

    const applied = new Set<string>(
      (await client.query<MigRow>("select id from schema_migrations")).rows.map(r => r.id)
    );

    for (const f of files) {
      if (applied.has(f)) continue;
      const full = path.join(dir, f);
      const sql = fs.readFileSync(full, "utf8");

      console.log("[db] applying migration:", f);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations(id) values ($1)", [f]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    }

    console.log("[db] migrations OK");
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}
