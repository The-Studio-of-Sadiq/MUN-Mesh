import { issueCert, certFor } from './actions';
import { publicKeys, newConference } from './conference';
import { createIdentity, type Crypto, type Identity } from './crypto';
import { MeshNode } from './node';
import { ALL, type Conference, type Event, type Role } from './types';

/** A small conference for tests: Secretariat root plus helpers to add certified people. */
export function testConference(opts: { crypto?: Crypto; now?: () => number; committees?: string[] } = {}) {
  const committees = (opts.committees ?? ['disec', 'unsc']).map((id) => ({ id, name: id.toUpperCase() }));
  const { conf, root } = newConference('Test MUN', committees, 1_700_000_000_000);
  const clock = { t: 1_700_000_100_000 };
  const now = opts.now ?? (() => clock.t);
  const node = (identity: Identity, subs: string[] | typeof ALL) =>
    new MeshNode({ conf, identity, subs, now, crypto: opts.crypto });
  const sec = node(root, ALL);

  /**
   * A new device with a cert, issued by `issuer` (the Secretariat by default).
   * Returns the node and the events it needs to know who it is.
   */
  function person(role: Role, name: string, com?: string, issuer: MeshNode = sec) {
    const identity = createIdentity();
    const subs = role === 'eb' || role === 'secretariat' ? ALL : [com!];
    const n = node(identity, subs);
    const cert = issueCert(issuer, certFor(publicKeys(identity), role, name, com));
    return { node: n, cert, identity };
  }

  return { conf: conf as Conference, root, sec, clock, node, person };
}

/** Hands each event to each node, like a perfect network. */
export function deliver(nodes: MeshNode[], events: Event[]): void {
  for (const n of nodes) n.accept(events);
}
