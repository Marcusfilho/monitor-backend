/**
 * schemeSelectionService.ts
 * Fonte única de verdade: active-config.json gerenciado pela internal-tools (configpage).
 *   Formato: { settings: { [clientId]: { vehicleSettingId, settingName, updatedAt } }, ... }
 *   Path via env ACTIVE_CONFIG_PATH (default /home/questar/internal-tools/active-config.json).
 *   Recarrega automaticamente quando o mtime muda — reflete edições do operador sem restart.
 *
 * Fallback legado: config/schemes_selection.json (formato { clients:[{client_id, selected_scheme_id}] }),
 *   consultado só para clientes ausentes no active-config.json.
 */
import * as fs from "fs";
import * as path from "path";

const ACTIVE_CONFIG_PATH = process.env.ACTIVE_CONFIG_PATH
  || "/home/questar/internal-tools/active-config.json";
const LEGACY_PATH = path.resolve(__dirname, "../../config/schemes_selection.json");

// ── active-config.json (primário) ─────────────────────────────────────────────
let _activeCache: Record<string, { vehicleSettingId?: string }> | null = null;
let _activeMtime = 0;

function loadActive(): Record<string, { vehicleSettingId?: string }> {
  try {
    const mtime = fs.statSync(ACTIVE_CONFIG_PATH).mtimeMs;
    if (_activeCache && mtime === _activeMtime) return _activeCache;
    const data = JSON.parse(fs.readFileSync(ACTIVE_CONFIG_PATH, "utf8"));
    _activeCache = data?.settings ?? {};
    _activeMtime = mtime;
    return _activeCache!;
  } catch (e: any) {
    console.error("[schemeSelection] falha ao ler active-config.json:", e?.message);
    return _activeCache ?? {};
  }
}

// ── schemes_selection.json (fallback legado) ──────────────────────────────────
interface LegacyEntry { client_id: number; selected_scheme_id: number; }
let _legacyCache: LegacyEntry[] | null = null;
let _legacyMtime = 0;

function loadLegacy(): LegacyEntry[] {
  try {
    const mtime = fs.statSync(LEGACY_PATH).mtimeMs;
    if (_legacyCache && mtime === _legacyMtime) return _legacyCache;
    const data = JSON.parse(fs.readFileSync(LEGACY_PATH, "utf8"));
    _legacyCache = Array.isArray(data) ? data : (data.clients ?? []);
    _legacyMtime = mtime;
    return _legacyCache!;
  } catch (e: any) {
    console.error("[schemeSelection] falha ao ler schemes_selection.json:", e?.message);
    return _legacyCache ?? [];
  }
}

export function getSelectedSchemeId(clientId: number | string): string | null {
  const key = String(clientId).trim();

  // 1. active-config.json (fonte única gerenciada pela internal-tools)
  const active = loadActive()[key];
  const settingId = active?.vehicleSettingId && String(active.vehicleSettingId).trim();
  if (settingId) return settingId;

  // 2. fallback legado para clientes ainda não presentes no active-config.json
  const id    = Number(clientId);
  const entry = loadLegacy().find(c => c.client_id === id);
  if (entry?.selected_scheme_id) return String(entry.selected_scheme_id);

  return null;
}

export function invalidateSchemeCache(): void {
  _activeCache = null; _activeMtime = 0;
  _legacyCache = null; _legacyMtime = 0;
}
