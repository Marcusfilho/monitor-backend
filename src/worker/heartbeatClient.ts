export type HeartbeatPayload = {
  worker_id: string;
  ts?: string;
  status?: string;
  job?: { id?: string | null; type?: string | null };
  checks?: Record<string, boolean>;
  last_error?: { code?: string; message?: string; at?: string };
  meta?: Record<string, any>;
};

export function startHeartbeat(opts: {
  baseUrl: string;
  workerId: string;
  workerKey: string;
  intervalMs?: number;
  getState?: () => Omit<HeartbeatPayload, "worker_id">;
}) {
  const intervalMs = opts.intervalMs ?? 30000;

  if (!opts.baseUrl) throw new Error("HB: missing BASE_URL");
  if (!opts.workerKey) throw new Error("HB: missing WORKER_KEY");

  async function sendOnce() {
    const payload: HeartbeatPayload = {
      worker_id: opts.workerId || "worker",
      ts: new Date().toISOString(),
      ...(opts.getState ? opts.getState() : { status: "running", checks: { backend_ok: true } }),
    };

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);

    try {
      const r = await fetch(`${opts.baseUrl}/api/worker/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-key": opts.workerKey,
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });

      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.error("[hb] http", r.status, txt.slice(0, 200));
      }
    } catch (e: any) {
      console.error("[hb] fail:", e?.message || e);
    } finally {
      clearTimeout(t);
    }
  }

  // start now + interval
  sendOnce().catch(() => {});
  return setInterval(() => sendOnce().catch(() => {}), intervalMs);
}
