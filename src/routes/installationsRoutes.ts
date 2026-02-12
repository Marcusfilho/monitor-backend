import { Router } from "express";

const router = Router();

// require(any) pra não travar por typings enquanto estabiliza V1
const installationsStore: any = require("../services/installationsStore");
const installationsEngine: any = require("../services/installationsEngine");

function pickFn(obj: any, names: string[]) {
  for (const n of names) if (obj && typeof obj[n] === "function") return obj[n].bind(obj);
  return null;
}

function loopbackBase() {
  const port = Number(process.env.PORT || 3000);
  return `http://127.0.0.1:${port}`;
}

function pickAdminKey(): string | null {
  return (
    process.env.ADMIN_API_KEY ||
    process.env.ADMIN_KEY ||
    process.env.X_ADMIN_KEY ||
    process.env.ADMIN_SECRET ||
    null
  );
}

function jobTypeFromService(svc: string | null): string {
  const s = String(svc || "").toUpperCase();
  if (s === "MAINT_NO_SWAP") return "html5_maint_no_swap";
  if (s === "MAINT_WITH_SWAP") return "html5_maint_with_swap";
  if (s === "UNINSTALL") return "html5_uninstall";
  if (s === "CHANGE_COMPANY") return "html5_change_company";
  return "html5_install";
}

async function postJson(url: string, body: any, extraHeaders?: Record<string, string>) {
  const f: any = (globalThis as any).fetch;
  if (!f) throw new Error("globalThis.fetch not available");

  const res = await f(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(extraHeaders || {}),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text().catch(() => "");
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

router.post("/", async (req, res) => {
  try {
    const payload = req.body || {};

    // 1) cria installation (prefer engine; fallback store)
    const create =
      pickFn(installationsEngine, ["createInstallation", "create", "createAndStart", "startInstallation"]) ||
      pickFn(installationsStore, ["createInstallation", "create"]);

    if (!create) {
      return res.status(500).json({ ok: false, error: "no createInstallation/create found in engine/store" });
    }

    const inst = await create(payload);

    const instId = inst?.installation_id || inst?.id || null;
    const instTok = inst?.installation_token || inst?.token || null;

    // 2) enqueue job inicial (via loopback /api/jobs)
    const svc = payload.service || inst?.service || null;
    const jobType = jobTypeFromService(svc);

    const payloadForJob = {
      installation_id: instId,
      installation_token: instTok,
      service: svc,
      plate: payload.plate || payload.placa || null,
      serial: payload.serial || payload.serie || payload.innerId || null,
      raw: payload,
    };

    const adminKey = pickAdminKey();
    const headers: Record<string, string> = {};
    if (adminKey) headers["x-admin-key"] = adminKey;
    headers["x-internal-call"] = "installationsRoutes";

    let enqueueDebug: any = { ok: false, method: "loopback:/api/jobs", type: jobType };

    try {
      const r = await postJson(`${loopbackBase()}/api/jobs`, { type: jobType, payload: payloadForJob }, headers);
      enqueueDebug.status = r.status;
      enqueueDebug.response = r.json;
      enqueueDebug.ok = r.status >= 200 && r.status < 300;
    } catch (e: any) {
      enqueueDebug.error = String(e?.stack || e?.message || e);
    }

    // 3) tenta anexar no objeto de retorno (debug)
    try {
      inst.enqueue = enqueueDebug;
    } catch (_) {}

    return res.status(201).json(inst);

  } catch (e: any) {
    console.error("[installationsRoutes] POST / error:", e && (e.stack || e.message || String(e)));
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const getOne =
      pickFn(installationsEngine, ["getInstallation", "getById", "read"]) ||
      pickFn(installationsStore, ["getInstallation", "getById", "read"]);

    if (!getOne) return res.status(500).json({ ok:false, error:"no getInstallation/getById/read found" });

    const inst = await getOne(id);
    if (!inst) return res.status(404).json({ ok:false, error:"not found" });
    return res.json(inst);
  } catch (e:any) {
    console.error("[installationsRoutes] GET /:id error:", e && (e.stack || e.message || String(e)));
    return res.status(500).json({ ok:false, error:"Internal Server Error" });
  }
});

router.post("/:id/actions/request-can-snapshot", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const fn = pickFn(installationsEngine, ["requestCanSnapshot", "request_can_snapshot"]);
    if (!fn) return res.status(501).json({ ok:false, error:"not implemented (engine missing requestCanSnapshot)" });
    const out = await fn(id, req.body || {});
    return res.json(out);
  } catch (e:any) {
    console.error("[installationsRoutes] request-can-snapshot error:", e && (e.stack || e.message || String(e)));
    return res.status(500).json({ ok:false, error:"Internal Server Error" });
  }
});

router.post("/:id/actions/approve-can", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const fn = pickFn(installationsEngine, ["approveCan", "approve_can"]);
    if (!fn) return res.status(501).json({ ok:false, error:"not implemented (engine missing approveCan)" });
    const out = await fn(id, req.body || {});
    return res.json(out);
  } catch (e:any) {
    console.error("[installationsRoutes] approve-can error:", e && (e.stack || e.message || String(e)));
    return res.status(500).json({ ok:false, error:"Internal Server Error" });
  }
});

export default router;
