// src/services/sharepointExporter.ts
// SP_EXPORT_V1 — exporta snapshots para lista SharePoint via Microsoft Graph API
//
// Auth: OAuth2 Client Credentials → token com escopo graph.microsoft.com/.default
// Na 1ª chamada: descobre siteId e listId a partir de SP_SITE_HOST/PATH e SP_LIST_NAME
// Demais: POST /sites/{siteId}/lists/{listId}/items com os campos mapeados
//
// Mapeamento de colunas (interno SharePoint, verificado em 2026-06-09):
//   Placa       → Title
//   Serviço     → Servi_x00e7_o
//   Comentário  → Obs_x002e_
//   Fabricante  → Fabricante1
//   Tecnico     → T_x00e9_cnico
//   Data serv.  → Datadoservi_x00e7_o

import type { SnapshotPayload } from "./snapshotStore";

// ─── config via env ───────────────────────────────────────────────────────────

const SP_ENABLED    = process.env.SP_EXPORT_ENABLED   === "1";
const TENANT_ID     = (process.env.SP_TENANT_ID       || "").trim();
const CLIENT_ID     = (process.env.SP_CLIENT_ID       || "").trim();
const CLIENT_SECRET = (process.env.SP_CLIENT_SECRET   || "").trim();
const SITE_HOST     = (process.env.SP_SITE_HOST       || "smartdrivinglabs.sharepoint.com").trim();
const SITE_PATH     = (process.env.SP_SITE_PATH       || "/sites/SmartDrivingLabs").trim();
const LIST_NAME     = (process.env.SP_LIST_NAME       || "BaseInstalados").trim();

const GRAPH_BASE = "https://graph.microsoft.com";
const TOKEN_URL  = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

// ─── cache em memória (vida do processo) ─────────────────────────────────────

let _token    : string | null = null;
let _tokenExp = 0;
let _siteId   : string | null = null;
let _listId   : string | null = null;

// ─── OAuth2 Client Credentials ───────────────────────────────────────────────

async function _getToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (_token && _tokenExp > now + 60) return _token;

  const res  = await fetch(TOKEN_URL, {
    method : "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body   : new URLSearchParams({
      grant_type   : "client_credentials",
      client_id    : CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope        : "https://graph.microsoft.com/.default",
    }).toString(),
  });

  const data: any = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`[SP_EXPORT_V1] token falhou ${res.status}: ${JSON.stringify(data)}`);
  }

  _token    = data.access_token;
  _tokenExp = now + (data.expires_in ?? 3600);
  return _token!;
}

// ─── Graph API helpers ────────────────────────────────────────────────────────

async function _graphGet(token: string, path: string): Promise<any> {
  const res  = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(`[SP_EXPORT_V1] GET ${path} ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
  }
  return data;
}

async function _graphPost(token: string, path: string, body: any): Promise<any> {
  const res  = await fetch(`${GRAPH_BASE}${path}`, {
    method : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body   : JSON.stringify(body),
  });
  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(`[SP_EXPORT_V1] POST ${path} ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
  }
  return data;
}

// ─── descoberta de siteId e listId (1× por processo) ─────────────────────────

async function _ensureIds(token: string): Promise<void> {
  if (_siteId && _listId) return;

  const siteData = await _graphGet(token, `/v1.0/sites/${SITE_HOST}:${SITE_PATH}`);
  _siteId = siteData.id;

  const listData = await _graphGet(
    token,
    `/v1.0/sites/${_siteId}/lists/${encodeURIComponent(LIST_NAME)}?$select=id,displayName`,
  );
  _listId = listData.id;

  console.log(`[SP_EXPORT_V1] siteId=${_siteId} listId=${_listId} (${listData.displayName})`);
}

// ─── mapeamento snapshot → campos SharePoint ─────────────────────────────────
// Nomes internos obtidos via GET /columns em 2026-06-09

const LABEL_PT: Record<string, string> = {
  UP: "CIMA", DOWN: "BAIXO", LEFT: "ESQUERDA",
  RIGHT: "DIREITA", FRONT: "FRENTE", BACK: "TRASEIRO",
};

function _buildFields(p: SnapshotPayload): Record<string, any> {
  const c   = p.snapshot_json.cadastro;
  const can = _formatCan(p.snapshot_json.can);

  const etiqueta = LABEL_PT[String(c.gsensor?.label_pos   ?? "").toUpperCase()] ?? "";
  const chicote  = LABEL_PT[String(c.gsensor?.harness_pos ?? "").toUpperCase()] ?? "";
  const tecnico  = typeof c.technician === "object"
    ? (c.technician?.nick ?? c.technician?.id ?? "")
    : (c.technician ?? "");

  return {
    Title                  : c.plate_real               ?? "",   // Placa
    "Servi_x00e7_o"        : c.service                  ?? "",   // Serviço
    Serial                 : p.serial                   ?? "",
    Modelo                 : c.vehicle?.model            ?? "",
    Etiqueta               : etiqueta,
    Chicote                : chicote,
    "Obs_x002e_"           : c.comment                  ?? "",   // Comentário
    Datadoservi_x00e7_o   : new Date(p.snapshot_json.ts).toISOString(), // Data do serviço
    Cliente                : c.client                   ?? "",
    Ano                    : c.vehicle?.year             ?? null,
    Fabricante1            : c.vehicle?.manufacturer    ?? "",   // Fabricante
    Cor                    : c.cor                      ?? "",
    "T_x00e9_cnico"        : tecnico,                            // Tecnico
    Chassi                 : c.chassi                   ?? "",
    LocalInstalacao        : c.localInstalacao          ?? "",
    JobID                  : p.job_id,
    CAN                    : can,
  };
}

function _formatCan(can: any): string {
  if (!can || typeof can !== "object") return "";
  const snap = Array.isArray(can.snapshots) && can.snapshots.length > 0 ? can.snapshots[0] : can;
  const parts: string[] = [];

  const ign = snap?.header?.raw?.ignition ?? snap?.ignition ?? null;
  if (ign != null && ign !== "") parts.push(`IGN:${ign}`);

  const key = snap?.header?.configuration_key_db ?? snap?.config_key_db ?? null;
  if (key && key !== "00000000") parts.push(`KEY:${key}`);

  const mods = snap?.moduleState ?? snap?.module_state ?? null;
  if (Array.isArray(mods)) {
    const active = mods
      .filter((m: any) => m.active && m.ok)
      .map((m: any) => m.sub || m.name)
      .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
      .slice(0, 5);
    if (active.length) parts.push(`MOD:${active.join(",")}`);
  }

  const params = snap?.parameters ?? null;
  if (Array.isArray(params)) {
    for (const param of params) {
      const val = param.value ?? param.raw_value;
      if (!val || val === "00000000" || val === "0") continue;
      const name = (param.name || param.id || "?").replace(/\s+/g, "_").substring(0, 12);
      parts.push(`${name}:${val}`);
    }
  }

  return parts.join(" | ");
}

// ─── exportSnapshot (ponto de entrada) ───────────────────────────────────────

export async function exportSnapshot(id: number, p: SnapshotPayload): Promise<void> {
  if (!SP_ENABLED) {
    throw new Error(`[SP_EXPORT_V1] desabilitado (SP_EXPORT_ENABLED != 1) — id=${id}`);
  }
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("[SP_EXPORT_V1] SP_TENANT_ID / SP_CLIENT_ID / SP_CLIENT_SECRET não configurados");
  }

  const token = await _getToken();
  await _ensureIds(token);

  const fields = _buildFields(p);
  await _graphPost(token, `/v1.0/sites/${_siteId}/lists/${_listId}/items`, { fields });

  console.log(`[SP_EXPORT_V1] exportado id=${id} plate=${p.plate} → SharePoint ✅`);
}
