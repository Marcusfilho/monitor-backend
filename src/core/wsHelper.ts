import { openWs, openFreshWs } from './wsClient';

const RECV_TIMEOUT_MS = 45_000;

export function genFlowId(): string {
  return String(200000 + Math.floor(Math.random() * 800000));
}

export function genMtkn(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
}

let wsLoggedIn = false;

async function doLogin(): Promise<void> {
  const login = (process.env.WS_LOGIN_NAME || '').trim();
  const pass  = (process.env.WS_PASSWORD   || '').trim();
  if (!login || !pass) { wsLoggedIn = true; return; }

  const TOKEN_API_URL = (
    process.env.MONITOR_TOKEN_API_URL ||
    'https://api-il.traffilog.com/appengine_3/5E1DCD81-5138-4A35-B271-E33D71FFFFD9/1/json'
  ).trim();

  console.log('[wsHelper] HTTP user_login...');
  const res = await fetch(TOKEN_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: { name: 'user_login', parameters: { login_name: login, password: pass } }
    }),
  });

  const j: any = await res.json();
  const av    = j?.response?.properties?.action_value ?? '';
  const token = j?.response?.properties?.session_token ?? '';

  if (String(av) !== '0' || !token) throw new Error(`HTTP user_login FAIL action_value=${av}`);

  process.env.MONITOR_SESSION_TOKEN = token;
  try {
    const u = new URL(process.env.MONITOR_WS_URL || '');
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length >= 2) { seg[1] = token; u.pathname = '/' + seg.join('/'); }
    process.env.MONITOR_WS_URL = u.toString();
  } catch {}

  wsLoggedIn = true;
  console.log('[wsHelper] HTTP user_login OK');
}

export async function ensureLogin(): Promise<void> { await doLogin(); }

// ─── Fila de listeners por action_name ────────────────────────────────────────
const pending: Map<string, Array<(obj: any) => void>> = new Map();

// ─── Handlers de refresh (pushes assíncronos) ─────────────────────────────────
// Chave: qualquer string (geralmente data_source como 'UNIT_PARAMETERS')
// Valor: Set de handlers registrados para aquele data_source
const refreshHandlers: Map<string, Set<(props: any) => void>> = new Map();

/**
 * Registra um handler para pushes refresh de um data_source específico.
 * Retorna função de cleanup para remover o handler.
 *
 * Exemplo:
 *   const unsub = onRefresh('UNIT_PARAMETERS', (props) => { ... });
 *   // quando terminar:
 *   unsub();
 */
export function onRefresh(
  dataSource: string,
  handler: (props: any) => void
): () => void {
  if (!refreshHandlers.has(dataSource)) {
    refreshHandlers.set(dataSource, new Set());
  }
  refreshHandlers.get(dataSource)!.add(handler);
  console.log(`[wsHelper] onRefresh registrado para data_source="${dataSource}"`);

  return () => {
    const set = refreshHandlers.get(dataSource);
    if (set) {
      set.delete(handler);
      if (set.size === 0) refreshHandlers.delete(dataSource);
      console.log(`[wsHelper] onRefresh removido para data_source="${dataSource}"`);
    }
  };
}

// ─── Parsing / dispatch ───────────────────────────────────────────────────────

function extractActionName(buf: string): string {
  const m = buf.match(/"action_name"\s*:\s*"([^"]+)"/);
  return m ? m[1] : '';
}

function isJsonComplete(buf: string): boolean {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return true; }
  }
  return false;
}

function dispatch(ws: any): void {
  const buf: string = ws.__fragBuf;
  if (!buf.trimStart().startsWith('{')) return;
  if (!isJsonComplete(buf)) return;

  let depth = 0, inStr = false, escape = false, endIdx = -1;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx < 0) return;

  const chunk = buf.slice(0, endIdx + 1);
  let parsed: any = null;

  try {
    parsed = JSON.parse(chunk);
  } catch {
    const actionName = extractActionName(chunk);
    if (!actionName) {
      ws.__fragBuf = buf.slice(endIdx + 1).trimStart();
      console.log('[wsHelper] dispatch: chunk inválido descartado len=' + chunk.length);
      return;
    }
    const actionValueM  = chunk.match(/"action_value"\s*:\s*"([^"]*)"/);
    const actionRecordsM = chunk.match(/"action_records"\s*:\s*"([^"]*)"/);
    parsed = {
      response: {
        properties: {
          action_name: actionName,
          action_value: actionValueM ? actionValueM[1] : '0',
          action_records: actionRecordsM ? actionRecordsM[1] : '0',
          data: [],
        }
      }
    };
  }

  ws.__fragBuf = buf.slice(endIdx + 1).trimStart();

  const props      = parsed?.response?.properties ?? parsed?.response ?? parsed;
  const recvAction = String(props?.action_name ?? parsed?.action_name ?? '');

  if (!recvAction) {
    if (ws.__fragBuf.length > 0) dispatch(ws);
    return;
  }

  console.log('[wsHelper] dispatch action="' + recvAction + '" keys=' + Object.keys(props).slice(0, 6).join(','));

  // ── Pushes de refresh: rotear para onRefresh handlers ──────────────────────
  if (recvAction === 'refresh') {
    const dataSource = String(props?.data_source ?? '');
    const handlers = refreshHandlers.get(dataSource);
    if (handlers && handlers.size > 0) {
      for (const h of handlers) {
        try { h(props); } catch (e) {
          console.error('[wsHelper] onRefresh handler error:', e);
        }
      }
    } else {
      // Sem handler registrado — loga mas NÃO descarta em silêncio
      console.log(`[wsHelper] dispatch: refresh data_source="${dataSource}" sem handler (ignorado)`);
    }
    if (ws.__fragBuf.trimStart().startsWith('{')) dispatch(ws);
    return;
  }

  // ── Ações normais: fila pending por action_name ────────────────────────────
  const list = pending.get(recvAction);
  if (list && list.length > 0) {
    const cb = list.shift()!;
    if (list.length === 0) pending.delete(recvAction);
    cb(parsed);
  } else {
    console.log('[wsHelper] dispatch: nenhum listener para action="' + recvAction + '" (ignorado)');
  }

  if (ws.__fragBuf.trimStart().startsWith('{')) dispatch(ws);
}

function installHandler(ws: any): void {
  if (ws.__helperHandlerInstalled) return;
  ws.__helperHandlerInstalled = true;
  ws.__fragBuf = '';

  ws.on('message', (buf: any) => {
    const txt = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    const dec = txt.trim().startsWith('{') || txt.trim().startsWith('[')
      ? txt : (() => { try { return decodeURIComponent(txt); } catch { return txt; } })();
    ws.__fragBuf += dec;
    dispatch(ws);
  });

  ws.on('open', () => {
    ws.__fragBuf = '';
    console.log('[wsHelper] WS open — fragBuf reset');
  });

  ws.on('close', () => {
    ws.__fragBuf = '';
    console.log('[wsHelper] WS fechado — fragBuf limpo');
  });

  console.log('[wsHelper] handler global instalado');
}

// ─── API pública ──────────────────────────────────────────────────────────────

export async function sendFrame(
  actionName: string,
  params: Record<string, unknown>
): Promise<void> {
  if (!wsLoggedIn) await doLogin();
  const { ws } = await openWs();
  installHandler(ws);

  const token  = process.env.MONITOR_SESSION_TOKEN || '';
  const mtkn   = genMtkn();
  const flowId = genFlowId();

  const frame = {
    action: {
      flow_id: flowId,
      name: actionName,
      parameters: { ...params, _action_name: actionName, mtkn },
      session_token: token,
      mtkn,
    }
  };

  ws.send(JSON.stringify(frame));
  console.log('[wsHelper] FRAME (no-wait) action=' + actionName);
}

export async function sendActionFresh(
  actionName: string,
  params: Record<string, unknown>
): Promise<any> {
  if (!wsLoggedIn) await doLogin();

  const { ws } = await openFreshWs();
  installHandler(ws);

  const token  = process.env.MONITOR_SESSION_TOKEN || '';
  const mtkn   = genMtkn();
  const flowId = genFlowId();

  const frame = {
    action: {
      flow_id: flowId,
      name: actionName,
      parameters: { ...params, _action_name: actionName, mtkn },
      session_token: token,
      mtkn,
    }
  };

  const recvPromise = new Promise<any>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const list = pending.get(actionName);
      if (list) { const i = list.indexOf(cb); if (i >= 0) list.splice(i, 1); }
      reject(new Error('wsHelper timeout action=' + actionName));
    }, RECV_TIMEOUT_MS);

    function cb(obj: any) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(obj);
    }

    if (!pending.has(actionName)) pending.set(actionName, []);
    pending.get(actionName)!.push(cb);
  });

  ws.send(JSON.stringify(frame));
  console.log('[wsHelper] SEND(fresh) action=' + actionName);

  const result = await recvPromise;
  console.log('[wsHelper] RECV(fresh) ok action=' + actionName);
  return result;
}

export async function sendAction(
  actionName: string,
  params: Record<string, unknown>,
  timeoutMs: number = RECV_TIMEOUT_MS
): Promise<any> {
  if (!wsLoggedIn) await doLogin();

  const { ws } = await openWs();
  installHandler(ws);

  const token  = process.env.MONITOR_SESSION_TOKEN || '';
  const mtkn   = genMtkn();
  const flowId = genFlowId();

  const frame = {
    action: {
      flow_id: flowId,
      name: actionName,
      parameters: { ...params, _action_name: actionName, mtkn },
      session_token: token,
      mtkn,
    }
  };

  const recvPromise = new Promise<any>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const list = pending.get(actionName);
      if (list) { const i = list.indexOf(cb); if (i >= 0) list.splice(i, 1); }
      reject(new Error('wsHelper timeout action=' + actionName));
    }, timeoutMs);

    function cb(obj: any) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(obj);
    }

    if (!pending.has(actionName)) pending.set(actionName, []);
    pending.get(actionName)!.push(cb);
  });

  ws.send(JSON.stringify(frame));
  console.log('[wsHelper] SEND action=' + actionName);

  const result = await recvPromise;
  console.log('[wsHelper] RECV ok action=' + actionName);
  return result;
}
