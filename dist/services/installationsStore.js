"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_PATH = process.env.INSTALLATIONS_STORE_PATH || "/tmp/installations_store.json";
let mem = { installations: {} };

function nowIso() { return new Date().toISOString(); }

function randHex(n) { return crypto.randomBytes(n).toString("hex"); }

function load() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = String(fs.readFileSync(STORE_PATH, "utf8") || "").trim();
      if (raw) mem = JSON.parse(raw);
    }
  } catch (_) {}
  if (!mem || typeof mem !== "object") mem = { installations: {} };
  if (!mem.installations) mem.installations = {};
  return mem;
}

function save() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(mem, null, 2), "utf8");
  } catch (_) {}
}

function createInstallation(payload) {
  load();
  const id = "inst_" + randHex(12);
  const token = "tok_" + randHex(16);

  const service = String(payload.service || "").trim().toUpperCase();
  const rec = {
    installation_id: id,
    installation_token: token,
    service,
    status: "CREATED",
    created_at: nowIso(),
    updated_at: nowIso(),
    payload: payload || {},
    resolved: { vehicle_id: null, current_client_id: null, target_client_id: Number(payload.target_client_id || 0) || null },
    jobs: [],
    can: { snapshots: [], last_snapshot_at: null, summary: null }
  };

  mem.installations[id] = rec;
  save();
  return rec;
}

function getInstallation(id) {
  load();
  return mem.installations[String(id || "").trim()] || null;
}

function requireToken(rec, token) {
  const got = String(token || "").trim();
  return rec && got && got === String(rec.installation_token || "").trim();
}

function patchInstallation(id, patch) {
  load();
  const rec = mem.installations[String(id || "").trim()];
  if (!rec) return null;
  Object.assign(rec, patch || {});
  rec.updated_at = nowIso();
  mem.installations[rec.installation_id] = rec;
  save();
  return rec;
}

function pushJob(id, jobInfo) {
  load();
  const rec = mem.installations[String(id || "").trim()];
  if (!rec) return null;
  rec.jobs = Array.isArray(rec.jobs) ? rec.jobs : [];
  rec.jobs.push(Object.assign({ ts: nowIso() }, jobInfo || {}));
  rec.updated_at = nowIso();
  mem.installations[rec.installation_id] = rec;
  save();
  return rec;
}

function setResolved(id, resolvedPatch) {
  load();
  const rec = mem.installations[String(id || "").trim()];
  if (!rec) return null;
  rec.resolved = Object.assign({}, rec.resolved || {}, resolvedPatch || {});
  rec.updated_at = nowIso();
  mem.installations[rec.installation_id] = rec;
  save();
  return rec;
}

module.exports = {
  createInstallation,
  getInstallation,
  patchInstallation,
  pushJob,
  setResolved,
  requireToken
};
