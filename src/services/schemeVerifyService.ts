// src/services/schemeVerifyService.ts
// SB_VERIFY_V1 — conferência interna do scheme atribuído no Traffilog.
//
// Roda como sweep periódico no processo principal, DEPOIS que o serviço já terminou
// (a linha do snapshot só existe após o save_snapshot, último passo do pipeline).
// O técnico não vê, não espera e não é notificado — é diagnóstico + reparo interno.
//
// Lê ASSIGNED_VEHICLE_SETTING_ID via MWS (HTTP) e compara com o scheme pretendido.
// Divergência → reenfileira o scheme_builder silenciosamente.
//
// Limite conhecido: MWS prova ATRIBUIÇÃO no servidor, não que o equipamento carregou.
// O caso device-side (completed_no_push) exigiria o WS get_client_vehicles_opr
// (loaded_setting_name vs assigned_setting_name), como faz o Ops Console.

import { configFromEnv, ensureHtml5Session } from "../core/html5Session.js";
import { mwsLoadBaseline } from "../core/mwsService.js";
import { getSelectedSchemeId } from "./schemeSelectionService.js";
import { listUnverifiedForSchemeCheck, markSchemeVerified } from "./snapshotStore.js";
import { createJob } from "../jobs/jobStore.js";

const ENABLED  = (process.env.SB_VERIFY_ENABLED || "1").trim() !== "0";
const DRY_RUN  = (process.env.SB_VERIFY_DRY_RUN || "1").trim() !== "0";
const MAX_AGE_H = Number(process.env.SB_VERIFY_MAX_AGE_H || 24);
const LIMIT     = Number(process.env.SB_VERIFY_LIMIT     || 20);

/**
 * Verifica uma linha de snapshot. Não lança — falha vira veredito 'unknown'.
 */
async function verifyRow(cfg: any, row: any): Promise<void> {
  // Mesma precedência do SKIP_SB_V1 (installWorker.ts:480): o scheme do cliente é a
  // fonte autoritativa — o vehicle_setting_id da linha é o que o job carregou na época
  // e envelhece quando o cliente troca de scheme (visto no 219002: linhas com 5680,
  // config e servidor já em 5681 desde 28/07).
  const target = String(getSelectedSchemeId(row.client_id) ?? "").trim()
              || String(row.vehicle_setting_id || "").trim();

  let assigned = "";
  try {
    const baseline = await mwsLoadBaseline(cfg, row.vehicle_id, `sbverify_${row.id}`);
    assigned = String(baseline.fields.ASSIGNED_VEHICLE_SETTING_ID || "").trim();
  } catch (e: any) {
    console.log(`[sb-verify] id=${row.id} veh=${row.vehicle_id} MWS falhou: ${e?.message || e}`);
  }

  let verdict = "unknown";
  if (assigned && target) verdict = assigned === target ? "ok" : "mismatch";

  // Só reenvia com alvo inequívoco — 'unknown' nunca escreve no Traffilog.
  let resendJobId: string | null = null;
  if (verdict === "mismatch" && !DRY_RUN) {
    // _terminal: true é obrigatório — sem ele o dispatchPipeline cascateia para
    // monitor_can_snapshot e ressuscita uma instalação na tela do técnico.
    const job = createJob("scheme_builder", {
      service            : row.service,
      client_id          : row.client_id,
      client_descr       : row.client_descr,
      vehicle_id         : row.vehicle_id,
      vehicle_setting_id : target,
      plate_real         : row.plate,
      comment            : "SB_VERIFY_RESEND",
      _terminal          : true,
    });
    resendJobId = job.id;
  }

  markSchemeVerified(row.id, {
    verdict,
    assignedSettingId: assigned ? Number(assigned) : null,
    resendJobId,
  });

  console.log(
    `[sb-verify] id=${row.id} veh=${row.vehicle_id} plate=${row.plate}` +
    ` assigned=${assigned || "-"} target=${target || "-"} verdict=${verdict}` +
    (verdict === "mismatch" ? (DRY_RUN ? " (DRY_RUN — sem reenvio)" : ` reenviado job=${resendJobId}`) : "")
  );
}

/**
 * Um ciclo do sweep. Sequencial e limitado — no regime real (2-5 serviços/dia)
 * cada tick faz zero ou uma chamada MWS.
 */
export async function sweepSchemeVerify(): Promise<void> {
  if (!ENABLED) return;

  let rows: any[] = [];
  try {
    rows = listUnverifiedForSchemeCheck(LIMIT, MAX_AGE_H);
  } catch (e: any) {
    console.error("[sb-verify] falha ao listar candidatos:", e?.message || e);
    return;
  }
  if (!rows.length) return;

  console.log(`[sb-verify] ${rows.length} linha(s) para conferir (dry_run=${DRY_RUN})`);

  const cfg = configFromEnv();
  try {
    await ensureHtml5Session(cfg, "SB_VERIFY");
  } catch (e: any) {
    console.error("[sb-verify] sessão HTML5 indisponível — adiando ciclo:", e?.message || e);
    return;
  }

  for (const row of rows) {
    try {
      await verifyRow(cfg, row);
    } catch (e: any) {
      console.error(`[sb-verify] id=${row.id} erro inesperado:`, e?.message || e);
    }
  }
}
