/** Raw bytes; keys, signatures and ciphertext. */
export type Bytes = Uint8Array;
/** Bytes as unpadded base64url, the form they take in events and on the wire. */
export type B64 = string;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function toB64(bytes: Bytes): B64 {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/** Throws on anything that is not unpadded base64url. */
export function fromB64(text: B64): Bytes {
  if (text.length % 4 === 1) throw new Error('bad base64url length');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const digit = code < 128 ? LOOKUP[code]! : -1;
    if (digit < 0) throw new Error('bad base64url character');
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

// Some phone JS engines lack TextDecoder (and older ones TextEncoder); fall back to plain code.
const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
const decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }) : null;
export const utf8 = (text: string): Bytes => (encoder ? encoder.encode(text) : encodeUtf8(text));
export const fromUtf8 = (bytes: Bytes): string => (decoder ? decoder.decode(bytes) : decodeUtf8(bytes));

function encodeUtf8(text: string): Bytes {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** Strict: throws on malformed input, like TextDecoder with `fatal`. */
function decodeUtf8(bytes: Bytes): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    const need = b < 0x80 ? 0 : b >= 0xf0 && b < 0xf5 ? 3 : b >= 0xe0 ? 2 : b >= 0xc2 && b < 0xe0 ? 1 : -1;
    if (need < 0 || i + need >= bytes.length + (need === 0 ? 1 : 0)) throw new Error('bad utf-8');
    let c = need === 0 ? b : b & (0x3f >> need);
    for (let k = 1; k <= need; k++) {
      const next = bytes[i + k]!;
      if ((next & 0xc0) !== 0x80) throw new Error('bad utf-8');
      c = (c << 6) | (next & 63);
    }
    if ((need === 2 && c < 0x800) || (need === 3 && (c < 0x10000 || c > 0x10ffff)) || (c >= 0xd800 && c <= 0xdfff)) {
      throw new Error('bad utf-8');
    }
    out += String.fromCodePoint(c);
    i += need + 1;
  }
  return out;
}

/** Exposed for tests of the fallback path. */
export const _utf8Fallback = { encodeUtf8, decodeUtf8 };

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * JSON with object keys sorted, so every device serialises the same value to
 * the same bytes. Signatures and event ids are computed over this.
 * Only plain JSON values are allowed (no undefined, NaN or class instances).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as object)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  throw new Error(`cannot encode ${typeof value}`);
}
