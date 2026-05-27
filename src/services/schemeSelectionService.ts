/**
 * schemeSelectionService.ts
 * Lê config/schemes_selection.json e retorna o selected_scheme_id para um client_id.
 * Suporta formato array [ { client_id, selected_scheme_id, ... } ]
 * e formato legado { clients: [ ... ] }
 */
import * as fs from "fs";
import * as path from "path";

const SCHEMES_PATH = path.resolve(__dirname, "../../config/schemes_selection.json");

interface SchemeEntry {
  client_id: number;
  selected_scheme_id: number;
}

let _cache: SchemeEntry[] | null = null;

function load(): SchemeEntry[] {
  if (_cache) return _cache;
  try {
    const raw  = fs.readFileSync(SCHEMES_PATH, "utf8");
    const data = JSON.parse(raw);
    // suporta array direto ou { clients: [...] }
    _cache = Array.isArray(data) ? data : (data.clients ?? []);
    return _cache!;
  } catch (e: any) {
    console.error("[schemeSelection] falha ao ler schemes_selection.json:", e?.message);
    return [];
  }
}

export function getSelectedSchemeId(clientId: number | string): string | null {
  const entries = load();
  const id      = Number(clientId);
  const entry   = entries.find(c => c.client_id === id);
  if (!entry?.selected_scheme_id) return null;
  return String(entry.selected_scheme_id);
}

export function invalidateSchemeCache(): void {
  _cache = null;
}
