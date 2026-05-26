/**
 * schemeSelectionService.ts
 * Lê config/schemes_selection.json e retorna o selected_scheme_id para um client_id.
 */
import * as fs from "fs";
import * as path from "path";

const SCHEMES_PATH = path.resolve(__dirname, "../../config/schemes_selection.json");

interface SchemeEntry {
  client_id: number;
  selected_scheme_id: number;
}

interface SchemesFile {
  clients: SchemeEntry[];
}

let _cache: SchemesFile | null = null;

function load(): SchemesFile {
  if (_cache) return _cache;
  try {
    const raw = fs.readFileSync(SCHEMES_PATH, "utf8");
    _cache = JSON.parse(raw) as SchemesFile;
    return _cache;
  } catch (e: any) {
    console.error("[schemeSelection] falha ao ler schemes_selection.json:", e?.message);
    return { clients: [] };
  }
}

export function getSelectedSchemeId(clientId: number | string): string | null {
  const data = load();
  const id = Number(clientId);
  const entry = data.clients.find(c => c.client_id === id);
  if (!entry?.selected_scheme_id) return null;
  return String(entry.selected_scheme_id);
}

// Invalida cache (útil após atualização do arquivo via tela de configuração)
export function invalidateSchemeCache(): void {
  _cache = null;
}
