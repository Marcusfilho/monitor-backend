"use strict";

const express = require("express");
const router = express.Router();

const store = require("../services/installationsStore");
const engine = require("../services/installationsEngine");

// helper token
function getToken(req) {
  return String(req.headers["x-installation-token"] || req.query.token || "").trim();
}

// POST /api/installations
router.post("/", async (req, res) => {
  try {
    const payload = req.body || {};
    const rec = store.createInstallation(payload);

    const started = await engine.startPipeline(rec);

    return res.status(201).json({
      ok: true,
      installation_id: started.installation_id,
      installation_token: started.installation_token,
      status: started.status,
      next_poll_ms: 1500
    });
  } catch (e) {
    const code = e && (e.code || e.message) ? String(e.code || e.message) : "error";
    return res.status(500).json({ ok: false, error: code });
  }
});

// GET /api/installations/:id
router.get("/:id", (req, res) => {
  const rec = store.getInstallation(req.params.id);
  if (!rec) return res.status(404).json({ ok: false, error: "not_found" });

  return res.json({ ok: true, installation: rec });
});

// POST /api/installations/:id/actions/request-can-snapshot
router.post("/:id/actions/request-can-snapshot", async (req, res) => {
  const rec = store.getInstallation(req.params.id);
  if (!rec) return res.status(404).json({ ok: false, error: "not_found" });

  if (!store.requireToken(rec, getToken(req))) {
    return res.status(401).json({ ok: false, error: "token_invalid" });
  }

  try {
    const upd = await engine.requestCanSnapshot(rec.installation_id);
    return res.json({ ok: true, installation: upd });
  } catch (e) {
    const code = e && (e.code || e.message) ? String(e.code || e.message) : "error";
    return res.status(400).json({ ok: false, error: code });
  }
});

// POST /api/installations/:id/actions/approve-can
router.post("/:id/actions/approve-can", async (req, res) => {
  const rec = store.getInstallation(req.params.id);
  if (!rec) return res.status(404).json({ ok: false, error: "not_found" });

  if (!store.requireToken(rec, getToken(req))) {
    return res.status(401).json({ ok: false, error: "token_invalid" });
  }

  const body = req.body || {};
  try {
    const upd = await engine.approveCan(rec.installation_id, {
      override: !!body.override,
      reason: body.reason || null
    });
    return res.json({ ok: true, installation: upd });
  } catch (e) {
    const code = e && (e.code || e.message) ? String(e.code || e.message) : "error";
    return res.status(400).json({ ok: false, error: code });
  }
});

module.exports = router;
