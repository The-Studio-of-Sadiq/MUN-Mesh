import { toB64, type B64 } from './bytes';
import { nobleCrypto, type Crypto, type Identity } from './crypto';
import { createEvent } from './event';
import { HlcClock } from './hlc';
import { checkJoinRequest, createJoinRequest, isHostPort, type JoinFields, type JoinRequest } from './join';
import { authorizeAny } from './permissions';
import { Replica, type Fork, type RejectReason } from './replica';
import type { Summary } from './store';
import { ALL, GLOBAL, type Bodies, type Conference, type Event, type Kind } from './types';

export const PROTOCOL_VERSION = 1;

/** File chunk traffic, handled by `FileManager` (files.ts) through `onWire`. */
export type FileWire =
  /** Please send these chunks. */
  | { t: 'want'; c: B64[] }
  /** One chunk: its id and the encrypted bytes. */
  | { t: 'chunk'; id: B64; d: B64 }
  /** I don't have these. `soon`: I'm fetching them; ask again shortly (or I'll push them to you). */
  | { t: 'nochunk'; c: B64[]; soon?: boolean };

/** Reasons travel as codes so each device can show them in its own language. */
export type ByeReason = 'versionMismatch' | 'wrongConference';

/**
 * Messages between two linked devices. The same on every transport: TCP on a
 * LAN, Android Nearby, or the simulator's in-memory links.
 */
export type Wire =
  /** `addrs`: "host:port" where the sender accepts connections, so others can reach it directly too. */
  | { t: 'hello'; v: number; conf: string; node: B64; subs: string[] | typeof ALL; addrs?: string[] }
  /** Per scope, what the sender holds; the receiver answers with what's missing. */
  | { t: 'sum'; s: Record<string, Summary> }
  | { t: 'ev'; e: Event[] }
  | { t: 'fork'; f: Fork[] }
  /** Devices waiting to be let in; spread to everyone so the right EB sees them. */
  | { t: 'join'; r: JoinRequest[] }
  | FileWire
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
  addrs: string[];
  lastSync: number;
}

export interface PeerInfo {
  id: string;
  node: B64;
  addrs: string[];
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

const MAX_JOIN_REQUESTS = 2000;

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
  private readonly peerListeners = new Set<(peer: PeerInfo) => void>();
  private readonly wireListeners = new Set<(peerId: string, msg: FileWire) => void>();
  private readonly goneListeners = new Set<(peerId: string) => void>();
  private readonly joinListeners = new Set<(r: JoinRequest) => void>();
  /** Latest join request per device key. */
  private readonly joins = new Map<B64, JoinRequest>();
  private addresses: string[] = [];

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

  /** Called when a neighbour says hello (after a new link). */
  onPeer(listener: (peer: PeerInfo) => void): () => void {
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }

  /** Called for each new or updated join request. */
  onJoinRequest(listener: (r: JoinRequest) => void): () => void {
    this.joinListeners.add(listener);
    return () => this.joinListeners.delete(listener);
  }

  /** File chunk messages from neighbours. */
  onWire(listener: (peerId: string, msg: FileWire) => void): () => void {
    this.wireListeners.add(listener);
    return () => this.wireListeners.delete(listener);
  }

  /** Called when a link closes. */
  onDisconnect(listener: (peerId: string) => void): () => void {
    this.goneListeners.add(listener);
    return () => this.goneListeners.delete(listener);
  }

  /** Sends to one neighbour that has said hello; false if it's gone. */
  sendTo(peerId: string, msg: FileWire): boolean {
    const peer = this.peers.get(peerId);
    if (!peer?.subs) return false;
    peer.link.send(msg);
    return true;
  }

  /** A neighbour's signing key, once it has said hello. */
  peerNode(peerId: string): B64 | null {
    return this.peers.get(peerId)?.node ?? null;
  }

  /** Scopes a neighbour keeps, or null if it hasn't said hello. */
  peerSubs(peerId: string): string[] | typeof ALL | null {
    return this.peers.get(peerId)?.subs ?? null;
  }

  /** Linked neighbours (that have said hello). */
  neighbours(): PeerInfo[] {
    return [...this.peers].filter(([, p]) => p.node).map(([id, p]) => ({ id, node: p.node!, addrs: p.addrs }));
  }

  /** Where this device accepts connections ("host:port"); told to every neighbour. */
  setAddresses(addrs: string[]): void {
    this.addresses = addrs.filter(isHostPort);
  }

  connect(id: string, link: Link): void {
    this.peers.set(id, { link, addrs: [], lastSync: this.now() });
    const subs = this.replica.subs === ALL ? ALL : [...this.replica.subs];
    const hello: Wire = { t: 'hello', v: PROTOCOL_VERSION, conf: this.replica.confId, node: this.key, subs };
    if (this.addresses.length) hello.addrs = this.addresses;
    link.send(hello);
  }

  /** Asks to be let in. The request spreads to every device until someone with authority issues a cert. */
  requestJoin(fields: JoinFields): JoinRequest {
    const r = createJoinRequest(this.replica.crypto, this.replica.confId, this.identity, fields, this.now());
    this.joins.set(r.sign, r);
    this.broadcast({ t: 'join', r: [r] }, null);
    return r;
  }

  /** Join requests from devices that still have no cert, newest first. */
  pendingJoins(): JoinRequest[] {
    return [...this.joins.values()]
      .filter((r) => this.replica.auth.roles(r.sign).length === 0)
      .sort((a, b) => b.at - a.at);
  }

  /** Loads events this device stored earlier; they were checked when first received. */
  restore(events: Event[]): void {
    for (const e of events) {
      const result = this.replica.ingest(e, true);
      for (const stored of result.stored) this.clock.observe(stored.h);
    }
  }

  disconnect(id: string): void {
    if (!this.peers.delete(id)) return;
    for (const l of this.goneListeners) l(id);
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
        peer.addrs = Array.isArray(msg.addrs) ? msg.addrs.filter(isHostPort).slice(0, 16) : [];
        this.sendSummary(peer);
        const forks = this.replica.allForks();
        if (forks.length) peer.link.send({ t: 'fork', f: forks });
        const joins = this.pendingJoins();
        if (joins.length) peer.link.send({ t: 'join', r: joins });
        for (const l of this.peerListeners) l({ id, node: peer.node, addrs: peer.addrs });
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
      case 'join': {
        if (!peer.subs || !Array.isArray(msg.r)) return;
        const fresh: JoinRequest[] = [];
        for (const r of msg.r.slice(0, MAX_JOIN_REQUESTS)) {
          const known = (r as JoinRequest | null)?.sign ? this.joins.get((r as JoinRequest).sign) : undefined;
          if (known && known.at >= (r as JoinRequest).at) continue;
          if (!checkJoinRequest(this.replica.crypto, this.replica.confId, r)) continue;
          if (this.replica.auth.roles(r.sign).length > 0) continue;
          if (this.joins.size >= MAX_JOIN_REQUESTS && !known) continue;
          this.joins.set(r.sign, r);
          fresh.push(r);
        }
        for (const r of fresh) for (const l of this.joinListeners) l(r);
        if (fresh.length) this.broadcast({ t: 'join', r: fresh }, id);
        return;
      }
      case 'want':
      case 'chunk':
      case 'nochunk':
        if (!peer.subs) return;
        for (const l of this.wireListeners) l(id, msg);
        return;
      case 'bye':
        this.disconnect(id);
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
