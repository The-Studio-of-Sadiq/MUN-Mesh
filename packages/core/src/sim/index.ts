import type { Link, MeshNode, Wire } from '../node';

/**
 * A deterministic network for testing the real `MeshNode` at conference
 * scale. Only the links are simulated (latency, bandwidth, shared Wi-Fi
 * airtime, devices dropping off); every node runs the same code a phone or
 * hub runs, and every message goes through JSON as it would on a socket.
 */
export class Sim {
  now = 0;
  private queue: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;
  readonly random: () => number;

  constructor(seed = 1) {
    this.random = mulberry32(seed);
  }

  at(time: number, fn: () => void): void {
    this.push({ at: Math.max(time, this.now), seq: this.seq++, fn });
  }

  after(delay: number, fn: () => void): void {
    this.at(this.now + delay, fn);
  }

  every(interval: number, fn: () => void, start = interval): void {
    const run = () => {
      fn();
      this.after(interval, run);
    };
    this.at(start, run);
  }

  /** Runs everything scheduled up to `until`, then sets the clock there. */
  run(until: number): void {
    while (this.queue.length && this.queue[0]!.at <= until) {
      const next = this.pop()!;
      this.now = next.at;
      next.fn();
    }
    this.now = until;
  }

  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.random() * list.length)]!;
  }

  between(min: number, max: number): number {
    return min + this.random() * (max - min);
  }

  // Binary heap ordered by (at, seq), so same-time events run in scheduling order.
  private push(item: { at: number; seq: number; fn: () => void }): void {
    const q = this.queue;
    q.push(item);
    let i = q.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (before(q[parent]!, q[i]!)) break;
      [q[parent], q[i]] = [q[i]!, q[parent]!];
      i = parent;
    }
  }

  private pop() {
    const q = this.queue;
    const top = q[0];
    const last = q.pop()!;
    if (q.length) {
      q[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < q.length && before(q[l]!, q[m]!)) m = l;
        if (r < q.length && before(q[r]!, q[m]!)) m = r;
        if (m === i) break;
        [q[m], q[i]] = [q[i]!, q[m]!];
        i = m;
      }
    }
    return top;
  }
}

const before = (a: { at: number; seq: number }, b: { at: number; seq: number }) => a.at < b.at || (a.at === b.at && a.seq < b.seq);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Physical kinds of link, with rough real-world numbers. */
export const LINK_KINDS = {
  /** Phone or laptop ↔ hub over a room's Wi-Fi router. Shares the room's airtime. */
  wifi: { latency: 8, bytesPerSec: 2_000_000 },
  /** Cable or a laptop's second adapter between rooms. */
  bridge: { latency: 3, bytesPerSec: 10_000_000 },
  /** Android Nearby Connections (Bluetooth / Wi-Fi Direct) between phones. */
  nearby: { latency: 60, bytesPerSec: 150_000 },
} as const;

export type LinkKind = keyof typeof LINK_KINDS;

/** Usable airtime of one room's router, shared by every Wi-Fi link in the room. */
export const ROOM_AIRTIME_BYTES_PER_SEC = 6_000_000;

interface SimLink {
  id: string;
  a: string;
  b: string;
  kind: LinkKind;
  /** Wi-Fi links in the same room share its router's airtime. */
  medium: string | null;
  /** Wanted up (false after a link failure in the scenario). */
  enabled: boolean;
  up: boolean;
  /** Bumped on every down, so messages in flight on the old connection are lost. */
  epoch: number;
  /** When each direction's previous message finishes arriving (keeps per-link order). */
  free: Record<string, number>;
}

export interface NetStats {
  messages: number;
  bytes: number;
  byType: Record<string, { messages: number; bytes: number }>;
  /** Messages lost because a link went down while they were in flight. */
  dropped: number;
}

export class SimNet {
  readonly sim: Sim;
  readonly nodes = new Map<string, MeshNode>();
  readonly links = new Map<string, SimLink>();
  readonly stats: NetStats = { messages: 0, bytes: 0, byType: {}, dropped: 0 };
  private readonly offline = new Set<string>();
  private readonly mediumFree = new Map<string, number>();

  constructor(sim: Sim) {
    this.sim = sim;
  }

  add(name: string, node: MeshNode): void {
    this.nodes.set(name, node);
  }

  isOnline(name: string): boolean {
    return !this.offline.has(name);
  }

  link(a: string, b: string, kind: LinkKind, medium: string | null = null): string {
    const id = `${a}~${b}`;
    this.links.set(id, { id, a, b, kind, medium, enabled: true, up: false, epoch: 0, free: { [a]: 0, [b]: 0 } });
    this.setLink(id, true);
    return id;
  }

  /** Breaks or restores a link (a bridge cable pulled, a phone out of range). */
  setLink(id: string, enabled: boolean): void {
    const l = this.links.get(id)!;
    l.enabled = enabled;
    this.apply(l);
  }

  private apply(l: SimLink): void {
    const wanted = l.enabled && this.isOnline(l.a) && this.isOnline(l.b);
    if (wanted === l.up) return;
    l.up = wanted;
    const na = this.nodes.get(l.a)!;
    const nb = this.nodes.get(l.b)!;
    if (!wanted) {
      l.epoch++;
      na.disconnect(l.id);
      nb.disconnect(l.id);
      return;
    }
    na.connect(l.id, this.endpoint(l, l.a, l.b));
    nb.connect(l.id, this.endpoint(l, l.b, l.a));
  }

  /** Takes a device off the network (battery, walked out) or back. Its links follow. */
  setOnline(name: string, online: boolean): void {
    if (online) this.offline.delete(name);
    else this.offline.add(name);
    for (const l of this.links.values()) {
      // A link whose other end is offline stays down until that end returns.
      if (l.a === name || l.b === name) this.apply(l);
    }
  }

  private endpoint(l: SimLink, from: string, to: string): Link {
    const epoch = l.epoch;
    return {
      send: (msg: Wire) => {
        if (!l.up || l.epoch !== epoch) return;
        const text = JSON.stringify(msg);
        const size = text.length;
        this.count(msg.t, size);
        const spec = LINK_KINDS[l.kind];
        let start = Math.max(this.sim.now, l.free[from]!);
        if (l.medium) {
          // Airtime: one transmission at a time per room.
          start = Math.max(start, this.mediumFree.get(l.medium) ?? 0);
          this.mediumFree.set(l.medium, start + (size / ROOM_AIRTIME_BYTES_PER_SEC) * 1000);
        }
        const done = start + (size / spec.bytesPerSec) * 1000;
        l.free[from] = done;
        this.sim.at(done + spec.latency, () => {
          if (!l.up || l.epoch !== epoch) {
            this.stats.dropped++;
            return;
          }
          this.nodes.get(to)!.receive(l.id, JSON.parse(text) as Wire);
        });
      },
      close: () => this.setLink(l.id, false),
    };
  }

  private count(type: string, bytes: number): void {
    this.stats.messages++;
    this.stats.bytes += bytes;
    const t = (this.stats.byType[type] ??= { messages: 0, bytes: 0 });
    t.messages++;
    t.bytes += bytes;
  }
}
