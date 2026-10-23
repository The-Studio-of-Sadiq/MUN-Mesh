import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { concat, fromB64, fromUtf8, toB64, utf8, type B64, type Bytes } from '../bytes';

/**
 * The few primitives that run on every received event. Pluggable so the
 * Electron hub (and the harness) can use Node's native, much faster code;
 * phones use the portable pure-JS default. Both must agree bit for bit.
 */
export interface Crypto {
  sha256(data: Bytes): Bytes;
  sign(message: Bytes, secretKey: Bytes): Bytes;
  verify(signature: Bytes, message: Bytes, publicKey: Bytes): boolean;
}

export const nobleCrypto: Crypto = {
  sha256: (data) => sha256(data),
  sign: (message, secretKey) => ed25519.sign(message, secretKey),
  // Strict RFC 8032 rules, the same as Node's native verifier, so devices never
  // disagree about which signatures are valid.
  verify: (signature, message, publicKey) => {
    try {
      return ed25519.verify(signature, message, publicKey, { zip215: false });
    } catch {
      return false;
    }
  },
};

/**
 * A device's keys: one pair to sign events, one to receive encrypted ones.
 * Created once on first launch and kept on the device.
 */
export interface Identity {
  sign: { pub: Bytes; secret: Bytes };
  box: { pub: Bytes; secret: Bytes };
}

export function createIdentity(): Identity {
  const sign = ed25519.keygen();
  const box = x25519.keygen();
  return {
    sign: { pub: sign.publicKey, secret: sign.secretKey },
    box: { pub: box.publicKey, secret: box.secretKey },
  };
}

export interface StoredIdentity {
  sign: B64;
  box: B64;
}

/** Only the secret halves are stored; the public keys are derived again. */
export const saveIdentity = (id: Identity): StoredIdentity => ({ sign: toB64(id.sign.secret), box: toB64(id.box.secret) });

export function loadIdentity(stored: StoredIdentity): Identity {
  const signSecret = fromB64(stored.sign);
  const boxSecret = fromB64(stored.box);
  return {
    sign: { pub: ed25519.getPublicKey(signSecret), secret: signSecret },
    box: { pub: x25519.getPublicKey(boxSecret), secret: boxSecret },
  };
}

// ── Sealed messages ──────────────────────────────────────────────────────────
// A body encrypted once with a random content key, and that key wrapped for
// each recipient's box key. An EB approving a chit re-wraps the same content
// key for the recipient without re-encrypting the message.

const NONCE = 24;
const WRAP_INFO = utf8('mun/wrap/v1');

export interface Wrapped {
  /** Recipient's box public key. */
  to: B64;
  /** Ephemeral X25519 public key ‖ nonce ‖ wrapped content key. */
  w: B64;
}

export interface Sealed {
  keys: Wrapped[];
  /** nonce ‖ XChaCha20-Poly1305 ciphertext of the JSON body. */
  ct: B64;
}

export function wrapKey(contentKey: Bytes, recipientBoxPub: Bytes): Wrapped {
  const eph = x25519.keygen();
  const shared = x25519.getSharedSecret(eph.secretKey, recipientBoxPub);
  const kek = hkdf(sha256, shared, concat(eph.publicKey, recipientBoxPub), WRAP_INFO, 32);
  const nonce = randomBytes(NONCE);
  const ct = xchacha20poly1305(kek, nonce).encrypt(contentKey);
  return { to: toB64(recipientBoxPub), w: toB64(concat(eph.publicKey, nonce, ct)) };
}

/** Returns null when the key isn't for us or was tampered with. */
export function unwrapKey(wrapped: Wrapped, box: Identity['box']): Bytes | null {
  try {
    const raw = fromB64(wrapped.w);
    const ephPub = raw.subarray(0, 32);
    const nonce = raw.subarray(32, 32 + NONCE);
    const shared = x25519.getSharedSecret(box.secret, ephPub);
    const kek = hkdf(sha256, shared, concat(ephPub, box.pub), WRAP_INFO, 32);
    return xchacha20poly1305(kek, nonce).decrypt(raw.subarray(32 + NONCE));
  } catch {
    return null;
  }
}

export function seal(body: unknown, recipientBoxPubs: Bytes[]): { sealed: Sealed; contentKey: Bytes } {
  const contentKey = randomBytes(32);
  const nonce = randomBytes(NONCE);
  const ct = xchacha20poly1305(contentKey, nonce).encrypt(utf8(JSON.stringify(body)));
  const seen = new Set<string>();
  const keys: Wrapped[] = [];
  for (const pub of recipientBoxPubs) {
    const id = toB64(pub);
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push(wrapKey(contentKey, pub));
  }
  return { sealed: { keys, ct: toB64(concat(nonce, ct)) }, contentKey };
}

export function openWithKey<T = unknown>(sealed: Sealed, contentKey: Bytes): T | null {
  try {
    const raw = fromB64(sealed.ct);
    const plain = xchacha20poly1305(contentKey, raw.subarray(0, NONCE)).decrypt(raw.subarray(NONCE));
    return JSON.parse(fromUtf8(plain)) as T;
  } catch {
    return null;
  }
}

/** The content key, if one of the wrapped keys is ours. */
export function contentKeyFor(sealed: Sealed, box: Identity['box']): Bytes | null {
  const me = toB64(box.pub);
  const mine = sealed.keys.find((k) => k.to === me);
  return mine ? unwrapKey(mine, box) : null;
}

export function open<T = unknown>(sealed: Sealed, box: Identity['box']): T | null {
  const key = contentKeyFor(sealed, box);
  return key ? openWithKey<T>(sealed, key) : null;
}
