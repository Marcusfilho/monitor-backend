#!/usr/bin/env node
/**
 * tools/vm_snapshot_post_v3.js
 * Pós-processa o JSON do vm_snapshot_ws.js para:
 * - module_state.relevant: CAN0/CAN1/J1708/KEYPAD_DALLAS_IBUTTON/KEYPAD_RAMZOR (por match)
 * - parameters_tab.preview: garante preview mesmo se não houver valores
 */
const fs = require("fs");

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function pick(obj, paths, def = undefined) {
  for (const p of paths) {
    const parts = p.split(".");
    let cur = obj;
    let ok = true;
    for (const k of parts) {
      if (!cur || typeof cur !== "object" || !(k in cur)) { ok = false; break; }
      cur = cur[k];
    }
    if (ok) return cur;
  }
  return def;
}

function normStr(x) {
  return (x == null) ? "" : String(x);
}

function getAnyValue(row) {
  const candidates = [
    "value_raw","valueRaw","raw_value","rawValue",
    "value","param_value","paramValue",
    "display_value","displayValue",
    "raw","raw_val","rawVal"
  ];
  for (const k of candidates) {
    if (row && Object.prototype.hasOwnProperty.call(row, k)) {
      const v = row[k];
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      return v;
    }
  }
  // fallback: procura alguma chave que pareça valor
  if (row && typeof row === "object") {
    for (const [k,v] of Object.entries(row)) {
      if (!/value|raw|val/i.test(k)) continue;
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      return v;
    }
  }
  return null;
}

function matchRow(rows, pred) {
  return (rows || []).find(pred) || null;
}

function buildModuleRelevant(allRows) {
  const rows = allRows || [];
  const out = [];

  const rules = [
    { key: "CAN0", find: r => /CAN/i.test(normStr(r.module_descr)) && /CAN0/i.test(normStr(r.sub_module_descr)) },
    { key: "CAN1", find: r => /CAN/i.test(normStr(r.module_descr)) && /CAN1/i.test(normStr(r.sub_module_descr)) },
    { key: "J1708", find: r => /J1708/i.test(normStr(r.module_descr)) || /J1708/i.test(normStr(r.sub_module_descr)) },
    { key: "KEYPAD_DALLAS_IBUTTON", find: r => /KEYPAD/i.test(normStr(r.module_descr)) && /(DALLAS|IBUTTON|I-?BUTTON)/i.test(normStr(r.sub_module_descr)) },
    { key: "KEYPAD_RAMZOR", find: r => /KEYPAD/i.test(normStr(r.module_descr)) && /RAMZOR/i.test(normStr(r.sub_module_descr)) },
  ];

  for (const rule of rules) {
    const hit = matchRow(rows, rule.find);
    if (hit) {
      out.push({ key: rule.key, missing: false, ...hit });
    } else {
      out.push({ key: rule.key, missing: true, id: null, module_descr: null, sub_module_descr: null, active: null, ok: null, message: null });
    }
  }
  return out;
}

function buildParamsPreview(paramsTab) {
  const rows = pick(paramsTab, ["rows","preview"], []) || [];
  let withValue = 0;
  for (const r of rows) {
    const v = getAnyValue(r);
    if (v !== null) withValue++;
  }

  const interesting = /sys_param|can|engine|fuel|mileage|speed|rpm|odo|odometer|hour|hours/i;
  const picked = [];

  // 1) primeiro: linhas com valor ou interessantes
  for (const r of rows) {
    if (picked.length >= 60) break;
    const name = normStr(r.name);
    const v = getAnyValue(r);
    if (v !== null || interesting.test(name)) {
      picked.push({
        id: r.id ?? null,
        name: r.name ?? null,
        value_raw: (v === null ? null : v),
        last_update: r.last_update ?? r.lastUpdate ?? null,
        source: r.source ?? null,
      });
    }
  }

  // 2) se ainda ficou vazio (caso atual): garante prova que chegou listagem
  if (picked.length === 0) {
    for (const r of rows.slice(0, 12)) {
      picked.push({
        id: r.id ?? null,
        name: r.name ?? null,
        value_raw: null,
        last_update: r.last_update ?? r.lastUpdate ?? null,
        source: r.source ?? null,
      });
    }
  }

  return {
    count_opr: paramsTab.count_opr ?? paramsTab.countOpr ?? (Array.isArray(rows) ? rows.length : null),
    count_with_value: withValue,
    preview: picked,
  };
}

function main() {
  const input = JSON.parse(readStdin());
  const header = input.header || {};

  // tenta achar "todas as rows" do module_state; se não existir, usa relevant mesmo
  const moduleAll =
    pick(input, ["module_state.rows","module_state.all","module_state.raw","module_state.relevant"], []) || [];

  const out = {
    ...input,
    header: header,
    module_state: {
      ...(input.module_state || {}),
      relevant: buildModuleRelevant(moduleAll),
    },
    parameters_tab: buildParamsPreview(input.parameters_tab || {}),
  };

  process.stdout.write(JSON.stringify(out, null, 2));
}

main();
