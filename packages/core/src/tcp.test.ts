import { afterEach, describe, expect, it } from 'vitest';
import { certFor, issueCert, post } from './actions';
import { newConference, publicKeys } from './conference';
import { createIdentity, type Identity } from './crypto';
import { createNodeCrypto } from './crypto/node';
import { attachSocket, Device, type SocketLike, type Transport } from './device';
import { MeshNode, type Wire } from './node';
import { nodeTransport } from './transport-node';
import { ALL, type Event } from './types';

const crypto = createNodeCrypto();
/** Real TCP on localhost; hubs advertise 127.0.0.1 only, so the test decides who can reach whom. */
const local: Transport = { ...nodeTransport, localAddresses: async () => ['127.0.0.1'] };
const hidden: Transport = { ...nodeTransport, localAddresses: async () => [] };

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function waitFor(cond: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function conference() {
  const { conf, root } = newConference('TCP MUN', [{ id: 'disec', name: 'DISEC' }, { id: 'unsc', name: 'UNSC' }], 1);
  const node = (identity: Identity, subs: string[] | typeof ALL) => new MeshNode({ conf, identity, subs, now: Date.now, crypto });
  async function device(identity: Identity, subs: string[] | typeof ALL, opts: { listen: boolean; transport?: Transport; maxOutbound?: number }) {
    const d = new Device({
      node: node(identity, subs),
      transport: opts.transport ?? local,
      listenPort: opts.listen ? 0 : null,
      maxOutbound: opts.maxOutbound ?? 8,
    });
    await d.start();
    cleanups.push(() => d.stop());
    return d;
  }
  const addr = (d: Device) => `127.0.0.1:${d.port}`;
  // One Secretariat device: two devices signing with the root key would fork its log.
  const sec = node(root, ALL);
  return { conf, root, node, device, addr, sec };
}

/** A hub (EB laptop) certified by the Secretariat. */
async function hub(c: ReturnType<typeof conference>, com: string, transport = local) {
  const id = createIdentity();
  const d = await c.device(id, ALL, { listen: true, transport });
  d.node.accept([issueCert(c.sec, certFor(publicKeys(id), 'eb', `${com} chair`, com))]);
  return d;
}

const has = (d: Device, e: Event) => d.node.replica.store.has(e.id);

describe('line framing', () => {
  function fakeSocket() {
    const handlers: Record<string, ((a?: unknown) => void)[]> = { data: [], close: [], error: [] };
    const written: string[] = [];
    let destroyed = false;
    const socket: SocketLike = {
      write: (d) => void written.push(d),
      end: () => {},
      destroy: () => {
        destroyed = true;
        handlers.close!.forEach((h) => h());
      },
      on: ((event: string, cb: (a?: unknown) => void) => void handlers[event]!.push(cb)) as SocketLike['on'],
    };
    return { socket, written, emit: (d: string) => handlers.data!.forEach((h) => h(d)), destroyed: () => destroyed };
  }

  it('reassembles messages split across chunks and cuts off garbage', () => {
    const c = conference();
    const n = c.node(createIdentity(), ['disec']);
    const f = fakeSocket();
    attachSocket(n, 'x', f.socket);
    const hello = JSON.parse(f.written[0]!) as Wire;
    expect(hello.t).toBe('hello');
    const peer = JSON.stringify({ t: 'hello', v: 1, conf: n.replica.confId, node: 'k'.repeat(43), subs: ['disec'] });
    f.emit(peer.slice(0, 10));
    f.emit(`${peer.slice(10)}\n{"t":"sum","s":{}}\n`);
    expect(n.neighbours()).toHaveLength(1);
    f.emit('not json\n');
    expect(f.destroyed()).toBe(true);
    expect(n.neighbours()).toHaveLength(0);
  });
});

describe('devices over TCP', () => {
  it('lets a phone in after the EB approves its request, then carries its messages', async () => {
    const c = conference();
    const chair = await hub(c, 'disec');
    const phoneId = createIdentity();
    const phone = await c.device(phoneId, ['disec'], { listen: false, maxOutbound: 2 });
    phone.addAddress(c.addr(chair), 'invite');
    await waitFor(() => phone.node.neighbours().length === 1);

    phone.node.requestJoin({ name: 'France', role: 'delegate', com: 'disec' });
    await waitFor(() => chair.node.pendingJoins().length === 1);
    const req = chair.node.pendingJoins()[0]!;
    expect(req.name).toBe('France');
    issueCert(chair.node, certFor({ sign: req.sign, box: req.box }, 'delegate', req.name, req.com));
    await waitFor(() => phone.node.replica.auth.roles(phone.node.key).length > 0);
    expect(chair.node.pendingJoins()).toEqual([]);

    const hello = post(phone.node, 'disec', 'Bonjour');
    await waitFor(() => has(chair, hello));
  });

  it('bridges two rooms through a laptop on both networks', async () => {
    const c = conference();
    // Hubs that don't advertise addresses, so nothing but the bridge links the rooms.
    const roomA = await hub(c, 'disec', hidden);
    const roomB = await hub(c, 'unsc', hidden);
    const bridge = await c.device(createIdentity(), ALL, { listen: false });
    bridge.addAddress(c.addr(roomA), 'beacon');
    bridge.addAddress(c.addr(roomB), 'beacon');
    const phoneA = await c.device(createIdentity(), ['disec'], { listen: false });
    phoneA.addAddress(c.addr(roomA), 'invite');
    await waitFor(() => roomA.node.neighbours().length === 2 && roomB.node.neighbours().length === 1);

    const ebNote = post(roomA.node, 'disec', 'Room A to everyone');
    // The Secretariat's laptop is in room B; its notice must reach a phone in room A.
    const announcement = c.sec.publish('global', 'announce', { text: 'Lunch at 1' });
    roomB.node.accept([announcement]);
    await waitFor(() => has(roomB, ebNote) && has(phoneA, announcement));
    expect(roomA.node.neighbours().some((n) => n.node === roomB.node.key)).toBe(false);
  });

  it('keeps one link when two hubs dial each other', async () => {
    const c = conference();
    const a = await hub(c, 'disec');
    const b = await hub(c, 'unsc');
    a.addAddress(c.addr(b), 'beacon');
    b.addAddress(c.addr(a), 'beacon');
    await waitFor(() => a.node.neighbours().length === 1 && b.node.neighbours().length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(a.status().links).toHaveLength(1);
    expect(b.status().links).toHaveLength(1);
  });

  it('reconnects to a hub that restarts and catches up', async () => {
    const c = conference();
    const chair = await hub(c, 'disec');
    const cochairId = createIdentity();
    const cochair = await c.device(cochairId, ALL, { listen: true });
    cochair.node.accept(chair.node.replica.store.events('global'));
    cochair.node.accept([issueCert(c.sec, certFor(publicKeys(cochairId), 'eb', 'co-chair', 'disec'))]);
    chair.addAddress(c.addr(cochair), 'beacon');
    const phone = await c.device(createIdentity(), ['disec'], { listen: false, maxOutbound: 2 });
    phone.addAddress(c.addr(chair), 'invite');
    // The chair's hello lists its own addresses; the phone keeps them for reconnecting.
    await waitFor(() => phone.node.neighbours().length === 1);
    expect(phone.status().known.map((k) => k.addr)).toContain(c.addr(chair));

    // The chair's laptop restarts on the same port; the phone redials and catches up.
    const port = chair.port!;
    chair.stop();
    await waitFor(() => phone.node.neighbours().length === 0);
    const restarted = new Device({ node: chair.node, transport: local, listenPort: port, maxOutbound: 8 });
    await restarted.start();
    cleanups.push(() => restarted.stop());
    const missed = post(restarted.node, 'disec', 'Back online');
    await waitFor(() => has(phone, missed), 10_000);
  });
});
