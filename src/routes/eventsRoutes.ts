/**
 * eventsRoutes.ts — SSE endpoint para fase CAN
 *
 * GET /events/:jobId
 *   - Abre stream text/event-stream
 *   - Faz polling do jobStore a cada 3s
 *   - Só escreve no stream se dados mudaram
 *   - Encerra com event: stopped quando as regras de parada são atingidas
 *
 * Regras de parada:
 *   - ignição ligada + todos os parâmetros principais presentes → reason: complete
 *   - 5 min elapsed → reason: timeout
 *   - POST /jobs/:jobId/can-refresh recebido → reinicia o timer por mais 5 min
 *   - POST /jobs/:jobId/validate recebido → encerra definitivamente → reason: validated
 */

import { Router, Request, Response } from "express";
import { getJob } from "../jobs/jobStore";
import type { VmSnapshot } from "../core/vehicleMonitorSnapshotService";

const router = Router();

const POLL_MS  = 3000;
const FIVE_MIN = 5 * 60 * 1000;

// ─── Parâmetros obrigatórios para considerar CAN "completo" ──────────────────
// Ajuste esta lista conforme os IDs reais do seu ambiente
const REQUIRED_PARAM_IDS = new Set([
  "00002719", // engine_total_fuel_used (SYS)
  "00002717", // fuel_level_1 (SYS)
  "00002718", // engine_fuel_rate (SYS)
  "00002714", // sys_param_vehicle_distance
  "00002715", // rpm (SYS)
]);

const REQUIRED_MODULE_COUNT = 5;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hasDriverCode(snapshot: VmSnapshot): boolean {
  const dc = snapshot.header?.driver_code;
  return dc != null && String(dc).trim() !== "";
}

function hasRequiredParams(snapshot: VmSnapshot): boolean {
  const presentIds = new Set(
    snapshot.parameters
      .filter(p => (p.raw_value ?? "") !== "")
      .map(p => p.id.toUpperCase())
  );
  for (const id of REQUIRED_PARAM_IDS) {
    if (!presentIds.has(id.toUpperCase())) return false;
  }
  return true;
}

function hasRequiredModules(snapshot: VmSnapshot): boolean {
  return snapshot.moduleState.length >= REQUIRED_MODULE_COUNT;
}

function isIgnitionOn(snapshot: VmSnapshot): boolean {
  // isConnected = 1 indica ignição ligada no Traffilog
  return snapshot.isConnected === 1;
}

function isCanComplete(snapshot: VmSnapshot): boolean {
  return (
    isIgnitionOn(snapshot) &&
    hasDriverCode(snapshot) &&
    hasRequiredParams(snapshot) &&
    hasRequiredModules(snapshot)
  );
}

interface StopResult {
  stop: boolean;
  reason?: string;
}

function shouldStop(snapshot: VmSnapshot | null, startTime: number): StopResult {
  const elapsed = Date.now() - startTime;

  if (!snapshot) {
    if (elapsed >= FIVE_MIN) return { stop: true, reason: "timeout" };
    return { stop: false };
  }

  if (isCanComplete(snapshot)) return { stop: true, reason: "complete" };
  if (elapsed >= FIVE_MIN)     return { stop: true, reason: "timeout" };

  return { stop: false };
}

// ─── Estado de can-refresh por jobId ─────────────────────────────────────────
// Armazena o timestamp de início vigente para cada job (resetado pelo can-refresh)
const jobStartTimes = new Map<string, number>();

// ─── GET /events/:jobId ───────────────────────────────────────────────────────

router.get("/:jobId", (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);

  // Headers SSE obrigatórios
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  // Inicializa (ou reutiliza) o startTime deste job
  if (!jobStartTimes.has(jobId)) {
    jobStartTimes.set(jobId, Date.now());
  }

  let lastPayload = "";
  let stopped     = false;

  function sendData(data: object) {
    if (stopped) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function sendStopped(reason: string) {
    if (stopped) return;
    stopped = true;
    res.write(`event: stopped\ndata: ${JSON.stringify({ reason })}\n\n`);
    res.end();
    clearInterval(timer);
    jobStartTimes.delete(jobId);
  }

  const timer = setInterval(() => {
    const job = getJob(jobId);

    if (!job) {
      sendStopped("job_not_found");
      return;
    }

    // Aceita snapshot parcial (durante coleta) ou final (job completo)
    const snapshot: VmSnapshot | null =
      job.result?.snapshot ?? null;
    const isPartial: boolean = job.result?.partial === true;

    const startTime = jobStartTimes.get(jobId) ?? Date.now();
    const stop      = shouldStop(snapshot, startTime);

    if (snapshot) {
      // Envia só se houve mudança (evita flood de dados iguais)
      const payload = JSON.stringify(snapshot);
      if (payload !== lastPayload) {
        lastPayload = payload;
        sendData({ ...snapshot, _partial: isPartial });
      }
    }

    if (stop.stop) {
      sendStopped(stop.reason!);
    }
  }, POLL_MS);

  // Limpa ao fechar conexão (browser fechou a aba, etc.)
  req.on("close", () => {
    stopped = true;
    clearInterval(timer);
  });
});

export default router;
