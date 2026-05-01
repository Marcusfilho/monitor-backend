// src/services/maintNoSwapSbService.ts
// SILENT_SB_V1 — Dispara Scheme Builder silencioso ao final de MAINT_NO_SWAP.
// Não exibe nenhum feedback no app. Processado pelo schemeBuilderWorker existente.

import { createJob } from "../jobs/jobStore";

/**
 * Extrai campos necessários para o SB a partir da installation.
 * Tenta múltiplos caminhos defensivamente (payload, resolved, raiz).
 */
function extractSbParams(inst: any): {
  clientId: string | null;
  clientName: string | null;
  vehicleId: string | null;
  vehicleSettingId: number | null;
  comment: string;
} {
  const p = inst?.payload ?? {};
  const r = inst?.resolved ?? {};

  const clientId         = String(p.clientId         ?? p.client_id         ?? r.clientId         ?? r.client_id         ?? "").trim() || null;
  const clientName       = String(p.clientName       ?? p.client_name       ?? r.clientName       ?? r.client_name       ?? clientId ?? "").trim() || null;
  const vehicleId        = String(p.vehicleId        ?? p.vehicle_id        ?? r.vehicleId        ?? r.vehicle_id        ?? "").trim() || null;
  const vsRaw            =        p.vehicleSettingId ?? p.vehicle_setting_id ?? r.vehicleSettingId ?? r.vehicle_setting_id ?? null;
  const vehicleSettingId = vsRaw != null ? Number(vsRaw) : null;

  let comment = String(p.comment ?? "").trim();
  if (!comment) {
    try {
      const d = new Date();
      comment = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} MAINT_NO_SWAP`;
    } catch { comment = "MAINT_NO_SWAP"; }
  }

  return { clientId, clientName, vehicleId, vehicleSettingId, comment };
}

/**
 * Enfileira um job scheme_builder silencioso para MAINT_NO_SWAP.
 * Fire-and-forget: não lança exceção, não bloqueia o fluxo chamador.
 *
 * @param installationId  ID da installation que está sendo finalizada
 * @param inst            Objeto installation completo (para extrair campos)
 */
export function enqueueSilentSB(installationId: string, inst: any): void {
  try {
    const { clientId, clientName, vehicleId, vehicleSettingId, comment } = extractSbParams(inst);

    if (!vehicleId || !vehicleSettingId || !clientId) {
      console.log(
        `[SILENT_SB_V1] skip — campos insuficientes installation=${installationId}`,
        { vehicleId, vehicleSettingId, clientId }
      );
      return;
    }

    const job = createJob("scheme_builder", {
      installation_id: installationId,
      service: "MAINT_NO_SWAP",
      silent: true,
      clientId,
      clientName,
      vehicleId,
      vehicleSettingId,
      comment,
    });

    console.log(
      `[SILENT_SB_V1] job enfileirado job=${job.id} installation=${installationId}`,
      { vehicleId, vehicleSettingId, clientId }
    );
  } catch (e: any) {
    // silencioso: nunca propagar erro para não afetar o fluxo principal
    console.error(`[SILENT_SB_V1] erro ao enfileirar installation=${installationId}:`, e?.message ?? String(e));
  }
}
