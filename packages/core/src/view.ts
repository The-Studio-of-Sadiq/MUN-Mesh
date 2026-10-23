import type { B64 } from './bytes';
import { compareHlc, type Hlc } from './hlc';
import { authorize, type Member } from './permissions';
import type { Replica } from './replica';
import type { Event, Kind } from './types';

export type ChitStatus = 'pending' | 'approved' | 'rejected';

export interface ChitState {
  chit: Event<'chit'>;
  status: ChitStatus;
  decision?: Event<'chitOk'> | Event<'chitNo'>;
}

export interface ScopeView {
  scope: string;
  /** Visible posts and announcements, in timestamp order. */
  posts: Event<'post' | 'announce'>[];
  /** Posts a moderation rule hides, with the rule; the EB console can show these greyed out. */
  hidden: { event: Event<'post' | 'announce'>; why: HiddenReason }[];
  pinned: B64[];
  locked: boolean;
  slowSec: number;
  /** Delegates currently muted. */
  muted: B64[];
  chits: ChitState[];
  /** Delegate↔EB threads, keyed by the delegate's signing key. */
  dms: Map<B64, Event<'dm'>[]>;
}

export type HiddenReason = 'muted' | 'locked' | 'slowMode' | 'revoked' | 'forked' | 'notAllowed';

const byTime = (x: Event, y: Event) => compareHlc(x.h, y.h) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * What a scope looks like, worked out from its events alone, so every device
 * with the same events shows the same thing. Moderation is ordered two ways:
 * - mutes, kicks and forks by the author's own sequence numbers, which
 *   they can't fake (the EB records the number they had reached);
 * - locks and slow mode by timestamp, as they apply to everyone at once.
 */
export function scopeView(replica: Replica, scope: string): ScopeView {
  const events = replica.store.events(scope).sort(byTime);
  const auth = replica.auth;
  const of = <K extends Kind>(k: K) => events.filter((e): e is Event<K> => e.k === k);

  // The role at the event's time decides; a later demotion doesn't rewrite history.
  const valid = (e: Event): boolean => {
    const m = auth.memberAt(e.a, e.h);
    return !!m && authorize(auth, m, e) === null;
  };
  const gone = (e: Event): HiddenReason | null => {
    if (auth.isRevoked(e.a, scope, e.n)) return 'revoked';
    if (e.n >= replica.forkedFrom(e.a, scope)) return 'forked';
    return valid(e) ? null : 'notAllowed';
  };
  const live = <T extends Event>(list: T[]) => list.filter((e) => gone(e) === null);

  const mutes = live([...of('mute'), ...of('unmute')]).sort(byTime);
  const mutedAt = (author: B64, seq: number): boolean => {
    let muted = false;
    for (const m of mutes) if (m.b.sub === author && m.b.from <= seq) muted = m.k === 'mute';
    return muted;
  };
  const locks = live(of('lock'));
  const lockedAt = (h: Hlc): boolean => {
    let on = false;
    for (const l of locks) if (compareHlc(l.h, h) < 0) on = l.b.on;
    return on;
  };
  const slows = live(of('slow'));
  const slowAt = (h: Hlc): number => {
    let sec = 0;
    for (const s of slows) if (compareHlc(s.h, h) < 0) sec = s.b.sec;
    return sec;
  };

  const posts: ScopeView['posts'] = [];
  const hidden: ScopeView['hidden'] = [];
  const lastPost = new Map<B64, number>();
  const ordinary = (m: Member | null) => !!m && (m.role === 'delegate' || m.role === 'observer');
  // Per author in sequence order, so slow mode compares each post with that author's previous visible one.
  const candidates = events.filter((e): e is Event<'post' | 'announce'> => e.k === 'post' || e.k === 'announce');
  const bySeq = [...candidates].sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.n - y.n));
  const verdict = new Map<B64, HiddenReason | null>();
  for (const e of bySeq) {
    let why = gone(e);
    const restricted = ordinary(auth.memberAt(e.a, e.h));
    if (!why && restricted && mutedAt(e.a, e.n)) why = 'muted';
    if (!why && restricted && lockedAt(e.h)) why = 'locked';
    if (!why && restricted) {
      const sec = slowAt(e.h);
      const prev = lastPost.get(e.a);
      if (sec > 0 && prev !== undefined && e.h.t - prev < sec * 1000) why = 'slowMode';
    }
    if (!why) lastPost.set(e.a, e.h.t);
    verdict.set(e.id, why);
  }
  for (const e of candidates) {
    const why = verdict.get(e.id) ?? null;
    if (why) hidden.push({ event: e, why });
    else posts.push(e);
  }

  const pins = new Map<B64, boolean>();
  for (const p of live(of('pin'))) pins.set(p.b.ev, p.b.on);

  const decisions = new Map<B64, Event<'chitOk'> | Event<'chitNo'>>();
  for (const d of live([...of('chitOk'), ...of('chitNo')]).sort(byTime)) {
    if (!decisions.has(d.b.chit)) decisions.set(d.b.chit, d);
  }
  const chits: ChitState[] = live(of('chit')).map((chit) => {
    const decision = decisions.get(chit.id);
    const status: ChitStatus = !decision ? 'pending' : decision.k === 'chitOk' ? 'approved' : 'rejected';
    return { chit, status, decision };
  });

  const dms = new Map<B64, Event<'dm'>[]>();
  for (const d of live(of('dm'))) {
    const thread = dms.get(d.b.with) ?? [];
    thread.push(d);
    dms.set(d.b.with, thread);
  }

  const mutedNow = new Set<B64>();
  for (const m of mutes) {
    if (m.k === 'mute') mutedNow.add(m.b.sub);
    else mutedNow.delete(m.b.sub);
  }

  return {
    scope,
    posts,
    hidden,
    pinned: [...pins].filter(([, on]) => on).map(([id]) => id),
    locked: locks.length > 0 && locks[locks.length - 1]!.b.on,
    slowSec: slows.length > 0 ? slows[slows.length - 1]!.b.sec : 0,
    muted: [...mutedNow],
    chits,
    dms,
  };
}
