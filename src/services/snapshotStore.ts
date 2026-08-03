// src/services/snapshotStore.ts
// SNAPSHOT_STORE_V1 — gravação local no SQLite + store-and-forward para Google Drive
//
// Fluxo:
//   saveSnapshot()
//     → INSERT service_snapshots (status='pending')
//     → tenta driveExport() imediatamente
//         OK  → UPDATE status='exported'  (ou DELETE, ver CLEANUP_MODE)
//         FAIL → permanece 'pending'; timer de 30min retenta via retryPending()
//
// HISTORY_V1: a tabela é a base histórica permanente de todos os serviços, lida
// direto (SQLite, modo WAL) por outra repo da VM. Por isso o default do cleanup
// é "mark" — env ausente nunca pode destruir dado.

// better-sqlite3 é carregado dinamicamente — só disponível na VM
let Database: any = null;
try { Database = require("better-sqlite3"); } catch { /* Render: ignorar */ }
import path from "path";
// HISTORY_V1: reusa o mesmo resumo de CAN que vai para o SharePoint, para a coluna
// can_summary. Import type-only do outro lado → sem ciclo em runtime.
import { _formatCan as formatCan } from "./sharepointExporter";

// ─── configuração ────────────────────────────────────────────────────────────

const DB_PATH =
  (process.env.SQLITE_DB_PATH || "").trim() ||
  path.join(process.cwd(), "data", "monitor.db");

// "mark"   → mantém registro com status='exported' (padrão — base histórica)
// "delete" → remove após export confirmado (opt-in explícito)
const CLEANUP_MODE = (process.env.SNAPSHOT_CLEANUP_MODE || "mark").trim() as "delete" | "mark";

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

// HISTORY_V1: colunas adicionadas ao schema original. Migração idempotente via
// ALTER TABLE para bases que já existem com o schema antigo.
const _SCHEMA_SQL = `
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id             TEXT,
  sp_item_id         INTEGER,
  source             TEXT NOT NULL DEFAULT 'worker',
  service            TEXT,
  service_date       TEXT,
  technician         TEXT,
  plate              TEXT,
  serial             TEXT,
  vehicle_id         INTEGER,
  asset_type         INTEGER,
  vehicle_setting_id INTEGER,
  client_id          INTEGER,
  client_descr       TEXT,
  manufacturer       TEXT,
  model              TEXT,
  year               INTEGER,
  color              TEXT,
  chassi             TEXT,
  local_instalacao   TEXT,
  etiqueta           TEXT,
  chicote            TEXT,
  comment            TEXT,
  can_summary        TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',
  snapshot_json      TEXT,
  created_at         TEXT NOT NULL
`;

const _HISTORY_COLUMNS: Array<[string, string]> = [
  ["sp_item_id",       "INTEGER"],
  ["source",           "TEXT NOT NULL DEFAULT 'worker'"],
  ["service_date",     "TEXT"],
  ["manufacturer",     "TEXT"],
  ["model",            "TEXT"],
  ["year",             "INTEGER"],
  ["color",            "TEXT"],
  ["chassi",           "TEXT"],
  ["local_instalacao", "TEXT"],
  ["etiqueta",         "TEXT"],
  ["chicote",          "TEXT"],
  ["comment",          "TEXT"],
  ["can_summary",      "TEXT"],
  // SB_VERIFY_V1 — conferência interna do scheme atribuído no Traffilog
  ["sb_verified",            "TEXT"],     // null=não checado | 'ok' | 'mismatch' | 'unknown'
  ["sb_assigned_setting_id", "INTEGER"],  // o que o servidor realmente tem
  ["sb_verified_at",         "TEXT"],
  ["sb_resend_job_id",       "TEXT"],     // job do reenvio automático (auditoria)
];

function _ensureSchema(): void {
  if (!Database) return;
  const db = openDb();
  try {
    // WAL: leitor externo (outra repo) não bloqueia nem lê sujo durante a escrita.
    // Persiste no header do arquivo — basta rodar uma vez.
    db.pragma("journal_mode = WAL");

    db.prepare(`CREATE TABLE IF NOT EXISTS service_snapshots (${_SCHEMA_SQL})`).run();

    let info: any[] = db.prepare("PRAGMA table_info(service_snapshots)").all();
    const existing = new Set<string>(info.map((c: any) => c.name));
    for (const [name, decl] of _HISTORY_COLUMNS) {
      if (!existing.has(name)) {
        db.prepare(`ALTER TABLE service_snapshots ADD COLUMN ${name} ${decl}`).run();
        console.log(`[SNAPSHOT_STORE_V1] migração: coluna ${name} adicionada`);
        info = db.prepare("PRAGMA table_info(service_snapshots)").all();
      }
    }

    // O schema antigo tinha job_id e snapshot_json NOT NULL — as linhas vindas do
    // SharePoint não têm nenhum dos dois. ALTER TABLE não afrouxa constraint no
    // SQLite, então é preciso reconstruir a tabela preservando as linhas.
    const tooStrict = info.some(
      (c: any) => (c.name === "job_id" || c.name === "snapshot_json") && c.notnull === 1,
    );
    if (tooStrict) {
      const cols = info.map((c: any) => c.name).filter((n: string) => n !== "id").join(", ");
      db.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN;
        CREATE TABLE service_snapshots__new (${_SCHEMA_SQL});
        INSERT INTO service_snapshots__new (id, ${cols}) SELECT id, ${cols} FROM service_snapshots;
        DROP TABLE service_snapshots;
        ALTER TABLE service_snapshots__new RENAME TO service_snapshots;
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
      console.log("[SNAPSHOT_STORE_V1] migração: tabela reconstruída (job_id/snapshot_json nullable)");
    }

    // UNIQUE só em sp_item_id (chave de dedup do backfill). job_id fica sem UNIQUE
    // de propósito: violação de constraint no INSERT derrubaria um job ao vivo.
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS ux_snapshots_sp_item
                ON service_snapshots(sp_item_id) WHERE sp_item_id IS NOT NULL`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_snapshots_job    ON service_snapshots(job_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_snapshots_date   ON service_snapshots(service_date)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_snapshots_plate  ON service_snapshots(plate)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_snapshots_client ON service_snapshots(client_id)`).run();
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

// ─── SB_VERIFY_V1 — conferência do scheme atribuído ──────────────────────────

/**
 * Linhas candidatas à conferência de scheme.
 *
 * As travas do WHERE são deliberadamente redundantes: a tabela é base histórica e
 * tem ~4.969 linhas vindas do backfill do SharePoint (source='sharepoint', todas com
 * vehicle_id NULL). Uma varredura sem escopo dispararia reenvio de SB em massa.
 *
 * UNINSTALL fica de fora: o veículo acabou de ser desativado, o scheme atribuído
 * diverge do alvo do cliente por construção e o reenvio gravaria scheme em veículo
 * desinstalado (ocorreu em 03/08 com 4 veículos do lote das 13:49).
 */
export function listUnverifiedForSchemeCheck(limit: number, maxAgeHours: number): any[] {
  const db = openDb();
  try {
    const cutoff = new Date(Date.now() - maxAgeHours * 3600_000).toISOString();
    return db
      .prepare(
        `SELECT id, job_id, service, plate, vehicle_id, vehicle_setting_id,
                client_id, client_descr
         FROM service_snapshots
         WHERE source = 'worker'
           AND vehicle_id  IS NOT NULL
           AND client_id   IS NOT NULL
           AND sb_verified IS NULL
           AND (service IS NULL OR service <> 'UNINSTALL')
           AND created_at >= ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(cutoff, limit);
  } finally {
    db.close();
  }
}

export function markSchemeVerified(
  id: number,
  v: { verdict: string; assignedSettingId: number | null; resendJobId: string | null },
): void {
  const db = openDb();
  try {
    db.prepare(
      `UPDATE service_snapshots
          SET sb_verified            = ?,
              sb_assigned_setting_id = ?,
              sb_verified_at         = ?,
              sb_resend_job_id       = ?
        WHERE id = ?`,
    ).run(v.verdict, v.assignedSettingId, new Date().toISOString(), v.resendJobId, id);
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
        (job_id, sp_item_id, source, service, service_date, technician, plate, serial,
         vehicle_id, asset_type, vehicle_setting_id,
         client_id, client_descr,
         manufacturer, model, year, color, chassi, local_instalacao,
         etiqueta, chicote, comment, can_summary,
         status, snapshot_json, created_at)
      VALUES
        (@job_id, NULL, 'worker', @service, @service_date, @technician, @plate, @serial,
         @vehicle_id, @asset_type, @vehicle_setting_id,
         @client_id, @client_descr,
         @manufacturer, @model, @year, @color, @chassi, @local_instalacao,
         @etiqueta, @chicote, @comment, @can_summary,
         @status, @snapshot_json, @created_at)
    `);

    // HISTORY_V1: colunas achatadas derivadas do próprio payload — o SnapshotPayload
    // não muda, então saveSnapshotWorker e o exporter do SharePoint ficam intactos.
    const c = p.snapshot_json.cadastro;

    const result = stmt.run({
      ...p,
      service_date:     new Date(p.snapshot_json.ts).toISOString(),
      manufacturer:     c.vehicle?.manufacturer ?? null,
      model:            c.vehicle?.model        ?? null,
      year:             c.vehicle?.year         ?? null,
      color:            c.cor                   ?? null,
      chassi:           c.chassi                ?? null,
      local_instalacao: c.localInstalacao       ?? null,
      etiqueta:         c.gsensor?.label_pos    ?? null,
      chicote:          c.gsensor?.harness_pos  ?? null,
      comment:          c.comment               ?? null,
      can_summary:      formatCan(p.snapshot_json.can) || null,
      snapshot_json:    JSON.stringify(p.snapshot_json),
      status:           "pending",
      created_at:       new Date().toISOString(),
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
