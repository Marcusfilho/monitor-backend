#!/usr/bin/env node
// retry-snapshots.cjs — retenta exportar snapshots pendentes ao SharePoint.
// Chamado pelo systemd timer monitor-snapshot-retry-rw.timer.
// Requer o módulo já compilado (npm run build) e as mesmas envs do worker
// (SP_* + SQLITE_DB_PATH), fornecidas pela unit .service.

const store = require("/home/questar/monitor-backend-rewrite/dist/services/snapshotStore.js");

(async () => {
  try {
    await store.retryPending();
    process.exit(0);
  } catch (e) {
    console.error("[retry-snapshots] falha:", e && e.message ? e.message : e);
    process.exit(1);
  }
})();
