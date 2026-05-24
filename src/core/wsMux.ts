// src/core/wsMux.ts
//
// WsMux: resolve respostas por mtkn (não por action_name).
// Baseado no TraffilogWsMux do monitor-backend.
// Usa a conexão cacheada do wsManager — mesma sessão que o servidor conhece.

import crypto from 'crypto';
import { getConn } from './wsManager';

export type WsLike = {
  on(event: 'message', cb: (data: any) => void): any;
  send(data: string): any;
  close(): any;
};

function makeMtkn(): string {
  const hex = crypto.randomBytes(16).toString('hex');
  return BigInt('0x' + hex).toString(10);
}

function makeFlowId(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

type PendingEntry = {
  resolve: (x: any) => void;
  reject: (e: any) => void;
  t: NodeJS.Timeout;
};

export class WsMux {
  private pending    = new Map<string, PendingEntry>();
  private refreshHandlers = new Set<(props: any) => void>();

  constructor(
    private ws: WsLike,
    private sessionToken: string,
    private urlEncode = true,
  ) {
    this.ws.on('message', (data: any) => {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');

      // decodifica se vier URL-encoded
      const decoded = text.trimStart().startsWith('%7B')
        ? (() => { try { return decodeURIComponent(text); } catch { return text; } })()
        : text;

      let msg: any = null;
      try { msg = JSON.parse(decoded); } catch { return; }

      const props = msg?.response?.properties;
      if (!props) return;

      const mtkn       = String(props.mtkn ?? '');
      const actionName = String(props.action_name ?? '');

      // Resolve promise pendente pelo mtkn
      if (mtkn && this.pending.has(mtkn)) {
        const p = this.pending.get(mtkn)!;
        clearTimeout(p.t);
        this.pending.delete(mtkn);
        p.resolve(props);
        return;
      }

      // Push de refresh → distribui para handlers registrados
      if (actionName === 'refresh') {
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

  sendAction<T = any>(
    name: string,
    parameters: Record<string, any>,
    timeoutMs = 15_000,
  ): Promise<T> {
    const token = makeMtkn();
    const frame = {
      action: {
        flow_id: makeFlowId(),
        name,
        parameters: { ...parameters, _action_name: name, mtkn: token },
        session_token: this.sessionToken,
        mtkn: token,
      },
    };

    const payloadJson = JSON.stringify(frame);
    const payload     = this.urlEncode ? encodeURIComponent(payloadJson) : payloadJson;

    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(token);
        reject(new Error(`[WsMux] timeout mtkn=${token} action=${name}`));
      }, timeoutMs);

      this.pending.set(token, { resolve, reject, t });
      this.ws.send(payload);
    });
  }
}

/**
 * Retorna um WsMux pronto usando a conexão cacheada do wsManager.
 * Toda a sessão autenticada fica numa só conexão — os pushes chegam aqui.
 */
export async function getCachedMux(): Promise<WsMux> {
  const { ws, sessionToken } = await getConn();
  return new WsMux(ws as any, sessionToken, true);
}
