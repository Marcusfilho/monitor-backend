// src/routes/jobRoutes.ts
import { Router, Request, Response } from "express";
import { createJob, getNextJob, completeJob, getJob, listJobs } from "../jobs/jobStore";
import { getSessionToken } from "../services/sessionTokenStore";

const router = Router();

// === PIPELINE_AUTO_SB_V1 (encadear Monitor após HTML5 sem workaround) ===
// Nota: services/* vivem em dist/ (JS). Em dev (ts-node), esse require pode falhar — por isso é best-effort.
const installationsStore: any = (() => { try { return require("../services/installationsStore"); } catch { return null; } })();
const catalogs: any = (() => { try { return require("../services/catalogs"); } catch { return null; } })();

function _num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function _upper(v: any): string { return String(v || "").trim().toUpperCase(); }
function _getInstallationId(job: any): string | null {
  const id = job?.payload?.installation_id ?? job?.payload?.installationId ?? null;
  return id ? String(id) : null;
}
function _resultOk(result: any): boolean {
  if (!result || typeof result !== "object") return false;
  if ((result as any).ok === true) return true;
  const st = String((result as any).status || "").toLowerCase();
  return st === "ok" || st === "success" || st === "done" || st === "completed";
}
function _pickVehicleId(job: any, result: any): number | null {
  const meta = (result && typeof result === "object") ? (result as any).meta : null;
  return _num(meta?.vehicle_id ?? meta?.VEHICLE_ID ?? (result as any)?.vehicle_id ?? (result as any)?.VEHICLE_ID);
}
function _pickClientId(inst: any, job: any, result: any): number | null {
  return _num(
    inst?.payload?.target_client_id ??
    job?.payload?.target_client_id ??
    inst?.payload?.client_id ??
    job?.payload?.client_id ??
    ((result as any)?.meta ? (result as any).meta.target_client_id : null)
  );
}
function _pickVehicleSettingId(inst: any, job: any, result: any): number | null {
  const meta = (result as any)?.meta || null;
  return _num(
    meta?.vehicleSettingId ??
    meta?.vehicle_setting_id ??
    inst?.payload?.vehicleSettingId ??
    inst?.payload?.vehicle_setting_id ??
    job?.payload?.vehicleSettingId ??
    job?.payload?.vehicle_setting_id
  );
}
function _alreadyHasSb(installationId: string): boolean {
  try {
    return listJobs().some((j: any) =>
      j?.type === "scheme_builder" &&
      String(j?.payload?.installation_id ?? j?.payload?.installationId ?? "") === String(installationId) &&
      j?.status !== "error"
    );
  } catch { return false; }
}
function _enqueueSchemeBuilderAfterHtml5(job: any, result: any) {
  try {
    if (!job || String(job.type || "") !== "html5_install") return;
    if (!_resultOk(result)) return;

    const installationId = _getInstallationId(job);
    if (!installationId) return;

    const service = _upper(job?.payload?.service ?? job?.payload?.servico);
    if (!service) return;

    const mskip = (result as any)?.meta ? (result as any).meta.monitor_skip : null;
    if (mskip === 1 || mskip === "1" || mskip === true) return;

    if (!["INSTALL","MAINT_NO_SWAP","MAINT_WITH_SWAP"].includes(service)) return;
    if (_alreadyHasSb(installationId)) return;

    const inst = installationsStore?.getInstallation ? installationsStore.getInstallation(installationId) : null;

    const vehicleId = _pickVehicleId(job, result);
    const clientId = _pickClientId(inst, job, result);
    const vehicleSettingId = _pickVehicleSettingId(inst, job, result);

    if (vehicleId) { try { installationsStore?.setResolved && installationsStore.setResolved(installationId, { vehicle_id: vehicleId }); } catch {} }

    if (!vehicleId || !clientId || !vehicleSettingId) {
      try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "HTML5_DONE" }); } catch {}
      console.log(`[jobs] [PIPELINE] skip SB: missing fields installation=${installationId} service=${service} vehicleId=${vehicleId} clientId=${clientId} vehicleSettingId=${vehicleSettingId}`);
      return;
    }

    const c = catalogs?.getClient ? catalogs.getClient(clientId) : null;
    const clientName = String((c && c.clientName) ? c.clientName : clientId);

    const sb = createJob("scheme_builder", {
      installation_id: installationId,
      service,
      clientId: String(clientId),
      clientName,
      vehicleId: String(vehicleId),
      vehicleSettingId: Number(vehicleSettingId),
      comment: `APP ${service} inst=${installationId}`
    });

    try { installationsStore?.pushJob && installationsStore.pushJob(installationId, { type: "scheme_builder", job_id: sb.id, status: "queued" }); } catch {}
    try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "SB_QUEUED" }); } catch {}

    console.log(`[jobs] [PIPELINE] enqueued scheme_builder job=${sb.id} installation=${installationId} vehicleId=${vehicleId} vehicleSettingId=${vehicleSettingId}`);
  } catch (e: any) {
    console.log("[jobs] [PIPELINE] enqueue SB failed:", e && (e.message || String(e)));
  }
}
// === /PIPELINE_AUTO_SB_V1 ===


/** POST /api/jobs */
router.post("/", (req: Request, res: Response) => {
  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: "Field 'type' is required" });
  const job = createJob(type, payload);
  return res.status(201).json({ job });
});

/** GET /api/jobs/next?type=scheme_builder&worker=vm-worker-01 */
router.get("/next", (req: Request, res: Response) => {
  const type = (req.query.type as string) || "";
  const workerId = (req.query.worker as string) || "unknown-worker";
  if (!type) return res.status(400).json({ error: "Query param 'type' is required" });

  // ✅ HTML5 jobs não dependem de session token (são server-to-server via HTML5 cookie-jar)
  const typeLc = String(type).toLowerCase();
  const isHtml5 = typeLc.startsWith("html5_");
  const isSchemeBuilder = typeLc === "scheme_builder";

  if (!isHtml5) {
    // ✅ scheme_builder não depende de token global no Render (worker faz user_login local)
    // ✅ demais tipos mantêm o gating atual
    const token = (getSessionToken() || "").trim();
    if (!isSchemeBuilder) {
      if (!token) return res.status(503).json({ error: "missing session token (set via /api/admin/session-token)" });
    }

    const job = getNextJob(type, workerId);
    if (!job) return res.status(204).send();

    // ✅ injeta token apenas na resposta
    const out: any = JSON.parse(JSON.stringify(job));
    out.payload = out.payload || {};
    if (token) out.payload.sessionToken = token;

    return res.json({ job: out });
  }

  // ✅ HTML5: não injeta token
  const job = getNextJob(type, workerId);
  if (!job) return res.status(204).send();
  return res.json({ job });
});


/** POST /api/jobs/:id/complete */
// POST /api/jobs/:id/progress  body: { percent: 0..100, stage?: string, detail?: string }
// POST /api/jobs/:id/progress  body: { percent: 0..100, stage?: string, detail?: string }
router.post("/:id/progress", (req, res) => {
  const jobId = String((req as any).params?.id || "");
  const id = jobId; // compat: alguns lookups usam "id"
  const body = (req as any).body || {};

  const p = Number(body.percent);
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    return res.status(400).json({ error: "percent must be 0..100" });
  }

  const job = getJob(id);
  if (!job) return res.status(404).json({ error: "job not found" });

  (job as any).progressPercent = Math.round(p);
  (job as any).progressStage = (typeof body.stage === "string") ? body.stage : null;
  (job as any).progressDetail = (typeof body.detail === "string") ? body.detail : null;
  (job as any).lastProgressAt = new Date().toISOString();

  return res.json({ ok: true });
});
router.post("/:id/complete", (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, result, workerId } = req.body || {};
  if (!status) return res.status(400).json({ error: "Field 'status' is required" });

  const rawStatus = String(status || "").toLowerCase();

// worker pode mandar status=success; também aceitamos done/completed/complete.
// além disso, se result.ok === true, consideramos completed.
const okFlag =
  rawStatus === "ok" ||
  rawStatus === "success" ||
  rawStatus === "done" ||
  rawStatus === "completed" ||
  rawStatus === "complete" ||
  ((req.body as any)?.ok === true) ||
  ((result as any)?.ok === true);

const finalStatus = okFlag ? "completed" : "error";
  const job = completeJob(id, finalStatus, result, workerId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  // dispara encadeamento para Monitor (SB) após HTML5
  if (finalStatus === "completed") {
    _enqueueSchemeBuilderAfterHtml5(job, result);
  }

  return res.json({ job });
});

router.get("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const job = getJob(id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json({ job });
});

router.get("/", (_req: Request, res: Response) => res.json({ jobs: listJobs() }));

export default router;
