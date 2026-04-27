// src/routes/jobRoutes.ts
import { Router, Request, Response } from "express";
import { createJob, getNextJob, completeJob, getJob, listJobs, updateJob } from "../jobs/jobStore";
import { requireWorkerKey } from "../middleware/requireWorkerKey";
import { getSessionToken } from "../services/sessionTokenStore";


function pickCanSnapshotFromCompleteBody(root: any){
  const first = (v: any) => Array.isArray(v) && v.length ? v[0] : null;

  const candidates = [
    // root
    first(root?.snapshots),
    first(root?.can_snapshots),
    first(root?.canSnapshots),
    root?.snapshot,
    root?.bestSnapshot,
    root?.best_snapshot,

    // root.meta (IMPORTANT)
    root?.meta?.snapshot,
    root?.meta?.bestSnapshot,
    root?.meta?.best_snapshot,
    first(root?.meta?.snapshots),
    first(root?.meta?.can_snapshots),
    first(root?.meta?.canSnapshots),

    // nested root.result
    root?.result?.snapshot,
    first(root?.result?.snapshots),
    first(root?.result?.can_snapshots),
    first(root?.result?.canSnapshots),
    root?.result?.bestSnapshot,
    root?.result?.best_snapshot,

    // nested root.result.meta
    root?.result?.meta?.snapshot,
    root?.result?.meta?.bestSnapshot,
    root?.result?.meta?.best_snapshot,
    first(root?.result?.meta?.snapshots),
    first(root?.result?.meta?.can_snapshots),
    first(root?.result?.meta?.canSnapshots),
  ].filter(Boolean);

  const snap = candidates.length ? candidates[0] : null;
  return (snap && typeof snap === "object") ? snap : null;
}

// OPTC_UNWRAP_SNAPSHOT_V1: normaliza formatos diferentes de snapshot (progress/complete)
function unwrapSnapshot(x: any){
  if (!x) return null;
  const lastOf = (v: any) => Array.isArray(v) ? (v.length ? v[v.length-1] : null) : v;
  let cur: any = lastOf(x);
  for (let i=0;i<5;i++){
    if (!cur || typeof cur !== "object") break;
    if (Array.isArray(cur)) { cur = lastOf(cur); continue; }
    if ((cur as any).snapshot) { cur = (cur as any).snapshot; continue; }
    if ((cur as any).data) { cur = (cur as any).data; continue; }
    if ((cur as any).payload) { cur = (cur as any).payload; continue; }
    if ((cur as any).result) { cur = (cur as any).result; continue; }
    break;
  }
  const looks = (v: any) => !!(v && typeof v === "object" && ((v as any).counts || Array.isArray((v as any).parameters) || Array.isArray((v as any).moduleState)));
  let snap: any = looks(cur) ? cur : null;
  if (!snap) snap = pickCanSnapshotFromCompleteBody(cur) || pickCanSnapshotFromCompleteBody(x) || null;
  if (snap && typeof snap === "object"){
    if (!(snap as any).captured_at && !(snap as any).capturedAt) (snap as any).captured_at = new Date().toISOString();
  }
  return snap;
}



const router = Router();

// === PIPELINE_AUTO_SB_V1 (encadear Monitor após HTML5 sem workaround) ===
// Nota: services/* vivem em dist/ (JS). Em dev (ts-node), esse require pode falhar — por isso é best-effort.
function __pickInstallStore(mod: any){
  try {
    const cand = [mod, mod && mod.default, mod && mod.installationsStore, mod && mod.store, mod && mod.installations];
    for (const c of cand){
      if (!c || typeof c !== "object") continue;
      const gi = c.getInstallation || c.get || null;
      const pi = c.patchInstallation || c.updateInstallation || c.setInstallation || c.patch || null;
      if (typeof gi === "function" && typeof pi === "function"){
        if (!c.patchInstallation && c.updateInstallation) {
          try { c.patchInstallation = c.updateInstallation; } catch {}
        }
        return c;
      }
    }
  } catch {}
  return null;
}

const installationsStore: any = (() => {
  const paths = ["../services/installationsStore", "../services/installationsEngine"];
  for (const p of paths){
    try {
      const mod = require(p);
      const store = __pickInstallStore(mod);
      if (store) {
        console.log("[jobs] installationsStore OK via", p);
        return store;
      }
    } catch {}
  }
  console.log("[jobs] installationsStore INDISPONÍVEL — persist CAN snapshot DESLIGADO");
  return null;
})();

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
  if (st === "ok" || st === "success" || st === "done" || st === "completed") return true;
  // MAINT_WITH_SWAP: worker retorna result sem ok/status mas com flow+vehicle_id
  const flow = String((result as any).flow || "").toUpperCase();
  if (flow === "MAINT_WITH_SWAP" && (result as any).vehicle_id) return true;
  return false;
}
function _pickVehicleId(job: any, result: any): number | null {
  const meta = (result && typeof result === "object") ? (result as any).meta : null;
  return _num(
    meta?.vehicle_id ?? meta?.VEHICLE_ID ??
    (result as any)?.vehicle_id ?? (result as any)?.VEHICLE_ID ??
    job?.payload?.vehicle_id_final ?? job?.payload?.vehicle_id ?? job?.payload?.VEHICLE_ID ?? job?.payload?.vehicleId
  );
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

function _alreadyHasCan(installationId: string): boolean {
  try {
    return listJobs().some((j: any) =>
      j?.type === "monitor_can_snapshot" &&
      String(j?.payload?.installation_id ?? j?.payload?.installationId ?? "") === String(installationId) &&
      j?.status !== "error"
    );
  } catch { return false; }
}

function _alreadyHasGs(installationId: string): boolean {
  try {
    return listJobs().some((j: any) =>
      j?.type === "monitor_gs" &&
      String(j?.payload?.installation_id ?? j?.payload?.installationId ?? "") === String(installationId) &&
      j?.status !== "error"
    );
  } catch { return false; }
}
function _handleCanSnapshotComplete(job: any, result: any, jobId?: string) {
  try {
    if (!installationsStore?.getInstallation || !installationsStore?.patchInstallation) { console.log("[jobs] CAN snapshot: sem store/get+patch, skip persist"); return; }
    if (!job || String(job.type || "") !== "monitor_can_snapshot") return;

    const installationId = _getInstallationId(job);
    if (!installationId) return;

    const inst = installationsStore.getInstallation(installationId);
    if (!inst) return;

    const meta = (result && typeof result === "object") ? (result as any).meta : null;

    const can: any = (inst as any).can && typeof (inst as any).can === "object" ? (inst as any).can : {};
    const prev = Array.isArray(can.snapshots) ? can.snapshots : [];
    let incoming: any[] = [];

    if (meta) {
      if (Array.isArray((meta as any).snapshots)) incoming = (meta as any).snapshots;
      else if ((meta as any).snapshot != null) incoming = [(meta as any).snapshot];

      can.last_snapshot_at = new Date().toISOString();

      if ((meta as any).summary !== undefined) can.summary = (meta as any).summary;
      else can.summary = can.summary || meta || null;
    } else {
      can.summary = can.summary || null;
    }

    const merged = incoming.concat(prev).filter((v) => v != null);
    can.snapshots = merged.slice(0, 5);

    try {
      const __snap = pickCanSnapshotFromCompleteBody(result);
      const __summary = (__snap && __snap.counts) ? __snap.counts : null;

      
    const __hasData = !!(__snap && (
      (__snap.counts && (((__snap.counts.params_total||0)+(__snap.counts.module_total||0)+(__snap.counts.paramsTotal||0)+(__snap.counts.moduleTotal||0))>0)) ||
      ((Array.isArray(__snap.parameters)&&__snap.parameters.length) || (Array.isArray(__snap.module_state)&&__snap.module_state.length) || (Array.isArray(__snap.moduleState)&&__snap.moduleState.length))
    )); /*__READYFIX_V2__*/
const __canPatched = Object.assign({}, (can && typeof can === "object") ? can : {}, {
        snapshots: __snap ? [__snap] : ((can && can.snapshots) ? can.snapshots : []),
        summary: __summary || ((can && can.summary) ? can.summary : null),
        last_snapshot_at: (__snap && (__snap.captured_at || __snap.capturedAt)) || ((can && (can.last_snapshot_at || can.lastSnapshotAt)) ? (can.last_snapshot_at || can.lastSnapshotAt) : null),
      });

      installationsStore.patchInstallation(installationId, { can: __canPatched,
    can_snapshot_latest: (__snap || null),
    can_snapshot: (__hasData ? __snap : null), status: (__hasData ? "CAN_SNAPSHOT_READY" : "CAN_SNAPSHOT_ERROR") });
    } catch {}

    try {
      const metaSmall = meta && (meta as any).summary !== undefined ? (meta as any).summary : null;
      installationsStore.pushJob && installationsStore.pushJob(installationId, {
        type: "monitor_can_snapshot",
        job_id: String(jobId || job?.id || ""),
        status: "completed",
        ok: _resultOk(result),
        meta: metaSmall,
      });
    } catch {}
  } catch (e: any) {
    console.log("[jobs] handle CAN snapshot failed:", e && (e.message || String(e)));
  }
}



function _pickErrSummary(result: any){
  try {
    if (!result) return { message: "job_failed" };
    if (typeof result === "string") return { message: result };
    if (typeof result !== "object") return { message: String(result) };

    const r: any = result as any;
    const msg =
      r.error ??
      r.detail ??
      r.message ??
      r.reason ??
      (r.meta && (r.meta.error ?? r.meta.detail ?? r.meta.message)) ??
      null;

    const code =
      r.code ??
      r.statusCode ??
      r.httpStatus ??
      (r.meta && (r.meta.code ?? r.meta.statusCode)) ??
      null;

    const out: any = { message: String(msg || "job_failed") };
    if (code != null) out.code = String(code);
    const hint = r.hint ?? (r.meta && r.meta.hint) ?? null;
    if (hint != null) out.hint = String(hint).slice(0, 240);
    return out;
  } catch {
    return { message: "job_failed" };
  }
}

// quando o html5_* falhar, refletir no status da instalação (senão o app fica "CREATED" e confunde)
function _handleHtml5CompleteToInstallation(job: any, result: any, finalStatus: string, jobId: string){
  try {
    if (!installationsStore?.getInstallation || !installationsStore?.patchInstallation) return;
    const type = String(job?.type || "");
    if (!(type === "html5_install" || type.startsWith("html5_"))) return;

    const installationId = _getInstallationId(job);
    if (!installationId) return;

    const ok = String(finalStatus || "") === "completed";
    const now = new Date().toISOString();

    // histórico (best-effort)
    try {
      installationsStore.pushJob && installationsStore.pushJob(installationId, {
        type,
        job_id: String(jobId || job?.id || ""),
        status: ok ? "completed" : "error",
        ok,
        err: ok ? null : _pickErrSummary(result),
      });
    } catch {}

    if (ok) {
      // limpa erro anterior
      try { installationsStore.patchInstallation(installationId, { last_error: null }); } catch {}
      const __svc = _upper(job?.payload?.service ?? job?.payload?.servico);
      const __finalSt = (__svc === "UNINSTALL") ? "COMPLETED" : "HTML5_DONE";
      try { installationsStore.patchInstallation(installationId, { status: __finalSt }); } catch {} // FIX_UNINSTALL_STATUS_V1

      // SAVE_SNAPSHOT_V1: enfileira job para a VM gravar no SQLite
      try {
        const _inst = installationsStore.getInstallation(installationId);
        const _p    = _inst?.payload || {};
        createJob("save_snapshot", {
          installation_id:  installationId,
          service:          String(__svc || _p.service || "UNKNOWN"),
          plate_real:       _p.plate_real       ?? _p.plate        ?? null,
          serial:           _p.serial           ?? null,
          technician:       _p.technician?.nick ?? _p.technician?.id ?? _p.technicianName ?? null,
          clientId:         _p.target_client_id ?? _p.client_id    ?? null,
          clientName:       _p.clientName       ?? null,
          vehicleId:        _p.vehicle_id_final ?? _p.vehicleId    ?? null,
          vehicleSettingId: _p.vehicleSettingId ?? null,
          assetType:        _p.assetType        ?? null,
          vehicle:          _p.vehicle          ?? null,
          gsensor:          _p.gsensor          ?? null,
          comment:          _p.comment          ?? null,
          cor:              _p.cor              ?? null,
          chassi:           _p.chassi           ?? null,
          localInstalacao:  _p.localInstalacao  ?? null,
        });
        console.log("[jobs] [SAVE_SNAPSHOT_V1] job enfileirado installation=" + installationId + " service=" + __svc);
      } catch (_se: any) {
        console.error("[jobs] [SAVE_SNAPSHOT_V1] falha ao enfileirar job:", _se?.message || _se);
      }

      return;
    }

    const err = Object.assign(
      { ts: now, job_id: String(jobId || job?.id || ""), job_type: type },
      _pickErrSummary(result)
    );

    try {
      installationsStore.patchInstallation(installationId, {
        status: "HTML5_ERROR",
        last_error: err,
      });
    } catch {}
  } catch (e: any) {
    console.log("[jobs] handle HTML5 complete failed:", e && (e.message || String(e)));
  }
}

// =============================================================================
// SB_SKIP_V2: consulta GET_VHCL_ACTIVATION_DATA_NEW para ler o estado atual
// do veículo no Monitor (ASSIGNED_VEHICLE_SETTING_ID + ASSET_TYPE).
// Não precisa de cookie/sessão — endpoint público do HTML5.
// =============================================================================
const _HTML5_ACTION_URL_JR = (process.env.HTML5_ACTION_URL || "https://html5.traffilog.com/AppEngine_2_1/default.aspx").trim();
const _SB_SKIP_TIMEOUT_MS  = Number(process.env.SB_SKIP_TIMEOUT_MS || "8000");

function _readHtml5CookieHeader(): string {
  try {
    const fs = require("fs");
    const path = (process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json").trim();
    if (!fs.existsSync(path)) return "";
    const raw = fs.readFileSync(path, "utf8");
    if (!raw) return "";
    let j: any = null;
    try { j = JSON.parse(raw); } catch { j = raw; }
    if (!j) return "";
    if (typeof j === "string") return j.trim();
    if (typeof j.cookieHeader === "string") return j.cookieHeader.trim();
    if (typeof j.cookie === "string") return j.cookie.trim();
    return "";
  } catch (_) { return ""; }
}
function _getVhclActivationData(vehicleId: string|number, clientId: string|number): Promise<{ settingId: number|null; assetType: number|null }> {
  return new Promise((resolve) => {
    try {
      const https = require("https");
      const { URL } = require("url");
      const u = new URL(_HTML5_ACTION_URL_JR);
      const body = Buffer.from(
        `VEHICLE_ID=${encodeURIComponent(String(vehicleId))}&CLIENT_ID=${encodeURIComponent(String(clientId))}&action=GET_VHCL_ACTIVATION_DATA_NEW&VERSION_ID=2`,
        "utf8"
      );
      const cookieHeader = _readHtml5CookieHeader();
      const headers: Record<string,string> = {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "content-length": String(body.length),
        "accept": "*/*",
        "origin": "https://html5.traffilog.com",
        "referer": "https://html5.traffilog.com/appv2/index.htm",
      };
      if (cookieHeader) headers["cookie"] = cookieHeader;
      const req = https.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port ? Number(u.port) : 443,
        path: (u.pathname || "/") + (u.search || ""),
        method: "POST",
        headers,
      }, (res: any) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: any) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          try {
            const txt = Buffer.concat(chunks).toString("utf8");
            console.log(`[jobs] SB_SKIP_V2 GET_VHCL_ACTIVATION_DATA_NEW vehicleId=${vehicleId} len=${txt.length} head=${txt.slice(0,120)}`);
            const mSetting = txt.match(/ASSIGNED_VEHICLE_SETTING_ID\s*=\s*"(\d+)"/i);
            const mAsset   = txt.match(/ASSET_TYPE\s*=\s*"(\d+)"/i);
            resolve({
              settingId: mSetting ? Number(mSetting[1]) : null,
              assetType: mAsset   ? Number(mAsset[1])   : null,
            });
          } catch (_) { resolve({ settingId: null, assetType: null }); }
        });
      });
      req.setTimeout(_SB_SKIP_TIMEOUT_MS, () => { req.destroy(); resolve({ settingId: null, assetType: null }); });
      req.on("error", () => resolve({ settingId: null, assetType: null })); 
      req.write(body);
      req.end();
    } catch (_) { resolve({ settingId: null, assetType: null }); }
  });
}
// =============================================================================

function _alreadyHasChangeCompany(installationId: string): boolean {
  try {
    return listJobs().some((j: any) =>
      j?.type === "resolver_change_company" &&
      String(j?.payload?.installation_id ?? j?.payload?.installationId ?? "") === String(installationId) &&
      j?.status !== "error"
    );
  } catch { return false; }
}

function _enqueueChangeCompanyAfterHtml5(job: any, result: any) {
  try {
    if (!job || String(job.type || "") !== "html5_install") return;
    if (!_resultOk(result)) return;

    const installationId = _getInstallationId(job);
    if (!installationId) return;

    const confirmed =
      job.payload?.confirmed_change_company === true ||
      job.payload?.confirmed_change_company === "true" ||
      job.payload?.confirmed_change_company === "True";
    if (!confirmed) return;

    if (_alreadyHasChangeCompany(installationId)) return;

    const vehicle_id =
      job.payload?.vehicle_id_final ??
      job.payload?.vehicle_id ??
      job.payload?.VEHICLE_ID ??
      job.payload?.vehicleId ?? null;

    const plate_real =
      job.payload?.plate_real ??
      job.payload?.plate ??
      job.payload?.LICENSE_NMBR ?? null;

    // client_id é a fonte mais confiável — resolve o GROUP_NAME via endpoint CLIENTS
    const client_id = _num(
      job.payload?.target_client_id ??
      job.payload?.client_id_target ??
      job.payload?.client_id
    );

    const inst = installationsStore?.getInstallation ? installationsStore.getInstallation(installationId) : null;
    const client_id_final = client_id ?? _num(inst?.payload?.target_client_id ?? inst?.resolved?.target_client_id);

    // client_descr como fallback para log
    const client_descr =
      job.payload?.client_descr ??
      job.payload?.clientName ??
      inst?.payload?.clientName ?? null;

    if (!vehicle_id || !plate_real || !client_id_final) {
      console.log(`[jobs] [PIPELINE] skip CHANGE_COMPANY: campos faltando vehicle_id=${vehicle_id} plate_real=${plate_real} client_id=${client_id_final}`);
      return;
    }

    const service = _upper(job?.payload?.service ?? job?.payload?.servico ?? inst?.payload?.service);

    const ccJob = createJob("resolver_change_company", {
      flow: "CHANGE_COMPANY",
      vehicle_id,
      plate_real,
      client_id: client_id_final,
      client_descr,
      installation_id: installationId,
      service,
    });

    try { installationsStore?.pushJob && installationsStore.pushJob(installationId, { type: "resolver_change_company", job_id: ccJob.id, status: "queued" }); } catch {}
    try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "CHANGE_COMPANY_QUEUED" }); } catch {}

    console.log(`[jobs] [PIPELINE] enqueued resolver_change_company job=${ccJob.id} installation=${installationId} vehicle_id=${vehicle_id} client_id=${client_id_final}`);
  } catch (e: any) {
    console.log("[jobs] [PIPELINE] enqueue CHANGE_COMPANY failed:", e && (e.message || String(e)));
  }
}

async function _enqueueSchemeBuilderAfterHtml5(job: any, result: any) {
  try {
    const jobType = String(job?.type || "");
    if (jobType !== "html5_install" && jobType !== "html5_maint_no_swap" && jobType !== "html5_maint_with_swap" && jobType !== "resolver_change_company") return;
    if (jobType === "html5_install" && (
      job.payload?.confirmed_change_company === true ||
      job.payload?.confirmed_change_company === "true" ||
      job.payload?.confirmed_change_company === "True"
    )) return;
    const installationId = _getInstallationId(job);
    if (!installationId) return;

    const service = _upper(job?.payload?.service ?? job?.payload?.servico);
    if (!service) return;

    // UNINSTALL: marca COMPLETED direto — result.status é null mesmo com sucesso
    if (service === "UNINSTALL") {
      const html5Ok = !!(result && (result.ok === true || (Array.isArray(result.steps) && result.steps.some((s: any) => s.ok === true))));
      const finalSt = html5Ok ? "COMPLETED" : "HTML5_ERROR";
      try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: finalSt }); } catch {}
      console.log(`[jobs] [PIPELINE] UNINSTALL → ${finalSt} installation=${installationId}`);
      return;
    }
    if (!_resultOk(result)) return;

    const inst = installationsStore?.getInstallation ? installationsStore.getInstallation(installationId) : null;
    const vehicleId = _pickVehicleId(job, result);

    const mskip = (result as any)?.meta ? (result as any).meta.monitor_skip : null;
    if (mskip === 1 || mskip === "1" || mskip === true) {
      // MAINT_NO_SWAP com monitor_skip: não muta HTML5, mas ainda enfileira CAN
      if (service === "MAINT_NO_SWAP" && vehicleId) {
        const canJob = createJob("monitor_can_snapshot", {
          installation_id: installationId,
          service,
          vehicleId: String(vehicleId),
          cycles:      Number(process.env.CAN_SNAPSHOT_CYCLES      || "12"),
          interval_ms: Number(process.env.CAN_SNAPSHOT_INTERVAL_MS || "12000"),
        });
        try { installationsStore?.pushJob && installationsStore.pushJob(installationId, { type: "monitor_can_snapshot", job_id: canJob.id, status: "queued" }); } catch {}
        try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "CAN_RUNNING" }); } catch {}
        console.log(`[jobs] MAINT_NO_SWAP monitor_skip → CAN enfileirado job=${canJob.id} installation=${installationId} vehicleId=${vehicleId}`);
        return;
      }
      return;
    }

    if (!["INSTALL","MAINT_NO_SWAP","MAINT_WITH_SWAP"].includes(service)) return;
    if (_alreadyHasSb(installationId)) return;
    const clientId = _pickClientId(inst, job, result);
    const vehicleSettingId = _pickVehicleSettingId(inst, job, result);

    if (vehicleId) { try { installationsStore?.setResolved && installationsStore.setResolved(installationId, { vehicle_id: vehicleId }); } catch {} }

    if (!vehicleId || !clientId || !vehicleSettingId) {
      try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "HTML5_DONE" }); } catch {}
      console.log(`[jobs] [PIPELINE] skip SB: missing fields installation=${installationId} service=${service} vehicleId=${vehicleId} clientId=${clientId} vehicleSettingId=${vehicleSettingId}`);
      return;
    }

    // =========================================================================
    // SB_SKIP_V3: decisão vem do worker HTML5 via result.meta.sb_skip
    // O worker já tem cookie fresco e consultou GET_VHCL_ACTIVATION_DATA_NEW.
    // =========================================================================
    const _sbSkip = (result as any)?.meta?.sb_skip === true;
    if (_sbSkip) {
      const _detail = (result as any)?.meta?.sb_skip_detail || {};
      console.log(`[jobs] SB_SKIP_V3: PULANDO SB vehicleId=${vehicleId} detail=${JSON.stringify(_detail)}`);
      try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, {
        status: "SB_DONE",
        sb: { skipped: true, reason: "already_configured", ..._detail }
      }); } catch {}

      if (service === "MAINT_NO_SWAP") {
        try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "COMPLETED" }); } catch {}
        console.log(`[jobs] SB_SKIP_V3: MAINT_NO_SWAP → COMPLETED.`);
        return;
      }

      const canJob = createJob("monitor_can_snapshot", {
        installation_id: installationId,
        service,
        vehicleId: String(vehicleId),
        cycles:      Number(process.env.CAN_SNAPSHOT_CYCLES      || "12"),
        interval_ms: Number(process.env.CAN_SNAPSHOT_INTERVAL_MS || "12000"),
      });
      try { installationsStore?.pushJob && installationsStore.pushJob(installationId, { type: "monitor_can_snapshot", job_id: canJob.id, status: "queued" }); } catch {}
      try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "CAN_RUNNING" }); } catch {}
      console.log(`[jobs] SB_SKIP_V3: CAN enfileirado job=${canJob.id} installation=${installationId}`);
      return;
    }
    // =========================================================================

    // MAINT_NO_SWAP: nunca envia SB — vai direto para CAN
    if (service === "MAINT_NO_SWAP") {
      if (!vehicleId) {
        try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "COMPLETED" }); } catch {}
        console.log(`[jobs] MAINT_NO_SWAP → COMPLETED (sem vehicleId para CAN).`);
        return;
      }
      const canJob = createJob("monitor_can_snapshot", {
        installation_id: installationId,
        service,
        vehicleId: String(vehicleId),
        cycles:      Number(process.env.CAN_SNAPSHOT_CYCLES      || "12"),
        interval_ms: Number(process.env.CAN_SNAPSHOT_INTERVAL_MS || "12000"),
      });
      try { installationsStore?.pushJob && installationsStore.pushJob(installationId, { type: "monitor_can_snapshot", job_id: canJob.id, status: "queued" }); } catch {}
      try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "CAN_RUNNING" }); } catch {}
      console.log(`[jobs] MAINT_NO_SWAP → CAN enfileirado job=${canJob.id} installation=${installationId} vehicleId=${vehicleId}`);
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
      comment: (() => { const _b = String((inst && inst.payload && inst.payload.comment) || "").trim(); if (_b) return _b; try { const d = new Date(); return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`; } catch(_) { return ""; } })()
    });

    try { installationsStore?.pushJob && installationsStore.pushJob(installationId, { type: "scheme_builder", job_id: sb.id, status: "queued" }); } catch {}
    try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "SB_QUEUED" }); } catch {}

    console.log(`[jobs] [PIPELINE] enqueued scheme_builder job=${sb.id} installation=${installationId} vehicleId=${vehicleId} vehicleSettingId=${vehicleSettingId}`);
  } catch (e: any) {
    console.log("[jobs] [PIPELINE] enqueue SB failed:", e && (e.message || String(e)));
  }
}


function _enqueueCanAfterSchemeBuilder(job: any, result: any) {
  try {
    if (!job || String(job.type || "") !== "scheme_builder") return;
    if (!_resultOk(result)) return;

    const installationId = _getInstallationId(job);
    if (!installationId) return;
    if (_alreadyHasCan(installationId)) return;

    const inst = installationsStore?.getInstallation ? installationsStore.getInstallation(installationId) : null;
    const service = _upper(job?.payload?.service ?? inst?.service);

    // FIX_SB_STUCK_V1: qualquer early return deve tirar a instalação de SB_RUNNING
    function _sbDoneFallback(reason: string) {
      console.log(`[jobs] [PIPELINE] SB concluído mas CAN não enfileirado (${reason}) — marcando SB_DONE installation=${installationId}`);
      try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "SB_DONE" }); } catch {}
    }

    if (!service) { _sbDoneFallback("service ausente"); return; }
    if (!["INSTALL", "MAINT_WITH_SWAP"].includes(service)) { _sbDoneFallback(`service=${service} não requer CAN`); return; }

    // FIX_SB_STUCK_V1: fallback busca vehicleId na instalação se não vier no payload do job
    const vehicleId = _num(
      job?.payload?.vehicleId ?? job?.payload?.vehicle_id ?? job?.payload?.VEHICLE_ID ??
      inst?.resolved?.vehicle_id ?? inst?.payload?.vehicleId ?? inst?.payload?.vehicle_id
    );
    if (!vehicleId) {
      _sbDoneFallback("vehicleId ausente no job e na instalação");
      return;
    }

    // Post-SB CAN battery: o worker faz Gate B (reboot) e publica snapshots parciais
    const cycles = _num((job as any)?.payload?.can_cycles ?? (job as any)?.payload?.cycles) ?? 12;
    const interval_ms = _num((job as any)?.payload?.can_interval_ms ?? (job as any)?.payload?.interval_ms) ?? 12000;

    const canJob = createJob("monitor_can_snapshot", {
      installation_id: installationId,
      service,
      vehicleId: String(vehicleId),
      cycles,
      interval_ms,
      mode: "post_sb",
      reboot_sleep_ms: 60000,
      sb_poll_interval_ms: 60000,
    });

    try { installationsStore?.pushJob && installationsStore.pushJob(installationId, { type: "monitor_can_snapshot", job_id: canJob.id, status: "queued" }); } catch {}
    try { installationsStore?.patchInstallation && installationsStore.patchInstallation(installationId, { status: "WAITING_REBOOT_CAN" }); } catch {}

    console.log(`[jobs] [PIPELINE] enqueued monitor_can_snapshot(post_sb) job=${canJob.id} installation=${installationId} vehicleId=${vehicleId}`);
  } catch (e: any) {
    console.log("[jobs] [PIPELINE] enqueue CAN failed:", e && (e.message || String(e)));
  }
}

function _handleGsComplete(job: any, result: any, jobId?: string) {
  try {
    if (!job || String(job.type || "") !== "monitor_gs") return;
    const installationId = _getInstallationId(job);
    if (!installationId) return;
    if (!installationsStore?.patchInstallation) return;

    // marca GS_DONE + COMPLETED (o técnico não espera no app)
    installationsStore.patchInstallation(installationId, {
      status: _resultOk(result) ? "COMPLETED" : "GS_ERROR",
      gs: {
        done_at: new Date().toISOString(),
        ok: _resultOk(result),
      }
    });

    try {
      installationsStore.pushJob && installationsStore.pushJob(installationId, {
        type: "monitor_gs",
        job_id: String(jobId || job?.id || ""),
        status: "completed",
        ok: _resultOk(result),
        meta: (result && (result.meta || result)) ? (result.meta || result) : null,
      });
    } catch {}
  } catch (e: any) {
    console.log("[jobs] handle GS complete failed:", e && (e.message || String(e)));
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
/** GET /api/jobs/next?type=scheme_builder&worker=vm-worker-01 */
/** GET /api/jobs/next?type=...&worker=... */
router.get("/next", (req, res) => {
  const type = String(((req.query || {}) as any).type || "");
  const workerId = String(((req.query || {}) as any).worker || "unknown-worker");
  if (!type) return res.status(400).json({ error: "Query param 'type' is required" });

  const typeLc = type.toLowerCase();
  const isHtml5 = typeLc.startsWith("html5_");
  const token = String((getSessionToken() || "")).trim();

  // Gate disabled: jobs/next não deve depender de session token global
  res.setHeader("x-jobsnext-gate", token ? "present" : "missing_allowed_v4");

  const job = getNextJob(type, workerId);
  if (!job) return res.status(204).send();

  // Injeta token só em jobs não-HTML5 (HTML5 usa cookie-jar / fluxo próprio)
  if (!isHtml5 && token) {
    const out = JSON.parse(JSON.stringify(job));
    out.payload = out.payload || {};
    if (!out.payload.sessionToken) out.payload.sessionToken = token;
    return res.json({ job: out });
  }

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

// worker pode mandar status=success/done.
 // IMPORTANTE: para jobs CAN, status pode ser apenas um "envelope".
 // Regra: completed/complete só é OK se NÃO houver ok=false explícito.
 const isCompletedWord = (rawStatus === "completed" || rawStatus === "complete");
 const okFlag =
   rawStatus === "ok" ||
   rawStatus === "success" ||
   rawStatus === "done" ||
   ((req.body as any)?.ok === true) ||
   ((result as any)?.ok === true) ||
   (isCompletedWord && ((req.body as any)?.ok !== false) && ((result as any)?.ok !== false) && (String((result as any)?.status||"").toLowerCase() !== "error"));

 const finalStatus = okFlag ? "completed" : "error";
 /*__JOBS_COMPLETE_V3__*/

// OPTC_COMPLETE_BODY_SNAPSHOT_FALLBACK_V1: se o worker mandar snapshot fora de result, copia para dentro
try {
  const rootSnap = pickCanSnapshotFromCompleteBody(req.body);
  if (rootSnap && result && typeof result === "object"){
    const rAny: any = result as any;
    if (!rAny.snapshot) rAny.snapshot = rootSnap;
    if (!Array.isArray(rAny.snapshots)) rAny.snapshots = [rootSnap];
  }
} catch(_e) {}
  const job = completeJob(id, finalStatus, result, workerId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  // CAN snapshot: sempre atualizar instalação (READY/ERROR), mesmo se job falhar
  try { if ((job as any)?.type === "monitor_can_snapshot") _handleCanSnapshotComplete(job, result, id); } catch {}
  // GS: atualizar instalação (COMPLETED/ERROR)
  try { if ((job as any)?.type === "monitor_gs") _handleGsComplete(job, result, id); } catch {}
  // HTML5: refletir erro/sucesso na instalação (HTML5_ERROR + last_error)
  try { _handleHtml5CompleteToInstallation(job, result, finalStatus, id); } catch {}


  // dispara encadeamento para Monitor (SB) após HTML5 somente em sucesso
  if (finalStatus === "completed") {
    _enqueueChangeCompanyAfterHtml5(job, result);
    _enqueueSchemeBuilderAfterHtml5(job, result);
    _enqueueCanAfterSchemeBuilder(job, result);
  }

  return res.json({ job });
});


router.post("/:id/cancel", requireWorkerKey, (req: Request, res: Response) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "job_not_found" });
  const terminal = ["completed", "cancelled", "error"];
  if (terminal.includes(job.status)) return res.json({ skipped: true, status: job.status });
  updateJob(req.params.id, { status: "cancelled" });
  return res.json({ ok: true, id: req.params.id });
});

router.get("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const job = getJob(id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json({ job });
});

router.get("/", (_req: Request, res: Response) => res.json({ jobs: listJobs() }));

export default router;
