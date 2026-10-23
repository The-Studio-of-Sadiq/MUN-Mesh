import type { B64 } from './bytes';
import type { Event } from './types';

/** For each author, the highest sequence number held with nothing missing below it. */
export type Summary = Record<B64, number>;

interface Log {
  seqs: Map<number, B64>;
  /** Highest n such that 1..n are all held. */
  prefix: number;
  max: number;
}

export type AddResult = { added: true } | { added: false; fork?: Event };

/**
 * Every event a device keeps, as one append-only log per (scope, author).
 * Nothing is ever removed: a muted or revoked author's events stay so the
 * logs remain complete for syncing, and the view hides them.
 */
export class EventStore {
  private readonly byId = new Map<B64, Event>();
  private readonly logs = new Map<string, Map<B64, Log>>();

  get size(): number {
    return this.byId.size;
  }

  has(id: B64): boolean {
    return this.byId.has(id);
  }

  get(id: B64): Event | undefined {
    return this.byId.get(id);
  }

  /** A second, different event at a taken (scope, author, seq) is a fork: returned as evidence, not stored. */
  add(e: Event): AddResult {
    if (this.byId.has(e.id)) return { added: false };
    let authors = this.logs.get(e.s);
    if (!authors) this.logs.set(e.s, (authors = new Map()));
    let log = authors.get(e.a);
    if (!log) authors.set(e.a, (log = { seqs: new Map(), prefix: 0, max: 0 }));
    const existing = log.seqs.get(e.n);
    if (existing !== undefined) return { added: false, fork: this.byId.get(existing) };
    log.seqs.set(e.n, e.id);
    log.max = Math.max(log.max, e.n);
    while (log.seqs.has(log.prefix + 1)) log.prefix++;
    this.byId.set(e.id, e);
    return { added: true };
  }

  /** Next sequence number for our own events in a scope. */
  nextSeq(scope: string, author: B64): number {
    return (this.logs.get(scope)?.get(author)?.max ?? 0) + 1;
  }

  /** Highest sequence number held for an author in a scope. */
  maxSeq(scope: string, author: B64): number {
    return this.logs.get(scope)?.get(author)?.max ?? 0;
  }

  summary(scope: string): Summary {
    const out: Summary = {};
    for (const [author, log] of this.logs.get(scope) ?? []) out[author] = log.prefix;
    return out;
  }

  /** Events in a scope the other side lacks, given its summary, oldest first per author. */
  missing(scope: string, theirs: Summary): Event[] {
    const out: Event[] = [];
    for (const [author, log] of this.logs.get(scope) ?? []) {
      const have = theirs[author] ?? 0;
      for (let n = have + 1; n <= log.max; n++) {
        const id = log.seqs.get(n);
        if (id !== undefined) out.push(this.byId.get(id)!);
      }
    }
    return out;
  }

  scopes(): string[] {
    return [...this.logs.keys()];
  }

  events(scope: string): Event[] {
    const out: Event[] = [];
    for (const log of this.logs.get(scope)?.values() ?? []) {
      for (const id of log.seqs.values()) out.push(this.byId.get(id)!);
    }
    return out;
  }
}
