// src/services/maintNoSwapSbService.ts
// SILENT_SB_V1 — Dispara Scheme Builder silencioso ao final de MAINT_NO_SWAP.
// Não exibe nenhum feedback no app. Processado pelo schemeBuilderWorker existente.
//
// IMPORTANTE: Esta função NÃO tenta resolver vehicleId — o chamador DEVE passar
// o vehicleId já resolvido do escopo local (canJob.payload.vehicleId, result.meta.vehicleId, etc).
// Não usar vhcls-lookup. Não usar extractSbParams genérico.

import { createJob } from "../jobs/jobStore";

/**
 * Enfileira um job scheme_builder silencioso para MAINT_NO_SWAP.
 * Fire-and-forget: não lança exceção, não bloqueia o fluxo chamador.
 * Não altera status da installation. Não chama pushJob.
 *
 * @param installationId  ID da installation que está sendo finalizada
 * @param vehicleId       vehicle_id já resolvido pelo chamador (não pode ser null)
 * @param vehicleSettingId vehicle_setting_id da installation
 * @param clientId        client_id da installation
 * @param clientName      nome do cliente (fallback: clientId)
 * @param comment         comentário opcional (fallback: data + "MAINT_NO_SWAP")
 */
export function enqueueSilentSB(
  installationId: string,
  vehicleId: string | null | undefined,
  vehicleSettingId: number | null | undefined,
  clientId: string | null | undefined,
  clientName?: string | null,
  comment?: string | null
): void {
  try {
    if (!vehicleId || !vehicleSettingId || !clientId) {
      console.log(
        `[SILENT_SB_V1] skip — campos insuficientes installation=${installationId}`,
        { vehicleId, vehicleSettingId, clientId }
      );
      return;
    }

    const _clientName = clientName ?? clientId;

    let _comment = comment?.trim() ?? "";
    if (!_comment) {
      try {
        const d = new Date();
        _comment = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} MAINT_NO_SWAP`;
      } catch {
        _comment = "MAINT_NO_SWAP";
      }
    }

    const job = createJob("scheme_builder", {
      installation_id: installationId,
      service: "MAINT_NO_SWAP",
      silent: true,           // flag de rastreabilidade — não altera comportamento do worker
      clientId,
      clientName: _clientName,
      vehicleId,
      vehicleSettingId,
      comment: _comment,
    });

    console.log(
      `[SILENT_SB_V1] job enfileirado job=${job.id} installation=${installationId}`,
      { vehicleId, vehicleSettingId, clientId }
    );
  } catch (e: any) {
    // silencioso: nunca propagar erro para não afetar o fluxo principal
    console.error(
      `[SILENT_SB_V1] erro ao enfileirar installation=${installationId}:`,
      e?.message ?? String(e)
    );
  }
}
