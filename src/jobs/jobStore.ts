import crypto from "crypto";
import fs from "fs";
import path from "path";

// waiting_approval/approved são estados do pipeline de instalação (CAN aguardando
// o técnico validar / raiz liberada pelo approve-can). Ficavam fora do union e
// gravados com `as any`, então nenhum switch era cobrado pelo compilador a
// fechá-los — foi assim que 61 jobs travaram nesses dois estados.
export type JobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "error"
  | "cancelled"
  | "waiting_approval"
  | "approved";

export interface BaseJob<TPayload = any, TResult = any> {
  id: string;
  type: string;
  status: JobStatus;
  payload: TPayload;
  result?: TResult;
  workerId?: string | null;
  createdAt: string;
  updatedAt: string;
}

// === PERSIST_JOBS_V1 ===
// Path separado do monolito para não colidir com monitor-backend-dev.
// Default em data/ (junto do monitor.db) e não em /tmp: o histórico de jobs não
// pode sumir num reboot da VM.
const STORE_PATH =
  process.env.JOBS_STORE_PATH || path.resolve(__dirname, "../../data/jobs_store_rw.json");
let jobs: BaseJob[] = [];
let loaded = false;

function safeParseJobs(raw: string): BaseJob[] {
  try {
    const data = JSON.parse(String(raw || "").trim() || "null");
    if (!Array.isArray(data)) return [];
    return data
      .filter((j: any) => j && typeof j === "object")
      .map((j: any) => ({
        id: String(j.id || ""),
        type: String(j.type || ""),
        status: (String(j.status || "pending") as JobStatus),
        payload: j.payload,
        result: j.result,
        workerId: (j.workerId == null ? null : String(j.workerId)),
        createdAt: String(j.createdAt || new Date().toISOString()),
        updatedAt: String(j.updatedAt || new Date().toISOString()),
      }))
      .filter((j: any) => j.id && j.type);
  } catch {
    return [];
  }
}

function loadOnce() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, "utf8");
      jobs = safeParseJobs(raw);
    }
  } catch {
    jobs = jobs || [];
  }
}

function save() {
  try {
    const dir = path.dirname(STORE_PATH);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${STORE_PATH}.tmp`;
    // Sem indentação: `save()` é síncrono e reescreve o store INTEIRO em toda
    // mutação (createJob/getNextJob/updateJob/completeJob + um updateJob por frame
    // parcial do CAN), bloqueando o event loop que atende o poll de 2s do app e o
    // /api/jobs/next dos workers. O pretty-print custava 40% do arquivo.
    fs.writeFileSync(tmp, JSON.stringify(jobs), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch {
    // best effort
  }
}
// === /PERSIST_JOBS_V1 ===

function generateId() {
  return crypto.randomBytes(8).toString("hex");
}

export function createJob<TPayload = any>(type: string, payload: TPayload): BaseJob<TPayload>;
export function createJob<TPayload = any>(job: { type: string; payload: TPayload }): BaseJob<TPayload>;
export function createJob<TPayload = any>(typeOrJob: any, maybePayload?: TPayload): BaseJob<TPayload> {
  loadOnce();
  const now = new Date().toISOString();

  let type: string;
  let payload: any;

  if (typeOrJob && typeof typeOrJob === "object") {
    type = String(typeOrJob.type || "").trim();
    payload = typeOrJob.payload;
  } else {
    type = String(typeOrJob || "").trim();
    payload = maybePayload;
  }

  if (!type) throw new Error("missing_type");

  const job: BaseJob<TPayload> = {
    id: generateId(),
    type,
    status: "pending",
    payload,
    workerId: null,
    createdAt: now,
    updatedAt: now,
  };
  jobs.push(job);
  save();
  return job;
}

export function getNextJob(type: string, workerId: string): BaseJob | null {
  loadOnce();
  // SB_CLIENT_SERIALIZE_V1 removido (03/08): o SB do mesmo client_id era encadeado
  // no despacho por causa do slot de review por client_id. A internal-tools roda o
  // mesmo fluxo (startSettings → associate/review/execute) sem serialização, com o
  // Bench Setup disparando até 30 SB simultâneos do mesmo cliente em produção — o
  // slot só é disputado nos ~3s entre associate e execute_action_opr, não durante o
  // push-wait. Colisão residual é coberta pelo retry de fluxo completo do worker.
  const job = jobs.find((j) => j.type === type && j.status === "pending");
  if (!job) return null;
  job.status = "processing";
  job.workerId = workerId;
  job.updatedAt = new Date().toISOString();
  save();
  return job;
}

export function completeJob<TResult = any>(
  id: string,
  status: JobStatus,
  result: TResult,
  workerId?: string
): BaseJob | null {
  loadOnce();
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;
  job.status = status;
  job.result = result;
  job.updatedAt = new Date().toISOString();
  if (workerId) job.workerId = workerId;
  save();
  return job;
}

export function updateJob(id: string, patch: Partial<BaseJob>): BaseJob | null {
  loadOnce();
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;
  Object.assign(job, patch);
  job.updatedAt = new Date().toISOString();
  save();
  return job;
}

// === ORPHAN_RECLAIM_V1 ===
// Jobs em `processing` cujo worker morreu (restart) ou travou ficam presos para
// sempre — getNextJob só pega `pending`. Reseta para `pending` os que estão em
// `processing` há mais de ORPHAN_TIMEOUT_MS sem atualização de updatedAt.
// Só toca `processing`: waiting_approval/completed/etc. são preservados.
const ORPHAN_TIMEOUT_MS = 10 * 60 * 1000; // 10min

export function reclaimOrphans(timeoutMs = ORPHAN_TIMEOUT_MS): number {
  loadOnce();
  const cutoff = Date.now() - timeoutMs;
  let n = 0;
  for (const j of jobs) {
    if (j.status !== "processing") continue;
    const ts = Date.parse(j.updatedAt);
    if (!Number.isFinite(ts) || ts < cutoff) {
      j.status = "pending";
      j.workerId = null;
      j.updatedAt = new Date().toISOString();
      n++;
    }
  }
  if (n) save();
  return n;
}
// === /ORPHAN_RECLAIM_V1 ===

// === APPROVAL_TIMEOUT_V1 ===
// `waiting_approval` não tinha nenhuma saída automática: aprovação que o técnico
// nunca faz mantinha o job aberto para sempre (reclaimOrphans, acima, só toca
// `processing` — de propósito). Vira `error`, que é o único estado aceito pelo
// retry (jobRoutes/adminRoutes) — logo o job continua recuperável, não sumido.
// O `result` é preservado: o snapshot serve de diagnóstico para o admin.
const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS) || 12 * 60 * 60 * 1000; // 12h

export function expireStaleApprovals(timeoutMs = APPROVAL_TIMEOUT_MS): number {
  loadOnce();
  const cutoff = Date.now() - timeoutMs;
  let n = 0;
  for (const j of jobs) {
    if (j.status !== "waiting_approval") continue;
    const ts = Date.parse(j.updatedAt);
    if (!Number.isFinite(ts) || ts < cutoff) {
      j.status = "error";
      j.result = { ...(j.result ?? {}), ok: false, reason: "approval_timeout" };
      j.updatedAt = new Date().toISOString();
      n++;
    }
  }
  if (n) save();
  return n;
}
// === /APPROVAL_TIMEOUT_V1 ===

// === SNAPSHOT_PRUNE_V1 ===
// O store é fila operacional, não arquivo histórico: o snapshot CAN tem guarda
// permanente no SQLite (data/monitor.db) desde 28/07, e o retryPending do export
// lê de lá, não daqui. No store ele aparece 3× por instalação
// (monitor_can_snapshot.result.snapshot + gs_calibration.payload.can +
// save_snapshot.payload.can) e responde por ~90% do arquivo — que o save() acima
// reescreve inteiro a cada mutação. Limpar só o snapshot dos jobs já terminais
// mantém a linha (cadeia, placa, status, timestamps, erros) para o painel da
// internal-tools.
//
// Três travas: (1) `waiting_approval` nunca é tocado — o técnico valida horas
// depois e o snapshot é o que ele vê na tela; (2) a janela de 24h protege o
// approve-can e o refresh-can, que leem `canJob.result.snapshot`; (3) `error`
// fica de fora — uma coleta que falhou nunca chegou ao save_snapshot, então o
// store é a ÚNICA cópia, e o expireStaleApprovals preserva o result de propósito
// para diagnóstico. Custa 4% do ganho.
const SNAPSHOT_PRUNE_AGE_MS = Number(process.env.SNAPSHOT_PRUNE_AGE_MS) || 24 * 60 * 60 * 1000; // 24h

export function pruneSnapshots(maxAgeMs = SNAPSHOT_PRUNE_AGE_MS): number {
  loadOnce();
  const cutoff = Date.now() - maxAgeMs;
  let n = 0;
  for (const j of jobs) {
    if (j.status !== "completed" && j.status !== "cancelled") continue;
    const ts = Date.parse(j.updatedAt);
    if (Number.isFinite(ts) && ts >= cutoff) continue;
    let hit = false;
    if (j.payload?.can != null) { j.payload.can = null; hit = true; }
    if (j.result?.snapshot != null) { j.result.snapshot = null; hit = true; }
    if (hit) n++;
  }
  if (n) save();
  return n;
}
// === /SNAPSHOT_PRUNE_V1 ===

export function getJob(id: string): BaseJob | null {
  loadOnce();
  return jobs.find((j) => j.id === id) || null;
}

export function listJobs(): BaseJob[] {
  loadOnce();
  return jobs;
}
