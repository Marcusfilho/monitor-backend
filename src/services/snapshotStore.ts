// src/services/snapshotStore.ts
// SNAPSHOT_STORE_V1 — gravação local no SQLite + store-and-forward para Google Drive
//
// Fluxo:
//   saveSnapshot()
//     → INSERT service_snapshots (status='pending')
//     → tenta driveExport() imediatamente
//         OK  → UPDATE status='exported'  (ou DELETE, ver CLEANUP_MODE)
//         FAIL → permanece 'pending'; cron das 6h retenta via retryPending()

// better-sqlite3 é carregado dinamicamente — só disponível na VM
let Database: any = null;
try { Database = require("better-sqlite3"); } catch { /* Render: ignorar */ }
import path from "path";

// ─── configuração ────────────────────────────────────────────────────────────

const DB_PATH =
  (process.env.SQLITE_DB_PATH || "").trim() ||
  path.join(process.cwd(), "data", "monitor.db");

// "delete" → remove após export confirmado (padrão)
// "mark"   → mantém registro com status='exported' (para auditoria)
const CLEANUP_MODE = (process.env.SNAPSHOT_CLEANUP_MODE || "delete").trim() as "delete" | "mark";

// ─── tipos ───────────────────────────────────────────────────────────────────

export interface SnapshotPayload {
  job_id:             string;
  service:            string;
  technician:         string | null;
  plate:              string | null;
  serial:             string | null;
  vehicle_id:         number | null;
  asset_type:         number | null;
  vehicle_setting_id: number | null;
  client_id:          number | null;
  client_descr:       string | null;
  snapshot_json: {
    cadastro: {
      plate_real:       string | null;
      serial:           string | null;
      technician:       { id: string | null; nick: string | null };
      client:           string | null;
      service:          string | null;
      vehicle:          { manufacturer: string | null; model: string | null; year: number | null };
      gsensor:          any;
      comment:          string | null;
      cor:              string | null;   // CAMPOS_EXTRAS_V1
      chassi:           string | null;   // CAMPOS_EXTRAS_V1
      localInstalacao:  string | null;   // CAMPOS_EXTRAS_V1
    };
    can: any;
    ts:  number;
  };
}

// ─── helpers internos ────────────────────────────────────────────────────────

function openDb(): any {
  if (!Database) throw new Error("[snapshotStore] better-sqlite3 não disponível neste ambiente");
  return new Database(DB_PATH);
}

function _ensureSchema(): void {
  if (!Database) return;
  const db = openDb();
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS service_snapshots (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id             TEXT NOT NULL,
        service            TEXT,
        technician         TEXT,
        plate              TEXT,
        serial             TEXT,
        vehicle_id         INTEGER,
        asset_type         INTEGER,
        vehicle_setting_id INTEGER,
        client_id          INTEGER,
        client_descr       TEXT,
        status             TEXT NOT NULL DEFAULT 'pending',
        snapshot_json      TEXT NOT NULL,
        created_at         TEXT NOT NULL
      )
    `).run();
  } finally {
    db.close();
  }
}
_ensureSchema();

// ─── operações principais ────────────────────────────────────────────────────

/**
 * Grava o snapshot no SQLite com status='pending'.
 * Em seguida tenta exportar para o Drive imediatamente.
 * Se o export falhar, o registro permanece 'pending' para o cron retentar.
 *
 * @returns id do registro inserido
 */
export async function saveSnapshot(p: SnapshotPayload): Promise<number> {
  // 1) INSERT no SQLite
  const id = _insertSnapshot(p);

  // 2) tenta push imediato (best-effort — não lança exceção)
  try {
    await _tryExportAndClean(id, p);
  } catch (e: any) {
    console.error(
      `[SNAPSHOT_STORE_V1] export imediato falhou (id=${id}) — ficará pendente para o cron:`,
      e?.message || e,
    );
  }

  return id;
}

/**
 * Retenta todos os registros com status='pending'.
 * Chamar pelo cron das 6h como fallback.
 */
export async function retryPending(): Promise<void> {
  const rows = listPendingSnapshots();
  if (!rows.length) {
    console.log("[SNAPSHOT_STORE_V1] retryPending: nenhum registro pendente");
    return;
  }

  console.log(`[SNAPSHOT_STORE_V1] retryPending: ${rows.length} registro(s) para retentar`);

  for (const row of rows) {
    try {
      const json = JSON.parse(row.snapshot_json);
      // monta payload mínimo só para o export (campos da tabela + json)
      const p: any = {
        job_id:             row.job_id,
        service:            row.service,
        technician:         row.technician,
        plate:              row.plate,
        serial:             row.serial,
        vehicle_id:         row.vehicle_id,
        asset_type:         row.asset_type,
        vehicle_setting_id: row.vehicle_setting_id,
        client_id:          row.client_id,
        client_descr:       row.client_descr,
        snapshot_json:      json,
      };
      await _tryExportAndClean(row.id, p);
    } catch (e: any) {
      console.error(
        `[SNAPSHOT_STORE_V1] retryPending: falha no id=${row.id}:`,
        e?.message || e,
      );
    }
  }
}

// ─── operações de leitura / limpeza ──────────────────────────────────────────

export function listPendingSnapshots(): any[] {
  const db = openDb();
  try {
    return db
      .prepare(
        `SELECT id, job_id, plate, service, technician, serial,
                vehicle_id, asset_type, vehicle_setting_id,
                client_id, client_descr, snapshot_json, created_at
         FROM service_snapshots
         WHERE status = 'pending'
         ORDER BY id ASC`,
      )
      .all();
  } finally {
    db.close();
  }
}

export function deleteSnapshot(id: number): void {
  const db = openDb();
  try {
    db.prepare("DELETE FROM service_snapshots WHERE id = ?").run(id);
    console.log(`[SNAPSHOT_STORE_V1] deleted id=${id}`);
  } finally {
    db.close();
  }
}

export function markExported(id: number): void {
  const db = openDb();
  try {
    db.prepare(
      `UPDATE service_snapshots SET status = 'exported' WHERE id = ?`,
    ).run(id);
    console.log(`[SNAPSHOT_STORE_V1] marked exported id=${id}`);
  } finally {
    db.close();
  }
}

// ─── privado: INSERT ──────────────────────────────────────────────────────────

function _insertSnapshot(p: SnapshotPayload): number {
  const db = openDb();
  try {
    const stmt = db.prepare(`
      INSERT INTO service_snapshots
        (job_id, service, technician, plate, serial,
         vehicle_id, asset_type, vehicle_setting_id,
         client_id, client_descr, status, snapshot_json, created_at)
      VALUES
        (@job_id, @service, @technician, @plate, @serial,
         @vehicle_id, @asset_type, @vehicle_setting_id,
         @client_id, @client_descr, @status, @snapshot_json, @created_at)
    `);

    const result = stmt.run({
      ...p,
      snapshot_json: JSON.stringify(p.snapshot_json),
      status:        "pending",
      created_at:    new Date().toISOString(),
    });

    const id = Number(result.lastInsertRowid);
    console.log(
      `[SNAPSHOT_STORE_V1] INSERT id=${id} plate=${p.plate} job=${p.job_id}`,
    );
    return id;
  } finally {
    db.close();
  }
}

// ─── privado: exporters habilitados ──────────────────────────────────────────
// Adicione novos destinos aqui: basta criar um módulo com exportSnapshot(id, p)
// e registrá-lo com a env var de controle correspondente.

type ExportFn = (id: number, p: SnapshotPayload) => Promise<void>;

function _loadExporters(): ExportFn[] {
  const fns: ExportFn[] = [];

  if (process.env.SP_EXPORT_ENABLED === "1") {
    try {
      const m = require("./sharepointExporter");
      if (typeof m?.exportSnapshot === "function") fns.push(m.exportSnapshot);
    } catch (e: any) {
      console.warn("[SNAPSHOT_STORE_V1] sharepointExporter não carregou:", e?.message);
    }
  }

  if (process.env.DRIVE_EXPORT_ENABLED === "1") {
    try {
      const m = require("./driveExporter");
      if (typeof m?.exportSnapshot === "function") fns.push(m.exportSnapshot);
    } catch (e: any) {
      console.warn("[SNAPSHOT_STORE_V1] driveExporter não carregou:", e?.message);
    }
  }

  return fns;
}

// ─── privado: export + limpeza ────────────────────────────────────────────────

async function _tryExportAndClean(id: number, p: SnapshotPayload): Promise<void> {
  const exporters = _loadExporters();

  if (exporters.length === 0) {
    console.log(`[SNAPSHOT_STORE_V1] nenhum exporter habilitado — id=${id} fica pending`);
    return;
  }

  const results = await Promise.allSettled(exporters.map(fn => fn(id, p)));
  const anyOk   = results.some(r => r.status === "fulfilled");

  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`[SNAPSHOT_STORE_V1] exporter[${i}] falhou (id=${id}):`, (r as any).reason?.message ?? r);
    }
  });

  if (!anyOk) throw new Error("todos os exporters falharam");

  if (CLEANUP_MODE === "delete") deleteSnapshot(id);
  else markExported(id);
}
