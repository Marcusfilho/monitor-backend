/**
 * changeCompanyService.ts
 * Executa CHANGE_COMPANY: move um vehicle_id para outro cliente.
 *
 * Fluxo:
 *  1. LOGIN_USER_GROUPS → encontra GROUP_ID raiz do cliente destino
 *  2. ASSET_BASIC_SAVE com payload completo (campos do veículo + CLIENT_ID + GROUP_ID destino)
 *
 * O caller passa vhclsData com os campos do veículo já conhecidos (do VHCLS).
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
// HTTP helper
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
    const group_id      = attr("GROUP_ID");
    const client_descr  = attr("CLIENT_DESCR");
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
  cfg         : Html5SessionConfig,
  clientDescr : string,
  clientIdDest: string,
  jobId       : string | number
): Promise<string | null> {
  const r = await appenginePost(cfg, "LOGIN_USER_GROUPS", { VERSION_ID: "2" }, "CHANGE_COMPANY_GROUPS");

  if (r.loginNeg) {
    console.log(`[changeCompany] job=${jobId} LOGIN_USER_GROUPS loginNeg`);
    return null;
  }

  const groups = parseGroupsXml(r.text);
  console.log(`[changeCompany] job=${jobId} LOGIN_USER_GROUPS total grupos=${groups.length}`);

  const clientGroups = groups.filter(
    g => g.client_descr.trim().toUpperCase() === clientDescr.trim().toUpperCase()
  );
  console.log(`[changeCompany] job=${jobId} grupos do cliente "${clientDescr}": ${clientGroups.length}`);

  if (clientGroups.length === 0) {
    console.log(`[changeCompany] job=${jobId} cliente "${clientDescr}" não encontrado nos grupos`);
    return null;
  }

  const rootGroup = clientGroups.find(g => g.parent_object === "227807");
  if (!rootGroup) {
    console.log(
      `[changeCompany] job=${jobId} PARENT_OBJECT=227807 não encontrado para "${clientDescr}". ` +
      `Grupos: ${clientGroups.map(g => `GROUP_ID=${g.group_id} PARENT=${g.parent_object}`).join(" | ")}`
    );
    return null;
  }

  console.log(`[changeCompany] job=${jobId} grupo raiz: GROUP_ID=${rootGroup.group_id} para "${clientDescr}"`);
  return rootGroup.group_id;
}

// ---------------------------------------------------------------------------
// Passo 2: ASSET_BASIC_SAVE com payload completo
// Os campos do veículo vêm do vhclsData (já disponível no installWorker via VHCLS)
// ---------------------------------------------------------------------------

async function assetBasicSave(
  cfg       : Html5SessionConfig,
  vehicleId : string | number,
  clientId  : string | number,
  groupId   : string,
  jobId     : string | number,
  vhclsData : Record<string, string> = {}
): Promise<{ ok: boolean; error?: string }> {
  const v = vhclsData;

  const fields: Record<string, string> = {
    VERSION_ID              : "2",
    VEHICLE_ID              : String(vehicleId),
    ASSET_ID                : String(v.VEHICLE_ID || vehicleId),
    ASSET_DESCRIPTION       : String(v.LICENSE_NMBR || v.ASSET_DESCRIPTION || ""),
    CLIENT_ID               : String(clientId),
    GROUP_ID                : String(groupId),
    DRIVER_ID               : "undefined",
    URL                     : String(v.URL || "Images/icons/Vehicles/V2S0.png"),
    UNIT_TYPE_DESCR         : String(v.UNIT_TYPE || v.UNIT_TYPE_DESCR || "SPETROTEC"),
    MODEL_CODE              : String(v.ASSET_TYPE || v.MODEL_CODE || ""),
    ASSET_TYPE_DESCR        : String(
      v.MANUFACTURER_DESCR && v.MODEL
        ? v.MANUFACTURER_DESCR + " " + v.MODEL
        : v.ASSET_TYPE_DESCR || ""
    ),
    UNIT                    : String(v.INNER_ID || v.UNIT || ""),
    FIRMWARE                : String(v.FIRMWARE || ""),
    CHASSIS_SERIAL          : "",
    INTERNAL_VALUE          : "",
    LICENSE_TYPE_CODE       : "0",
    BODY_CONFIGURATION_CODE : "0",
    LETTERS_SEND_BY_CODE    : "0",
    VEHICLE_STATUS_CODE     : "0",
    NEXT_SER_KM             : "0",
    NEXT_SER_ENG            : "0",
    MODEL_YEAR              : "0",
    TIRES                   : "0",
    DRAGGING_HOOK           : "0",
    IN_GARAGE               : "0",
    GCW                     : "",
    TOTAL_WEIGHT_1          : "",
    FUEL_I_VOLUME           : "",
    FUEL_II_VOLUME          : "",
    FUEL_COST               : "",
    VEHICLE_MIN_FUEL_CONS   : "",
    VEHICLE_MAX_FUEL_CONS   : "",
    POINT_ZERO_FUEL_CONS    : "",
    MONTHLY_MILEAGE_LIMIT   : "",
    PARKING_SCM_ID          : "",
    FUEL_TYPE_ID            : "",
  };

  const r = await appenginePost(cfg, "ASSET_BASIC_SAVE", fields, "CHANGE_COMPANY_SAVE");
  const text = String(r.text || "");

  const isError =
    /<TEXT>\s*Action:\s*ASSET_BASIC_SAVE\s*error/i.test(text) ||
    /ASSET_BASIC_SAVE\s*error/i.test(text) ||
    /<ERROR\b/i.test(text) ||
    /No privilege to edit/i.test(text);

  if (r.loginNeg) {
    console.log(`[changeCompany] job=${jobId} ASSET_BASIC_SAVE loginNeg`);
    return { ok: false, error: "asset_basic_save_loginneg" };
  }
  if (isError) {
    console.log(`[changeCompany] job=${jobId} ASSET_BASIC_SAVE error: ${text.slice(0, 300)}`);
    return { ok: false, error: "asset_basic_save_action_error" };
  }
  console.log(`[changeCompany] job=${jobId} ASSET_BASIC_SAVE OK vehicle_id=${vehicleId} → client_id=${clientId} group_id=${groupId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ponto de entrada público
// ---------------------------------------------------------------------------

export async function executeChangeCompany(
  cfg         : Html5SessionConfig,
  vehicleId   : string | number,
  clientIdDest: string | number,
  clientDescr : string,
  jobId       : string | number,
  vhclsData   : Record<string, string> = {}
): Promise<ChangeCompanyResult> {
  console.log(
    `[changeCompany] job=${jobId} iniciando CHANGE_COMPANY ` +
    `vehicle_id=${vehicleId} → client_id=${clientIdDest} ("${clientDescr}")`
  );

  const groupId = await findRootGroupId(cfg, clientDescr, String(clientIdDest), jobId);
  if (!groupId) {
    return { ok: false, error: `grupo raiz não encontrado para "${clientDescr}"` };
  }

  const saveResult = await assetBasicSave(cfg, vehicleId, clientIdDest, groupId, jobId, vhclsData);
  if (!saveResult.ok) {
    return { ok: false, error: saveResult.error ?? "asset_basic_save_failed" };
  }

  return { ok: true, group_id: groupId, client_id: String(clientIdDest) };
}
