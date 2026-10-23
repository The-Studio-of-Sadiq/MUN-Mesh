import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { Crypto } from './index';

// DER prefixes that turn a raw 32-byte Ed25519 key into a key Node accepts.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Native Ed25519 and SHA-256 for Node and Electron (hubs verify every event
 * that passes through them). Same results as `nobleCrypto`, roughly 20× faster.
 */
export function createNodeCrypto(): Crypto {
  const publicKeys = new Map<string, KeyObject>();
  const secretKeys = new Map<string, KeyObject>();
  const publicKey = (raw: Uint8Array) => {
    const id = Buffer.from(raw).toString('base64');
    let key = publicKeys.get(id);
    if (!key) {
      if (publicKeys.size > 10_000) publicKeys.clear();
      key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
      publicKeys.set(id, key);
    }
    return key;
  };
  const secretKey = (raw: Uint8Array) => {
    const id = Buffer.from(raw).toString('base64');
    let key = secretKeys.get(id);
    if (!key) {
      key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
      secretKeys.set(id, key);
    }
    return key;
  };
  return {
    sha256: (data) => new Uint8Array(createHash('sha256').update(data).digest()),
    sign: (message, secret) => new Uint8Array(sign(null, message, secretKey(secret))),
    verify: (signature, message, pub) => {
      if (pub.length !== 32 || signature.length !== 64) return false;
      try {
        return verify(null, message, publicKey(pub), signature);
      } catch {
        return false;
      }
    },
  };
}
