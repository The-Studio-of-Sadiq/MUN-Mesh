import type { B64 } from './bytes';
import type { Device, SocketLike } from './device';

/**
 * Phone-to-phone links with Android's Nearby Connections (Bluetooth and
 * Wi-Fi Direct, chosen by Google Play services). The native module only
 * advertises, discovers, connects and moves text; everything else is here,
 * so it runs and is tested the same everywhere.
 */
export interface NearbyNative {
  /** Advertise as `name` and discover others offering `serviceId`. */
  start(serviceId: string, name: string): Promise<void>;
  stop(): Promise<void>;
  /** Ask to connect; both sides accept automatically (every message is signed anyway). */
  connect(endpoint: string, name: string): Promise<void>;
  send(endpoint: string, text: string): Promise<void>;
  disconnect(endpoint: string): void;
  onEvent(cb: (e: NearbyEvent) => void): () => void;
}

export type NearbyEvent =
  | { type: 'found'; endpoint: string; name: string }
  | { type: 'lost'; endpoint: string }
  /** `incoming`: the other phone asked. */
  | { type: 'connected'; endpoint: string; incoming: boolean }
  | { type: 'disconnected'; endpoint: string }
  | { type: 'data'; endpoint: string; text: string };

export const NEARBY_SERVICE_ID = 'com.studioofsadiq.mun';

/** Characters per piece: under Nearby's 32 KB message limit even if every character takes 3 bytes. */
export const NEARBY_PIECE_CHARS = 8000;

/** "conf|key": phones of another conference are never connected; the key prefix decides who dials. */
export const nearbyName = (confId: string, key: B64) => `${confId}|${key.slice(0, 16)}`;

function parseName(name: string): { conf: string; key: string } | null {
  const i = name.indexOf('|');
  return i > 0 ? { conf: name.slice(0, i), key: name.slice(i + 1) } : null;
}

/** Splits text into pieces without cutting a character in two (surrogate pairs stay together). */
export function splitPieces(text: string, size = NEARBY_PIECE_CHARS): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    let end = Math.min(text.length, i + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * A Nearby connection as a byte stream. Pieces carry a sequence number, so
 * the text is put back in order even if the radio delivers out of order.
 */
class NearbySocket implements SocketLike {
  private readonly handlers = { data: [] as ((d: string) => void)[], close: [] as (() => void)[], error: [] as ((e: unknown) => void)[] };
  private sendSeq = 0;
  private nextSeq = 0;
  private readonly early = new Map<number, string>();
  private sending: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly native: NearbyNative;
  readonly endpoint: string;

  constructor(native: NearbyNative, endpoint: string) {
    this.native = native;
    this.endpoint = endpoint;
  }

  write(data: string): void {
    if (this.closed) return;
    for (const piece of splitPieces(data)) {
      const framed = `${this.sendSeq++}:${piece}`;
      // One at a time, in order; a failed send ends the link.
      this.sending = this.sending.then(() => (this.closed ? undefined : this.native.send(this.endpoint, framed))).catch((e) => {
        this.handlers.error.forEach((h) => h(e));
        this.destroy();
      });
    }
  }

  end(): void {
    // Let queued pieces go out first.
    void this.sending.then(() => this.destroy());
  }

  destroy(): void {
    if (this.closed) return;
    this.native.disconnect(this.endpoint);
    this.closedByUs();
  }

  on(event: 'data' | 'close' | 'error', cb: (arg: never) => void): this {
    (this.handlers[event] as unknown[]).push(cb);
    return this;
  }

  /** A piece arrived from the radio. */
  received(framed: string): void {
    const colon = framed.indexOf(':');
    const seq = Number(framed.slice(0, colon));
    if (colon < 1 || !Number.isSafeInteger(seq) || seq < this.nextSeq) return;
    this.early.set(seq, framed.slice(colon + 1));
    if (this.early.size > 4096) return this.destroy();
    let piece: string | undefined;
    while ((piece = this.early.get(this.nextSeq)) !== undefined) {
      this.early.delete(this.nextSeq++);
      this.handlers.data.forEach((h) => h(piece!));
    }
  }

  closedByUs(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.close.forEach((h) => h());
  }
}

export interface NearbyStatus {
  running: boolean;
  /** Phones of this conference in range. */
  seen: number;
  links: number;
  /** Last thing Nearby refused, for showing on screen (the phone may have no way to send logs). */
  error?: string;
}

/** If the phone that should dial hasn't after this long, the other one does. */
const FALLBACK_DIAL_MS = 5000;

/**
 * Keeps up to `maxLinks` Nearby links to phones of the same conference and
 * hands each to the device as an ordinary link. Of two phones that see each
 * other, only the one with the smaller key dials, so they don't both try.
 */
export class NearbyRelay {
  private readonly device: Device;
  private readonly native: NearbyNative;
  private readonly confId: string;
  private readonly maxLinks: number;
  private readonly sockets = new Map<string, NearbySocket>();
  /** Endpoint → its name and when we first saw it. */
  private readonly found = new Map<string, { name: string; since: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | undefined;
  private readonly dialing = new Set<string>();
  private unsubscribe: () => void = () => {};
  private running = false;
  private readonly myName: string;

  constructor(opts: { device: Device; native: NearbyNative; confId: string; maxLinks?: number }) {
    this.device = opts.device;
    this.native = opts.native;
    this.confId = opts.confId;
    this.maxLinks = opts.maxLinks ?? 3;
    this.myName = nearbyName(this.confId, this.device.node.key);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.native.onEvent((e) => this.onEvent(e));
    this.timer = setInterval(() => this.dialSome(), 2000);
    try {
      await this.native.start(NEARBY_SERVICE_ID, this.myName);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe();
    for (const s of this.sockets.values()) s.destroy();
    this.sockets.clear();
    this.found.clear();
    await this.native.stop();
  }

  status(): NearbyStatus {
    return { running: this.running, seen: this.found.size, links: this.sockets.size, error: this.lastError };
  }

  private onEvent(e: NearbyEvent): void {
    switch (e.type) {
      case 'found': {
        const them = parseName(e.name);
        const me = parseName(this.myName)!;
        if (!them || them.conf !== this.confId || them.key === me.key) return;
        if (!this.found.has(e.endpoint)) this.found.set(e.endpoint, { name: e.name, since: Date.now() });
        if (me.key < them.key) this.maybeDial(e.endpoint);
        return;
      }
      case 'lost':
        this.found.delete(e.endpoint);
        return;
      case 'connected': {
        this.dialing.delete(e.endpoint);
        if (this.sockets.has(e.endpoint) || this.sockets.size >= this.maxLinks) {
          if (!this.sockets.has(e.endpoint)) this.native.disconnect(e.endpoint);
          return;
        }
        const socket = new NearbySocket(this.native, e.endpoint);
        this.sockets.set(e.endpoint, socket);
        socket.on('close', () => this.sockets.delete(e.endpoint));
        this.device.adopt(socket, e.incoming);
        return;
      }
      case 'disconnected': {
        this.dialing.delete(e.endpoint);
        const socket = this.sockets.get(e.endpoint);
        this.sockets.delete(e.endpoint);
        socket?.closedByUs();
        // Someone else in range may take the free slot.
        this.dialSome();
        return;
      }
      case 'data':
        this.sockets.get(e.endpoint)?.received(e.text);
        return;
    }
  }

  /**
   * Dials phones in range that aren't linked yet. The smaller key dials first;
   * discovery can be one-sided, so after a few seconds the other phone dials
   * too rather than both waiting forever. Failed dials are retried here.
   */
  private dialSome(): void {
    const me = parseName(this.myName)!.key;
    const now = Date.now();
    for (const [endpoint, { name, since }] of this.found) {
      const them = parseName(name);
      if (them && (me < them.key || now - since >= FALLBACK_DIAL_MS)) this.maybeDial(endpoint);
    }
  }

  private maybeDial(endpoint: string): void {
    if (!this.running || this.sockets.has(endpoint) || this.dialing.has(endpoint)) return;
    if (this.sockets.size + this.dialing.size >= this.maxLinks) return;
    this.dialing.add(endpoint);
    this.native.connect(endpoint, this.myName).catch((e) => {
      this.dialing.delete(endpoint);
      this.lastError = e instanceof Error ? e.message : String(e);
    });
  }
}
