import express from "express";
import { getDbPool } from "../db/pool";

const r = express.Router();

function requireAdmin(req: any, res: any, next: any) {
  const expected = (process.env.SESSION_TOKEN_ADMIN_KEY || "").trim();
  const got = (req.header("x-admin-key") || "").trim();
  if (!expected || got !== expected) return res.status(401).json({ error: "unauthorized" });
  next();
}

function normKey(s: string): string {
  return (s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// --- DB status
r.get("/db/status", requireAdmin, async (_req, res) => {
  try {
    const pool = getDbPool();
    const q = await pool.query("select now() as now");
    await pool.end();
    res.json({ ok: true, now: q.rows[0]?.now });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- Vehicle Settings (DE/PARA)
r.get("/vehicle-settings", requireAdmin, async (req, res) => {
  const clientId = (req.query.clientId || "").toString().trim();
  const pool = getDbPool();
  try {
    const q = clientId
      ? await pool.query(
          "select * from catalog_vehicle_settings where client_id=$1 order by profile_key",
          [Number(clientId)]
        )
      : await pool.query("select * from catalog_vehicle_settings order by client_id, profile_key");
    res.json({ items: q.rows });
  } finally {
    await pool.end().catch(() => {});
  }
});

r.post("/vehicle-settings/bulk-upsert", requireAdmin, express.json({ limit: "2mb" }), async (req, res) => {
  const updatedBy = (req.body?.updatedBy || "admin").toString();
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "items[] required" });

  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const it of items) {
      const clientId = Number(it.clientId);
      const profileKey = (it.profileKey || "default").toString().trim().toLowerCase();
      const isDefault = !!it.isDefault;

      await client.query(
        `
        insert into catalog_vehicle_settings
          (client_id, profile_key, client_name, setting_name, vehicle_setting_id, is_default, tags, updated_by)
        values
          ($1,$2,$3,$4,$5,$6,coalesce($7,'{}'::jsonb),$8)
        on conflict (client_id, profile_key) do update set
          client_name=excluded.client_name,
          setting_name=excluded.setting_name,
          vehicle_setting_id=excluded.vehicle_setting_id,
          is_default=excluded.is_default,
          tags=excluded.tags,
          updated_at=now(),
          updated_by=excluded.updated_by
        `,
        [
          clientId,
          profileKey,
          it.clientName ?? null,
          it.settingName ?? null,
          Number(it.vehicleSettingId),
          isDefault,
          it.tags ? JSON.stringify(it.tags) : null,
          updatedBy,
        ]
      );
    }
    await client.query("commit");
    res.json({ ok: true, upserted: items.length });
  } catch (e: any) {
    await client.query("rollback");
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
});

// --- Vehicle Models (modelo -> vehicle_type_id)
r.get("/vehicle-models", requireAdmin, async (req, res) => {
  const q = (req.query.q || "").toString();
  const pool = getDbPool();
  try {
    if (!q) {
      const out = await pool.query("select * from catalog_vehicle_models order by model_key limit 200");
      return res.json({ items: out.rows });
    }
    const nq = "%" + normKey(q) + "%";
    const out = await pool.query(
      "select * from catalog_vehicle_models where model_key like $1 or vehicle_type_raw ilike $2 or friendly_name ilike $2 order by model_key limit 200",
      [nq, "%" + q + "%"]
    );
    res.json({ items: out.rows });
  } finally {
    await pool.end().catch(() => {});
  }
});

r.post("/vehicle-models/bulk-upsert", requireAdmin, express.json({ limit: "5mb" }), async (req, res) => {
  const updatedBy = (req.body?.updatedBy || "admin").toString();
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "items[] required" });

  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const it of items) {
      const raw = (it.vehicleType || it.vehicle_type || it.vehicle_type_raw || "").toString();
      const modelKey = normKey(it.modelKey || raw);
      if (!modelKey) throw new Error("modelKey/vehicleType vazio");
      await client.query(
        `
        insert into catalog_vehicle_models
          (model_key, vehicle_type_id, friendly_name, vehicle_type_raw, tags, updated_by)
        values
          ($1,$2,$3,$4,coalesce($5,'{}'::jsonb),$6)
        on conflict (model_key) do update set
          vehicle_type_id=excluded.vehicle_type_id,
          friendly_name=excluded.friendly_name,
          vehicle_type_raw=excluded.vehicle_type_raw,
          tags=excluded.tags,
          updated_at=now(),
          updated_by=excluded.updated_by
        `,
        [
          modelKey,
          Number(it.vehicleTypeId || it.id),
          it.friendlyName ?? null,
          raw || null,
          it.tags ? JSON.stringify(it.tags) : null,
          updatedBy,
        ]
      );
    }
    await client.query("commit");
    res.json({ ok: true, upserted: items.length });
  } catch (e: any) {
    await client.query("rollback");
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
});

export default r;
