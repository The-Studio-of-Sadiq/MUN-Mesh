import { describe, expect, it } from 'vitest';
import { createNodeCrypto } from './crypto/node';
import { FieldTestReporter, fieldTests, summarizeFieldTest } from './fieldtest';
import { Sim, SimNet } from './sim';
import { testConference } from './testing';
import { GLOBAL } from './types';

describe('field test', () => {
  it('counts every device’s pings and shows an outage as latency, not loss', () => {
    const sim = new Sim(5);
    const net = new SimNet(sim);
    const t = testConference({ crypto: createNodeCrypto(), now: () => sim.now });
    const eb = t.person('eb', 'Chair', 'disec');
    eb.node.accept([eb.cert]);
    const phones = ['France', 'Kenya', 'Peru', 'Chile'].map((name) => {
      const p = t.person('delegate', name, 'disec', eb.node);
      p.node.accept([eb.cert, p.cert]);
      return p;
    });
    net.add('sec', t.sec);
    net.add('eb', eb.node);
    net.link('sec', 'eb', 'bridge');
    phones.forEach((p, i) => {
      net.add(`p${i}`, p.node);
      net.link(`p${i}`, 'eb', 'wifi', 'room');
    });
    const reporters = [eb, ...phones].map(
      (p) => new FieldTestReporter(p.node, { platform: 'android', relay: false, links: () => ({ tcp: p.node.neighbours().length, nearby: 0 }), now: () => sim.now }),
    );
    sim.every(1000, () => {
      for (const [name, n] of net.nodes) if (net.isOnline(name)) n.tick();
      for (const r of reporters) r.tick();
    });
    sim.run(2000);
    let seq = 0;
    sim.every(10_000, () => {
      if (sim.now <= 182_000) t.sec.publish(GLOBAL, 'ping', { test: 'run1', seq: seq++ });
    }, 2000);
    // Chile's phone is off for a minute in the middle.
    sim.at(60_000, () => net.setOnline('p3', false));
    sim.at(130_000, () => net.setOnline('p3', true));
    sim.run(300_000);

    expect(fieldTests(t.sec.replica)).toEqual(['run1']);
    const s = summarizeFieldTest(t.sec.replica, 'run1');
    expect(s.pings).toBe(19);
    expect(s.overall.devices).toBe(5);
    expect(s.overall.delivery).toBe(1);
    expect(s.committees.map((c) => c.com)).toEqual(['disec']);
    const chile = s.devices.find((d) => d.name === 'Chile')!;
    const france = s.devices.find((d) => d.name === 'France')!;
    expect(chile.received).toBe(19);
    expect(chile.max).toBeGreaterThan(60_000);
    expect(france.max).toBeLessThan(1000);
  });
});
