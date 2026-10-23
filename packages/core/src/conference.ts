import { toB64 } from './bytes';
import { createIdentity, type Identity } from './crypto';
import { checkConference } from './event';
import type { Committee, Conference } from './types';

/**
 * Run once on the Secretariat's laptop. The returned identity is the root of
 * trust: keep it backed up, because losing it means no new EB can be added.
 */
export function newConference(name: string, committees: Committee[], now: number): { conf: Conference; root: Identity } {
  const root = createIdentity();
  const conf: Conference = { name, root: toB64(root.sign.pub), rootBox: toB64(root.box.pub), committees, created: now };
  checkConference(conf);
  return { conf, root };
}

/** The public half of an identity, as shown in a device's join QR code. */
export const publicKeys = (id: Identity) => ({ sign: toB64(id.sign.pub), box: toB64(id.box.pub) });
