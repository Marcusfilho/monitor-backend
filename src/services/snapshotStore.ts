// src/services/snapshotStore.ts
// SNAPSHOT_STORE_V1 — gravação local no SQLite + store-and-forward para Google Drive
//
// Fluxo:
//   saveSnapshot()
//     → INSERT service_snapshots (status='pending')
//     → tenta driveExport() imediatamente
//         OK  → UPDATE status='exported'  (ou DELETE, ver CLEANUP_MODE)
//         FAIL → permanece 'pending'; cron das 6h retenta via retryPending()

import Database from "better-sqlite3";
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

function openDb(): Database.Database {
  return new Database(DB_PATH);
}

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

// ─── privado: export + limpeza ────────────────────────────────────────────────

async function _tryExportAndClean(id: number, p: SnapshotPayload): Promise<void> {
  // importa o driveExporter dinamicamente para não quebrar
  // o worker se o módulo ainda não existir
  let exporter: any = null;
  try {
    exporter = require("./driveExporter");
  } catch {
    console.log(
      `[SNAPSHOT_STORE_V1] driveExporter não disponível ainda — id=${id} fica pending`,
    );
    return;
  }

  if (typeof exporter?.exportSnapshot !== "function") {
    console.log(
      `[SNAPSHOT_STORE_V1] driveExporter.exportSnapshot não é função — id=${id} fica pending`,
    );
    return;
  }

  await exporter.exportSnapshot(id, p);

  // chegou aqui = export confirmado
  if (CLEANUP_MODE === "delete") {
    deleteSnapshot(id);
  } else {
    markExported(id);
  }
}
