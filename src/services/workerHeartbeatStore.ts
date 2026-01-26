export type WorkerHeartbeat = {
  worker_id: string;
  ts: string;
  status?: string;
  job?: { id?: string | null; type?: string | null };
  checks?: Record<string, boolean>;
  last_error?: { code?: string; message?: string; at?: string };
  meta?: Record<string, any>;
};

const hbByWorker = new Map<string, WorkerHeartbeat>();

export function upsertHeartbeat(hb: WorkerHeartbeat) {
  hbByWorker.set(hb.worker_id, hb);
}

export function getAllHeartbeats() {
  return Array.from(hbByWorker.values()).sort((a, b) => (a.worker_id > b.worker_id ? 1 : -1));
}
