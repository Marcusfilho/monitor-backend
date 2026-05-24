/**
 * vehicleMonitorSnapshotService.ts — CAN Snapshot (REWRITE)
 *
 * REFACTOR_CAN_V2: incorpora lógica do Internal Tools
 *   - Deduplicação por nome com preferência pelo prefixo SYS (000027xx)
 *   - Conversão hex→decimal com multiplier/offset/min/max para params conhecidos
 *   - moduleState filtra CAN/J1708/KEYPAD (resumo canSummary tipado)
 *   - Coleta ALL params (sem TARGET filter) — snapshot completo para o banco
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
// Usado para: deduplicação por nome (preferência SYS 000027xx) + conversão hex→decimal

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

/**
 * Converte raw_value hex→decimal para params conhecidos.
 * Para params desconhecidos, retorna null (valor bruto já fica em raw_value).
 */
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
  /** Valor convertido (hex→decimal) para parâmetros com PARAM_META. Null se desconhecido ou fora do range. */
  converted_value?: number | null;
  /** Unidade de medida (ex: "L/h", "%", "RPM"). Null para params sem meta. */
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

/** Resumo CAN tipado — portado do Internal Tools summarizeCanFromModuleState */
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
  /** Resumo dos módulos CAN/J1708 — derivado de moduleState */
  canSummary: CanSummary;
  rawCounts: {
    unitParametersEvents: number;
    unitMessagesEvents: number;
    unitConnEvents: number;
  };
};

// ─── TraffilogWsMux ───────────────────────────────────────────────────────────
// (sem alterações — apenas copiado do original para manter o arquivo auto-contido)

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
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
      let msg: WsResponse | null = null;
      try { msg = JSON.parse(text); } catch { return; }

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

      if (actionName === "refresh") {
        for (const h of this.refreshHandlers) {
          try { h(props); } catch {}
        }
      }
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
}

// ─── collectVehicleMonitorSnapshot ───────────────────────────────────────────

export async function collectVehicleMonitorSnapshot(opts: {
  ws: WsLike;
  sessionToken: string;
  vehicleId: number;
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
  const windowMs       = opts.windowMs       ?? 5000;
  const waitAfterCmdMs = opts.waitAfterCmdMs ?? 800;
  const mux = new TraffilogWsMux(opts.ws, opts.sessionToken, opts.urlEncode ?? true);

  // ── 1. get_vehicle_info ───────────────────────────────────────────────────
  const vehicleInfo = await mux.sendAction<any>("get_vehicle_info", {
    tag: "loading_screen",
    vehicle_id: String(opts.vehicleId),
  });

  const vi      = (vehicleInfo?.data?.[0] ?? {}) as JsonObj;
  const unitKey = safeDecodeURIComponent(String(vi.unit_key ?? ""));

  const header: VmHeader = {
    vehicle_id:            Number(vi.vehicle_id ?? opts.vehicleId),
    client_id:             vi.client_id         != null ? Number(vi.client_id)                            : null,
    inner_id:              vi.inner_id           != null ? String(vi.inner_id)                             : null,
    unit_key:              unitKey               || null,
    license_nmbr:          vi.license_nmbr       != null ? String(vi.license_nmbr)                        : null,
    unit_type:             vi.unit_type          != null ? String(vi.unit_type)                            : null,
    unit_version:          vi.unit_version       != null ? String(vi.unit_version)                        : null,
    configuration_key_db:  vi.configuration_key_db  != null ? String(vi.configuration_key_db)             : null,
    configuration_key_unit: vi.configuration_key_unit != null ? String(vi.configuration_key_unit)         : null,
    raw: vi,
  };

  // ── 2. Redis (is_connected) ───────────────────────────────────────────────
  const redis = await mux.sendAction<any>("get_vehicle_data_from_redis", {
    vehicle_id: String(opts.vehicleId),
  });
  const isConnectedRaw = redis?.data?.[0]?.is_connected;
  const isConnected    = isConnectedRaw == null ? null : Number(isConnectedRaw);

  // ── 3. Subscribes ─────────────────────────────────────────────────────────
  await mux.sendAction("vehicle_unsubscribe",  { vehicle_id: String(opts.vehicleId), object_type: "" });
  await mux.sendAction("vehicle_subscribe",    { vehicle_id: String(opts.vehicleId), object_type: "UNIT_MESSAGES" });
  await mux.sendAction("vehicle_subscribe",    { vehicle_id: String(opts.vehicleId), object_type: "UNIT_CONFIG_STATUS", value: "" });
  // UNIT_PARAMETERS subscribe ANTES do opr — ordem crítica (igual Internal Tools)
  await mux.sendAction("vehicle_subscribe",    { vehicle_id: String(opts.vehicleId), object_type: "UNIT_PARAMETERS" });

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

  if (!header.unit_key) throw new Error("[vm] unit_key ausente no get_vehicle_info");

  // ── 5. Module State (antes da janela — disponível desde o 1º partial) ─────
  const ms = await mux.sendAction<any>("get_monitor_module_state", {
    tag: "loading_screen",
    filter: "",
    vehicle_id: String(opts.vehicleId),
  });

  const moduleState: VmModuleStateRow[] = (ms?.data ?? []).map((r: any) => ({
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

  // ── 6. Handler de pushes ──────────────────────────────────────────────────
  //
  // REFACTOR_CAN_V2: deduplicação por nome com preferência SYS (000027xx)
  //   - nameToId rastreia qual paramId está "vencendo" para cada nome canônico
  //   - Se chegar um SYS param para o mesmo nome → substitui o não-SYS
  //   - Se já tiver SYS, só atualiza valor se for o mesmo ID
  //
  const latest    = new Map<string, VmParam>();  // paramId → param mais recente
  const nameToId  = new Map<string, string>();   // nome canônico → paramId vencedor

  let unitParametersEvents = 0;
  let unitMessagesEvents   = 0;
  let unitConnEvents       = 0;

  const off = mux.onRefresh((props) => {
    const ds = String(props?.data_source ?? "");

    if (ds === "UNIT_PARAMETERS") {
      unitParametersEvents++;
      const rows = Array.isArray(props?.data) ? props.data : (props?.data ? [props.data] : []);

      for (const row of rows) {
        // Normaliza ID igual ao Internal Tools: uppercase + pad 8
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

        // Nome canônico: PARAM_META > opr > row
        const metaName   = PARAM_META[id]?.name ?? null;
        const oprName    = idToName.get(id) ?? null;
        const rowName    = row?.param_type_descr != null ? safeDecodeURIComponent(String(row.param_type_descr)) : null;
        const canonical  = metaName ?? oprName ?? rowName ?? null;

        // Deduplicação por nome (lógica do Internal Tools)
        if (canonical) {
          const existingId    = nameToId.get(canonical);
          const incomingIsSys = isSysParam(id);

          if (!existingId) {
            // Primeiro que chega para este nome → aceita
            nameToId.set(canonical, id);
          } else if (incomingIsSys && !isSysParam(existingId)) {
            // SYS chega depois de não-SYS → SYS vence, remove o antigo
            latest.delete(existingId);
            nameToId.set(canonical, id);
          } else if (!incomingIsSys && isSysParam(existingId)) {
            // Não-SYS chega mas SYS já está vencendo → descarta silenciosamente
            continue;
          }
          // Se ambos SYS ou ambos não-SYS → atualiza valor normalmente
        }

        const prev = latest.get(id);

        // Conversão hex→decimal para params com PARAM_META
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

      // Partial callback (streaming progressivo)
      if (opts.onPartialParams) {
        try {
          const allParams  = Array.from(latest.values());
          const withValue  = allParams.filter(p => (p.raw_value ?? "") !== "").length;
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

  // ── 7. Dispara rajada + janela de coleta ──────────────────────────────────
  await mux.sendAction("send_quick_command", {
    unit_key:        header.unit_key,
    local_action_id: "5",
    cmd_id:          "9",
    ack_needed:      "0",
  });

  await sleep(waitAfterCmdMs);
  await sleep(windowMs);
  off();

  await mux.sendAction("vehicle_unsubscribe", { vehicle_id: String(opts.vehicleId), object_type: "" }).catch(() => {});

  // ── 8. canSummary (portado do Internal Tools) ─────────────────────────────
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
