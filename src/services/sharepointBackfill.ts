// src/services/sharepointBackfill.ts
// SP_BACKFILL_V1 — importa o histórico da lista SharePoint para a tabela
// service_snapshots. One-shot, idempotente por sp_item_id.
//
// As linhas importadas têm source='sharepoint' e snapshot_json NULL: a lista só
// guarda 17 campos achatados, o dado bruto de CAN foi perdido no delete antigo.

let Database: any = null;
try { Database = require("better-sqlite3"); } catch { /* ignorar */ }
import path from "path";
import { _getToken, _graphGet, _ensureIds } from "./sharepointExporter";

const DB_PATH =
  (process.env.SQLITE_DB_PATH || "").trim() ||
  path.join(process.cwd(), "data", "monitor.db");

const PAGE_SIZE = 500;

// ─── mapeamento reverso (espelha SERVICE_PT / LABEL_PT do sharepointExporter) ──

const SERVICE_FROM_PT: Record<string, string> = {
  "INSTALAÇÃO"           : "INSTALL",
  "RETIRADA"             : "UNINSTALL",
  "MANUTENÇÃO"           : "MAINT",             // legado, sem distinção de troca
  "MANUTENÇÃO SEM TROCA" : "MAINT_NO_SWAP",
  "MANUTENÇÃO COM TROCA" : "MAINT_WITH_SWAP",
  // valores já gravados em código cru em algumas linhas antigas
  "INSTALL"              : "INSTALL",
  "UNINSTALL"            : "UNINSTALL",
  "MAINT_NO_SWAP"        : "MAINT_NO_SWAP",
  "MAINT_WITH_SWAP"      : "MAINT_WITH_SWAP",
};

// O LABEL_PT do exporter só gera maiúsculas; a lista tem muito legado capitalizado
// e a forma "Trás" (1.292 linhas), que o exporter nunca produziu.
const LABEL_FROM_PT: Record<string, string> = {
  CIMA: "UP", BAIXO: "DOWN", ESQUERDA: "LEFT", DIREITA: "RIGHT",
  FRENTE: "FRONT", TRASEIRO: "BACK", TRAS: "BACK",
};

function _deaccentUpper(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
}

function _mapService(v: any): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return SERVICE_FROM_PT[s.toUpperCase()] ?? SERVICE_FROM_PT[_deaccentUpper(s)] ?? s;
}

function _mapLabel(v: any): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return LABEL_FROM_PT[_deaccentUpper(s)] ?? null;
}

/** Graph devolve colunas numéricas como float (913000494.0). */
function _numToStr(v: any): string | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.trunc(n)) : String(v);
}

function _toInt(v: any): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function _str(v: any): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

// ─── leitura paginada da lista ────────────────────────────────────────────────

export async function fetchAllListItems(): Promise<any[]> {
  const token = await _getToken();
  const { siteId, listId } = await _ensureIds(token);

  const items: any[] = [];
  let url: string | null =
    `/v1.0/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=${PAGE_SIZE}`;
  let page = 0;

  while (url) {
    const data: any = await _graphGet(token, url);
    items.push(...(data.value ?? []));
    page++;
    console.log(`[SP_BACKFILL_V1] página ${page}: +${data.value?.length ?? 0} (total ${items.length})`);

    const next: string | undefined = data["@odata.nextLink"];
    // nextLink vem absoluto; _graphGet prefixa GRAPH_BASE, então corta o host
    url = next ? next.replace(/^https:\/\/graph\.microsoft\.com/, "") : null;
  }

  return items;
}

// ─── item da lista → linha da tabela ──────────────────────────────────────────

export function mapItemToRow(item: any): Record<string, any> {
  const f = item.fields ?? {};
  const created = item.createdDateTime ?? f.Created ?? null;

  return {
    sp_item_id:       _toInt(item.id),
    job_id:           _str(f.JobID),
    service:          _mapService(f["Servi_x00e7_o"]),
    service_date:     _str(f["Datadoservi_x00e7_o"]) ?? created,
    technician:       _str(f["T_x00e9_cnico"]),
    plate:            _str(f.Title),
    serial:           _numToStr(f.Serial),
    client_descr:     _str(f.Cliente),
    manufacturer:     _str(f.Fabricante1),
    model:            _str(f.Modelo),
    year:             _toInt(f.Ano),
    color:            _str(f.Cor),
    chassi:           _str(f.Chassi),
    local_instalacao: _str(f.LocalInstalacao),
    etiqueta:         _mapLabel(f.Etiqueta),
    chicote:          _mapLabel(f.Chicote),
    comment:          _str(f["Obs_x002e_"]),
    can_summary:      _str(f.CAN),
    created_at:       created,
  };
}

// ─── backfill ─────────────────────────────────────────────────────────────────

export async function runBackfill(opts: { dryRun?: boolean } = {}): Promise<void> {
  if (!Database) throw new Error("[SP_BACKFILL_V1] better-sqlite3 não disponível");

  const items = await fetchAllListItems();
  console.log(`[SP_BACKFILL_V1] ${items.length} item(ns) lidos da lista`);

  const db = new Database(DB_PATH);
  try {
    // job_ids já gravados pelo worker — não reimportar o mesmo serviço em duplicata
    const workerJobIds = new Set<string>(
      db.prepare("SELECT job_id FROM service_snapshots WHERE source='worker' AND job_id IS NOT NULL")
        .all().map((r: any) => r.job_id),
    );

    const ins = db.prepare(`
      INSERT INTO service_snapshots
        (job_id, sp_item_id, source, service, service_date, technician, plate, serial,
         vehicle_id, asset_type, vehicle_setting_id, client_id, client_descr,
         manufacturer, model, year, color, chassi, local_instalacao,
         etiqueta, chicote, comment, can_summary, status, snapshot_json, created_at)
      VALUES
        (@job_id, @sp_item_id, 'sharepoint', @service, @service_date, @technician, @plate, @serial,
         NULL, NULL, NULL, NULL, @client_descr,
         @manufacturer, @model, @year, @color, @chassi, @local_instalacao,
         @etiqueta, @chicote, @comment, @can_summary, 'exported', NULL, @created_at)
      ON CONFLICT(sp_item_id) WHERE sp_item_id IS NOT NULL DO NOTHING
    `);

    let inserted = 0, dupSpItem = 0, dupJob = 0, invalid = 0;

    const run = db.transaction(() => {
      for (const item of items) {
        const row = mapItemToRow(item);

        if (row.sp_item_id == null || !row.created_at) { invalid++; continue; }
        if (row.job_id && workerJobIds.has(row.job_id)) { dupJob++; continue; }

        const res = ins.run(row);
        if (res.changes > 0) inserted++; else dupSpItem++;
      }
      if (opts.dryRun) throw new Error("__dry_run__");
    });

    try { run(); } catch (e: any) {
      if (e?.message !== "__dry_run__") throw e;
      console.log("[SP_BACKFILL_V1] dry-run: rollback, nada gravado");
    }

    console.log(
      `[SP_BACKFILL_V1] inseridas=${inserted} ja_importadas=${dupSpItem} ` +
      `puladas_job_do_worker=${dupJob} invalidas=${invalid}`,
    );
    const total = db.prepare("SELECT COUNT(*) n FROM service_snapshots").get().n;
    console.log(`[SP_BACKFILL_V1] total na tabela: ${total}`);
  } finally {
    db.close();
  }
}
