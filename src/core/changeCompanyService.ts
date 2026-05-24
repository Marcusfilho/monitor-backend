/**
 * changeCompanyService.ts
 * Executa CHANGE_COMPANY: move um vehicle_id para outro cliente.
 *
 * Fluxo:
 *  1. LOGIN_USER_GROUPS (sem payload — usa sessão admin do jar)
 *  2. Filtra grupos pelo CLIENT_DESCR do cliente destino
 *  3. Dentro desses grupos, pega o que tem PARENT_OBJECT === "227807" (grupo raiz)
 *  4. ASSET_BASIC_SAVE com VEHICLE_ID + CLIENT_ID destino + GROUP_ID encontrado
 *
 * Condição de chamada (regra de negócio — Caminho B):
 *   SE clientId_do_vehicle_id != clientId_do_cadastro → chamar CHANGE_COMPANY
 *
 * NÃO contém lógica de job, VHCLS, MWS ou workers.
 * Depende de: html5Session (sessão/cookie admin)
 */

import { ensureHtml5Session, readJarCookie, ensureCookieDefaults, Html5SessionConfig } from "./html5Session";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface GroupRecord {
  group_id      : string;
  client_descr  : string;
  parent_object : string;
}

export type ChangeCompanyResult =
  | { ok: true;  group_id: string; client_id: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// HTTP helper (POST ao AppEngine — reutiliza padrão do projeto)
// ---------------------------------------------------------------------------

async function appenginePost(
  cfg    : Html5SessionConfig,
  action : string,
  fields : Record<string, string>,
  tag    : string
): Promise<{ status: number; text: string; loginNeg: boolean }> {
  await ensureHtml5Session(cfg, tag).catch(() => {});

  const cookieHeader = ensureCookieDefaults(readJarCookie(cfg.cookieJarPath));

  const params = new URLSearchParams();
  params.set("action", action);
  for (const [k, v] of Object.entries(fields)) params.set(k, String(v ?? ""));

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), cfg.httpTimeoutMs);

  try {
    const res = await fetch(cfg.actionUrl, {
      method : "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "accept"      : "*/*",
        "origin"      : "https://html5.traffilog.com",
        "referer"     : "https://html5.traffilog.com/appv2/index.htm",
        "user-agent"  : "monitor-backend-html5-worker/rw",
        "cookie"      : cookieHeader,
      },
      body  : params.toString(),
      signal: controller.signal,
    });
    const text     = await res.text().catch(() => "");
    const loginNeg = /login\s*=\s*"-1"/i.test(text) || /<!DOCTYPE\s+html/i.test(text);
    console.log(`[changeCompany] [${tag}] action=${action} http=${res.status} len=${text.length} loginNeg=${loginNeg ? 1 : 0}`);
    return { status: res.status, text, loginNeg };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Parse do XML de LOGIN_USER_GROUPS
// Formato: <GROUP GROUP_ID="..." CLIENT_DESCR="..." PARENT_OBJECT="..." ... />
// ---------------------------------------------------------------------------

function parseGroupsXml(xml: string): GroupRecord[] {
  const records: GroupRecord[] = [];
  const re = /<GROUP\s([^>]*?)\/>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];

    function attr(name: string): string {
      const hit = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
      return hit ? hit[1].trim() : "";
    }

    const group_id     = attr("GROUP_ID");
    const client_descr = attr("CLIENT_DESCR");
    const parent_object = attr("PARENT_OBJECT");

    if (!group_id) continue;

    records.push({ group_id, client_descr, parent_object });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Passo 1: LOGIN_USER_GROUPS → encontra GROUP_ID raiz do cliente destino
// ---------------------------------------------------------------------------

async function findRootGroupId(
  cfg          : Html5SessionConfig,
  clientDescr  : string,  // CLIENT_DESCR do cliente destino (ex: "Empresa XYZ")
  clientIdDest : string,  // CLIENT_ID destino (para log)
  jobId        : string | number
): Promise<string | null> {
  const r = await appenginePost(cfg, "LOGIN_USER_GROUPS", { VERSION_ID: "2" }, "CHANGE_COMPANY_GROUPS");

  if (r.loginNeg) {
    console.log(`[changeCompany] job=${jobId} LOGIN_USER_GROUPS loginNeg — sessão expirada`);
    return null;
  }

  const groups = parseGroupsXml(r.text);
  console.log(`[changeCompany] job=${jobId} LOGIN_USER_GROUPS total grupos=${groups.length}`);

  // Filtra grupos do cliente destino
  const clientGroups = groups.filter(
    g => g.client_descr.trim().toUpperCase() === clientDescr.trim().toUpperCase()
  );

  console.log(`[changeCompany] job=${jobId} grupos do cliente "${clientDescr}": ${clientGroups.length}`);

  if (clientGroups.length === 0) {
    console.log(`[changeCompany] job=${jobId} cliente "${clientDescr}" não encontrado nos grupos`);
    return null;
  }

  // Grupo raiz = PARENT_OBJECT === "227807"
  const rootGroup = clientGroups.find(g => g.parent_object === "227807");

  if (!rootGroup) {
    // Fallback: se não encontrou 227807, loga todos os grupos do cliente para diagnóstico
    console.log(
      `[changeCompany] job=${jobId} PARENT_OBJECT=227807 não encontrado para "${clientDescr}". ` +
      `Grupos disponíveis: ${clientGroups.map(g => `GROUP_ID=${g.group_id} PARENT=${g.parent_object}`).join(" | ")}`
    );
    return null;
  }

  console.log(`[changeCompany] job=${jobId} grupo raiz encontrado: GROUP_ID=${rootGroup.group_id} para cliente "${clientDescr}"`);
  return rootGroup.group_id;
}

// ---------------------------------------------------------------------------
// Passo 2: ASSET_BASIC_SAVE → move vehicle_id para o cliente destino
// Payload mínimo: VEHICLE_ID + CLIENT_ID + GROUP_ID (ignorar demais campos)
// ---------------------------------------------------------------------------

async function assetBasicSave(
  cfg      : Html5SessionConfig,
  vehicleId: string | number,
  clientId : string | number,
  groupId  : string,
  jobId    : string | number
): Promise<{ ok: boolean; error?: string }> {
  const r = await appenginePost(cfg, "ASSET_BASIC_SAVE", {
    VERSION_ID: "2",
    VEHICLE_ID: String(vehicleId),
    CLIENT_ID : String(clientId),
    GROUP_ID  : String(groupId),
  }, "CHANGE_COMPANY_SAVE");

  const text = String(r.text || "");

  const isError =
    /<TEXT>\s*Action:\s*ASSET_BASIC_SAVE\s*error/i.test(text) ||
    /ASSET_BASIC_SAVE\s*error/i.test(text) ||
    /<ERROR\b/i.test(text);

  if (r.loginNeg) {
    console.log(`[changeCompany] job=${jobId} ASSET_BASIC_SAVE loginNeg`);
    return { ok: false, error: "asset_basic_save_loginneg" };
  }

  if (isError) {
    console.log(`[changeCompany] job=${jobId} ASSET_BASIC_SAVE action_error: ${text.slice(0, 200)}`);
    return { ok: false, error: "asset_basic_save_action_error" };
  }

  console.log(`[changeCompany] job=${jobId} ASSET_BASIC_SAVE OK vehicle_id=${vehicleId} → client_id=${clientId} group_id=${groupId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ponto de entrada público
// ---------------------------------------------------------------------------

/**
 * Executa CHANGE_COMPANY: move vehicle_id para o cliente destino.
 *
 * @param vehicleId    vehicle_id a mover
 * @param clientIdDest CLIENT_ID do cliente destino
 * @param clientDescr  CLIENT_DESCR do cliente destino (para localizar GROUP_ID)
 * @param jobId        ID do job (para logs)
 */
export async function executeChangeCompany(
  cfg         : Html5SessionConfig,
  vehicleId   : string | number,
  clientIdDest: string | number,
  clientDescr : string,
  jobId       : string | number
): Promise<ChangeCompanyResult> {
  console.log(
    `[changeCompany] job=${jobId} iniciando CHANGE_COMPANY ` +
    `vehicle_id=${vehicleId} → client_id=${clientIdDest} ("${clientDescr}")`
  );

  // Passo 1: encontra GROUP_ID raiz do cliente destino
  const groupId = await findRootGroupId(cfg, clientDescr, String(clientIdDest), jobId);

  if (!groupId) {
    return {
      ok   : false,
      error: `grupo raiz não encontrado para cliente "${clientDescr}" (PARENT_OBJECT=227807)`,
    };
  }

  // Passo 2: ASSET_BASIC_SAVE
  const saveResult = await assetBasicSave(cfg, vehicleId, clientIdDest, groupId, jobId);

  if (!saveResult.ok) {
    return { ok: false, error: saveResult.error ?? "asset_basic_save_failed" };
  }

  return { ok: true, group_id: groupId, client_id: String(clientIdDest) };
}
