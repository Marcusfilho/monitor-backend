"use strict";

const fs = require("fs");
const path = require("path");

const CATALOGS_PATH =
  process.env.CATALOGS_PATH ||
  path.join(process.cwd(), "config", "catalogs.json");

let _cache = null;
let _cacheMtime = 0;

function _readJson(p) {
  const raw = String(fs.readFileSync(p, "utf8") || "");
  return JSON.parse(raw);
}

function loadCatalogs() {
  try {
    const st = fs.statSync(CATALOGS_PATH);
    const mtime = Number(st.mtimeMs || 0);
    if (_cache && mtime === _cacheMtime) return _cache;
    const j = _readJson(CATALOGS_PATH);
    _cache = j || {};
    _cacheMtime = mtime;
    return _cache;
  } catch (e) {
    return _cache || { version: 0, clients: {}, gsensorMap: {} };
  }
}

function getClient(clientId) {
  const c = loadCatalogs();
  const key = String(clientId || "").trim();
  return (c.clients && c.clients[key]) || null;
}

function resolveVehicleSettingId({ target_client_id, client_id, vehicleSettingId, vehicle }) {
  // precedence: explicit vehicleSettingId (payload) > client default
  const explicit = Number(vehicleSettingId || 0);
  if (explicit > 0) return explicit;

  const c = getClient(target_client_id || client_id);
  const def = Number(c && c.defaultVehicleSettingId ? c.defaultVehicleSettingId : 0);
  return def > 0 ? def : null;
}

function resolveGsCommand({ label_pos, harness_pos }) {
  const c = loadCatalogs();
  const k = String(label_pos || "").trim().toUpperCase() + "|" + String(harness_pos || "").trim().toUpperCase();
  return (c.gsensorMap && c.gsensorMap[k]) || null;
}

module.exports = {
  loadCatalogs,
  getClient,
  resolveVehicleSettingId,
  resolveGsCommand
};
