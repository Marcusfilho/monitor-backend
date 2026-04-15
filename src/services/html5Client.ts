// src/services/html5Client.ts
// Cliente HTTP reutilizável para o HTML5 do Traffilog.
// Não depende do WebSocket — usa cookie jar salvo em disco.

import * as fs from "fs";
import * as https from "https";

const HTML5_ACTION_URL = (
  process.env.HTML5_ACTION_URL || "https://html5.traffilog.com/AppEngine_2_1/default.aspx"
).trim();

const HTML5_COOKIEJAR_PATH = (
  process.env.HTML5_COOKIEJAR_PATH || "/tmp/html5_cookiejar.json"
).trim();

const HTML5_TIMEOUT_MS = Number(process.env.HTML5_TIMEOUT_MS || "10000");

// ---------------------------------------------------------------------------
// Cookie jar
// ---------------------------------------------------------------------------

export function readHtml5Cookie(): string {
  try {
    if (!fs.existsSync(HTML5_COOKIEJAR_PATH)) return "";
    const raw = fs.readFileSync(HTML5_COOKIEJAR_PATH, "utf8").trim();
    if (!raw) return "";
    let j: any = null;
    try { j = JSON.parse(raw); } catch { return raw; }
    if (!j) return "";
    if (typeof j === "string") return j.trim();
    if (typeof j.cookieHeader === "string") return j.cookieHeader.trim();
    if (typeof j.cookie === "string") return j.cookie.trim();
    return "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// HTTP POST genérico ao HTML5
// ---------------------------------------------------------------------------

export function html5Post(bodyParams: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const bodyStr = Object.entries(bodyParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      const body = Buffer.from(bodyStr, "utf8");

      const cookieHeader = readHtml5Cookie();
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(body.length),
        "accept": "*/*",
        "origin": "https://html5.traffilog.com",
        "referer": "https://html5.traffilog.com/appv2/index.htm",
      };
      if (cookieHeader) headers["cookie"] = cookieHeader;

      const u = new URL(HTML5_ACTION_URL);
      const req = https.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port ? Number(u.port) : 443,
          path: (u.pathname || "/") + (u.search || ""),
          method: "POST",
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: any) => chunks.push(Buffer.from(c)));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          res.on("error", reject);
        }
      );

      req.setTimeout(HTML5_TIMEOUT_MS, () => {
        req.destroy();
        reject(new Error(`[html5] timeout após ${HTML5_TIMEOUT_MS}ms`));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ---------------------------------------------------------------------------
// VHCLS — busca veículos por placa ou serial
// ---------------------------------------------------------------------------

export interface VhclsRecord {
  vehicle_id: number;
  licence_nmbr: string;
  inner_id: string;       // vazio ("") quando sem serial instalado
  client_id: number;
  client_descr: string;
  unit_id: string;
}

function parseVhclsXml(xml: string): VhclsRecord[] {
  const records: VhclsRecord[] = [];
  // Extrai cada bloco <DATA .../>
  const dataRe = /<DATA\s([^>]*?)\/>/gi;
  let m: RegExpExecArray | null;

  while ((m = dataRe.exec(xml)) !== null) {
    const attrs = m[1];

    function attr(name: string): string {
      const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i");
      const hit = attrs.match(re);
      return hit ? hit[1].trim() : "";
    }

    const vehicleId = Number(attr("VEHICLE_ID"));
    if (!vehicleId) continue;

    // INNER_ID vem como "0000000913039454" quando tem serial,
    // ou ausente / vazio quando não tem serial instalado.
    const rawInnerId = attr("INNER_ID");

    records.push({
      vehicle_id: vehicleId,
      licence_nmbr: attr("LICENSE_NMBR"),
      inner_id: rawInnerId,
      client_id: Number(attr("CLIENT_ID")),
      client_descr: attr("CLIENT_DESCR"),
      unit_id: attr("UNIT_ID"),
    });
  }

  return records;
}

export async function vhclsQueryByPlate(licenceNmbr: string): Promise<VhclsRecord[]> {
  const xml = await html5Post({
    REFRESH_FLG: "1",
    LICENSE_NMBR: licenceNmbr,
    CLIENT_DESCR: "",
    OWNER_DESCR: "",
    DIAL_NMBR: "",
    INNER_ID: "",
    action: "VHCLS",
    VERSION_ID: "2",
  });
  return parseVhclsXml(xml);
}

export async function vhclsQueryBySerial(innerId: string): Promise<VhclsRecord[]> {
  const xml = await html5Post({
    REFRESH_FLG: "1",
    LICENSE_NMBR: "",
    CLIENT_DESCR: "",
    OWNER_DESCR: "",
    DIAL_NMBR: "",
    INNER_ID: innerId,
    action: "VHCLS",
    VERSION_ID: "2",
  });
  return parseVhclsXml(xml);
}

// ---------------------------------------------------------------------------
// Helpers de comparação
// ---------------------------------------------------------------------------

// inner_id "vazio" = ausente, "", ou só zeros
export function isEmptyInnerId(v: string): boolean {
  return !v || /^0+$/.test(v.trim());
}

// Normaliza serial para comparação: remove zeros à esquerda e espaços
export function normalizeSerial(v: string): string {
  return v.trim().replace(/^0+/, "") || "0";
}

export function serialsMatch(a: string, b: string): boolean {
  return normalizeSerial(a) === normalizeSerial(b);
}

// ---------------------------------------------------------------------------
// CLIENTS — lista todos os clientes disponíveis na sessão HTML5
// ---------------------------------------------------------------------------

export interface ClientRecord {
  client_id: number;
  client_descr: string;
  default_group_name: string;
}

function parseClientsXml(xml: string): ClientRecord[] {
  const records: ClientRecord[] = [];

  // Tenta <CLIENT CLIENT_ID="..." CLIENT_DESCR="..." DEFAULT_GROUP_NAME="..." />
  const re = /<CLIENT\s([^>]*?)\/>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];

    function attr(name: string): string {
      const hit = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
      return hit ? hit[1].trim() : "";
    }

    const clientId = Number(attr("CLIENT_ID"));
    if (!clientId) continue;

    records.push({
      client_id:          clientId,
      client_descr:       attr("CLIENT_DESCR"),
      default_group_name: attr("DEFAULT_GROUP_NAME"),
    });
  }

  return records;
}

export async function clientsQuery(): Promise<ClientRecord[]> {
  const xml = await html5Post({
    REFRESH_FLG: "1",
    action:      "CLIENTS",
    VERSION_ID:  "2",
  });
  return parseClientsXml(xml);
}
