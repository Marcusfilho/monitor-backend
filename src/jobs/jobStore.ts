import crypto from "crypto";

export type JobStatus = "pending" | "processing" | "completed" | "error";

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

const jobs: BaseJob[] = [];

function generateId() {
  return crypto.randomBytes(8).toString("hex");
}

export function createJob<TPayload = any>(
  type: string,
  payload: TPayload
): BaseJob<TPayload> {
  const now = new Date().toISOString();
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
  return job;
}

export function getNextJob(
  type: string,
  workerId: string
): BaseJob | null {
  const job = jobs.find((j) => j.type === type && j.status === "pending");
  if (!job) return null;

  job.status = "processing";
  job.workerId = workerId;
  job.updatedAt = new Date().toISOString();
  return job;
}

export function completeJob<TResult = any>(
  id: string,
  status: JobStatus,
  result: TResult,
  workerId?: string
): BaseJob | null {
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;

  job.status = status;
  job.result = result;
  job.updatedAt = new Date().toISOString();
  if (workerId) job.workerId = workerId;
  return job;
}

export function getJob(id: string): BaseJob | null {
  return jobs.find((j) => j.id === id) || null;
}

export function listJobs() {
  return jobs;
}
