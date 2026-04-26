// src/services/driveExporter.ts
// DRIVE_EXPORT_V1 — stub inicial
//
// Este arquivo é importado dinamicamente pelo snapshotStore.
// Enquanto a Service Account do Google Cloud não estiver configurada,
// a função simplesmente lança um erro controlado, e o snapshot
// permanece com status='pending' no SQLite para o cron retentar.
//
// Quando a SA estiver pronta, substitua o corpo de exportSnapshot()
// pela integração real com a Google Sheets / Drive API.

import type { SnapshotPayload } from "./snapshotStore";

const DRIVE_ENABLED = process.env.DRIVE_EXPORT_ENABLED === "1";

/**
 * Exporta um snapshot para o Google Drive / Sheets.
 * Lança exceção em caso de falha (o caller decide o que fazer).
 */
export async function exportSnapshot(id: number, p: SnapshotPayload): Promise<void> {
  if (!DRIVE_ENABLED) {
    throw new Error(
      `[DRIVE_EXPORT_V1] desabilitado (DRIVE_EXPORT_ENABLED != 1) — id=${id} permanece pending`,
    );
  }

  // ── TODO: implementar quando SA estiver configurada ──────────────────────
  //
  // 1. Carregar credencial:
  //    const creds = JSON.parse(fs.readFileSync(process.env.GSA_CREDENTIALS_PATH!, "utf8"));
  //
  // 2. Autenticar com googleapis:
  //    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: [...] });
  //
  // 3. Montar linha para o Sheets:
  //    const row = [
  //      p.snapshot_json.cadastro.plate_real,
  //      p.snapshot_json.cadastro.serial,
  //      p.snapshot_json.cadastro.technician.nick,
  //      p.snapshot_json.cadastro.client,
  //      p.snapshot_json.cadastro.service,
  //      p.snapshot_json.cadastro.cor,
  //      p.snapshot_json.cadastro.chassi,
  //      p.snapshot_json.cadastro.localInstalacao,
  //      new Date(p.snapshot_json.ts).toISOString(),
  //    ];
  //
  // 4. Append na planilha:
  //    await sheets.spreadsheets.values.append({ spreadsheetId, range: "A1", ... });
  //
  // ────────────────────────────────────────────────────────────────────────

  throw new Error("[DRIVE_EXPORT_V1] exportSnapshot() não implementado ainda");
}
