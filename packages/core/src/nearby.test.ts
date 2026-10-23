import { afterEach, describe, expect, it } from 'vitest';
import { certFor, fileOf, issueCert, post } from './actions';
import { newConference, publicKeys } from './conference';
import { createIdentity, type Identity } from './crypto';
import { createNodeCrypto } from './crypto/node';
import { Device, type Transport } from './device';
import { FileManager, MemoryChunkStore } from './files';
import { NearbyRelay, splitPieces, type NearbyEvent, type NearbyNative } from './nearby';
import { MeshNode } from './node';
import { nodeTransport } from './transport-node';
import { ALL, type Event } from './types';

const crypto = createNodeCrypto();
const local: Transport = { ...nodeTransport, localAddresses: async () => ['127.0.0.1'] };
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function waitFor(cond: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * A pretend radio: phones "in range" find each other, connections are
 * accepted on both sides, and pieces arrive after a random delay, so out of
 * order, like a real link might deliver them.
 */
class Air {
  private readonly radios = new Map<string, FakeRadio>();
  private readonly range = new Set<string>();
  private nextId = 1;

  radio(): FakeRadio {
    const r = new FakeRadio(this, `ep${this.nextId++}`);
    this.radios.set(r.id, r);
    return r;
  }

  inRange(a: FakeRadio, b: FakeRadio): void {
    this.range.add([a.id, b.id].sort().join('~'));
    if (a.name && b.name) {
      a.emit({ type: 'found', endpoint: b.id, name: b.name });
      b.emit({ type: 'found', endpoint: a.id, name: a.name });
    }
  }

  near(a: FakeRadio, b: FakeRadio): boolean {
    return this.range.has([a.id, b.id].sort().join('~'));
  }

  started(r: FakeRadio): void {
    for (const other of this.radios.values()) {
      if (other === r || !other.name || !this.near(r, other)) continue;
      r.emit({ type: 'found', endpoint: other.id, name: other.name });
      other.emit({ type: 'found', endpoint: r.id, name: r.name! });
    }
  }

  get(id: string): FakeRadio | undefined {
    return this.radios.get(id);
  }
}

class FakeRadio implements NearbyNative {
  readonly id: string;
  name: string | null = null;
  readonly sent: string[] = [];
  private readonly air: Air;
  private readonly listeners = new Set<(e: NearbyEvent) => void>();
  private readonly links = new Set<string>();
  constructor(air: Air, id: string) {
    this.air = air;
    this.id = id;
  }
  emit(e: NearbyEvent) {
    for (const l of this.listeners) l(e);
  }
  async start(_service: string, name: string) {
    this.name = name;
    this.air.started(this);
  }
  async stop() {
    this.name = null;
  }
  async connect(endpoint: string) {
    const other = this.air.get(endpoint);
    if (!other || !this.air.near(this, other)) throw new Error('out of range');
    this.links.add(endpoint);
    other.links.add(this.id);
    setTimeout(() => {
      this.emit({ type: 'connected', endpoint, incoming: false });
      other.emit({ type: 'connected', endpoint: this.id, incoming: true });
    }, 5);
  }
  async send(endpoint: string, text: string) {
    if (!this.links.has(endpoint)) throw new Error('not connected');
    this.sent.push(text);
    const other = this.air.get(endpoint)!;
    setTimeout(() => other.emit({ type: 'data', endpoint: this.id, text }), Math.random() * 15);
  }
  disconnect(endpoint: string) {
    this.links.delete(endpoint);
    const other = this.air.get(endpoint);
    other?.links.delete(this.id);
    other?.emit({ type: 'disconnected', endpoint: this.id });
  }
  onEvent(cb: (e: NearbyEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

describe('splitting text for Nearby', () => {
  it('never cuts a character in two', () => {
    const text = 'a'.repeat(7999) + '🇺🇳' + 'b'.repeat(10);
    const pieces = splitPieces(text);
    expect(pieces.join('')).toBe(text);
    for (const p of pieces) expect(() => encodeURIComponent(p)).not.toThrow();
  });
});

describe('relay over Nearby', () => {
  function conference() {
    const { conf, root } = newConference('Nearby MUN', [{ id: 'disec', name: 'DISEC' }], 1);
    const sec = new MeshNode({ conf, identity: root, subs: ALL, now: Date.now, crypto });
    async function device(identity: Identity, subs: string[] | typeof ALL, listen: boolean) {
      const d = new Device({ node: new MeshNode({ conf, identity, subs, now: Date.now, crypto }), transport: local, listenPort: listen ? 0 : null, maxOutbound: 4 });
      await d.start();
      cleanups.push(() => d.stop());
      const files = new FileManager({ node: d.node, store: new MemoryChunkStore(), now: Date.now, autoFetch: () => listen });
      await files.start();
      const t = setInterval(() => files.tick(), 200);
      cleanups.push(() => clearInterval(t));
      return { d, files };
    }
    async function member(subs: string[] | typeof ALL, role: 'eb' | 'delegate', name: string, listen = false) {
      const id = createIdentity();
      const m = await device(id, subs, listen);
      m.d.node.accept([issueCert(sec, certFor(publicKeys(id), role, name, 'disec'))]);
      return m;
    }
    return { conf, sec, member, device };
  }

  it('reaches the room from out of router range through another phone, both ways, files included', async () => {
    const c = conference();
    const air = new Air();
    const hub = await c.member(ALL, 'eb', 'Chair', true);
    // B is on the room's Wi-Fi and relays (keeps everything); A only reaches B.
    const b = await c.member(ALL, 'delegate', 'Kenya');
    const a = await c.member(['disec'], 'delegate', 'Peru');
    b.d.addAddress(`127.0.0.1:${hub.d.port}`, 'invite');
    const radioA = air.radio();
    const radioB = air.radio();
    const confId = hub.d.node.replica.confId;
    await new NearbyRelay({ device: a.d, native: radioA, confId }).start();
    await new NearbyRelay({ device: b.d, native: radioB, confId }).start();
    // A phone of another conference nearby is never linked.
    const stranger = air.radio();
    await stranger.start('x', 'otherconf|AAAAAAAAAAAAAAAA');
    air.inRange(radioA, stranger);
    air.inRange(radioA, radioB);
    await waitFor(() => a.d.node.neighbours().length === 1 && hub.d.node.neighbours().length === 1);
    expect(stranger.sent).toEqual([]);

    const fromA = post(a.d.node, 'disec', 'Peru, from the corridor');
    await waitFor(() => hub.d.node.replica.store.has(fromA.id));
    const fromHub = post(hub.d.node, 'disec', 'Chair to everyone');
    await waitFor(() => a.d.node.replica.store.has(fromHub.id));

    // A 600 KB file from the chair reaches A in pieces over the radio, through B.
    const data = new Uint8Array(600_000).map((_, i) => (i * 7) % 256);
    const up = await hub.files.addLocal(data);
    const e = post(hub.d.node, 'disec', 'Agenda', { file: { ...up, name: 'agenda.pdf', mime: 'application/pdf' } }) as Event;
    await waitFor(() => a.d.node.replica.store.has(e.id));
    a.files.want(up.att.id);
    await waitFor(() => !!a.files.status(up.att.id)?.done, 15_000);
    const got = fileOf(a.d.node, a.d.node.replica.store.get(e.id)!)!;
    const back = await a.files.read(got.att, got.meta);
    expect(back && Buffer.compare(back, data) === 0).toBe(true);
  }, 30_000);

  it('links even when only one phone sees the other', async () => {
    const c = conference();
    const air = new Air();
    const p = await c.member(['disec'], 'delegate', 'One');
    const q = await c.member(['disec'], 'delegate', 'Two');
    const rp = air.radio();
    const rq = air.radio();
    const confId = p.d.node.replica.confId;
    await new NearbyRelay({ device: p.d, native: rp, confId }).start();
    await new NearbyRelay({ device: q.d, native: rq, confId }).start();
    air.inRange(rp, rq);
    // Hide each phone from the other in turn: the one that should dial sees nothing.
    const smaller = p.d.node.key.slice(0, 16) < q.d.node.key.slice(0, 16) ? rp : rq;
    const other = smaller === rp ? rq : rp;
    smaller.emit({ type: 'lost', endpoint: other.id });
    await waitFor(() => p.d.node.neighbours().length === 1 && q.d.node.neighbours().length === 1, 10_000);
  }, 15_000);

  it('only one of two phones dials, and the link survives the other side dropping', async () => {
    const c = conference();
    const air = new Air();
    const p = await c.member(['disec'], 'delegate', 'One');
    const q = await c.member(['disec'], 'delegate', 'Two');
    const rp = air.radio();
    const rq = air.radio();
    const confId = p.d.node.replica.confId;
    const relayP = new NearbyRelay({ device: p.d, native: rp, confId });
    await relayP.start();
    await new NearbyRelay({ device: q.d, native: rq, confId }).start();
    air.inRange(rp, rq);
    await waitFor(() => p.d.node.neighbours().length === 1 && q.d.node.neighbours().length === 1);
    expect(p.d.status().links).toHaveLength(1);
    expect(q.d.status().links).toHaveLength(1);
    await relayP.stop();
    await waitFor(() => q.d.node.neighbours().length === 0);
  });
});
