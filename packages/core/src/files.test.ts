import { describe, expect, it } from 'vitest';
import { certFor, fileOf, issueCert, post, sendDm, setFileRules, type OutgoingFile } from './actions';
import { publicKeys } from './conference';
import { createIdentity } from './crypto';
import { createNodeCrypto } from './crypto/node';
import { checkEvent, createEvent } from './event';
import { assembleFile, checkFile, encryptFile, FileManager, fileRules, MemoryChunkStore } from './files';
import { MeshNode } from './node';
import { Sim, SimNet } from './sim';
import { deliver, testConference } from './testing';
import { ALL, CHUNK_SIZE, type Event } from './types';

const crypto = createNodeCrypto();

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

describe('file encryption', () => {
  it('round-trips and names chunks by their hash', async () => {
    const data = bytes(CHUNK_SIZE * 2 + 1000);
    const { att, key, chunks } = encryptFile(crypto, data);
    expect(att.chunks).toHaveLength(3);
    expect(att.size).toBe(data.length);
    const back = await assembleFile(att, key, async (id) => chunks.get(id) ?? null);
    expect(back).toEqual(data);
  });

  it('refuses a missing, swapped or tampered chunk', async () => {
    const { att, key, chunks } = encryptFile(crypto, bytes(CHUNK_SIZE + 10));
    const get = (over: Map<string, Uint8Array>) => async (id: string) => over.get(id) ?? null;
    const missing = new Map(chunks);
    missing.delete(att.chunks[1]!);
    expect(await assembleFile(att, key, get(missing))).toBeNull();
    const swapped = new Map([[att.chunks[0]!, chunks.get(att.chunks[1]!)!], [att.chunks[1]!, chunks.get(att.chunks[0]!)!]]);
    expect(await assembleFile(att, key, get(swapped))).toBeNull();
    const other = encryptFile(crypto, bytes(CHUNK_SIZE + 10, 2));
    expect(await assembleFile(att, other.key, get(chunks))).toBeNull();
  });

  it('applies size and type rules', () => {
    const rules = { maxMB: 2, block: ['exe'] };
    expect(checkFile(rules, 3 * 1024 * 1024, 'a.pdf')).toBe('tooLarge');
    expect(checkFile(rules, 100, 'setup.EXE')).toBe('blockedType');
    expect(checkFile(rules, 100, 'resolution.docx')).toBeNull();
  });

  it('rejects malformed attachments in events', () => {
    const id = createIdentity();
    const { att, key } = encryptFile(crypto, bytes(CHUNK_SIZE + 1));
    const make = (b: unknown) => createEvent(crypto, 'c', id, { s: 'disec', n: 1, h: { t: 1, c: 0 }, k: 'post', b: b as never });
    const file = { name: 'draft.pdf', mime: 'application/pdf', key };
    expect(checkEvent(crypto, 'c', make({ text: '', att, file }))).toBeNull();
    expect(checkEvent(crypto, 'c', make({ text: '', att }))).toBe('badBody');
    expect(checkEvent(crypto, 'c', make({ text: '' }))).toBe('badBody');
    expect(checkEvent(crypto, 'c', make({ text: 'x', att: { ...att, chunks: att.chunks.slice(1) }, file }))).toBe('badBody');
  });
});

/** Runs the simulator, letting chunk storage (promises) settle between steps. */
async function run(sim: Sim, until: number, step = 50) {
  while (sim.now < until) {
    sim.run(Math.min(until, sim.now + step));
    await new Promise((r) => setImmediate(r));
  }
}

function fileWorld() {
  const sim = new Sim(3);
  const net = new SimNet(sim);
  const t = testConference({ crypto, now: () => sim.now });
  const managers = new Map<string, FileManager>();
  const stores = new Map<string, MemoryChunkStore>();
  sim.every(1000, () => {
    for (const [name, n] of net.nodes) if (net.isOnline(name)) n.tick();
    for (const m of managers.values()) m.tick();
  });
  async function add(name: string, node: MeshNode, autoFetch = false) {
    const store = new MemoryChunkStore();
    const fm = new FileManager({ node, store, now: () => sim.now, autoFetch: () => autoFetch });
    await fm.start();
    net.add(name, node);
    managers.set(name, fm);
    stores.set(name, store);
    return fm;
  }
  return { sim, net, t, managers, stores, add };
}

async function share(fm: FileManager, data: Uint8Array, name = 'draft-resolution.pdf'): Promise<OutgoingFile> {
  const { att, key } = await fm.addLocal(data);
  return { att, key, name, mime: 'application/pdf' };
}

describe('file transfer', () => {
  it('moves a 25 MB file across two hops and resumes after the link drops', async () => {
    const { sim, net, t, stores, add } = fileWorld();
    const chairA = t.person('eb', 'Room A chair', 'disec');
    const chairB = t.person('eb', 'Room B chair', 'unsc');
    chairA.node.accept([chairA.cert]);
    chairB.node.accept([chairB.cert]);
    const france = t.person('delegate', 'France', 'disec', chairA.node);
    const kenya = t.person('delegate', 'Kenya', 'disec', chairA.node);
    france.node.accept([chairA.cert, france.cert]);
    kenya.node.accept([chairA.cert, kenya.cert]);
    const fmFrance = await add('france', france.node);
    await add('hubA', chairA.node, true);
    await add('hubB', chairB.node, true);
    const fmKenya = await add('kenya', kenya.node);
    // France is in room A, Kenya has wandered into room B: hub A — bridge — hub B.
    net.link('france', 'hubA', 'wifi', 'roomA');
    net.link('hubA', 'hubB', 'bridge');
    const kenyaLink = net.link('kenya', 'hubB', 'wifi', 'roomB');
    await run(sim, 3000);

    const data = bytes(25 * 1024 * 1024, 7);
    const file = await share(fmFrance, data);
    const e = post(france.node, 'disec', 'Our draft', { file });
    await run(sim, 6000);
    fmKenya.want(file.att.id);

    // Pull Kenya's Wi-Fi once part of the file has arrived.
    await run(sim, 12_000);
    const partial = fmKenya.status(file.att.id)!;
    expect(partial.have).toBeGreaterThan(0);
    expect(partial.done).toBe(false);
    net.setLink(kenyaLink, false);
    await run(sim, 40_000);
    // Nothing arrives while the link is down; the next step resumes rather than restarts.
    const whileDown = fmKenya.status(file.att.id)!.have;
    expect(whileDown).toBeLessThan(file.att.chunks.length);
    net.setLink(kenyaLink, true);
    await run(sim, 120_000);

    const done = fmKenya.status(file.att.id)!;
    expect(done.done).toBe(true);
    const got = fileOf(kenya.node, kenya.node.replica.store.get(e.id)!)!;
    // Compare bytes directly: a 25 MB toEqual diff would exhaust memory if they differed.
    const received = await fmKenya.read(got.att, got.meta);
    expect(received && Buffer.compare(received, data) === 0).toBe(true);
    // Both hubs keep a copy for whoever asks next.
    for (const hub of ['hubA', 'hubB']) expect(file.att.chunks.every((c) => stores.get(hub)!.data.has(c))).toBe(true);
  }, 120_000);

  it('doesn’t stall when hubs ask each other in a circle', async () => {
    const { sim, net, t, add } = fileWorld();
    // Three hubs linked in a triangle; the file's author is linked to only one of them.
    const hubs = ['disec', 'unsc', 'disec'].map((com, i) => {
      const p = t.person('eb', `Hub ${i}`, com);
      p.node.accept([p.cert]);
      return p;
    });
    const author = t.person('delegate', 'Author', 'disec', hubs[0]!.node);
    author.node.accept([hubs[0]!.cert, author.cert]);
    const fms = await Promise.all(hubs.map((h, i) => add(`h${i}`, h.node, true)));
    const fmAuthor = await add('author', author.node);
    net.link('h0', 'h1', 'bridge');
    net.link('h1', 'h2', 'bridge');
    net.link('h2', 'h0', 'bridge');
    net.link('author', 'h0', 'wifi');
    await run(sim, 3000);
    const file = await share(fmAuthor, bytes(3 * 1024 * 1024, 9));
    post(author.node, 'disec', '', { file });
    // Well under one request timeout (20 s): no hub waits on a circle.
    await run(sim, 15_000);
    for (const fm of fms) expect(fm.status(file.att.id)!.done).toBe(true);
  }, 60_000);

  it('passes a file along a chain of phones (Nearby relay)', async () => {
    const { sim, net, t, add } = fileWorld();
    const eb = t.person('eb', 'Chair', 'disec');
    eb.node.accept([eb.cert]);
    const phones = ['A', 'B', 'C'].map((n) => {
      const p = t.person('delegate', n, 'disec', eb.node);
      p.node.accept([eb.cert, p.cert]);
      return p;
    });
    const fms = await Promise.all(phones.map((p, i) => add(`p${i}`, p.node)));
    net.link('p0', 'p1', 'nearby');
    net.link('p1', 'p2', 'nearby');
    await run(sim, 3000);
    const data = bytes(600_000, 3);
    const file = await share(fms[0]!, data, 'map.png');
    post(phones[0]!.node, 'disec', '', { file });
    await run(sim, 5000);
    fms[2]!.want(file.att.id);
    await run(sim, 60_000);
    expect(fms[2]!.status(file.att.id)!.done).toBe(true);
  }, 60_000);

  it('keeps a private file sealed: a relaying delegate carries it but can’t open it', async () => {
    const { sim, net, t, add } = fileWorld();
    const eb = t.person('eb', 'Chair', 'disec');
    eb.node.accept([eb.cert]);
    const france = t.person('delegate', 'France', 'disec', eb.node);
    const relay = t.person('delegate', 'Relay', 'disec', eb.node);
    for (const p of [france, relay]) p.node.accept([eb.cert, france.cert, relay.cert]);
    const fmFrance = await add('france', france.node);
    const fmRelay = await add('relay', relay.node, true);
    const fmEb = await add('eb', eb.node);
    net.link('france', 'relay', 'nearby');
    net.link('relay', 'eb', 'wifi');
    await run(sim, 3000);
    const data = bytes(300_000, 5);
    const file = await share(fmFrance, data, 'position-paper.pdf');
    const dm = sendDm(france.node, 'disec', france.node.key, 'My position paper', file);
    await run(sim, 5000);
    fmEb.want(file.att.id);
    await run(sim, 30_000);
    expect(fmRelay.status(file.att.id)!.done).toBe(true);
    expect(fileOf(relay.node, relay.node.replica.store.get(dm.id)!)).toBeNull();
    const ebView = fileOf(eb.node, eb.node.replica.store.get(dm.id)!)!;
    expect(ebView.meta.name).toBe('position-paper.pdf');
    expect(await fmEb.read(ebView.att, ebView.meta)).toEqual(data);
  }, 60_000);

  it('doesn’t fetch files over the committee’s limit', async () => {
    const { sim, net, t, add } = fileWorld();
    const eb = t.person('eb', 'Chair', 'disec');
    eb.node.accept([eb.cert]);
    const france = t.person('delegate', 'France', 'disec', eb.node);
    france.node.accept([eb.cert, france.cert]);
    const rules = setFileRules(eb.node, 'disec', { maxMB: 1, block: ['exe'] });
    deliver([france.node], [rules]);
    expect(fileRules(france.node.replica, 'disec')).toEqual({ maxMB: 1, block: ['exe'] });
    const fmFrance = await add('france', france.node);
    const fmEb = await add('eb', eb.node, true);
    net.link('france', 'eb', 'wifi');
    await run(sim, 2000);
    const big = await share(fmFrance, bytes(2 * 1024 * 1024));
    // A modified app could still post it; everyone else just won't fetch it.
    post(france.node, 'disec', 'too big', { file: big });
    const exe = await share(fmFrance, bytes(1000), 'virus.exe');
    post(france.node, 'disec', 'blocked type', { file: exe });
    await run(sim, 20_000);
    expect(fmEb.status(big.att.id)!.have).toBe(0);
    expect(fmEb.status(exe.att.id)!.have).toBe(0);
  }, 60_000);

  it('rejects a chunk that doesn’t match its hash', async () => {
    const { sim, net, t, add } = fileWorld();
    const eb = t.person('eb', 'Chair', 'disec');
    eb.node.accept([eb.cert]);
    const fmEb = await add('eb', eb.node);
    const liarId = createIdentity();
    const liar = new MeshNode({ conf: t.conf, identity: liarId, subs: ALL, now: () => sim.now, crypto });
    liar.accept([eb.cert, issueCert(eb.node, certFor(publicKeys(liarId), 'delegate', 'Liar', 'disec'))]);
    net.add('liar', liar);
    // The liar answers every request with junk.
    liar.onWire((peer, msg) => {
      if (msg.t === 'want') for (const id of msg.c) liar.sendTo(peer, { t: 'chunk', id, d: 'AAAA' });
    });
    net.link('liar', 'eb', 'wifi');
    await run(sim, 2000);
    const { att, key } = encryptFile(crypto, bytes(1000));
    const e = post(liar, 'disec', 'file', { file: { att, key, name: 'a.pdf', mime: '' } });
    await run(sim, 3000);
    fmEb.want(att.id);
    await run(sim, 10_000);
    expect(fmEb.status(att.id)!.have).toBe(0);
    expect((e as Event).id).toBeTruthy();
  }, 30_000);
});
