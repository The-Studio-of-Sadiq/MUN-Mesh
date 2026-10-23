import {
  announce,
  approveChit,
  certFor,
  ebPost,
  issueCert,
  kick,
  lock,
  mute,
  post,
  readChit,
  readSealed,
  rejectChit,
  sendChit,
  sendDm,
  slowMode,
  unmute,
} from '../actions';
import type { B64 } from '../bytes';
import { newConference, publicKeys } from '../conference';
import { createIdentity, nobleCrypto, type Crypto, type Identity } from '../crypto';
import { createEvent } from '../event';
import { MeshNode, PublishRefused } from '../node';
import { ALL, EB_SCOPE, GLOBAL, type Event, type Role } from '../types';
import { scopeView } from '../view';
import { Sim, SimNet } from './index';

const MIN = 60_000;

export interface ScenarioOptions {
  committees: number;
  /** Delegates per committee (at least 16). */
  delegates: number;
  minutes: number;
  seed: number;
  crypto?: Crypto;
  log?: (line: string) => void;
}

interface Person {
  name: string;
  node: MeshNode;
  identity: Identity;
  role: Role;
  com?: string;
  /** Misbehaves on purpose; excluded from the "everyone agrees" checks where noted. */
  rogue?: 'muted' | 'locked' | 'kicked' | 'forker';
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Report {
  nodes: number;
  links: number;
  events: Record<string, number>;
  refused: number;
  deliveries: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number; under1s: number };
  /** Same, for deliveries untouched by the planned failures. */
  steadyLatencyMs: { p50: number; p95: number; p99: number; max: number; under1s: number };
  /** Time after activity stopped until the last device stored its last new event. */
  settleMs: number;
  traffic: { messages: number; megabytes: number; dropped: number; byType: Record<string, { messages: number; megabytes: number }> };
  checks: Check[];
  ok: boolean;
  wallMs: number;
}

/**
 * A whole conference on the simulated network: rooms with routers, EB
 * laptops bridging rooms, a room split across two unlinked routers, phones
 * that only reach the room through other phones (Nearby), devices dropping
 * off, half the building cut off for a while, a chair's laptop dying, and
 * delegates who misbehave. Then checks every surviving device agrees.
 */
export function runConferenceScenario(o: ScenarioOptions): Report {
  if (o.delegates < 16) throw new Error('need at least 16 delegates per committee');
  if (o.minutes < 10) throw new Error('need at least 10 minutes');
  const started = Date.now();
  const log = o.log ?? (() => {});
  const T = o.minutes * MIN;
  const sim = new Sim(o.seed);
  const net = new SimNet(sim);
  const crypto = o.crypto ?? nobleCrypto;
  const n = o.committees;
  const committees = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `Committee ${i + 1}` }));
  const { conf, root } = newConference('Harness MUN', committees, 0);
  const now = () => sim.now;

  const people = new Map<string, Person>();
  const add = (name: string, identity: Identity, role: Role, subs: string[] | typeof ALL, com?: string) => {
    const node = new MeshNode({ conf, identity, subs, now, crypto });
    const p: Person = { name, node, identity, role, com };
    people.set(name, p);
    net.add(name, node);
    return p;
  };
  const sec0 = add('sec0', root, 'secretariat', ALL);
  const sec1 = add('sec1', createIdentity(), 'secretariat', ALL);
  const chair = (r: number) => people.get(`c${r}-chair`)!;
  const cochair = (r: number) => people.get(`c${r}-cochair`)!;
  const del = (r: number, i: number) => people.get(`c${r}-d${i}`)!;

  // Which room shows which failure; spread out, so a small run still has each one.
  const room = { muted: 0, kicked: 1 % n, split: 2 % n, locked: 3 % n, forker: 4 % n, nearby: 5 % n, slow: 6 % n };
  const D = o.delegates;
  const nearbyCount = Math.max(2, Math.floor(D / 8));
  const nearbyPhones = Array.from({ length: nearbyCount }, (_, k) => D - nearbyCount + k);
  const relayPhones = [D - nearbyCount - 2, D - nearbyCount - 1];
  const rogueIndex = { muted: 5, locked: 7, kicked: 9, forker: 11 } as const;

  for (let r = 0; r < n; r++) {
    const com = `c${r}`;
    add(`${com}-chair`, createIdentity(), 'eb', ALL, com);
    add(`${com}-cochair`, createIdentity(), 'eb', ALL, com);
    for (let i = 0; i < D; i++) {
      // Bridges keep everything: the split room's laptop and the Nearby relay phones.
      const bridge = (r === room.split && i === 0) || (r === room.nearby && relayPhones.includes(i));
      const p = add(`${com}-d${i}`, createIdentity(), 'delegate', bridge ? ALL : [com], com);
      for (const [kind, idx] of Object.entries(rogueIndex)) {
        if (room[kind as keyof typeof rogueIndex] === r && idx === i) p.rogue = kind as Person['rogue'];
      }
    }
  }
  const late = add('c0-late', createIdentity(), 'delegate', ['c0'], 'c0');

  // ── Physical network ──
  const linkIds: Record<string, string[]> = { partition: [] };
  const half = Math.max(1, Math.floor(n / 2));
  for (let r = 0; r < n; r++) {
    const com = `c${r}`;
    const split = r === room.split;
    const mediumA = `${com}-routerA`;
    const mediumB = split ? `${com}-routerB` : mediumA;
    if (!split) net.link(chair(r).name, cochair(r).name, 'wifi', mediumA);
    const onRouter = (i: number) => !(r === room.nearby && nearbyPhones.includes(i));
    const routerOf = (i: number) => (split && i % 2 === 1 ? 'B' : 'A');
    for (let i = 0; i < D; i++) {
      const p = del(r, i);
      if (!onRouter(i)) continue;
      if (split && i === 0) {
        net.link(p.name, chair(r).name, 'wifi', mediumA);
        net.link(p.name, cochair(r).name, 'wifi', mediumB);
        continue;
      }
      const medium = routerOf(i) === 'A' ? mediumA : mediumB;
      if (!split || routerOf(i) === 'A') net.link(p.name, chair(r).name, 'wifi', medium);
      if (!split || routerOf(i) === 'B') net.link(p.name, cochair(r).name, 'wifi', medium);
      // One phone-to-phone link on the same router, for redundancy.
      const peers = Array.from({ length: D }, (_, j) => j).filter((j) => j !== i && onRouter(j) && routerOf(j) === routerOf(i));
      const j = sim.pick(peers);
      if (!net.links.has(`${p.name}~${del(r, j).name}`) && !net.links.has(`${del(r, j).name}~${p.name}`)) {
        net.link(p.name, del(r, j).name, 'wifi', medium);
      }
    }
    if (r === room.nearby) {
      // Out of router range: a chain of phones, each end reaching a relay phone.
      nearbyPhones.forEach((i, k) => {
        if (k === 0) net.link(del(r, i).name, del(r, relayPhones[0]!).name, 'nearby');
        if (k === nearbyPhones.length - 1) net.link(del(r, i).name, del(r, relayPhones[1]!).name, 'nearby');
        if (k > 0) net.link(del(r, i).name, del(r, nearbyPhones[k - 1]!).name, 'nearby');
      });
    }
    if (r + 1 < n) {
      // Each EB laptop's second adapter reaches the next room.
      const a = net.link(chair(r).name, cochair(r + 1).name, 'bridge');
      const b = net.link(cochair(r).name, chair(r + 1).name, 'bridge');
      if (r + 1 === half) linkIds.partition!.push(a, b);
    }
  }
  net.link('sec0', chair(0).name, 'bridge');
  if (half < n) linkIds.partition!.push(net.link('sec0', chair(half).name, 'bridge'));
  net.link('sec1', chair(n - 1).name, 'bridge');
  net.link(late.name, chair(0).name, 'wifi', 'c0-routerA');

  // ── Tracking ──
  const created = new Map<B64, { e: Event; at: number }>();
  const counts: Record<string, number> = {};
  let refused = 0;
  const latencies: number[] = [];
  /**
   * Deliveries unaffected by the planned failures: neither end dropped off,
   * not during the partition, and the recipient already approved (devices
   * waiting for approval are sent the committee's messages only once in).
   */
  const steady: number[] = [];
  const approvedAt = new Map<string, number>();
  const disturbed = new Set<string>();
  let lastStore = 0;
  for (const p of people.values()) {
    p.node.onEvent((e, from) => {
      if (e.k === 'cert' && (e as Event<'cert'>).b.sub === p.node.key && !approvedAt.has(p.name)) approvedAt.set(p.name, sim.now);
      if (from === null) return;
      lastStore = sim.now;
      const c = created.get(e.id);
      if (!c) return;
      latencies.push(sim.now - c.at);
      const author = authorName.get(e.a);
      const inPartition = c.at >= T * 0.3 && c.at <= T * 0.6;
      const member = (approvedAt.get(p.name) ?? Infinity) <= c.at || p.name.startsWith('sec0');
      if (!inPartition && member && !disturbed.has(p.name) && author && !disturbed.has(author)) steady.push(sim.now - c.at);
    });
  }
  const authorName = new Map([...people.values()].map((p) => [p.node.key, p.name]));
  const record = <E extends Event>(e: E): E => {
    created.set(e.id, { e, at: sim.now });
    counts[e.k] = (counts[e.k] ?? 0) + 1;
    return e;
  };
  /** An app action: retried until the device knows its own cert, like a real client waiting for approval. */
  const act = (p: Person, at: number, fn: () => Event | Event[] | null, until = T + 2 * MIN) => {
    const run = () => {
      if (p.node.replica.auth.roles(p.node.key).length === 0) {
        if (sim.now < until) sim.after(5_000, run);
        return;
      }
      try {
        const out = fn();
        if (out) for (const e of Array.isArray(out) ? out : [out]) record(e);
      } catch (err) {
        if (!(err instanceof PublishRefused)) throw err;
        refused++;
        if (refused <= 5) log(`refused: ${p.name} ${(err as PublishRefused).reason} at ${sim.now}`);
      }
    };
    sim.at(at, run);
  };
  sim.every(1000, () => {
    for (const [name, node] of net.nodes) if (net.isOnline(name)) node.tick();
  });
  /** An EB laptop in the committee that's still on. */
  const moderator = (r: number) => [chair(r), cochair(r)].find((p) => net.isOnline(p.name)) ?? chair(r);

  // ── Who is who ──
  act(sec0, 0, () => {
    const out = [issueCert(sec0.node, certFor(publicKeys(sec1.identity), 'secretariat', 'Deputy SG'))];
    for (let r = 0; r < n; r++) {
      for (const p of [chair(r), cochair(r)]) out.push(issueCert(sec0.node, certFor(publicKeys(p.identity), 'eb', p.name, p.com)));
    }
    // Each EB laptop is handed its own cert at the Secretariat desk.
    sec1.node.accept([out[0]!]);
    for (let r = 0; r < n; r++) {
      chair(r).node.accept([out[1 + 2 * r]!]);
      cochair(r).node.accept([out[2 + 2 * r]!]);
    }
    return out;
  });
  for (let r = 0; r < n; r++) {
    for (let i = 0; i < D; i++) {
      const p = del(r, i);
      act(chair(r), sim.between(2_000, 60_000), () => issueCert(chair(r).node, certFor(publicKeys(p.identity), 'delegate', p.name, p.com)));
    }
  }
  act(chair(0), T * 0.9, () => issueCert(chair(0).node, certFor(publicKeys(late.identity), 'delegate', 'Late delegate', 'c0')));

  // ── Ordinary activity ──
  const honest = [...people.values()].filter((p) => p.role === 'delegate' && !p.rogue && p !== late);
  for (const p of honest) {
    const r = Number(p.com!.slice(1));
    const posts = 3 + Math.floor(sim.random() * 6);
    for (let k = 0; k < posts; k++) act(p, sim.between(MIN, T), () => post(p.node, p.com!, `${p.name} speech ${k}`));
    for (let k = 0; k < 2; k++) {
      act(p, sim.between(MIN, T), () => {
        const to = del(r, Math.floor(sim.random() * D));
        return to === p ? null : sendChit(p.node, p.com!, to.node.key, `from ${p.name} to ${to.name}`);
      });
    }
    act(p, sim.between(MIN, T), () => sendDm(p.node, p.com!, p.node.key, `${p.name} asks the chair`));
  }
  for (let r = 0; r < n; r++) {
    for (let k = 0; k < 3; k++) act(chair(r), sim.between(MIN, T), () => announce(moderator(r).node, `c${r}`, `Announcement ${k}`));
    act(chair(r), sim.between(MIN, T), () => ebPost(moderator(r).node, `Committee ${r} status`));
  }
  for (let k = 0; k < 4; k++) act(sec0, sim.between(MIN, T), () => announce(sec0.node, GLOBAL, `Global notice ${k}`));
  act(chair(room.slow), T * 0.15, () => slowMode(moderator(room.slow).node, `c${room.slow}`, 30));

  // EB laptops work their queues: decide chits, answer threads.
  const decided = new Set<B64>();
  const answered = new Map<B64, B64>();
  sim.every(15_000, () => {
    for (let r = 0; r < n; r++) {
      for (const eb of [chair(r), cochair(r)]) {
        if (!net.isOnline(eb.name) || sim.random() < 0.5) continue;
        const view = scopeView(eb.node.replica, `c${r}`);
        for (const c of view.chits) {
          if (c.status !== 'pending' || decided.has(c.chit.id) || sim.now - c.chit.h.t < 10_000) continue;
          decided.add(c.chit.id);
          if (sim.random() < 0.85) {
            const ok = approveChit(eb.node, c.chit);
            // Can't approve yet (e.g. recipient's cert not here): try again next round.
            if (typeof ok === 'string') decided.delete(c.chit.id);
            else record(ok);
          } else {
            record(rejectChit(eb.node, c.chit));
          }
        }
        for (const [thread, msgs] of view.dms) {
          const last = msgs[msgs.length - 1]!;
          if (last.a === thread && answered.get(thread) !== last.id && sim.now - last.h.t > 20_000) {
            answered.set(thread, last.id);
            record(sendDm(eb.node, `c${r}`, thread, 'Noted.'));
          }
        }
      }
    }
  });

  // ── Misbehaviour and moderation ──
  const rogue = (kind: keyof typeof rogueIndex) => del(room[kind], rogueIndex[kind]);
  const spam = (p: Person, from: number, to: number, every: number) => {
    for (let t = from; t < to; t += every) act(p, t, () => post(p.node, p.com!, `${p.name} keeps talking`));
  };
  // Mute: the rogue keeps posting through the mute (an honest app would stop).
  spam(rogue('muted'), T * 0.2, T * 0.55, 30_000);
  act(chair(room.muted), T * 0.25, () => mute(moderator(room.muted).node, `c${room.muted}`, rogue('muted').node.key));
  act(chair(room.muted), T * 0.5, () => unmute(moderator(room.muted).node, `c${room.muted}`, rogue('muted').node.key));
  // Lock: one delegate posts while the channel is locked.
  act(chair(room.locked), T * 0.35, () => lock(moderator(room.locked).node, `c${room.locked}`, true));
  spam(rogue('locked'), T * 0.36, T * 0.44, 20_000);
  act(chair(room.locked), T * 0.45, () => lock(moderator(room.locked).node, `c${room.locked}`, false));
  // Kick: the device carries on as if nothing happened.
  const kickAt = T * 0.4;
  act(chair(room.kicked), kickAt, () => kick(moderator(room.kicked).node, `c${room.kicked}`, rogue('kicked').node.key));
  spam(rogue('kicked'), kickAt + 1, T, 20_000);
  // Fork: the cheater signs two versions of one message and hands each to a different neighbour.
  const forker = rogue('forker');
  act(forker, T * 0.6, () => {
    const a = post(forker.node, forker.com!, 'I vote yes');
    const b = createEvent(crypto, forker.node.replica.confId, forker.identity, {
      s: a.s, n: a.n, h: a.h, k: 'post', b: { text: 'I vote no' },
    });
    const victim = del(room.forker, 15);
    sim.after(50, () => victim.node.accept([b]));
    return a;
  });

  // ── Failures ──
  const churners = honest.filter((p) => sim.random() < 0.15);
  for (const p of churners) disturbed.add(p.name);
  for (const r of Object.keys(rogueIndex) as (keyof typeof rogueIndex)[]) disturbed.add(rogue(r).name);
  for (const p of churners) {
    for (let k = 0; k < 1 + Math.floor(sim.random() * 2); k++) {
      const off = sim.between(2 * MIN, T - 8 * MIN);
      sim.at(off, () => net.setOnline(p.name, false));
      sim.at(off + sim.between(MIN, 6 * MIN), () => net.setOnline(p.name, true));
    }
  }
  sim.at(T * 0.3, () => linkIds.partition!.forEach((id) => net.setLink(id, false)));
  sim.at(T * 0.6, () => linkIds.partition!.forEach((id) => net.setLink(id, true)));
  const deadChair = chair(Math.max(0, n - 2));
  disturbed.add(deadChair.name);
  sim.at(T * 0.45, () => net.setOnline(deadChair.name, false));

  log(`${people.size} devices, ${net.links.size} links; running ${o.minutes} simulated minutes…`);
  sim.run(T);
  const settleWindow = 3 * MIN;
  sim.run(T + settleWindow);
  log(`simulation done in ${Date.now() - started} ms; checking…`);

  // ── Checks ──
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const judges = [...people.values()].filter((p) => p !== deadChair && p.rogue !== 'kicked' && p.rogue !== 'forker');
  const ref = sec0.node.replica;
  const counted = (e: Event) => !ref.auth.isRevoked(e.a, e.s, e.n) && e.n < ref.forkedFrom(e.a, e.s);
  const scopes = [GLOBAL, EB_SCOPE, ...committees.map((c) => c.id)];

  for (const scope of scopes) {
    const keepers = judges.filter((p) => p.node.replica.keeps(scope));
    const union = new Set<B64>();
    for (const p of keepers) for (const e of p.node.replica.store.events(scope)) if (counted(e)) union.add(e.id);
    const behind = keepers.filter((p) => {
      const mine = p.node.replica.store.events(scope).filter(counted);
      return mine.length !== union.size;
    });
    check(
      `every device keeping "${scope}" has all ${union.size} events`,
      behind.length === 0,
      behind.length ? `missing on: ${behind.slice(0, 5).map((p) => p.name).join(', ')}${behind.length > 5 ? '…' : ''}` : `${keepers.length} devices`,
    );
    if (scope === GLOBAL || scope === EB_SCOPE) continue;
    const fingerprint = (p: Person) => {
      const v = scopeView(p.node.replica, scope);
      return JSON.stringify([
        v.posts.map((e) => e.id),
        v.hidden.map((h) => [h.event.id, h.why]),
        v.chits.map((c) => [c.chit.id, c.status]),
        v.pinned,
        v.locked,
        v.slowSec,
        [...v.muted].sort(),
      ]);
    };
    const expected = fingerprint(keepers[0]!);
    const differ = keepers.filter((p) => fingerprint(p) !== expected);
    check(`every device shows "${scope}" the same`, differ.length === 0, differ.length ? `differs on ${differ.length}` : `${keepers.length} devices`);
  }

  const viewOf = (r: number) => scopeView(ref, `c${r}`);
  const mutedPosts = viewOf(room.muted).hidden.filter((h) => h.why === 'muted').length;
  const mutedLeak = viewOf(room.muted).posts.filter(
    (e) => e.a === rogue('muted').node.key && e.h.t > T * 0.25 + 30_000 && e.h.t < T * 0.5,
  ).length;
  check('muted delegate is hidden while muted', mutedPosts > 0 && mutedLeak === 0, `${mutedPosts} hidden, ${mutedLeak} leaked`);

  const lockedPosts = viewOf(room.locked).hidden.filter((h) => h.why === 'locked').length;
  const lockLeak = viewOf(room.locked).posts.filter((e) => e.a === rogue('locked').node.key && e.h.t > T * 0.36 && e.h.t < T * 0.44).length;
  check('posts during a lock are hidden', lockedPosts > 0 && lockLeak === 0, `${lockedPosts} hidden, ${lockLeak} leaked`);

  const kicked = rogue('kicked');
  const kickedVisible = judges.reduce(
    (sum, p) => sum + (p.node.replica.keeps(kicked.com!) ? scopeView(p.node.replica, kicked.com!).posts.filter((e) => e.a === kicked.node.key && e.h.t > kickAt).length : 0),
    0,
  );
  const kickedSpam = [...created.values()].filter((c) => c.e.a === kicked.node.key && c.at > kickAt).length;
  check('a kicked device is shut out everywhere', kickedVisible === 0, `${kickedSpam} attempts after the kick, ${kickedVisible} visible`);

  const forkSeen = judges.filter((p) => p.node.replica.keeps(forker.com!) && p.node.replica.forkedFrom(forker.node.key, forker.com!) === Infinity);
  check('every device caught the forked message', forkSeen.length === 0, forkSeen.length ? `${forkSeen.length} unaware` : 'all devices hold the evidence');

  let approved = 0;
  let rejected = 0;
  let pending = 0;
  let unreadable = 0;
  let leaked = 0;
  for (let r = 0; r < n; r++) {
    for (const c of viewOf(r).chits) {
      const content = readChit(chair(r).node, c) ?? readChit(cochair(r).node, c);
      if (!content) {
        unreadable++;
        continue;
      }
      const recipient = [...people.values()].find((p) => p.node.key === content.to);
      if (!recipient || recipient === deadChair || recipient.rogue === 'kicked') continue;
      const theirView = scopeView(recipient.node.replica, `c${r}`).chits.find((x) => x.chit.id === c.chit.id);
      const read = theirView ? readChit(recipient.node, theirView) : null;
      if (c.status === 'approved') {
        approved++;
        if (!read || read.text !== content.text) unreadable++;
      } else if (c.status === 'rejected') {
        rejected++;
        if (read) leaked++;
      } else pending++;
    }
  }
  check(
    'approved chits reach their recipient; rejected ones stay sealed',
    unreadable === 0 && leaked === 0 && pending === 0,
    `${approved} approved, ${rejected} rejected, ${pending} pending, ${unreadable} unreadable, ${leaked} leaked`,
  );

  let replies = 0;
  let unreadReplies = 0;
  for (const p of honest) {
    const thread = scopeView(p.node.replica, p.com!).dms.get(p.node.key) ?? [];
    for (const d of thread.filter((d) => d.a !== p.node.key)) {
      replies++;
      if (readSealed(p.node, d)?.text !== 'Noted.') unreadReplies++;
    }
  }
  check('delegates can read the EB replies in their thread', unreadReplies === 0 && replies > 0, `${replies} replies`);

  const lateMissing = ref.store.events('c0').filter(counted).filter((e) => !late.node.replica.store.has(e.id)).length;
  check('a late joiner receives the full history', lateMissing === 0, lateMissing ? `${lateMissing} missing` : 'complete');

  const stats = (list: number[]) => {
    const sorted = [...list].sort((a, b) => a - b);
    const pct = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
    const under1s = Math.round((sorted.filter((l) => l < 1000).length / Math.max(1, sorted.length)) * 1000) / 10;
    return { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: pct(1), under1s };
  };
  const mb = (bytes: number) => Math.round((bytes / 1e6) * 10) / 10;
  const report: Report = {
    nodes: people.size,
    links: net.links.size,
    events: counts,
    refused,
    deliveries: latencies.length,
    latencyMs: stats(latencies),
    steadyLatencyMs: stats(steady),
    settleMs: Math.max(0, lastStore - T),
    traffic: {
      messages: net.stats.messages,
      megabytes: mb(net.stats.bytes),
      dropped: net.stats.dropped,
      byType: Object.fromEntries(Object.entries(net.stats.byType).map(([k, v]) => [k, { messages: v.messages, megabytes: mb(v.bytes) }])),
    },
    checks,
    ok: checks.every((c) => c.ok),
    wallMs: Date.now() - started,
  };
  return report;
}
