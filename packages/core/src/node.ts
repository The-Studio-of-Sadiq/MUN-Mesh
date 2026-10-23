import { toB64, type B64 } from './bytes';
import { nobleCrypto, type Crypto, type Identity } from './crypto';
import { createEvent } from './event';
import { HlcClock } from './hlc';
import { authorizeAny } from './permissions';
import { Replica, type Fork, type RejectReason } from './replica';
import type { Summary } from './store';
import { ALL, GLOBAL, type Bodies, type Conference, type Event, type Kind } from './types';

export const PROTOCOL_VERSION = 1;

/** Reasons travel as codes so each device can show them in its own language. */
export type ByeReason = 'versionMismatch' | 'wrongConference';

/**
 * Messages between two linked devices. The same on every transport: TCP on a
 * LAN, Android Nearby, or the simulator's in-memory links.
 */
export type Wire =
  | { t: 'hello'; v: number; conf: string; node: B64; subs: string[] | typeof ALL }
  /** Per scope, what the sender holds; the receiver answers with what's missing. */
  | { t: 'sum'; s: Record<string, Summary> }
  | { t: 'ev'; e: Event[] }
  | { t: 'fork'; f: Fork[] }
  | { t: 'bye'; reason: ByeReason };

/** One connection to a neighbouring device. */
export interface Link {
  send(msg: Wire): void;
  close(): void;
}

interface Peer {
  link: Link;
  node?: B64;
  subs?: string[] | typeof ALL;
  lastSync: number;
}

export interface NodeOptions {
  conf: Conference;
  identity: Identity;
  /** Scopes to keep. GLOBAL is always kept. Hubs and bridges pass ALL. */
  subs: string[] | typeof ALL;
  now: () => number;
  crypto?: Crypto;
  /** How often to re-compare with each neighbour, catching anything the live flood missed. */
  syncEveryMs?: number;
  /** Events per `ev` message. */
  batch?: number;
}

export type PublishError = 'notMember' | 'notKept' | RejectReason;

export class PublishRefused extends Error {
  readonly reason: PublishError;
  constructor(reason: PublishError) {
    super(`publish refused: ${reason}`);
    this.reason = reason;
  }
}

type EventListener = (e: Event, from: string | null) => void;

/**
 * One device in the mesh. Every node relays: a new event goes to every
 * neighbour that keeps its scope, and each neighbour does the same, so a
 * message reaches C through B even though A and C never connect. Duplicates
 * are dropped by id. Whenever two nodes link up, and periodically after,
 * they compare summaries and send each other whatever is missing, so
 * devices that were away catch up.
 */
export class MeshNode {
  readonly replica: Replica;
  readonly identity: Identity;
  readonly key: B64;
  readonly clock: HlcClock;
  private readonly now: () => number;
  private readonly syncEveryMs: number;
  private readonly batch: number;
  private readonly peers = new Map<string, Peer>();
  private readonly listeners = new Set<EventListener>();

  constructor(opts: NodeOptions) {
    const subs = opts.subs === ALL ? ALL : [...new Set([GLOBAL, ...opts.subs])];
    this.replica = new Replica(opts.conf, opts.crypto ?? nobleCrypto, subs);
    this.identity = opts.identity;
    this.key = toB64(opts.identity.sign.pub);
    this.now = opts.now;
    this.clock = new HlcClock(opts.now);
    this.syncEveryMs = opts.syncEveryMs ?? 20_000;
    this.batch = opts.batch ?? 200;
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Linked neighbours (that have said hello). */
  neighbours(): { id: string; node: B64 }[] {
    return [...this.peers].filter(([, p]) => p.node).map(([id, p]) => ({ id, node: p.node! }));
  }

  connect(id: string, link: Link): void {
    this.peers.set(id, { link, lastSync: this.now() });
    const subs = this.replica.subs === ALL ? ALL : [...this.replica.subs];
    link.send({ t: 'hello', v: PROTOCOL_VERSION, conf: this.replica.confId, node: this.key, subs });
  }

  disconnect(id: string): void {
    this.peers.delete(id);
  }

  /** Call every second or so; re-syncs with neighbours when due. */
  tick(): void {
    const now = this.now();
    for (const peer of this.peers.values()) {
      if (peer.subs && now - peer.lastSync >= this.syncEveryMs) this.sendSummary(peer);
    }
  }

  receive(id: string, msg: Wire): void {
    const peer = this.peers.get(id);
    if (!peer || typeof msg !== 'object' || msg === null) return;
    switch (msg.t) {
      case 'hello': {
        if (msg.v !== PROTOCOL_VERSION || msg.conf !== this.replica.confId) {
          peer.link.send({ t: 'bye', reason: msg.v !== PROTOCOL_VERSION ? 'versionMismatch' : 'wrongConference' });
          peer.link.close();
          this.peers.delete(id);
          return;
        }
        peer.node = msg.node;
        peer.subs = msg.subs === ALL ? ALL : Array.isArray(msg.subs) ? msg.subs.filter((s) => typeof s === 'string') : [];
        this.sendSummary(peer);
        const forks = this.replica.allForks();
        if (forks.length) peer.link.send({ t: 'fork', f: forks });
        return;
      }
      case 'sum': {
        if (!peer.subs || typeof msg.s !== 'object' || msg.s === null) return;
        const missing: Event[] = [];
        for (const scope of this.replica.sharedScopes(peer.subs)) {
          const theirs = msg.s[scope];
          missing.push(...this.replica.store.missing(scope, typeof theirs === 'object' && theirs ? theirs : {}));
        }
        this.sendEvents(peer, missing);
        return;
      }
      case 'ev': {
        if (!peer.subs || !Array.isArray(msg.e)) return;
        this.take(msg.e, id);
        return;
      }
      case 'fork': {
        if (!peer.subs || !Array.isArray(msg.f)) return;
        const fresh = msg.f.map((f) => this.replica.addFork(f)).filter((f): f is Fork => f !== null);
        if (fresh.length) this.broadcast({ t: 'fork', f: fresh }, id);
        return;
      }
      case 'bye':
        this.peers.delete(id);
        return;
    }
  }

  /** Signs, stores and floods a new event. Throws `PublishRefused` if this device may not post it. */
  publish<K extends Kind>(scope: string, kind: K, body: Bodies[K]): Event<K> {
    const replica = this.replica;
    if (!replica.keeps(scope)) throw new PublishRefused('notKept');
    if (replica.auth.roles(this.key).length === 0) throw new PublishRefused('notMember');
    const e = createEvent(replica.crypto, replica.confId, this.identity, {
      s: scope,
      n: replica.store.nextSeq(scope, this.key),
      h: this.clock.tick(),
      k: kind,
      b: body,
    });
    // Checked before ingesting: a refused event must not wait in pending and reuse this sequence number later.
    const denied = replica.auth.isRevoked(this.key, scope, e.n) ? 'revoked' : authorizeAny(replica.auth, e);
    if (denied) throw new PublishRefused(denied);
    const result = replica.ingest(e);
    if (result.status !== 'stored') throw new PublishRefused(result.reason ?? 'notAllowed');
    for (const stored of result.stored) for (const l of this.listeners) l(stored, null);
    this.forward(result.stored, null);
    return e;
  }

  /**
   * Takes events handed over outside the mesh, e.g. an EB laptop's own cert
   * scanned at the Secretariat desk. Returns what was stored.
   */
  accept(events: Event[]): Event[] {
    return this.take(events, null);
  }

  /** Ingests events from a neighbour (or handed over locally), then floods what's new and any fork found. */
  private take(events: unknown[], from: string | null): Event[] {
    const stored: Event[] = [];
    const forks: Fork[] = [];
    for (const raw of events) {
      const result = this.replica.ingest(raw);
      stored.push(...result.stored);
      if (result.fork) forks.push(result.fork);
    }
    for (const e of stored) {
      this.clock.observe(e.h);
      for (const l of this.listeners) l(e, from);
    }
    this.forward(stored, from);
    if (forks.length) this.broadcast({ t: 'fork', f: forks }, null);
    return stored;
  }

  private sendSummary(peer: Peer): void {
    peer.lastSync = this.now();
    const s: Record<string, Summary> = {};
    for (const scope of this.replica.sharedScopes(peer.subs!)) s[scope] = this.replica.store.summary(scope);
    peer.link.send({ t: 'sum', s });
  }

  private sendEvents(peer: Peer, events: Event[]): void {
    for (let i = 0; i < events.length; i += this.batch) peer.link.send({ t: 'ev', e: events.slice(i, i + this.batch) });
  }

  private forward(events: Event[], from: string | null): void {
    if (!events.length) return;
    for (const [id, peer] of this.peers) {
      if (id === from || !peer.subs) continue;
      const subs = peer.subs;
      const wanted = subs === ALL ? events : events.filter((e) => subs.includes(e.s));
      this.sendEvents(peer, wanted);
    }
  }

  private broadcast(msg: Wire, from: string | null): void {
    for (const [id, peer] of this.peers) if (id !== from && peer.subs) peer.link.send(msg);
  }
}
