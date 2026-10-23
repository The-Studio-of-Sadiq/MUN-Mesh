import { fromB64, toB64, type B64 } from './bytes';
import { contentKeyFor, open, openWithKey, seal, unwrapKey, wrapKey, type Sealed } from './crypto';
import type { MeshNode } from './node';
import type { Authority } from './permissions';
import { EB_SCOPE, GLOBAL, type CertBody, type ChitContent, type Event, type Role } from './types';
import type { ChitState } from './view';

// What the apps call. Each builds the event body (sealing it where needed)
// and publishes through the node.

export function issueCert(node: MeshNode, cert: Omit<CertBody, 'com'> & { com?: string }): Event<'cert'> {
  const staff = cert.role === 'secretariat' || cert.role === 'eb';
  return node.publish(staff ? GLOBAL : cert.com!, 'cert', cert);
}

/** Cert fields for a device, from its identity's public keys (e.g. scanned from its join QR). */
export function certFor(device: { sign: B64; box: B64 }, role: Role, name: string, com?: string): CertBody {
  return { sub: device.sign, box: device.box, role, name, ...(com ? { com } : {}) };
}

export const post = (node: MeshNode, scope: string, text: string, re?: B64) =>
  node.publish(scope, 'post', re ? { text, re } : { text });

export const announce = (node: MeshNode, scope: string, text: string) => node.publish(scope, 'announce', { text });

/** Box keys of a committee's current EB, plus the Secretariat root. */
export function moderatorBoxes(auth: Authority, com: string): B64[] {
  const out = [auth.conf.rootBox];
  for (const m of auth.all()) if (m.role === 'eb' && m.com === com) out.push(m.box);
  return out;
}

function sealFor(node: MeshNode, body: unknown, boxes: B64[]): Sealed {
  const recipients = [...boxes, toB64(node.identity.box.pub)].map(fromB64);
  return seal(body, recipients).sealed;
}

/** A chit goes to the EB first; the recipient can read it only once the EB approves it. */
export function sendChit(node: MeshNode, com: string, to: B64, text: string): Event<'chit'> {
  const content: ChitContent = { to, text };
  return node.publish(com, 'chit', { sealed: sealFor(node, content, moderatorBoxes(node.replica.auth, com)) });
}

export type ChitDecisionError = 'cannotOpen' | 'unknownRecipient';

/** EB: approve a chit by handing its content key to the recipient. */
export function approveChit(node: MeshNode, chit: Event<'chit'>): Event<'chitOk'> | ChitDecisionError {
  const key = contentKeyFor(chit.b.sealed, node.identity.box);
  const content = key && openWithKey<ChitContent>(chit.b.sealed, key);
  if (!key || !content) return 'cannotOpen';
  const recipient = node.replica.auth.member(content.to);
  if (!recipient) return 'unknownRecipient';
  return node.publish(chit.s, 'chitOk', { chit: chit.id, key: wrapKey(key, fromB64(recipient.box)) });
}

export const rejectChit = (node: MeshNode, chit: Event<'chit'>) => node.publish(chit.s, 'chitNo', { chit: chit.id });

/**
 * A chit's content as this device may see it: the sender and the EB always,
 * the recipient once it's approved. Null otherwise.
 */
export function readChit(node: MeshNode, state: ChitState): ChitContent | null {
  const direct = open<ChitContent>(state.chit.b.sealed, node.identity.box);
  if (direct) return direct;
  if (state.decision?.k !== 'chitOk') return null;
  const ok = state.decision as Event<'chitOk'>;
  if (ok.b.key.to !== toB64(node.identity.box.pub)) return null;
  const key = unwrapKey(ok.b.key, node.identity.box);
  return key ? openWithKey<ChitContent>(state.chit.b.sealed, key) : null;
}

/** Delegate↔EB private message. `withKey` is the delegate's signing key (the thread). */
export function sendDm(node: MeshNode, com: string, withKey: B64, text: string): Event<'dm'> {
  const auth = node.replica.auth;
  const delegate = auth.member(withKey);
  const boxes = moderatorBoxes(auth, com);
  if (delegate) boxes.push(delegate.box);
  return node.publish(com, 'dm', { with: withKey, sealed: sealFor(node, { text }, boxes) });
}

/** EB-to-EB channel, sealed to every EB and Secretariat device known. */
export function ebPost(node: MeshNode, text: string): Event<'ebpost'> {
  const boxes = node.replica.auth
    .all()
    .filter((m) => m.role === 'eb' || m.role === 'secretariat')
    .map((m) => m.box);
  return node.publish(EB_SCOPE, 'ebpost', { sealed: sealFor(node, { text }, boxes) });
}

export const readSealed = <T = { text: string }>(node: MeshNode, e: Event<'dm' | 'ebpost'>): T | null =>
  open<T>(e.b.sealed, node.identity.box);

/** Mute from the delegate's next message on (by what this device has seen of them). */
export const mute = (node: MeshNode, com: string, sub: B64) =>
  node.publish(com, 'mute', { sub, from: node.replica.store.maxSeq(com, sub) + 1 });

export const unmute = (node: MeshNode, com: string, sub: B64) =>
  node.publish(com, 'unmute', { sub, from: node.replica.store.maxSeq(com, sub) + 1 });

/**
 * Remove a device. Its messages up to now stay; everything after is refused
 * by every device. EB kick in their committee scope; Secretariat in global.
 */
export function kick(node: MeshNode, scope: string, sub: B64): Event<'revoke'> {
  const from: Record<string, number> = {};
  for (const s of node.replica.store.scopes()) {
    const seen = node.replica.store.maxSeq(s, sub);
    if (seen > 0) from[s] = seen + 1;
  }
  return node.publish(scope, 'revoke', { sub, from });
}

export const lock = (node: MeshNode, com: string, on: boolean) => node.publish(com, 'lock', { on });
export const slowMode = (node: MeshNode, com: string, sec: number) => node.publish(com, 'slow', { sec });
export const pin = (node: MeshNode, scope: string, ev: B64, on = true) => node.publish(scope, 'pin', { ev, on });
