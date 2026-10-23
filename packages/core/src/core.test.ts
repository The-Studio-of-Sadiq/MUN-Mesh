import { describe, expect, it } from 'vitest';
import {
  announce,
  approveChit,
  ebPost,
  kick,
  lock,
  mute,
  pin,
  post,
  readChit,
  readSealed,
  rejectChit,
  sendChit,
  sendDm,
  slowMode,
  unmute,
} from './actions';
import { _utf8Fallback, canonicalJson, fromB64, toB64, utf8 } from './bytes';
import { createIdentity, loadIdentity, nobleCrypto, open, saveIdentity, seal } from './crypto';
import { createNodeCrypto } from './crypto/node';
import { checkEvent, createEvent } from './event';
import { HlcClock, MAX_DRIFT_MS } from './hlc';
import { PublishRefused } from './node';
import { deliver, testConference } from './testing';
import { ALL, type Event } from './types';
import { scopeView } from './view';

describe('bytes', () => {
  it('round-trips base64url of every length', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(fromB64(toB64(bytes))).toEqual(bytes);
    }
    expect(toB64(utf8('hello?>'))).toBe(Buffer.from('hello?>').toString('base64url'));
    expect(() => fromB64('ab+c')).toThrow();
  });

  it('encodes UTF-8 the same without TextEncoder/TextDecoder', () => {
    for (const text of ['', 'abc', 'Côte d’Ivoire', 'বাংলাদেশ', '🇺🇳 MUN', 'a\u0000b']) {
      const native = new TextEncoder().encode(text);
      expect(_utf8Fallback.encodeUtf8(text)).toEqual(native);
      expect(_utf8Fallback.decodeUtf8(native)).toBe(text);
    }
    expect(() => _utf8Fallback.decodeUtf8(Uint8Array.from([0xc3]))).toThrow();
    expect(() => _utf8Fallback.decodeUtf8(Uint8Array.from([0xe0, 0x80, 0x80]))).toThrow();
    expect(() => _utf8Fallback.decodeUtf8(Uint8Array.from([0xed, 0xa0, 0x80]))).toThrow();
  });

  it('serialises objects the same whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } })).toBe(
      canonicalJson({ c: { y: 2, z: 1 }, a: [true, null, 'x'], b: 1 }),
    );
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: NaN })).toThrow();
  });
});

describe('crypto', () => {
  const native = createNodeCrypto();
  const id = createIdentity();
  const msg = utf8('Motion to open the speakers list');

  it('native and pure-JS Ed25519 agree', () => {
    const a = nobleCrypto.sign(msg, id.sign.secret);
    const b = native.sign(msg, id.sign.secret);
    expect(a).toEqual(b);
    expect(native.verify(a, msg, id.sign.pub)).toBe(true);
    expect(nobleCrypto.verify(b, msg, id.sign.pub)).toBe(true);
    const bad = a.slice();
    bad[0]! ^= 1;
    expect(native.verify(bad, msg, id.sign.pub)).toBe(false);
    expect(nobleCrypto.verify(bad, msg, id.sign.pub)).toBe(false);
    expect(native.sha256(msg)).toEqual(nobleCrypto.sha256(msg));
  });

  it('seals to each recipient and nobody else', () => {
    const [a, b, outsider] = [createIdentity(), createIdentity(), createIdentity()];
    const { sealed } = seal({ text: 'hi' }, [a.box.pub, b.box.pub]);
    expect(open(sealed, a.box)).toEqual({ text: 'hi' });
    expect(open(sealed, b.box)).toEqual({ text: 'hi' });
    expect(open(sealed, outsider.box)).toBeNull();
    const tampered = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith('A') ? 'BA' : 'AA') };
    expect(open(tampered, a.box)).toBeNull();
  });

  it('restores an identity from its stored secrets', () => {
    const back = loadIdentity(saveIdentity(id));
    expect(back.sign.pub).toEqual(id.sign.pub);
    expect(back.box.pub).toEqual(id.box.pub);
  });
});

describe('events', () => {
  const id = createIdentity();
  const make = () =>
    createEvent(nobleCrypto, 'conf1', id, { s: 'disec', n: 1, h: { t: 5, c: 0 }, k: 'post', b: { text: 'Hello' } });

  it('accepts a well-formed signed event', () => {
    expect(checkEvent(nobleCrypto, 'conf1', make())).toBeNull();
  });

  it('rejects tampering, replay into another conference and junk', () => {
    const e = make();
    expect(checkEvent(nobleCrypto, 'conf1', { ...e, b: { text: 'Goodbye' } })).toBe('badId');
    expect(checkEvent(nobleCrypto, 'conf2', e)).toBe('badId');
    const other = createEvent(nobleCrypto, 'conf1', createIdentity(), { s: 'disec', n: 1, h: e.h, k: 'post', b: e.b });
    expect(checkEvent(nobleCrypto, 'conf1', { ...e, sig: other.sig })).toBe('badSignature');
    expect(checkEvent(nobleCrypto, 'conf1', { ...e, k: 'post', b: { text: '' } })).toBe('badBody');
    expect(checkEvent(nobleCrypto, 'conf1', { ...e, k: 'nuke' })).toBe('malformed');
    expect(checkEvent(nobleCrypto, 'conf1', null)).toBe('malformed');
    expect(checkEvent(nobleCrypto, 'conf1', { ...e, n: 0 })).toBe('malformed');
  });
});

describe('hybrid logical clock', () => {
  it('never goes backwards and moves past what it sees', () => {
    let wall = 1000;
    const clock = new HlcClock(() => wall);
    const a = clock.tick();
    wall = 900; // the device clock was corrected backwards
    const b = clock.tick();
    expect(b).toEqual({ t: 1000, c: 1 });
    clock.observe({ t: 2000, c: 4 });
    expect(clock.tick()).toEqual({ t: 2000, c: 5 });
    clock.observe({ t: wall + MAX_DRIFT_MS + 1, c: 0 }); // a device with a wildly wrong clock
    expect(clock.tick().t).toBe(2000);
    expect(a.t).toBe(1000);
  });
});

describe('replica', () => {
  it('holds events from unknown devices until their cert arrives', () => {
    const t = testConference();
    const eb = t.person('eb', 'Chair', 'disec');
    eb.node.accept([eb.cert]);
    const france = t.person('delegate', 'France', 'disec', eb.node);
    const observer = t.node(createIdentity(), ['disec']);
    // France's own device needs its cert before it may post.
    france.node.accept([eb.cert, france.cert]);
    const hello = post(france.node, 'disec', 'Hello');

    // Arrives in the worst order: the post, then France's cert, then the EB's cert.
    expect(observer.replica.ingest(hello).status).toBe('pending');
    expect(observer.replica.ingest(france.cert).status).toBe('pending');
    const result = observer.replica.ingest(eb.cert);
    expect(result.stored.map((e) => e.id)).toEqual([eb.cert.id, france.cert.id, hello.id]);
    expect(observer.replica.pendingSize()).toBe(0);
  });

  it('enforces roles and committees', () => {
    const t = testConference();
    const ebDisec = t.person('eb', 'DISEC chair', 'disec');
    const ebUnsc = t.person('eb', 'UNSC chair', 'unsc');
    deliver([ebDisec.node, ebUnsc.node], [ebDisec.cert, ebUnsc.cert]);
    const france = t.person('delegate', 'France', 'disec', ebDisec.node);
    deliver([france.node, ebUnsc.node], [ebDisec.cert, ebUnsc.cert, france.cert]);

    expect(() => announce(france.node, 'disec', 'I am the chair now')).toThrow(PublishRefused);
    expect(() => post(france.node, 'global', 'Hi everyone')).toThrow(PublishRefused);
    expect(() => mute(ebUnsc.node, 'disec', france.node.key)).toThrow(PublishRefused);
    expect(() => t.person('delegate', 'Spy', 'disec', ebUnsc.node)).toThrow(PublishRefused);
    expect(post(france.node, 'disec', 'On a point of order').k).toBe('post');
    expect(announce(ebDisec.node, 'disec', 'Session resumes').k).toBe('announce');
  });

  it('ends up with the same role history whatever order certs arrive in', () => {
    const t = testConference();
    const eb = t.person('eb', 'Chair', 'disec');
    deliver([eb.node], [eb.cert]);
    const person = t.person('delegate', 'Kenya', 'disec', eb.node);
    deliver([person.node], [eb.cert, person.cert]);
    const early = post(person.node, 'disec', 'As a delegate');
    t.clock.t += 1000;
    // Promoted to co-chair by the Secretariat.
    const promotion = t.sec.publish('global', 'cert', { ...person.cert.b, role: 'eb' });
    person.node.accept([promotion]);
    t.clock.t += 1000;
    const later = announce(person.node, 'disec', 'As co-chair');

    const events = [eb.cert, person.cert, promotion, early, later];
    const a = t.node(createIdentity(), ['disec']);
    const b = t.node(createIdentity(), ['disec']);
    a.accept(events);
    b.accept([...events].reverse());
    for (const n of [a, b]) {
      expect(n.replica.store.has(early.id) && n.replica.store.has(later.id)).toBe(true);
      expect(scopeView(n.replica, 'disec').posts.map((p) => p.id)).toEqual([early.id, later.id]);
    }
  });

  it('keeps a kicked device out from the point it was kicked', () => {
    const t = testConference();
    const eb = t.person('eb', 'Chair', 'disec');
    deliver([eb.node], [eb.cert]);
    const rogue = t.person('delegate', 'Rogue', 'disec', eb.node);
    deliver([rogue.node], [eb.cert, rogue.cert]);
    const before = post(rogue.node, 'disec', 'fine');
    eb.node.accept([before]);
    const revoke = kick(eb.node, 'disec', rogue.node.key);
    const after = post(rogue.node, 'disec', 'spam'); // rogue hasn't heard yet

    const fresh = t.node(createIdentity(), ['disec']);
    fresh.accept([eb.cert, rogue.cert, before, revoke]);
    expect(fresh.replica.ingest(after).status).toBe('rejected');
    eb.node.accept([after]);
    expect(eb.node.replica.store.has(after.id)).toBe(false);
    expect(scopeView(fresh.replica, 'disec').posts.map((p) => p.id)).toEqual([before.id]);
  });

  it('detects a device signing two different events with one sequence number', () => {
    const t = testConference();
    const eb = t.person('eb', 'Chair', 'disec');
    deliver([eb.node], [eb.cert]);
    const cheat = t.person('delegate', 'Cheat', 'disec', eb.node);
    deliver([cheat.node], [eb.cert, cheat.cert]);
    const a = post(cheat.node, 'disec', 'version A');
    const b = createEvent(nobleCrypto, cheat.node.replica.confId, cheat.identity, {
      s: 'disec',
      n: a.n,
      h: a.h,
      k: 'post',
      b: { text: 'version B' },
    });
    eb.node.accept([a]);
    const result = eb.node.replica.ingest(b);
    expect(result.status).toBe('fork');
    expect(scopeView(eb.node.replica, 'disec').hidden.map((h) => h.why)).toEqual(['forked']);
    // Evidence convinces a device that only ever saw version B.
    const other = t.node(createIdentity(), ['disec']);
    other.accept([eb.cert, cheat.cert, b]);
    expect(other.replica.addFork(result.fork)).not.toBeNull();
    expect(scopeView(other.replica, 'disec').posts).toEqual([]);
  });
});

describe('moderation view', () => {
  function committee() {
    const t = testConference();
    const eb = t.person('eb', 'Chair', 'disec');
    deliver([eb.node], [eb.cert]);
    const france = t.person('delegate', 'France', 'disec', eb.node);
    const usa = t.person('delegate', 'USA', 'disec', eb.node);
    const all = [eb.node, france.node, usa.node];
    deliver(all, [eb.cert, france.cert, usa.cert]);
    /** Publish on one device and hand it to the others. */
    const share = (e: Event) => {
      deliver(all, [e]);
      return e;
    };
    return { t, eb, france, usa, all, share };
  }

  it('hides a muted delegate from the mute on, by their own sequence numbers', () => {
    const { t, eb, france, share } = committee();
    const p1 = share(post(france.node, 'disec', 'one'));
    share(mute(eb.node, 'disec', france.node.key));
    t.clock.t += 10;
    // France's clock is way behind, which must not help.
    const p2 = share(post(france.node, 'disec', 'two'));
    share(unmute(eb.node, 'disec', france.node.key));
    const p3 = share(post(france.node, 'disec', 'three'));
    const view = scopeView(eb.node.replica, 'disec');
    expect(view.posts.map((p) => p.id)).toEqual([p1.id, p3.id]);
    expect(view.hidden).toEqual([{ event: p2, why: 'muted' }]);
    expect(view.muted).toEqual([]);
  });

  it('keeps a lock in force against a backdated post', () => {
    const { t, eb, france, share } = committee();
    t.clock.t += 1000;
    const p1 = share(post(france.node, 'disec', 'before'));
    t.clock.t += 1000;
    share(lock(eb.node, 'disec', true));
    // A modified app signs a post during the lock with a timestamp from before it.
    const backdated = createEvent(nobleCrypto, france.node.replica.confId, france.identity, {
      s: 'disec', n: p1.n + 1, h: { t: p1.h.t + 1, c: 0 }, k: 'post', b: { text: 'sneaky' },
    });
    share(backdated);
    t.clock.t += 1000;
    share(lock(eb.node, 'disec', false));
    const p3 = share(post(france.node, 'disec', 'after'));
    const view = scopeView(eb.node.replica, 'disec');
    expect(view.posts.map((p) => p.id)).toEqual([p1.id, p3.id]);
    expect(view.hidden).toEqual([{ event: backdated, why: 'locked' }]);
  });

  it('applies lock and slow mode to delegates but not the EB', () => {
    const { t, eb, france, share } = committee();
    t.clock.t += 1000;
    share(lock(eb.node, 'disec', true));
    t.clock.t += 1000;
    const locked = share(post(france.node, 'disec', 'during lock'));
    const chair = share(post(eb.node, 'disec', 'chair speaking'));
    t.clock.t += 1000;
    share(lock(eb.node, 'disec', false));
    share(slowMode(eb.node, 'disec', 30));
    t.clock.t += 1000;
    const a = share(post(france.node, 'disec', 'first'));
    t.clock.t += 5_000;
    const tooSoon = share(post(france.node, 'disec', 'second'));
    t.clock.t += 30_000;
    const ok = share(post(france.node, 'disec', 'third'));
    const view = scopeView(eb.node.replica, 'disec');
    expect(view.posts.map((p) => p.id)).toEqual([chair.id, a.id, ok.id]);
    expect(view.hidden.map((h) => [h.event.id, h.why])).toEqual([
      [locked.id, 'locked'],
      [tooSoon.id, 'slowMode'],
    ]);
    expect(view.locked).toBe(false);
    expect(view.slowSec).toBe(30);
  });

  it('runs a chit through the EB: recipient reads it only once approved', () => {
    const { t, eb, france, usa, share } = committee();
    const outsider = t.person('delegate', 'Brazil', 'disec', eb.node);
    deliver([outsider.node], [eb.cert, outsider.cert, france.cert, usa.cert]);
    const chit = share(sendChit(france.node, 'disec', usa.node.key, 'Would you support clause 4?'));
    outsider.node.accept([chit]);

    const pending = scopeView(usa.node.replica, 'disec').chits[0]!;
    expect(pending.status).toBe('pending');
    expect(readChit(usa.node, pending)).toBeNull();
    expect(readChit(france.node, pending)?.text).toBe('Would you support clause 4?');
    const ebSees = scopeView(eb.node.replica, 'disec').chits[0]!;
    expect(readChit(eb.node, ebSees)).toEqual({ to: usa.node.key, text: 'Would you support clause 4?' });

    const ok = approveChit(eb.node, chit as Event<'chit'>);
    if (typeof ok === 'string') throw new Error(ok);
    share(ok);
    outsider.node.accept([ok]);
    const approved = scopeView(usa.node.replica, 'disec').chits[0]!;
    expect(approved.status).toBe('approved');
    expect(readChit(usa.node, approved)?.text).toBe('Would you support clause 4?');
    expect(readChit(outsider.node, scopeView(outsider.node.replica, 'disec').chits[0]!)).toBeNull();

    // A rejected chit stays unreadable to its recipient...
    const second = share(sendChit(usa.node, 'disec', france.node.key, 'No.'));
    share(rejectChit(eb.node, second as Event<'chit'>));
    const rejected = scopeView(france.node.replica, 'disec').chits.find((c) => c.chit.id === second.id)!;
    expect(rejected.status).toBe('rejected');
    expect(readChit(france.node, rejected)).toBeNull();
    // ...until an EB member approves it after all: approval wins (its key is out), and can't be taken back.
    const late = approveChit(eb.node, second as Event<'chit'>);
    if (typeof late === 'string') throw new Error(late);
    share(late);
    share(rejectChit(eb.node, second as Event<'chit'>));
    const overturned = scopeView(france.node.replica, 'disec').chits.find((c) => c.chit.id === second.id)!;
    expect(overturned.status).toBe('approved');
    expect(readChit(france.node, overturned)?.text).toBe('No.');
  });

  it('lets the EB read every delegate thread; other delegates cannot', () => {
    const { eb, france, usa, share } = committee();
    const q = share(sendDm(france.node, 'disec', france.node.key, 'May I leave early?'));
    const a = share(sendDm(eb.node, 'disec', france.node.key, 'Yes'));
    const thread = scopeView(eb.node.replica, 'disec').dms.get(france.node.key)!;
    expect(thread.map((d) => d.id)).toEqual([q.id, a.id]);
    expect(readSealed(eb.node, q as Event<'dm'>)?.text).toBe('May I leave early?');
    expect(readSealed(france.node, a as Event<'dm'>)?.text).toBe('Yes');
    expect(readSealed(usa.node, q as Event<'dm'>)).toBeNull();
    expect(() => sendDm(usa.node, 'disec', france.node.key, 'impersonating')).toThrow(PublishRefused);
  });

  it('pins and unpins', () => {
    const { eb, france, share } = committee();
    const p = share(post(france.node, 'disec', 'Draft resolution 1.1'));
    share(pin(eb.node, 'disec', p.id));
    expect(scopeView(france.node.replica, 'disec').pinned).toEqual([p.id]);
    share(pin(eb.node, 'disec', p.id, false));
    expect(scopeView(france.node.replica, 'disec').pinned).toEqual([]);
  });

  it('seals the EB channel to EB and Secretariat devices', () => {
    const t = testConference();
    const a = t.person('eb', 'DISEC chair', 'disec');
    const b = t.person('eb', 'UNSC chair', 'unsc');
    const certs = [a.cert, b.cert];
    deliver([a.node, b.node], certs);
    const msg = ebPost(a.node, 'Lunch moved to 1pm');
    const delegateLike = t.node(createIdentity(), ALL);
    expect(readSealed(b.node, msg)?.text).toBe('Lunch moved to 1pm');
    expect(readSealed(t.sec, msg)?.text).toBe('Lunch moved to 1pm');
    expect(readSealed(delegateLike, msg)).toBeNull();
  });
});
