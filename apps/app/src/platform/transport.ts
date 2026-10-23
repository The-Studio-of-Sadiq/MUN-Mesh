import type { SocketLike, Transport } from '@mun/core';
import { rankAddresses } from './addresses';

/** Exposed by apps/desktop/preload.js. Absent in a plain browser. */
type BridgeEvent =
  | { type: 'connection'; id: number }
  | { type: 'data'; id: number; data: string }
  | { type: 'close'; id: number }
  | { type: 'error'; id: number; message: string };

interface NetBridge {
  listen(port: number): Promise<number>;
  unlisten(): Promise<void>;
  connect(host: string, port: number, timeoutMs: number): Promise<number>;
  write(id: number, data: string): void;
  end(id: number): void;
  destroy(id: number): void;
  addresses(): Promise<string[]>;
  onEvent(cb: (e: BridgeEvent) => void): () => void;
}

const bridge = (globalThis as { munNet?: NetBridge }).munNet;

type Handlers = { data: ((d: string) => void)[]; close: (() => void)[]; error: ((e: unknown) => void)[] };

/** A socket living in Electron's main process, driven over IPC. */
class BridgeSocket implements SocketLike {
  handlers: Handlers = { data: [], close: [], error: [] };
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
  write(data: string) {
    bridge!.write(this.id, data);
  }
  end() {
    bridge!.end(this.id);
  }
  destroy() {
    bridge!.destroy(this.id);
  }
  on(event: 'data' | 'close' | 'error', cb: (arg: never) => void) {
    (this.handlers[event] as unknown[]).push(cb);
    return this;
  }
}

const sockets = new Map<number, BridgeSocket>();
let onIncoming: ((s: SocketLike) => void) | null = null;

bridge?.onEvent((e) => {
  if (e.type === 'connection') {
    const s = new BridgeSocket(e.id);
    sockets.set(e.id, s);
    onIncoming?.(s);
    return;
  }
  const s = sockets.get(e.id);
  if (!s) return;
  if (e.type === 'data') s.handlers.data.forEach((h) => h(e.data));
  else if (e.type === 'error') s.handlers.error.forEach((h) => h(new Error(e.message)));
  else {
    sockets.delete(e.id);
    s.handlers.close.forEach((h) => h());
  }
});

/** Raw sockets exist in the Windows app and on phones, not in a plain browser. */
export const socketsAvailable = !!bridge;

/** Laptops accept connections, so they can be hubs and bridges. */
export const canHost = !!bridge;

export const transport: Transport = {
  async listen(port, onSocket) {
    if (!bridge) throw new Error('No sockets in a browser');
    onIncoming = onSocket;
    const actual = await bridge.listen(port);
    return {
      port: actual,
      close: () => {
        onIncoming = null;
        void bridge.unlisten();
      },
    };
  },

  async connect(host, port, timeoutMs) {
    if (!bridge) throw new Error('No sockets in a browser');
    const id = await bridge.connect(host, port, timeoutMs);
    const s = new BridgeSocket(id);
    sockets.set(id, s);
    return s;
  },

  async localAddresses() {
    return bridge ? rankAddresses(await bridge.addresses()) : [];
  },
};
