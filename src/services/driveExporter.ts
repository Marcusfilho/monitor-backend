// src/services/driveExporter.ts
// DRIVE_EXPORT_V1 — exporta snapshots para Google Sheets via Service Account

import fs from "fs";
import path from "path";
import https from "https";
import type { SnapshotPayload } from "./snapshotStore";

const DRIVE_ENABLED   = process.env.DRIVE_EXPORT_ENABLED === "1";
const SA_KEY_PATH     = (process.env.GOOGLE_SA_KEY_PATH || "").trim();
const SPREADSHEET_ID  = (process.env.SPREADSHEET_ID || "").trim();
const SHEET_NAME      = (process.env.SHEET_NAME || "Instalações").trim();

// ─── cabeçalho da planilha ────────────────────────────────────────────────────
const HEADER = [
  "ID", "Data", "Placa", "Serial", "Técnico", "Cliente",
  "Serviço", "Fabricante", "Modelo", "Ano",
  "Cor", "Chassi", "Local Instalação", "Comentário", "Job ID",
  "Etiqueta", "Chicote", "CAN",
];

// ─── decodificação gsensor → Etiqueta / Chicote ───────────────────────────────

const LABEL_PT: Record<string, string> = {
  UP: "CIMA", DOWN: "BAIXO", LEFT: "ESQUERDA",
  RIGHT: "DIREITA", FRONT: "FRENTE", BACK: "TRASEIRO",
};

function gsensorToEtiquetaChicote(gsensor: any): { etiqueta: string; chicote: string } {
  if (!gsensor || typeof gsensor !== "object") return { etiqueta: "", chicote: "" };
  return {
    etiqueta: LABEL_PT[String(gsensor.label_pos  ?? "").toUpperCase()] ?? "",
    chicote:  LABEL_PT[String(gsensor.harness_pos ?? "").toUpperCase()] ?? "",
  };
}

// ─── formatação CAN compacta ──────────────────────────────────────────────────

function formatCanSummary(can: any): string {
  if (!can || typeof can !== "object") return "";
  const parts: string[] = [];

  if (can.ignition !== undefined && can.ignition !== null && can.ignition !== "") {
    parts.push(`IGN:${can.ignition}`);
  }

  if (can.config_key_db && can.config_key_db !== "00000000") {
    parts.push(`KEY:${can.config_key_db}`);
  }

  if (Array.isArray(can.moduleState)) {
    const activeModules = can.moduleState
      .filter((m: any) => m.active === true && m.ok === true)
      .map((m: any) => m.sub || m.name)
      .filter((v: string, i: number, arr: string[]) => arr.indexOf(v) === i)
      .slice(0, 5);
    if (activeModules.length > 0) {
      parts.push(`MOD:${activeModules.join(",")}`);
    }
  }

  if (Array.isArray(can.parameters)) {
    for (const param of can.parameters) {
      const val = param.value ?? param.raw_value;
      if (!val || val === "00000000" || val === "0") continue;
      const name = (param.name || param.original_name || param.id || "?")
        .replace(/\s+/g, "_")
        .substring(0, 12);
      parts.push(`${name}:${val}`);
    }
  }

  return parts.join(" | ");
}

// ─── JWT / OAuth2 sem googleapis (zero dependência extra) ────────────────────

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(creds: any): Promise<string> {
  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss:   creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud:   "https://oauth2.googleapis.com/token",
    iat:   now,
    exp:   now + 3600,
  };

  const header  = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify(claim)));
  const signing = `${header}.${payload}`;

  const { createSign } = await import("crypto");
  const sign = createSign("RSA-SHA256");
  sign.update(signing);
  const signature = base64url(sign.sign(creds.private_key));

  const jwt = `${signing}.${signature}`;

  return new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req  = https.request(
      {
        hostname: "oauth2.googleapis.com",
        path:     "/token",
        method:   "POST",
        headers:  { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.access_token) resolve(parsed.access_token);
            else reject(new Error(`[DRIVE_EXPORT_V1] token error: ${data}`));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Sheets API ──────────────────────────────────────────────────────────────

async function sheetsRequest(
  method: string,
  urlPath: string,
  token: string,
  body?: any,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        hostname: "sheets.googleapis.com",
        path:     urlPath,
        method,
        headers: {
          Authorization:  `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function ensureHeader(token: string): Promise<void> {
  const range    = encodeURIComponent(`${SHEET_NAME}!A1:R1`);
  const existing = await sheetsRequest(
    "GET",
    `/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}`,
    token,
  );
  const values = existing?.values?.[0];
  if (!values || values.length === 0) {
    await sheetsRequest(
      "PUT",
      `/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(`${SHEET_NAME}!A1`)}?valueInputOption=RAW`,
      token,
      { values: [HEADER] },
    );
    console.log(`[DRIVE_EXPORT_V1] cabeçalho criado na aba "${SHEET_NAME}"`);
  }
}

async function appendRow(token: string, row: any[]): Promise<void> {
  const range = encodeURIComponent(`${SHEET_NAME}!A1`);
  const res   = await sheetsRequest(
    "POST",
    `/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    token,
    { values: [row] },
  );
  if (res?.error) throw new Error(`Sheets API: ${JSON.stringify(res.error)}`);
}

// ─── exportSnapshot (ponto de entrada) ───────────────────────────────────────

export async function exportSnapshot(id: number, p: SnapshotPayload): Promise<void> {
  if (!DRIVE_ENABLED) {
    throw new Error(
      `[DRIVE_EXPORT_V1] desabilitado (DRIVE_EXPORT_ENABLED != 1) — id=${id} permanece pending`,
    );
  }

  if (!SA_KEY_PATH || !SPREADSHEET_ID) {
    throw new Error("[DRIVE_EXPORT_V1] GOOGLE_SA_KEY_PATH ou SPREADSHEET_ID não configurados");
  }

  const creds = JSON.parse(fs.readFileSync(SA_KEY_PATH, "utf8"));
  const token = await getAccessToken(creds);

  await ensureHeader(token);

  const c   = p.snapshot_json.cadastro;
  const { etiqueta, chicote } = gsensorToEtiquetaChicote(c.gsensor);
  const canSummary = formatCanSummary(p.snapshot_json.can);
  const row = [
    id,
    new Date(p.snapshot_json.ts).toISOString(),
    c.plate_real        ?? "",
    p.serial            ?? "",
    c.technician?.nick  ?? c.technician?.id ?? "",
    c.client            ?? "",
    c.service           ?? "",
    c.vehicle?.manufacturer ?? "",
    c.vehicle?.model        ?? "",
    c.vehicle?.year         ?? "",
    c.cor               ?? "",
    c.chassi            ?? "",
    c.localInstalacao   ?? "",
    c.comment           ?? "",
    p.job_id,
    etiqueta,
    chicote,
    canSummary,
  ];

  await appendRow(token, row);
  console.log(`[DRIVE_EXPORT_V1] exportado id=${id} plate=${p.plate} → Sheets ✅`);
}
