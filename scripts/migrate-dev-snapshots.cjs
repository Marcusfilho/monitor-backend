#!/usr/bin/env node
// HISTORY_V1 — one-shot: copia as linhas legadas da DB do monitor-backend-dev
// para a DB canônica da rewrite. Idempotente por job_id.
//
//   SQLITE_DB_PATH=/home/questar/monitor-backend-rewrite/data/monitor.db \
//     node scripts/migrate-dev-snapshots.cjs [--dry-run]

const SRC = process.env.SRC_DB_PATH || "/home/questar/monitor-backend-dev/data/monitor.db";
const DRY = process.argv.includes("--dry-run");

// garante schema novo (WAL, colunas, índices) na DB de destino
require("/home/questar/monitor-backend-rewrite/dist/services/snapshotStore.js");
const { _formatCan } = require("/home/questar/monitor-backend-rewrite/dist/services/sharepointExporter.js");

const Database = require("better-sqlite3");
const DEST = (process.env.SQLITE_DB_PATH || "").trim();
if (!DEST) { console.error("SQLITE_DB_PATH não definido"); process.exit(1); }
if (DEST === SRC) { console.error("origem e destino são a mesma DB"); process.exit(1); }

const src = new Database(SRC, { readonly: true });
const dst = new Database(DEST);

const rows = src.prepare("SELECT * FROM service_snapshots ORDER BY id ASC").all();
console.log(`origem: ${SRC} → ${rows.length} linha(s)`);
console.log(`destino: ${DEST}`);

const already = new Set(
  dst.prepare("SELECT job_id FROM service_snapshots WHERE job_id IS NOT NULL").all().map(r => r.job_id),
);

const ins = dst.prepare(`
  INSERT INTO service_snapshots
    (job_id, sp_item_id, source, service, service_date, technician, plate, serial,
     vehicle_id, asset_type, vehicle_setting_id, client_id, client_descr,
     manufacturer, model, year, color, chassi, local_instalacao,
     etiqueta, chicote, comment, can_summary, status, snapshot_json, created_at)
  VALUES
    (@job_id, NULL, 'worker', @service, @service_date, @technician, @plate, @serial,
     @vehicle_id, @asset_type, @vehicle_setting_id, @client_id, @client_descr,
     @manufacturer, @model, @year, @color, @chassi, @local_instalacao,
     @etiqueta, @chicote, @comment, @can_summary, @status, @snapshot_json, @created_at)
`);

let inserted = 0, skipped = 0;
const run = dst.transaction(() => {
  for (const r of rows) {
    if (r.job_id && already.has(r.job_id)) { skipped++; continue; }

    let j = {};
    try { j = JSON.parse(r.snapshot_json || "{}"); } catch { /* json legado corrompido */ }
    const c = j.cadastro || {};

    ins.run({
      job_id:           r.job_id || null,
      service:          r.service,
      service_date:     j.ts ? new Date(j.ts).toISOString() : r.created_at,
      technician:       r.technician,
      plate:            r.plate,
      serial:           r.serial,
      vehicle_id:       r.vehicle_id,
      asset_type:       r.asset_type,
      vehicle_setting_id: r.vehicle_setting_id,
      client_id:        r.client_id,
      client_descr:     r.client_descr,
      manufacturer:     c.vehicle?.manufacturer ?? null,
      model:            c.vehicle?.model        ?? null,
      year:             c.vehicle?.year         ?? null,
      color:            c.cor                   ?? null,
      chassi:           c.chassi                ?? null,
      local_instalacao: c.localInstalacao       ?? null,
      etiqueta:         c.gsensor?.label_pos    ?? null,
      chicote:          c.gsensor?.harness_pos  ?? null,
      comment:          c.comment               ?? null,
      can_summary:      (j.can ? _formatCan(j.can) : "") || null,
      status:           "exported",   // já foram exportadas na época
      snapshot_json:    r.snapshot_json,
      created_at:       r.created_at,
    });
    inserted++;
  }
  if (DRY) throw new Error("__dry_run__");
});

try { run(); } catch (e) {
  if (e.message !== "__dry_run__") throw e;
  console.log("(dry-run: rollback)");
}

console.log(`inseridas=${inserted} puladas(job_id ja existe)=${skipped}`);
console.log(`total no destino: ${dst.prepare("SELECT COUNT(*) n FROM service_snapshots").get().n}`);
src.close(); dst.close();
