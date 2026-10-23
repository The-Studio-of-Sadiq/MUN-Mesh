import type { B64 } from './bytes';
import { compareHlc, type Hlc } from './hlc';
import { EB_SCOPE, GLOBAL, type CertBody, type Conference, type Event, type Role } from './types';

export interface Member {
  key: B64;
  box: B64;
  role: Role;
  com?: string;
  name: string;
  /** The cert event that made them a member; absent for the root key. */
  cert?: Event<'cert'>;
}

interface Revocation {
  from: Record<string, number>;
  /** Committee the revoker was EB of; null when the Secretariat revoked. */
  byCom: string | null;
}

/**
 * Who is who, built from cert and revoke events. The conference root key is
 * always the Secretariat; everyone else needs a cert from someone allowed
 * to issue it.
 */
export class Authority {
  readonly conf: Conference;
  private readonly root: Member;
  /** Every cert per subject, oldest first. A new cert changes someone's role from its timestamp on. */
  private readonly certs = new Map<B64, Member[]>();
  private readonly revocations = new Map<B64, Revocation[]>();
  private readonly committees: Set<string>;

  constructor(conf: Conference) {
    this.conf = conf;
    this.root = { key: conf.root, box: conf.rootBox, role: 'secretariat', name: 'Secretariat' };
    this.committees = new Set(conf.committees.map((c) => c.id));
  }

  /** Current role: the latest cert. */
  member(key: B64): Member | null {
    if (key === this.root.key) return this.root;
    const list = this.certs.get(key);
    return list ? list[list.length - 1]! : null;
  }

  /** The role in force for an event at `h`: the latest cert issued at or before it (or the first cert). */
  memberAt(key: B64, h: Hlc): Member | null {
    if (key === this.root.key) return this.root;
    const list = this.certs.get(key);
    if (!list) return null;
    let found = list[0]!;
    for (const m of list) if (compareHlc(m.cert!.h, h) <= 0) found = m;
    return found;
  }

  /** Every role the key has held; an event is stored if any of them allows it. */
  roles(key: B64): Member[] {
    if (key === this.root.key) return [this.root];
    return this.certs.get(key) ?? [];
  }

  all(): Member[] {
    const out = [this.root];
    for (const key of this.certs.keys()) out.push(this.member(key)!);
    return out;
  }

  isCommittee(scope: string): boolean {
    return this.committees.has(scope);
  }

  applyCert(e: Event<'cert'>): Member | null {
    const b: CertBody = e.b;
    if (b.sub === this.root.key) return null;
    const member: Member = { key: b.sub, box: b.box, role: b.role, com: b.com, name: b.name, cert: e };
    const list = this.certs.get(b.sub) ?? [];
    if (list.some((m) => m.cert!.id === e.id)) return null;
    list.push(member);
    list.sort((x, y) => compareHlc(x.cert!.h, y.cert!.h) || (x.cert!.id < y.cert!.id ? -1 : 1));
    this.certs.set(b.sub, list);
    return member;
  }

  applyRevoke(e: Event<'revoke'>): void {
    const byCom = e.s === GLOBAL ? null : e.s;
    const list = this.revocations.get(e.b.sub) ?? [];
    list.push({ from: e.b.from, byCom });
    this.revocations.set(e.b.sub, list);
  }

  /** Whether this device has been removed: some revocation in reach of it exists. */
  isRemoved(key: B64): boolean {
    const list = this.revocations.get(key);
    if (!list || key === this.root.key) return false;
    const certs = this.certs.get(key) ?? [];
    return list.some((r) => r.byCom === null || certs.some((m) => m.com === r.byCom && (m.role === 'delegate' || m.role === 'observer')));
  }

  /**
   * Whether the author's event at this sequence number is cut off by a
   * revocation. An EB's revocation only reaches its own committee's
   * delegates and observers.
   */
  isRevoked(author: B64, scope: string, seq: number): boolean {
    const list = this.revocations.get(author);
    if (!list || author === this.root.key) return false;
    const certs = this.certs.get(author) ?? [];
    return list.some((r) => {
      const inReach = certs.some((m) => m.com === r.byCom && (m.role === 'delegate' || m.role === 'observer'));
      if (r.byCom !== null && !inReach) return false;
      return seq >= (r.from[scope] ?? 1);
    });
  }
}

/**
 * Why a member may not publish this event, or null if they may. Every node
 * runs this on every event, so the rules hold no matter which device relays.
 */
export type DenyReason = 'unknownScope' | 'notAllowed' | 'badCert';

/** Store-time check: allowed under any role the author has held. Order-independent, so all devices keep the same events. */
export function authorizeAny(auth: Authority, e: Event): DenyReason | null {
  let reason: DenyReason | null = 'notAllowed';
  for (const m of auth.roles(e.a)) {
    reason = authorize(auth, m, e);
    if (reason === null) return null;
  }
  return reason;
}

export function authorize(auth: Authority, author: Member, e: Event): DenyReason | null {
  const s = e.s;
  const committee = auth.isCommittee(s) ? s : null;
  if (!committee && s !== GLOBAL && s !== EB_SCOPE) return 'unknownScope';
  const sec = author.role === 'secretariat';
  const ebHere = committee !== null && author.role === 'eb' && author.com === committee;
  const delegateHere = committee !== null && author.role === 'delegate' && author.com === committee;
  const moderator = committee !== null && (sec || ebHere);
  const ok = (allowed: boolean) => (allowed ? null : 'notAllowed');

  switch (e.k) {
    case 'cert': {
      const b = e.b as CertBody;
      if (b.role === 'secretariat') return s === GLOBAL && sec && b.com === undefined ? null : 'badCert';
      if (b.role === 'eb') return s === GLOBAL && sec && !!b.com && auth.isCommittee(b.com) ? null : 'badCert';
      return moderator && b.com === committee ? null : 'badCert';
    }
    case 'revoke':
      return ok(s === GLOBAL ? sec : moderator);
    case 'mute':
    case 'unmute':
    case 'lock':
    case 'slow':
    case 'rules':
    case 'chitOk':
    case 'chitNo':
      return ok(moderator);
    case 'pin':
      return ok(moderator || (s === GLOBAL && sec));
    case 'post':
      return ok(s === GLOBAL ? sec : moderator || delegateHere);
    case 'announce':
      return ok(s === GLOBAL ? sec : moderator);
    case 'chit':
      return ok(delegateHere);
    case 'dm':
      return ok(moderator || (delegateHere && (e as Event<'dm'>).b.with === author.key));
    case 'ebpost':
      return ok(s === EB_SCOPE && (sec || author.role === 'eb'));
  }
}
