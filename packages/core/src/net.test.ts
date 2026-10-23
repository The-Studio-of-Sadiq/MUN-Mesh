import { describe, expect, it } from 'vitest';
import { post } from './actions';
import { newConference } from './conference';
import { createIdentity } from './crypto';
import { createNodeCrypto } from './crypto/node';
import { createEvent } from './event';
import { MeshNode } from './node';
import { Sim, SimNet } from './sim';
import { deliver, testConference } from './testing';
import { ALL, type Event } from './types';

const crypto = createNodeCrypto();

function world() {
  const sim = new Sim(7);
  const net = new SimNet(sim);
  const t = testConference({ crypto, now: () => sim.now });
  sim.every(1000, () => {
    for (const [name, n] of net.nodes) if (net.isOnline(name)) n.tick();
  });
  const eb = t.person('eb', 'Chair', 'disec');
  eb.node.accept([eb.cert]);
  const delegate = (name: string, com = 'disec', issuer = eb.node) => {
    const p = t.person('delegate', name, com, issuer);
    p.node.accept([eb.cert, p.cert]);
    return p.node;
  };
  const has = (n: MeshNode, e: Event) => n.replica.store.has(e.id);
  return { sim, net, t, eb, delegate, has };
}

describe('mesh', () => {
  it('relays A → B → C when A and C never connect', () => {
    const { sim, net, eb, delegate, has } = world();
    const a = delegate('France');
    const b = delegate('Kenya');
    const c = delegate('Peru');
    net.add('eb', eb.node);
    net.add('a', a);
    net.add('b', b);
    net.add('c', c);
    // Only the EB knows everyone's certs at first; they spread too.
    net.link('eb', 'b', 'wifi');
    net.link('a', 'b', 'nearby');
    net.link('b', 'c', 'nearby');
    sim.run(5_000);
    const hello = post(a, 'disec', 'Hello from France');
    sim.run(6_000);
    expect(has(c, hello)).toBe(true);
    expect(has(eb.node, hello)).toBe(true);
  });

  it('catches a device up when it comes back', () => {
    const { sim, net, eb, delegate, has } = world();
    const a = delegate('France');
    const c = delegate('Peru');
    net.add('eb', eb.node);
    net.add('a', a);
    net.add('c', c);
    net.link('a', 'eb', 'wifi');
    net.link('c', 'eb', 'wifi');
    sim.run(2_000);
    net.setOnline('c', false);
    const missed = [post(a, 'disec', 'one'), post(a, 'disec', 'two'), post(eb.node, 'disec', 'three')];
    sim.run(10_000);
    expect(missed.some((e) => has(c, e))).toBe(false);
    net.setOnline('c', true);
    sim.run(11_000);
    expect(missed.every((e) => has(c, e))).toBe(true);
  });

  it('recovers a message lost when the link dropped mid-flight', () => {
    const { sim, net, eb, delegate, has } = world();
    const a = delegate('France');
    net.add('eb', eb.node);
    net.add('a', a);
    const link = net.link('a', 'eb', 'nearby');
    sim.run(2_000);
    const lost = post(a, 'disec', 'into the void');
    net.setLink(link, false); // drops while the message is in flight
    net.setLink(link, true);
    sim.run(2_500);
    expect(net.stats.dropped).toBeGreaterThan(0);
    sim.run(5_000);
    expect(has(eb.node, lost)).toBe(true);
  });

  it("doesn't send a committee's traffic to devices that don't keep it", () => {
    const { sim, net, t, eb, delegate, has } = world();
    const unscChair = t.person('eb', 'UNSC chair', 'unsc');
    unscChair.node.accept([unscChair.cert]);
    const france = delegate('France');
    const japan = delegate('Japan', 'unsc', unscChair.node);
    net.add('eb', eb.node);
    net.add('france', france);
    net.add('japan', japan);
    net.link('france', 'eb', 'wifi');
    net.link('japan', 'eb', 'wifi');
    sim.run(2_000);
    const p = post(france, 'disec', 'DISEC only');
    const g = t.sec.publish('global', 'announce', { text: 'Lunch at 1' });
    eb.node.accept([g]);
    sim.run(4_000);
    expect(has(japan, p)).toBe(false);
    expect(has(japan, g)).toBe(true);
  });

  it('turns away a device from another conference', () => {
    const { sim, net, eb, delegate, has } = world();
    const other = newConference('Other MUN', [{ id: 'disec', name: 'DISEC' }], 1);
    const stranger = new MeshNode({ conf: other.conf, identity: other.root, subs: ALL, now: () => sim.now, crypto });
    const a = delegate('France');
    net.add('eb', eb.node);
    net.add('a', a);
    net.add('stranger', stranger);
    net.link('stranger', 'eb', 'wifi');
    net.link('a', 'eb', 'wifi');
    sim.run(2_000);
    const p = post(a, 'disec', 'hello');
    sim.run(4_000);
    expect(has(stranger, p)).toBe(false);
    expect(eb.node.neighbours().map((n) => n.node)).toEqual([a.key]);
  });

  it('spreads fork evidence so every device hides the cheater', () => {
    const { sim, net, t, eb, delegate } = world();
    const cheat = t.person('delegate', 'Cheat', 'disec', eb.node);
    cheat.node.accept([eb.cert, cheat.cert]);
    const left = delegate('Left');
    const right = delegate('Right');
    for (const [name, n] of [['eb', eb.node], ['left', left], ['right', right], ['cheat', cheat.node]] as const) {
      net.add(name, n);
    }
    net.link('left', 'eb', 'wifi');
    net.link('right', 'eb', 'wifi');
    sim.run(2_000);
    // The cheater hands a different version to each side.
    const a = post(cheat.node, 'disec', 'I vote yes');
    const b = createEvent(crypto, cheat.node.replica.confId, cheat.identity, {
      s: 'disec', n: a.n, h: a.h, k: 'post', b: { text: 'I vote no' },
    });
    deliver([left], [a]);
    deliver([right], [b]);
    sim.run(4_000);
    for (const n of [eb.node, left, right]) expect(n.replica.forkedFrom(cheat.node.key, 'disec')).toBe(1);
  });
});
