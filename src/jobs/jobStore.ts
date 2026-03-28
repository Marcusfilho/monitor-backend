import crypto from "crypto";
import fs from "fs";
import path from "path";

export type JobStatus = "pending" | "processing" | "completed" | "error" | "cancelled";

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
// Objetivo: evitar perder jobs em caso de restart do processo (Render), mantendo em arquivo.
// Observação: não substitui um DB/queue real; é um "best effort" para a fase V1.
const STORE_PATH = process.env.JOBS_STORE_PATH || "/tmp/jobs_store.json";
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
        status: (String(j.status || "pending") as any),
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
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2), "utf8");
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

  if (!type) {
    throw new Error("missing_type");
  }

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

export function getNextJob(
  type: string,
  workerId: string
): BaseJob | null {
  loadOnce();
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
export function getJob(id: string): BaseJob | null {
  loadOnce();
  return jobs.find((j) => j.id === id) || null;
}

export function listJobs() {
  loadOnce();
  return jobs;
}
