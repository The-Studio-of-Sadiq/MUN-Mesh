import type { B64 } from './bytes';
import type { Crypto } from './crypto';
import { checkConference, checkEvent, conferenceId, type EventProblem } from './event';
import { Authority, authorizeAny, type DenyReason } from './permissions';
import { EventStore } from './store';
import { ALL, type Conference, type Event } from './types';

/** Two different events signed by one author for the same (scope, seq): proof the device is misbehaving. */
export interface Fork {
  a: Event;
  b: Event;
}

export type RejectReason = EventProblem | DenyReason | 'revoked';

export type IngestStatus = 'stored' | 'duplicate' | 'pending' | 'ignored' | 'rejected' | 'fork';

export interface IngestResult {
  status: IngestStatus;
  reason?: RejectReason;
  /** Events newly stored: this one and any that were waiting for it (e.g. on a cert). */
  stored: Event[];
  fork?: Fork;
}

const PENDING_PER_AUTHOR = 500;
const PENDING_TOTAL = 20_000;
const REJECTED_MEMORY = 50_000;

/**
 * A device's copy of the conference: the events it keeps, and who is
 * allowed to do what. Any device can be handed events in any order, from
 * anyone; the replica keeps exactly those that are signed and permitted, so
 * devices that have seen the same events agree.
 */
export class Replica {
  readonly conf: Conference;
  readonly confId: string;
  readonly crypto: Crypto;
  readonly store = new EventStore();
  readonly auth: Authority;
  /** Scopes kept here, or ALL. */
  readonly subs: ReadonlySet<string> | typeof ALL;

  /** Events whose author has no cert (yet), or that no cert of theirs allows yet. */
  private readonly pending = new Map<B64, Map<B64, Event>>();
  private pendingCount = 0;
  private readonly rejected = new Set<B64>();
  /** `${author}|${scope}` → the earliest fork seen. */
  private readonly forks = new Map<string, Fork>();

  constructor(conf: Conference, crypto: Crypto, subs: Iterable<string> | typeof ALL) {
    checkConference(conf);
    this.conf = conf;
    this.crypto = crypto;
    this.confId = conferenceId(conf, crypto);
    this.auth = new Authority(conf);
    this.subs = subs === ALL ? ALL : new Set(subs);
  }

  keeps(scope: string): boolean {
    return this.subs === ALL || this.subs.has(scope);
  }

  /** Scopes this replica exchanges with a peer that keeps `theirs`. */
  sharedScopes(theirs: readonly string[] | typeof ALL): string[] {
    const known = new Set(this.store.scopes());
    if (theirs !== ALL) for (const s of theirs) if (this.keeps(s)) known.add(s);
    if (this.subs !== ALL) for (const s of this.subs) known.add(s);
    return [...known].filter((s) => this.keeps(s) && (theirs === ALL || theirs.includes(s)));
  }

  seen(id: B64): boolean {
    return this.store.has(id) || this.rejected.has(id);
  }

  ingest(raw: unknown): IngestResult {
    const id = (raw as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && this.seen(id)) return { status: 'duplicate', stored: [] };
    const problem = checkEvent(this.crypto, this.confId, raw);
    if (problem) {
      if (typeof id === 'string') this.remember(id);
      return { status: 'rejected', reason: problem, stored: [] };
    }
    const e = raw as Event;
    if (!this.keeps(e.s)) return { status: 'ignored', stored: [] };
    if (this.pending.get(e.a)?.has(e.id)) return { status: 'pending', stored: [] };
    const stored: Event[] = [];
    const result = this.admit(e, stored);
    return { ...result, stored };
  }

  /** Records another device's fork evidence if it holds up. */
  addFork(raw: unknown): Fork | null {
    const f = raw as Fork;
    if (!f || typeof f !== 'object') return null;
    if (checkEvent(this.crypto, this.confId, f.a) || checkEvent(this.crypto, this.confId, f.b)) return null;
    if (f.a.a !== f.b.a || f.a.s !== f.b.s || f.a.n !== f.b.n || f.a.id === f.b.id) return null;
    return this.recordFork(f) ? f : null;
  }

  /** First forked sequence number of an author in a scope; their events from there on are hidden. */
  forkedFrom(author: B64, scope: string): number {
    return this.forks.get(`${author}|${scope}`)?.a.n ?? Infinity;
  }

  allForks(): Fork[] {
    return [...this.forks.values()];
  }

  pendingSize(): number {
    return this.pendingCount;
  }

  private admit(e: Event, stored: Event[]): Omit<IngestResult, 'stored'> {
    if (this.auth.roles(e.a).length === 0) {
      this.hold(e);
      return { status: 'pending' };
    }
    if (this.auth.isRevoked(e.a, e.s, e.n)) {
      this.remember(e.id);
      return { status: 'rejected', reason: 'revoked' };
    }
    const denied = authorizeAny(this.auth, e);
    if (denied === 'unknownScope') {
      this.remember(e.id);
      return { status: 'rejected', reason: denied };
    }
    if (denied) {
      // A cert that arrives later may allow it (e.g. a delegate made EB).
      this.hold(e);
      return { status: 'pending' };
    }
    const added = this.store.add(e);
    if (!added.added) {
      if (!added.fork) return { status: 'duplicate' };
      const fork = { a: added.fork, b: e };
      return this.recordFork(fork) ? { status: 'fork', fork } : { status: 'duplicate' };
    }
    stored.push(e);
    if (e.k === 'cert') {
      this.auth.applyCert(e as Event<'cert'>);
      this.release((e as Event<'cert'>).b.sub, stored);
    } else if (e.k === 'revoke') {
      this.auth.applyRevoke(e as Event<'revoke'>);
    }
    return { status: 'stored' };
  }

  private release(author: B64, stored: Event[]): void {
    const waiting = this.pending.get(author);
    if (!waiting) return;
    this.pending.delete(author);
    this.pendingCount -= waiting.size;
    const ordered = [...waiting.values()].sort((x, y) => x.n - y.n);
    for (const e of ordered) this.admit(e, stored);
  }

  private hold(e: Event): void {
    let waiting = this.pending.get(e.a);
    if (!waiting) this.pending.set(e.a, (waiting = new Map()));
    if (waiting.has(e.id)) return;
    if (waiting.size >= PENDING_PER_AUTHOR || this.pendingCount >= PENDING_TOTAL) {
      // Drop this author's oldest held event; it can arrive again through sync.
      const oldest = waiting.keys().next().value;
      if (oldest === undefined) return;
      waiting.delete(oldest);
      this.pendingCount--;
    }
    waiting.set(e.id, e);
    this.pendingCount++;
  }

  private remember(id: B64): void {
    if (this.rejected.size >= REJECTED_MEMORY) this.rejected.clear();
    this.rejected.add(id);
  }

  private recordFork(f: Fork): boolean {
    const key = `${f.a.a}|${f.a.s}`;
    const known = this.forks.get(key);
    if (known && known.a.n <= f.a.n) return false;
    this.forks.set(key, f);
    return true;
  }
}
