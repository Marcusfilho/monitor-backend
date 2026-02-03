"use strict";

// PATCH_C8_ALLOWED_GROUPS
// Regra:
// - default: usar GROUP_ID do nível 3 do cliente (match por nome)
// - override opcional: aceitar group_id_target se estiver em nível 4/5 e pertencer ao mesmo cliente

function _normName(v){
  return String(v || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function _getLevel(g){
  const v = g && (g.group_hierarchy_level ?? g.level ?? g.hierarchy_level);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function _getId(g){
  return g && (g.group_id ?? g.GROUP_ID ?? g.id ?? g.groupId ?? null);
}

function _getName(g){
  return g && (g.group_name ?? g.name ?? g.groupName ?? "");
}

function _findById(list, id){
  const want = String(id);
  return (list || []).find(g => String(_getId(g)) === want) || null;
}

function _pickClientLevel3Group(allowedGroups, clientName){
  const tgt = _normName(clientName);
  const lvl3 = (allowedGroups || []).filter(g => _getLevel(g) === 3);

  // 1) match exato
  let hit = lvl3.find(g => _normName(_getName(g)) === tgt);
  if (hit) return hit;

  // 2) match parcial (contém)
  hit = lvl3.find(g => {
    const n = _normName(_getName(g));
    return n.includes(tgt) || tgt.includes(n);
  });
  if (hit) return hit;

  // 3) fallback: primeiro lvl3
  return lvl3[0] || null;
}

function _belongsToClientGroup(child, clientGroup, allowedGroups){
  const rootId = _getId(clientGroup);
  const childId = _getId(child);
  if (!rootId || !childId) return false;

  const root = String(rootId);
  const parentKeys = ["parent_group_id","parent_id","parentGroupId","parent_object","group_parent_id"];
  let cur = child;
  const seen = new Set([String(childId)]);

  // tenta subir cadeia por parent_*
  for (let i=0; i<10; i++){
    let pid = null;
    for (const k of parentKeys){
      if (cur && cur[k] !== undefined && cur[k] !== null && String(cur[k]).trim() !== ""){
        pid = String(cur[k]);
        break;
      }
    }
    if (!pid) break;
    if (pid === root) return true;
    if (seen.has(pid)) break;
    seen.add(pid);
    cur = _findById(allowedGroups, pid);
    if (!cur) break;
  }

  // fallback por nome (menos forte)
  const a = _normName(_getName(clientGroup));
  const b = _normName(_getName(child));
  return a && b ? b.includes(a) : false;
}

function resolveGroupIdFromAllowedGroups(allowedGroups, clientName, groupIdTarget){
  if (!Array.isArray(allowedGroups) || allowedGroups.length === 0){
    return { ok:false, error:"allowedGroups empty" };
  }
  if (!clientName){
    return { ok:false, error:"missing clientName" };
  }

  const clientGroup = _pickClientLevel3Group(allowedGroups, clientName);
  const clientGroupId = _getId(clientGroup);
  if (!clientGroupId){
    return { ok:false, error:"client level3 group not found" };
  }

  const base = { ok:true, clientGroupId:String(clientGroupId) };

  const tgt = (groupIdTarget !== undefined && groupIdTarget !== null && String(groupIdTarget).trim() !== "")
    ? String(groupIdTarget).trim()
    : null;

  if (!tgt){
    return { ...base, groupId:String(clientGroupId), source:"default_l3" };
  }

  const cand = _findById(allowedGroups, tgt);
  if (!cand){
    return { ...base, groupId:String(clientGroupId), source:"default_l3 (override_not_found)" };
  }

  const lvl = _getLevel(cand);
  const okLvl = (lvl === 4 || lvl === 5);
  const okBelongs = _belongsToClientGroup(cand, clientGroup, allowedGroups);

  if (okLvl && okBelongs){
    return { ...base, groupId:String(_getId(cand)), source:("override_l" + String(lvl)) };
  }

  return {
    ...base,
    groupId:String(clientGroupId),
    source:"default_l3 (override_rejected)",
    overrideRejected:{ level:lvl, okLevel:okLvl, okBelongs:okBelongs }
  };
}

function injectGroupIdIntoAssetBasicSave(step, groupId){
  if (!step || !step.action) return step;
  const name = String(step.action.name || step.action.action || "").toUpperCase();
  if (name !== "ASSET_BASIC_SAVE") return step;

  const params = Array.isArray(step.action.parameters)
    ? step.action.parameters
    : (step.action.parameters ? [step.action.parameters] : []);

  const first = (params[0] && typeof params[0] === "object") ? params[0] : {};
  const cur = first.GROUP_ID ?? first.group_id ?? first.groupId;

  if (cur === undefined || cur === null || String(cur).trim() === ""){
    first.GROUP_ID = String(groupId);
  }

  params[0] = first;
  step.action.parameters = params;

  step.__patch = step.__patch || [];
  step.__patch.push({ id:"PATCH_C8_ALLOWED_GROUPS", injected:"GROUP_ID", value:String(first.GROUP_ID) });
  return step;
}

function extractAllowedGroupsFromCaptures(captures){
  if (!captures || typeof captures !== "object") return null;

  const cands = [
    captures.allowed_groups,
    captures.allowedGroups,
    captures.get_user_allowed_groups,
    captures.user_allowed_groups,
    captures.allowed_groups_res
  ];

  for (const c of cands){
    if (!c) continue;
    if (Array.isArray(c)) return c;

    if (typeof c === "object"){
      if (Array.isArray(c.groups)) return c.groups;
      if (Array.isArray(c.data)) return c.data;
      if (Array.isArray(c.result)) return c.result;
    }
  }
  return null;
}

function applyPatchC8AllowedGroups(step, ctx){
  try{
    if (!ctx || !ctx.job) return step;
    const payload = ctx.job.payload || {};

    const clientName =
      payload.client_name ||
      payload.clientName ||
      payload.client ||
      payload.company_name ||
      payload.target_client_name;

    if (!clientName) return step;

    const allowedGroups = extractAllowedGroupsFromCaptures(ctx.captures);
    if (!allowedGroups) return step;

    const groupIdTarget =
      payload.group_id_target ||
      payload.groupIdTarget ||
      null;

    const r = resolveGroupIdFromAllowedGroups(allowedGroups, clientName, groupIdTarget);
    if (!r.ok) return step;

    return injectGroupIdIntoAssetBasicSave(step, r.groupId);
  } catch (e){
    return step;
  }
}

module.exports = {
  resolveGroupIdFromAllowedGroups,
  injectGroupIdIntoAssetBasicSave,
  extractAllowedGroupsFromCaptures,
  applyPatchC8AllowedGroups
};
