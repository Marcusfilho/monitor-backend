import express from "express";

declare const require: any;

const router = express.Router();

// Carrega módulos em runtime (evita TS quebrar por tipos/exports enquanto você estabiliza)
function loadAny(modPath: string): any {
  try { return require(modPath); } catch { return null; }
}

function unwrap(mod: any): any {
  if (!mod) return null;
  if (mod.default) return mod.default;
  return mod;
}

function pickFn(obj: any, names: string[]): Function | null {
  if (!obj) return null;
  for (const n of names) {
    if (typeof obj[n] === "function") return obj[n].bind(obj);
  }
  return null;
}

async function callMaybe(fn: any, ...args: any[]) {
  const r = fn(...args);
  return (r && typeof r.then === "function") ? await r : r;
}

// tenta engine e store (nomes mais prováveis)
function getEngine() {
  const m = unwrap(loadAny("../services/installationsEngine"));
  return m?.installationsEngine || m;
}
function getStore() {
  const m = unwrap(loadAny("../services/installationsStore"));
  return m?.installationsStore || m;
}

router.post("/", async (req, res) => {
  try {
    const engine = getEngine();
    const store = getStore();

    const fn =
      pickFn(engine, ["createInstallation", "create", "createAndStart", "startInstallation"]) ||
      pickFn(store,  ["createInstallation", "create"]);

    if (!fn) {
      return res.status(500).json({ error: "installations create handler not wired", hint: "export createInstallation/create in installationsEngine or installationsStore" });
    }

    const out = await callMaybe(fn, req.body);
    return res.status(201).json(out ?? { ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: "failed to create installation", details: String(e?.stack || e?.message || e) });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const engine = getEngine();
    const store = getStore();
    const id = String(req.params.id || "");

    const fn =
      pickFn(store,  ["getInstallation", "get", "read", "load"]) ||
      pickFn(engine, ["getInstallation", "get", "read", "load"]);

    if (!fn) {
      return res.status(500).json({ error: "installations read handler not wired", hint: "export getInstallation/get in installationsStore or installationsEngine" });
    }

    const out = await callMaybe(fn, id);
    if (!out) return res.status(404).json({ error: "installation not found", id });
    return res.json(out);
  } catch (e: any) {
    return res.status(500).json({ error: "failed to read installation", details: String(e?.stack || e?.message || e) });
  }
});

router.post("/:id/actions/request-can-snapshot", async (req, res) => {
  try {
    const engine = getEngine();
    const id = String(req.params.id || "");

    const fn = pickFn(engine, ["requestCanSnapshot", "requestCanSnapshotForInstallation", "enqueueCanSnapshot", "canSnapshotRequest"]);
    if (!fn) {
      return res.status(500).json({ error: "request-can-snapshot not wired", hint: "export requestCanSnapshot* in installationsEngine" });
    }

    const out = await callMaybe(fn, id, req.body);
    return res.json(out ?? { ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: "failed request-can-snapshot", details: String(e?.stack || e?.message || e) });
  }
});

router.post("/:id/actions/approve-can", async (req, res) => {
  try {
    const engine = getEngine();
    const id = String(req.params.id || "");

    const fn = pickFn(engine, ["approveCan", "approveCanForInstallation", "canApprove", "approveCanSnapshot"]);
    if (!fn) {
      return res.status(500).json({ error: "approve-can not wired", hint: "export approveCan* in installationsEngine" });
    }

    const out = await callMaybe(fn, id, req.body);
    return res.json(out ?? { ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: "failed approve-can", details: String(e?.stack || e?.message || e) });
  }
});

export default router;
