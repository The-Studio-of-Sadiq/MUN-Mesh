import type { B64 } from './bytes';
import { splitHostPort } from './join';
import type { Link, MeshNode, PeerInfo, Wire } from './node';

/**
 * A byte stream to another device, as Node's `net.Socket`,
 * react-native-tcp-socket and the Electron IPC bridge all provide. Data
 * arrives as UTF-8 text (the transport sets the encoding).
 */
export interface SocketLike {
  write(data: string): void;
  end(): void;
  destroy(): void;
  on(event: 'data', cb: (data: string) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  on(event: 'error', cb: (err: unknown) => void): unknown;
}

export interface ListeningServer {
  port: number;
  close(): void;
}

/** Platform networking: Node `net` (hubs, tests), Android/iOS TCP, or Electron's bridge. */
export interface Transport {
  /** Listens on all interfaces; falls back to any free port if `port` is taken. */
  listen(port: number, onSocket: (s: SocketLike) => void): Promise<ListeningServer>;
  connect(host: string, port: number, timeoutMs: number): Promise<SocketLike>;
  /** This device's LAN IPv4 addresses. */
  localAddresses(): Promise<string[]>;
}

/** Longest line accepted; a peer sending more without a newline is cut off. */
export const MAX_LINE_CHARS = 16 * 1024 * 1024;

/**
 * Wires a socket to the node as one link: one JSON message per line.
 * `onClose` runs once, however the link ends.
 */
export function attachSocket(node: MeshNode, id: string, socket: SocketLike, onClose?: () => void): Link {
  let buffer = '';
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    node.disconnect(id);
    onClose?.();
  };
  const link: Link = {
    send: (msg: Wire) => {
      if (!closed) socket.write(`${JSON.stringify(msg)}\n`);
    },
    close: () => {
      socket.destroy();
      finish();
    },
  };
  socket.on('data', (chunk) => {
    if (closed) return;
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Wire;
      try {
        msg = JSON.parse(line) as Wire;
      } catch {
        link.close();
        return;
      }
      node.receive(id, msg);
      if (closed) return;
    }
    if (buffer.length > MAX_LINE_CHARS) link.close();
  });
  socket.on('close', finish);
  socket.on('error', () => link.close());
  node.connect(id, link);
  return link;
}

/** Where an address came from; invites and beacons are tried before addresses heard second-hand. */
export type AddressSource = 'invite' | 'manual' | 'beacon' | 'peer';
const PRIORITY: Record<AddressSource, number> = { manual: 0, invite: 1, beacon: 2, peer: 3 };

interface BookEntry {
  addr: string;
  source: AddressSource;
  failures: number;
  nextTry: number;
}

interface LinkState {
  id: string;
  socket: SocketLike;
  link: Link;
  inbound: boolean;
  addr?: string;
  node?: B64;
}

export interface DeviceOptions {
  node: MeshNode;
  transport: Transport;
  /** Accept connections on this port (hubs and bridge laptops). Null: only dial out (phones). */
  listenPort: number | null;
  /** Most outgoing links to keep. Hubs dial every hub they hear of; phones keep two or three. */
  maxOutbound: number;
  now?: () => number;
  connectTimeoutMs?: number;
}

export interface DeviceStatus {
  port: number | null;
  addresses: string[];
  links: { id: string; inbound: boolean; addr?: string; node?: B64 }[];
  known: { addr: string; source: AddressSource; failures: number }[];
}

/**
 * Keeps a device connected: listens (hubs), dials known addresses with
 * back-off, learns hub addresses from neighbours and beacons, and drops
 * duplicate links to the same device.
 */
export class Device {
  readonly node: MeshNode;
  private readonly transport: Transport;
  private readonly opts: DeviceOptions;
  private readonly now: () => number;
  private server: ListeningServer | null = null;
  private readonly book = new Map<string, BookEntry>();
  private readonly links = new Map<string, LinkState>();
  private readonly dialing = new Set<string>();
  private ownAddresses: string[] = [];
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly listeners = new Set<() => void>();

  constructor(opts: DeviceOptions) {
    this.opts = opts;
    this.node = opts.node;
    this.transport = opts.transport;
    this.now = opts.now ?? Date.now;
    this.node.onPeer((peer) => this.onPeer(peer));
  }

  /** Called whenever links or known addresses change. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.opts.listenPort !== null) {
      this.server = await this.transport.listen(this.opts.listenPort, (s) => this.attach(s, true));
    }
    await this.refreshAddresses();
    this.timer = setInterval(() => this.tick(), 1000);
    this.maintain();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.server?.close();
    for (const l of this.links.values()) l.link.close();
    this.links.clear();
  }

  get port(): number | null {
    return this.server?.port ?? null;
  }

  /** Re-reads this device's IPs (e.g. after joining another Wi-Fi) and tells neighbours on the next hello. */
  async refreshAddresses(): Promise<string[]> {
    const port = this.port;
    const ips = port === null ? [] : await this.transport.localAddresses();
    this.ownAddresses = ips.map((ip) => `${ip}:${port}`);
    this.node.setAddresses(this.ownAddresses);
    this.changed();
    return this.ownAddresses;
  }

  addAddress(addr: string, source: AddressSource): void {
    if (this.ownAddresses.includes(addr)) return;
    const known = this.book.get(addr);
    if (known) {
      if (PRIORITY[source] < PRIORITY[known.source]) known.source = source;
      // Fresh evidence it's there (a beacon, a new invite): try again soon.
      if (source !== 'peer') known.nextTry = Math.min(known.nextTry, this.now());
      return;
    }
    this.book.set(addr, { addr, source, failures: 0, nextTry: this.now() });
    this.changed();
    this.maintain();
  }

  status(): DeviceStatus {
    return {
      port: this.port,
      addresses: this.ownAddresses,
      links: [...this.links.values()].map(({ id, inbound, addr, node }) => ({ id, inbound, addr, node })),
      known: [...this.book.values()].map(({ addr, source, failures }) => ({ addr, source, failures })),
    };
  }

  private tick(): void {
    this.node.tick();
    this.maintain();
  }

  private maintain(): void {
    if (this.stopped) return;
    const now = this.now();
    let outbound = [...this.links.values()].filter((l) => !l.inbound).length + this.dialing.size;
    const linkedAddrs = new Set([...this.links.values()].map((l) => l.addr));
    const candidates = [...this.book.values()]
      .filter((b) => !linkedAddrs.has(b.addr) && !this.dialing.has(b.addr) && b.nextTry <= now)
      .sort((a, b) => PRIORITY[a.source] - PRIORITY[b.source] || a.failures - b.failures);
    for (const entry of candidates) {
      if (outbound >= this.opts.maxOutbound) break;
      outbound++;
      void this.dial(entry);
    }
  }

  private async dial(entry: BookEntry): Promise<void> {
    this.dialing.add(entry.addr);
    try {
      const { host, port } = splitHostPort(entry.addr);
      const socket = await this.transport.connect(host, port, this.opts.connectTimeoutMs ?? 4000);
      if (this.stopped) {
        socket.destroy();
        return;
      }
      entry.failures = 0;
      this.attach(socket, false, entry.addr);
    } catch {
      entry.failures++;
      // 2 s, 4 s, … up to 30 s; addresses that keep failing (another subnet) settle at 5 min.
      entry.nextTry = this.now() + (entry.failures > 6 ? 300_000 : Math.min(30_000, 1000 * 2 ** entry.failures));
    } finally {
      this.dialing.delete(entry.addr);
      this.changed();
    }
  }

  private attach(socket: SocketLike, inbound: boolean, addr?: string): void {
    const id = `${inbound ? 'in' : 'out'}-${this.nextId++}`;
    const state = { id, socket, inbound, addr } as LinkState;
    this.links.set(id, state);
    state.link = attachSocket(this.node, id, socket, () => {
      this.links.delete(id);
      const entry = addr ? this.book.get(addr) : undefined;
      if (entry) entry.nextTry = this.now() + 2000;
      this.changed();
    });
    this.changed();
  }

  private onPeer(peer: PeerInfo): void {
    const state = this.links.get(peer.id);
    if (!state) return;
    if (peer.node === this.node.key) {
      // Dialled ourselves through one of our own addresses.
      if (state.addr) this.book.delete(state.addr);
      state.link.close();
      return;
    }
    state.node = peer.node;
    const twin = [...this.links.values()].find((l) => l !== state && l.node === peer.node);
    if (twin) {
      let drop: LinkState | null;
      if (twin.inbound !== state.inbound) {
        // One link each way. Both ends apply the same rule, so they close the
        // same one: keep the link dialled by the device with the smaller key.
        const keepMine = this.node.key < peer.node;
        drop = state.inbound === keepMine ? state : twin;
      } else {
        // Two links the same way (the other device has two addresses). Only
        // the dialling side closes one, and leaves that address alone a while.
        drop = state.inbound ? null : state;
        const entry = drop?.addr ? this.book.get(drop.addr) : undefined;
        if (entry) entry.nextTry = this.now() + 60_000;
      }
      if (drop) {
        drop.link.close();
        if (drop === state) return;
      }
    }
    for (const a of peer.addrs) this.addAddress(a, 'peer');
    this.changed();
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}
