#!/usr/bin/env node
// SP_BACKFILL_V1 — one-shot: importa o histórico da lista SharePoint para a
// tabela service_snapshots. Idempotente (ON CONFLICT(sp_item_id) DO NOTHING).
//
//   set -a; . ./worker_secrets_rw.env; set +a
//   node scripts/backfill-sharepoint.cjs [--dry-run]

// garante o schema (WAL, colunas, índices) antes de importar
require("/home/questar/monitor-backend-rewrite/dist/services/snapshotStore.js");
const { runBackfill } = require("/home/questar/monitor-backend-rewrite/dist/services/sharepointBackfill.js");

(async () => {
  try {
    await runBackfill({ dryRun: process.argv.includes("--dry-run") });
    process.exit(0);
  } catch (e) {
    console.error("[SP_BACKFILL_V1] falhou:", e && e.message ? e.message : e);
    process.exit(1);
  }
})();
