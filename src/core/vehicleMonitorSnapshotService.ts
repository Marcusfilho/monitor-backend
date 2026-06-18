/**
 * vehicleMonitorSnapshotService.ts — CAN Snapshot (REWRITE)
 *
 * REFACTOR_CAN_V2: incorpora lógica do Internal Tools
 *   - Deduplicação por nome com preferência pelo prefixo SYS (000027xx)
 *   - Conversão hex→decimal com multiplier/offset/min/max para params conhecidos
 *   - moduleState filtra CAN/J1708/KEYPAD (resumo canSummary tipado)
 *   - Coleta ALL params (sem TARGET filter) — snapshot completo para o banco
 *
 * FIX 2026-05-31 — Lógica REATIVA (substitui sleep fixo):
 *   - Em vez de await sleep(windowMs) fixo após send_quick_command,
 *     aguarda até silêncio de VM_WAIT_AFTER_LAST_PARAM_MS desde último UNIT_PARAMETERS
 *   - Timeout total VM_WINDOW_MS como fallback (default 300s)
 *   - Cobre caso de reboot pós-instalação (~60s sem dados antes dos params chegarem)
 */

import crypto from "crypto";

// ─── WS Types ────────────────────────────────────────────────────────────────

export type WsLike = {
  on(event: "message", cb: (data: any) => void): any;
  send(data: string): any;
  close(): any;
};

type JsonObj = Record<string, any>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeDecodeURIComponent(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function makeMtkn(): string {
  const hex = crypto.randomBytes(16).toString("hex");
  return BigInt("0x" + hex).toString(10);
}

function makeFlowId(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function asBool01(v: any): boolean {
  return String(v) === "1";
}

// ─── PARAM_META (portado do Internal Tools) ──────────────────────────────────

const SYS_PREFIX = "000027";

function isSysParam(id: string): boolean {
  return id.toUpperCase().startsWith(SYS_PREFIX);
}

interface ParamMeta {
  name: string;
  multiplier: number;
  offset: number;
  min: number;
  max: number;
  unit: string;
}

const PARAM_META: Record<string, ParamMeta> = {
  "00002719": { name: "engine_total_fuel_used",      multiplier: 0.1,     offset: 0,    min: 0,    max: 2e7,      unit: "L"   },
  "00000031": { name: "engine_total_fuel_used",      multiplier: 0.5,     offset: 0,    min: 0,    max: 2.1e9,    unit: "L"   },
  "00002717": { name: "fuel_level_1",                multiplier: 1.0,     offset: 0,    min: 1,    max: 102,      unit: "%"   },
  "00000032": { name: "fuel_level_1",                multiplier: 0.4,     offset: 0,    min: 3,    max: 100,      unit: "%"   },
  "00002718": { name: "engine_fuel_rate",            multiplier: 0.01,    offset: 0,    min: 0,    max: 10000,    unit: "L/h" },
  "0000003C": { name: "engine_fuel_rate",            multiplier: 0.05,    offset: 0,    min: 0,    max: 3212.75,  unit: "L/h" },
  "00002723": { name: "engine_oil_pressure",         multiplier: 0.01,    offset: 0,    min: 0,    max: 20,       unit: "kPa" },
  "00000024": { name: "engine_oil_pressure",         multiplier: 0.04,    offset: 0,    min: 0,    max: 10,       unit: "kPa" },
  "0000271E": { name: "engine_oil_temperature",      multiplier: 1.0,     offset: -273, min: -273, max: 2000,     unit: "°C"  },
  "0000271F": { name: "engine_coolant_temperature",  multiplier: 1.0,     offset: -273, min: -273, max: 250,      unit: "°C"  },
  "0000002F": { name: "engine_coolant_temperature",  multiplier: 1.0,     offset: -40,  min: -40,  max: 210,      unit: "°C"  },
  "00002714": { name: "sys_param_vehicle_distance",  multiplier: 0.001,   offset: 0,    min: 1,    max: 4e6,      unit: "km"  },
  "0000AF8C": { name: "arm_analog_input_3",          multiplier: 0.03519, offset: 0,    min: 0,    max: 1000,     unit: "-"   },
  "00002715": { name: "rpm",                         multiplier: 1.0,     offset: 0,    min: 0,    max: 20000,    unit: "RPM" },
  "0000003A": { name: "rpm",                         multiplier: 0.125,   offset: 0,    min: 0,    max: 8031.88,  unit: "RPM" },
};

function convertParamValue(paramId: string, rawHex: string): number | null {
  const meta = PARAM_META[paramId.toUpperCase()];
  if (!meta || !rawHex) return null;
  const dec = parseInt(rawHex, 16);
  if (isNaN(dec)) return null;
  const converted = dec * meta.multiplier + meta.offset;
  if (converted < meta.min || converted > meta.max) return null;
  return Math.round(converted * 1000) / 1000;
}

// ─── Output Types ─────────────────────────────────────────────────────────────

export type VmHeader = {
  vehicle_id: number;
  client_id?: number | null;
  inner_id?: string | null;
  unit_key?: string | null;
  license_nmbr?: string | null;
  unit_type?: string | null;
  unit_version?: string | null;
  configuration_key_db?: string | null;
  configuration_key_unit?: string | null;
  driver_code?: string | null;
  raw?: JsonObj;
};

export type VmParam = {
  id: string;
  name: string | null;
  raw_value: string | null;
  value?: string | null;
  converted_value?: number | null;
  unit?: string | null;
  source: string | null;
  orig_time: string | null;
  last_update?: string | null;
  inner_id: string | null;
};

export type VmModuleStateRow = {
  id: string;
  module: string;
  sub: string;
  last_update_date: string | null;
  active: boolean;
  was_ok: boolean;
  ok: boolean;
  error: boolean;
  error_descr: string | null;
};

export type CanSummary = {
  can0:     VmModuleStateRow | null;
  can1:     VmModuleStateRow | null;
  j1708:    VmModuleStateRow | null;
  can0_ok:  boolean;
  can1_ok:  boolean;
  j1708_ok: boolean;
};

export type VmSnapshot = {
  capturedAt: string;
  vehicleId: number;
  isConnected: number | null;
  header: VmHeader;
  parameters: VmParam[];
  moduleState: VmModuleStateRow[];
  canSummary: CanSummary;
  rawCounts: {
    unitParametersEvents: number;
    unitMessagesEvents: number;
    unitConnEvents: number;
  };
};

// ─── TraffilogWsMux ───────────────────────────────────────────────────────────

type WsResponse = {
  response?: { properties?: { action_name?: string; mtkn?: string; data_source?: string; data?: any[]; [k: string]: any } };
};

type WsActionFrame = {
  action: {
    flow_id: string;
    name: string;
    parameters: Record<string, any>;
    session_token: string;
    mtkn: string;
  };
};

class TraffilogWsMux {
  private ws: WsLike;
  private sessionToken: string;
  private urlEncode: boolean;

  private pending = new Map<string, { resolve: (x: any) => void; reject: (e: any) => void; t: NodeJS.Timeout }>();
  private refreshHandlers = new Set<(p: any) => void>();

  constructor(ws: WsLike, sessionToken: string, urlEncode = true) {
    this.ws = ws;
    this.sessionToken = sessionToken;
    this.urlEncode = urlEncode;

    this.ws.on("message", (data: any) => {
      const raw  = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
      const text = raw.trimStart().startsWith("%7B")
        ? (() => { try { return decodeURIComponent(raw); } catch { return raw; } })()
        : raw;
      let msg: WsResponse | null = null;
      try { msg = JSON.parse(text); } catch { return; }

      // FIX_MUX_ACTION_VALUE_V1: {action_value,error_description} sem response.properties → rejeita pending
      if (!msg?.response && (msg as any)?.action_value && String((msg as any).action_value) !== "0") {
        const av = String((msg as any).action_value);
        const desc = String((msg as any).error_description ?? "");
        for (const [token, p] of this.pending) {
          clearTimeout(p.t);
          this.pending.delete(token);
          p.reject(new Error("[vm] action_value=" + av + (desc ? " " + desc : "")));
        }
        return;
      }
      const props = msg?.response?.properties;
      if (!props) return;

      const actionName = props.action_name;
      const token = props.mtkn;

      if (token && this.pending.has(token)) {
        const p = this.pending.get(token)!;
        clearTimeout(p.t);
        this.pending.delete(token);
        p.resolve(props);
        return;
      }

      // DEBUG: loga mensagens não-pending e não-refresh (vehicle_subscribe responses, pushes inesperados)
      if (process.env.VM_WS_DEBUG === "1") {
        const { appendFileSync } = require("fs") as typeof import("fs");
        const snippet = { an: actionName, ds: props?.data_source, dataLen: Array.isArray(props?.data) ? props.data.length : "?", keys: Object.keys(props).join(","), raw: text.slice(0, 400) };
        appendFileSync("/tmp/vm_ws_debug.log", JSON.stringify(snippet) + "\n");
      }

      if (actionName === "refresh") {
        for (const h of this.refreshHandlers) {
          try { h(props); } catch {}
        }
        return;
      }

      // Mensagens com action_name diferente de "refresh" e não correlacionadas a pending
      // são ignoradas por ora — VM_WS_DEBUG=1 captura o conteúdo para análise
    });
  }

  onRefresh(handler: (props: any) => void): () => void {
    this.refreshHandlers.add(handler);
    return () => this.refreshHandlers.delete(handler);
  }

  sendAction<T = any>(name: string, parameters: Record<string, any>, timeoutMs = 15000): Promise<T> {
    const token = makeMtkn();
    const frame: WsActionFrame = {
      action: {
        flow_id: makeFlowId(),
        name,
        parameters: { ...parameters, _action_name: name, mtkn: token },
        session_token: this.sessionToken,
        mtkn: token,
      },
    };

    const payloadJson = JSON.stringify(frame);
    const payload = this.urlEncode ? encodeURIComponent(payloadJson) : payloadJson;

    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(token);
        reject(new Error(`[vm] timeout mtkn=${token} action=${name}`));
      }, timeoutMs);

      this.pending.set(token, { resolve, reject, t });
      this.ws.send(payload);
    });
  }

  /**
   * Envia frame sem aguardar resposta (fire-and-forget).
   * Usado para vehicle_subscribe / vehicle_unsubscribe cujas respostas
   * chegam sem mtkn correlacionável — igual ao comportamento do Monitor.
   */
  fireAndForget(name: string, parameters: Record<string, any>): void {
    const frame: WsActionFrame = {
      action: {
        flow_id: makeFlowId(),
        name,
        parameters: { ...parameters, _action_name: name, mtkn: "0" },
        session_token: this.sessionToken,
        mtkn: "0",
      },
    };
    const payload = this.urlEncode
      ? encodeURIComponent(JSON.stringify(frame))
      : JSON.stringify(frame);
    this.ws.send(payload);
  }
}

// ─── collectVehicleMonitorSnapshot ───────────────────────────────────────────

export async function collectVehicleMonitorSnapshot(opts: {
  ws: WsLike;
  sessionToken: string;
  vehicleId: number;
  clientId?: number | string | null;
  windowMs?: number;
  waitAfterCmdMs?: number;
  urlEncode?: boolean;
  onPartialParams?: (
    params: VmParam[],
    counts: { total: number; withValue: number; events: number },
    header: VmHeader,
    moduleState: VmModuleStateRow[]
  ) => void;
}): Promise<VmSnapshot> {
  // FIX: windowMs agora é o TIMEOUT TOTAL (default 300s), não a janela fixa
  const windowMs            = opts.windowMs       ?? Number(process.env.VM_WINDOW_MS              ?? 300_000);
  const waitAfterCmdMs      = opts.waitAfterCmdMs ?? Number(process.env.VM_WAIT_AFTER_CMD_MS      ?? 2_000);
  // Tempo de silêncio após último UNIT_PARAMETERS para encerrar (default 5s)
  const waitAfterLastParamMs = Number(process.env.VM_WAIT_AFTER_LAST_PARAM_MS ?? 5_000);
  // Intervalo de resubscription quando ainda não chegou nenhum dado (default 30s)
  const resubscribeIntervalMs = Number(process.env.VM_RESUBSCRIBE_INTERVAL_MS ?? 30_000);

  const mux = new TraffilogWsMux(opts.ws, opts.sessionToken, opts.urlEncode ?? true);

  // ── 1. get_vehicle_info ───────────────────────────────────────────────────
  const vehicleInfo = await mux.sendAction<any>("get_vehicle_info", {
    tag: "loading_screen",
    vehicle_id: String(opts.vehicleId),
    ...(opts.clientId != null ? { client_id: String(opts.clientId) } : {}),
  }); // FIX_VM_CLIENT_ID_V1

  const vi      = (vehicleInfo?.data?.[0] ?? {}) as JsonObj;
  const unitKey = safeDecodeURIComponent(String(vi.unit_key ?? ""));

  const header: VmHeader = {
    vehicle_id:             Number(vi.vehicle_id ?? opts.vehicleId),
    client_id:              vi.client_id              != null ? Number(vi.client_id)                   : null,
    inner_id:               vi.inner_id               != null ? String(vi.inner_id)                    : null,
    unit_key:               unitKey                   || null,
    license_nmbr:           vi.license_nmbr           != null ? String(vi.license_nmbr)                : null,
    unit_type:              vi.unit_type              != null ? String(vi.unit_type)                   : null,
    unit_version:           vi.unit_version           != null ? String(vi.unit_version)                : null,
    configuration_key_db:   vi.configuration_key_db   != null ? String(vi.configuration_key_db)        : null,
    configuration_key_unit: vi.configuration_key_unit != null ? String(vi.configuration_key_unit)      : null,
    raw: vi,
  };

  // ── 2. Redis (is_connected) ───────────────────────────────────────────────
  const redis = await mux.sendAction<any>("get_vehicle_data_from_redis", {
    vehicle_id: String(opts.vehicleId),
  });
  const isConnectedRaw = redis?.data?.[0]?.is_connected;
  const isConnected    = isConnectedRaw == null ? null : Number(isConnectedRaw);
  console.log(`[vm] vehicleId=${opts.vehicleId} is_connected=${isConnected ?? "null"}${isConnected === 0 ? " ⚠️ OFFLINE — dados podem demorar" : ""}`);

  // ── 3. Subscribes — ANTES do module state (servidor precisa de subscription ativa) ───
  mux.fireAndForget("vehicle_unsubscribe", { vehicle_id: String(opts.vehicleId), object_type: "" });
  mux.fireAndForget("vehicle_subscribe",   { vehicle_id: String(opts.vehicleId), object_type: "UNIT_MESSAGES" });
  mux.fireAndForget("vehicle_subscribe",   { vehicle_id: String(opts.vehicleId), object_type: "UNIT_CONFIG_STATUS", value: "" });
  mux.fireAndForget("vehicle_subscribe",   { vehicle_id: String(opts.vehicleId), object_type: "UNIT_PARAMETERS" });

  // ── 4. Module State (após subscribes + 500ms para servidor registrar) ─────
  await sleep(500);
  let ms: any = null;
  try {
    // Tentativa A: com client_id
    const [msA, msB] = await Promise.all([
      mux.sendAction<any>("get_monitor_module_state", {
        tag: "loading_screen", filter: "", vehicle_id: String(opts.vehicleId),
        ...(header.client_id != null ? { client_id: String(header.client_id) } : {}),
      }),
      // Tentativa B: sem client_id (fallback — DB pode não filtrar por cliente)
      mux.sendAction<any>("get_monitor_module_state", {
        tag: "loading_screen", filter: "", vehicle_id: String(opts.vehicleId),
      }),
    ]);
    const lenA = msA?.data?.length ?? 0;
    const lenB = msB?.data?.length ?? 0;
    console.log(`[vm-ms] A(com client_id)=data:${lenA} B(sem client_id)=data:${lenB} av=${msA?.action_value}`);
    ms = lenA > 0 ? msA : (lenB > 0 ? msB : msA);
    if ((ms?.data?.length ?? 0) === 0) console.log(`[vm-ms] raw=${JSON.stringify(ms)}`);
  } catch (msErr: any) {
    console.log(`[vm-ms] ERRO: ${msErr?.message || String(msErr)}`);
  }

  function parseMsData(data: any[]): VmModuleStateRow[] {
    return data.map((r: any) => ({
      id:               String(r?.id ?? ""),
      module:           String(r?.module_descr ?? ""),
      sub:              String(r?.sub_module_descr ?? ""),
      last_update_date: r?.last_update_date ? safeDecodeURIComponent(String(r.last_update_date)) : null,
      active:           asBool01(r?.active),
      was_ok:           asBool01(r?.was_ok),
      ok:               asBool01(r?.ok),
      error:            asBool01(r?.error),
      error_descr:      r?.error_descr != null ? String(r.error_descr) : null,
    }));
  }

  const moduleState: VmModuleStateRow[] = parseMsData(ms?.data ?? []);
  let moduleStateRetried = false;

  // ── 4. opr + metadata ─────────────────────────────────────────────────────
  const opr = await mux.sendAction<any>("get_unit_parameters_opr", {
    filter: "",
    vehicle_id: String(opts.vehicleId),
  });

  const idToName = new Map<string, string>();
  for (const row of (opr?.data ?? [])) {
    const id   = String(row?.id ?? "").toUpperCase().padStart(8, "0");
    const name = safeDecodeURIComponent(String(row?.param_type_descr ?? ""));
    if (id) idToName.set(id, name);
  }

  await mux.sendAction("get_unit_parameters_metadata", {
    filter: "",
    vehicle_id: String(opts.vehicleId),
  }).catch(() => {});

  if (!header.unit_key) {
    const fs = require("fs"); fs.appendFileSync("/tmp/vm_debug.log", JSON.stringify({ts: new Date().toISOString(), vi}, null, 2) + "\n---\n");
    console.log(`[vm] vehicleId=${opts.vehicleId} unit_key ausente — send_quick_command será pulado, aguardando dados passivos`);
  }

  // ── 6. Handler de pushes ──────────────────────────────────────────────────
  const latest   = new Map<string, VmParam>();
  const nameToId = new Map<string, string>();

  let unitParametersEvents = 0;
  let unitMessagesEvents   = 0;
  let unitConnEvents       = 0;

  // FIX: variáveis de controle reativo
  let lastParamAt       = 0;
  let collectionStarted = false;

  const off = mux.onRefresh((props) => {
    const ds = String(props?.data_source ?? "");

    // Log diagnóstico: data_source não tratado (inclui ds="" para capturar pushes inesperados)
    if (ds !== "UNIT_PARAMETERS" && ds !== "UNIT_MESSAGES" && ds !== "unit_connection_status") {
      const dlen = Array.isArray(props?.data) ? props.data.length : "?";
      console.log(`[vm] vehicleId=${opts.vehicleId} refresh ds="${ds}" (não tratado) data_len=${dlen} an=${props?.action_name ?? "?"}`);
    }

    if (ds === "UNIT_PARAMETERS") {
      unitParametersEvents++;
      const rows = Array.isArray(props?.data) ? props.data : (props?.data ? [props.data] : []);

      for (const row of rows) {
        const id = String(row?.id ?? row?.param_id ?? "").toUpperCase().padStart(8, "0");
        if (!id || id === "00000000") continue;

        const rawValue =
          row?.param_value  != null ? String(row.param_value)  :
          row?.paramvalue   != null ? String(row.paramvalue)   :
          row?.raw_value    != null ? String(row.raw_value)    :
          row?.value        != null ? String(row.value)        : null;

        const lastUpdate =
          row?.orig_time        != null ? String(row.orig_time)        :
          row?.last_update      != null ? String(row.last_update)      :
          row?.last_update_date != null ? String(row.last_update_date) : null;

        const metaName  = PARAM_META[id]?.name ?? null;
        const oprName   = idToName.get(id) ?? null;
        const rowName   = row?.param_type_descr != null ? safeDecodeURIComponent(String(row.param_type_descr)) : null;
        const canonical = metaName ?? oprName ?? rowName ?? null;

        if (canonical) {
          const existingId    = nameToId.get(canonical);
          const incomingIsSys = isSysParam(id);
          if (!existingId) {
            nameToId.set(canonical, id);
          } else if (incomingIsSys && !isSysParam(existingId)) {
            latest.delete(existingId);
            nameToId.set(canonical, id);
          } else if (!incomingIsSys && isSysParam(existingId)) {
            continue;
          }
        }

        const prev      = latest.get(id);
        const converted = rawValue != null ? convertParamValue(id, rawValue) : null;
        const meta      = PARAM_META[id];

        latest.set(id, {
          id,
          name:            canonical ?? prev?.name ?? null,
          raw_value:       rawValue  ?? prev?.raw_value  ?? null,
          value:           rawValue  ?? prev?.value      ?? null,
          converted_value: converted ?? prev?.converted_value ?? null,
          unit:            meta?.unit ?? prev?.unit ?? null,
          source:          row?.paramsource != null ? String(row.paramsource) : (row?.source != null ? String(row.source) : prev?.source ?? null),
          orig_time:       lastUpdate ?? prev?.orig_time   ?? null,
          last_update:     lastUpdate ?? prev?.last_update ?? null,
          inner_id:        row?.inner_id != null ? String(row.inner_id) : prev?.inner_id ?? null,
        });
      }

      // FIX: atualiza controle reativo
      lastParamAt       = Date.now();
      collectionStarted = true;

      // Retry module state no primeiro evento, se ainda vazio após subscribe
      if (unitParametersEvents === 1 && moduleState.length === 0 && !moduleStateRetried) {
        moduleStateRetried = true;
        mux.sendAction<any>("get_monitor_module_state", {
          tag: "loading_screen",
          filter: "",
          vehicle_id: String(opts.vehicleId),
          ...(header.client_id != null ? { client_id: String(header.client_id) } : {}),
        }).then(msR => {
          const rows = parseMsData(msR?.data ?? []);
          if (rows.length > 0) {
            console.log(`[vm-ms] retry OK data=${rows.length}`);
            moduleState.splice(0, moduleState.length, ...rows);
          }
        }).catch(() => {});
      }

      if (opts.onPartialParams) {
        try {
          const allParams = Array.from(latest.values());
          const withValue = allParams.filter(p => (p.raw_value ?? "") !== "").length;
          opts.onPartialParams(allParams, { total: allParams.length, withValue, events: unitParametersEvents }, header, moduleState);
        } catch { /* best-effort */ }
      }
      return;
    }

    if (ds === "UNIT_MESSAGES") {
      unitMessagesEvents++;
      const rows = Array.isArray(props?.data) ? props.data : (props?.data ? [props.data] : []);
      for (const row of rows) {
        const dc = row?.driver_code != null ? String(row.driver_code).trim() : "";
        if (dc) { header.driver_code = dc; break; }
      }
      return;
    }

    if (ds === "unit_connection_status") { unitConnEvents++; return; }
  });

  // ── 7. Dispara rajada + reenvio reativo (FIX_CAN_RETRY_V1) ─────────────────
  // Reenvia send_quick_command a cada 5s até ter todos os grupos alvo ou timeout

  // Grupos: cada grupo = 1 parâmetro lógico. Basta 1 ID do grupo ter valor > "".
  const TARGET_GROUPS: string[][] = [
    ["00000031", "000000C5", "00002719", "0000A8BD"], // engine_total_fuel_used
    ["00000032", "000000C3", "0000879F", "00002717"], // fuel_level_1
    ["0000003C", "00002718", "0000C21F"],             // engine_fuel_rate
    ["00000024", "0000010D", "00002723"],             // engine_oil_pressure
    ["0000168E", "0000271E"],                         // engine_oil_temperature_1
    ["0000002F", "0000010E", "0000271F"],             // engine_coolant_temperature
    ["0000002E", "0000010F"],                         // engine_fuel_temperature_1
    ["00002714"],                                     // sys_param_vehicle_distance
    ["0000AF8C", "0000D419", "0000D41A"],             // arm_analog_input_3
    ["000000AD", "0000003A", "00002715"],             // rpm
  ];

  function hasAllTargets(): boolean {
    return TARGET_GROUPS.every(group =>
      group.some(id => {
        const p = latest.get(id.toUpperCase());
        return p != null && (p.raw_value ?? "") !== "";
      })
    );
  }

  async function fireQuickCommand(): Promise<void> {
    console.log(`[vm] vehicleId=${opts.vehicleId} unit_key="${header.unit_key}" send_quick_command iniciando`);
    try {
      await mux.sendAction("send_quick_command", {
        unit_key:        header.unit_key,
        local_action_id: "5",
        cmd_id:          "9",
        ack_needed:      "0",
      });
      console.log(`[vm] vehicleId=${opts.vehicleId} send_quick_command OK`);
    } catch (e: any) {
      console.log(`[vm] vehicleId=${opts.vehicleId} send_quick_command FALHOU (non-fatal): ${e?.message || e}`);
    }
  }

  if (header.unit_key) {
    await fireQuickCommand();
    await sleep(waitAfterCmdMs);
  }

  // FIX: substitui sleep(windowMs) fixo por espera reativa
  // Encerra quando: (a) silêncio >= waitAfterLastParamMs após último UNIT_PARAMETERS
  //                 (b) timeout total windowMs esgotado
  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const hardDeadline = setTimeout(() => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[vm] vehicleId=${opts.vehicleId} TIMEOUT TOTAL ${elapsed}s — params=${latest.size} events=${unitParametersEvents}`);
      cleanup();
      resolve();
    }, windowMs);

    const quietChecker = setInterval(() => {
      if (!collectionStarted) return;
      if ((Date.now() - lastParamAt) >= waitAfterLastParamMs) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[vm] vehicleId=${opts.vehicleId} silêncio ${waitAfterLastParamMs}ms — encerrando em ${elapsed}s`);
        cleanup();
        resolve();
      }
    }, 500);

    const progressTimer = setInterval(() => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`[vm] vehicleId=${opts.vehicleId} aguardando... ${elapsed}s — params=${latest.size} events=${unitParametersEvents}`);
    }, 10_000);

    // FIX_CAN_RETRY_V1: reenvio periódico a cada 5s enquanto faltam parâmetros alvo
    const RETRY_INTERVAL_MS = 5_000;
    const retryTimer = setInterval(() => {
      if (!header.unit_key) return;
      if (hasAllTargets()) return;
      fireQuickCommand().catch(() => {});
    }, RETRY_INTERVAL_MS);

    // FIX_CAN_RESUBSCRIBE_V1: se nenhum UNIT_PARAMETERS chegou ainda, refaz subscribe completo
    // Cobre o caso de dispositivo que voltou online após o subscribe inicial (ex: reboot pós-SB)
    let resubCount = 0;
    const resubTimer = setInterval(() => {
      if (collectionStarted) return; // já chegaram dados — sem necessidade
      resubCount++;
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`[vm] vehicleId=${opts.vehicleId} resubscribe #${resubCount} em ${elapsed}s — sem UNIT_PARAMETERS até agora`);
      mux.fireAndForget("vehicle_unsubscribe", { vehicle_id: String(opts.vehicleId), object_type: "" });
      mux.fireAndForget("vehicle_subscribe",   { vehicle_id: String(opts.vehicleId), object_type: "UNIT_MESSAGES" });
      mux.fireAndForget("vehicle_subscribe",   { vehicle_id: String(opts.vehicleId), object_type: "UNIT_CONFIG_STATUS", value: "" });
      mux.fireAndForget("vehicle_subscribe",   { vehicle_id: String(opts.vehicleId), object_type: "UNIT_PARAMETERS" });
      if (header.unit_key) fireQuickCommand().catch(() => {});
    }, resubscribeIntervalMs);

    function cleanup() {
      clearTimeout(hardDeadline);
      clearInterval(quietChecker);
      clearInterval(progressTimer);
      clearInterval(retryTimer);
      clearInterval(resubTimer);
    }
  });

  off();

  await mux.sendAction("vehicle_unsubscribe", { vehicle_id: String(opts.vehicleId), object_type: "" }).catch(() => {});

  // ── 8. canSummary ─────────────────────────────────────────────────────────
  const canSummary = buildCanSummary(moduleState);

  const paramsWithValue = Array.from(latest.values()).filter(p => (p.raw_value ?? "") !== "").length;
  console.log(
    `[vm] vehicleId=${opts.vehicleId} params=${latest.size} withValue=${paramsWithValue}` +
    ` events=${unitParametersEvents} can0_ok=${canSummary.can0_ok} can1_ok=${canSummary.can1_ok}`
  );

  return {
    capturedAt:  new Date().toISOString(),
    vehicleId:   opts.vehicleId,
    isConnected,
    header,
    parameters:  Array.from(latest.values()),
    moduleState,
    canSummary,
    rawCounts: { unitParametersEvents, unitMessagesEvents, unitConnEvents },
  };
}

// ─── buildCanSummary ──────────────────────────────────────────────────────────

export function buildCanSummary(moduleState: VmModuleStateRow[]): CanSummary {
  const pick = (module: string, sub: string) =>
    moduleState.find((r) => r.module === module && r.sub === sub) ?? null;

  const can0  = pick("CAN", "CAN0");
  const can1  = pick("CAN", "CAN1");
  const j1708 = moduleState.find((r) => r.module === "J1708") ?? null;

  return {
    can0,
    can1,
    j1708,
    can0_ok:  !!(can0  && can0.ok  && can0.active),
    can1_ok:  !!(can1  && can1.ok  && can1.active),
    j1708_ok: !!(j1708 && j1708.ok && j1708.active),
  };
}

/** @deprecated Use buildCanSummary — mantido para compatibilidade */
export function summarizeCanFromModuleState(moduleState: VmModuleStateRow[]) {
  return buildCanSummary(moduleState);
}
