// sharepointPhotoUploader.ts — upload de fotos de instalação para SharePoint
// Estrutura: Arquivos SDL/Operação/Clientes/Fotos Instalações/{cliente}/{placa}/{TipoN.ext}
// Auth: reutiliza credenciais SP_* do .env (mesmas do sharepointExporter)

const TENANT_ID     = (process.env.SP_TENANT_ID     || "").trim();
const CLIENT_ID     = (process.env.SP_CLIENT_ID     || "").trim();
const CLIENT_SECRET = (process.env.SP_CLIENT_SECRET || "").trim();
const SITE_HOST     = (process.env.SP_SITE_HOST     || "smartdrivinglabs.sharepoint.com").trim();
const SITE_PATH     = (process.env.SP_SITE_PATH     || "/sites/SmartDrivingLabs").trim();
const DRIVE_NAME    = (process.env.SP_PHOTOS_DRIVE  || "Arquivos SDL").trim();
const PHOTOS_ROOT   = (process.env.SP_PHOTOS_ROOT   || "Operação/Clientes/Fotos Instalações").trim();

const GRAPH_BASE = "https://graph.microsoft.com";
const TOKEN_URL  = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

// ─── cache ────────────────────────────────────────────────────────────────────
let _token    : string | null = null;
let _tokenExp = 0;
let _siteId   : string | null = null;
let _driveId  : string | null = null;

// ─── types ────────────────────────────────────────────────────────────────────
export const ALLOWED_PHOTO_TYPES = [
  "Cabeamento", "LocalInstalacao", "Veiculo",
  "Equipamento", "Placa", "Chassi", "Documento",
] as const;
export type PhotoType = typeof ALLOWED_PHOTO_TYPES[number];

export interface UploadPhotoParams {
  type        : PhotoType;
  clientDescr : string;
  plate       : string;   // plate_real
  fleet       : string;   // pode ser ""
  buffer      : Buffer;
  mimeType    : string;
  ext         : string;   // ".jpg", ".png", etc.
}

export interface UploadPhotoResult {
  ok     : boolean;
  name   : string;
  webUrl : string;
  error ?: string;
}

// ─── OAuth2 ───────────────────────────────────────────────────────────────────
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
    throw new Error(`[SP_PHOTOS] token falhou ${res.status}: ${JSON.stringify(data)}`);
  }
  _token    = data.access_token;
  _tokenExp = now + (data.expires_in ?? 3600);
  return _token!;
}

// ─── Graph helpers ────────────────────────────────────────────────────────────
async function _get(token: string, path: string): Promise<any> {
  const res  = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  const data: any = await res.json();
  if (!res.ok) throw new Error(`[SP_PHOTOS] GET ${path} → ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
  return data;
}

async function _put(token: string, path: string, body: Buffer, contentType: string): Promise<any> {
  const res  = await fetch(`${GRAPH_BASE}${path}`, {
    method : "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body,
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`[SP_PHOTOS] PUT ${path} → ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
  return data;
}

// ─── descoberta de siteId + driveId (cached) ──────────────────────────────────
async function _getIds(token: string): Promise<{ siteId: string; driveId: string }> {
  if (_siteId && _driveId) return { siteId: _siteId, driveId: _driveId };

  const site = await _get(token, `/v1.0/sites/${SITE_HOST}:${SITE_PATH}`);
  _siteId = site.id;

  const drivesData: any = await _get(token, `/v1.0/sites/${_siteId}/drives?$select=id,name`);
  const drives: any[] = drivesData?.value ?? [];
  const found = drives.find((d: any) => d.name === DRIVE_NAME);
  if (!found) throw new Error(`[SP_PHOTOS] drive "${DRIVE_NAME}" não encontrado (drives: ${drives.map((d:any)=>d.name).join(", ")})`);
  _driveId = found.id;

  console.log(`[SP_PHOTOS] siteId=${_siteId} driveId=${_driveId} drive="${DRIVE_NAME}"`);
  return { siteId: _siteId!, driveId: _driveId! };
}

// ─── sanitiza nome de pasta (remove chars inválidos do SP) ───────────────────
function _sanitize(s: string): string {
  return s
    .replace(/[\\/:*?"<>|#%]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 120)
    || "sem_nome";
}

// ─── codifica path preservando barras ─────────────────────────────────────────
function _encodePath(segments: string[]): string {
  return segments.map(s => encodeURIComponent(s)).join("/");
}

// ─── próximo número sequencial para o tipo ────────────────────────────────────
async function _nextNumber(token: string, driveId: string, folderPath: string, prefix: string): Promise<number> {
  const encoded = _encodePath(folderPath.split("/"));
  const data    = await _get(token, `/v1.0/drives/${driveId}/root:/${encoded}:/children?$select=name&$top=200`);
  if (!data) return 1; // pasta não existe

  const files: any[] = data.value ?? [];
  const re   = new RegExp(`^${prefix}(\\d+)\\.`, "i");
  let   max  = 0;
  for (const f of files) {
    const m = re.exec(f.name ?? "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

// ─── upload principal ─────────────────────────────────────────────────────────
export async function uploadInstallationPhoto(p: UploadPhotoParams): Promise<UploadPhotoResult> {
  const token              = await _getToken();
  const { driveId }        = await _getIds(token);

  const clientFolder = _sanitize(p.clientDescr);
  const plateFolder  = _sanitize(p.fleet ? `${p.fleet} - ${p.plate}` : p.plate);
  const folderPath   = `${PHOTOS_ROOT}/${clientFolder}/${plateFolder}`;

  const n        = await _nextNumber(token, driveId, folderPath, p.type);
  const filename  = `${p.type}${n}${p.ext}`;
  const filePath  = `${folderPath}/${filename}`;
  const encoded   = _encodePath(filePath.split("/"));

  const item = await _put(token, `/v1.0/drives/${driveId}/root:/${encoded}:/content`, p.buffer, p.mimeType);

  console.log(`[SP_PHOTOS] ✅ ${filename} → ${folderPath}`);
  return { ok: true, name: filename, webUrl: item.webUrl ?? "" };
}
