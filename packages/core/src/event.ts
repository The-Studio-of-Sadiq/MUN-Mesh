import { canonicalJson, fromB64, toB64, utf8, type B64 } from './bytes';
import type { Crypto, Identity, Sealed, Wrapped } from './crypto';
import type { Hlc } from './hlc';
import {
  ALL,
  CHUNK_SIZE,
  EB_SCOPE,
  GLOBAL,
  HARD_MAX_FILE_MB,
  MAX_TEXT,
  type Attachment,
  type Bodies,
  type Conference,
  type Event,
  type FileMeta,
  type Kind,
} from './types';

const KEY_CHARS = 43; // 32 bytes in base64url
const ID_BYTES = 18;

export function conferenceId(conf: Conference, crypto: Crypto): string {
  return toB64(crypto.sha256(utf8(canonicalJson(conf))).subarray(0, 12));
}

/** Throws if the conference can't work (bad keys, reserved or duplicate committee ids). */
export function checkConference(conf: Conference): void {
  if (fromB64(conf.root).length !== 32 || fromB64(conf.rootBox).length !== 32) throw new Error('bad root key');
  const ids = new Set<string>();
  for (const c of conf.committees) {
    if (!/^[a-z0-9-]{1,24}$/.test(c.id)) throw new Error(`bad committee id "${c.id}"`);
    if (c.id === GLOBAL || c.id === EB_SCOPE || ids.has(c.id)) throw new Error(`committee id "${c.id}" is taken`);
    ids.add(c.id);
  }
}

/** The bytes an event's signature covers; binding the conference id stops replay into another conference. */
function signedBytes(conf: string, e: Omit<Event, 'id' | 'sig'>): Uint8Array {
  return utf8(canonicalJson({ c: conf, a: e.a, s: e.s, n: e.n, h: e.h, k: e.k, b: e.b }));
}

export function createEvent<K extends Kind>(
  crypto: Crypto,
  conf: string,
  identity: Identity,
  fields: { s: string; n: number; h: Hlc; k: K; b: Bodies[K] },
): Event<K> {
  const unsigned = { a: toB64(identity.sign.pub), ...fields };
  const bytes = signedBytes(conf, unsigned);
  const sig = crypto.sign(bytes, identity.sign.secret);
  return { id: toB64(crypto.sha256(bytes).subarray(0, ID_BYTES)), ...unsigned, sig: toB64(sig) };
}

/**
 * Why an event received from the network is unusable, or null if its shape,
 * id and signature are all valid. Says nothing about whether the author may
 * post it; that's `authorize` in permissions.
 */
export type EventProblem = 'malformed' | 'badBody' | 'badId' | 'badSignature';

export function checkEvent(crypto: Crypto, conf: string, raw: unknown): EventProblem | null {
  if (!isEventShape(raw)) return 'malformed';
  const e = raw;
  if (!validBody(e.k, e.b)) return 'badBody';
  let bytes: Uint8Array;
  let author: Uint8Array;
  let sig: Uint8Array;
  try {
    bytes = signedBytes(conf, e);
    author = fromB64(e.a);
    sig = fromB64(e.sig);
  } catch {
    return 'malformed';
  }
  if (toB64(crypto.sha256(bytes).subarray(0, ID_BYTES)) !== e.id) return 'badId';
  return crypto.verify(sig, bytes, author) ? null : 'badSignature';
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isKey = (v: unknown): v is B64 => typeof v === 'string' && v.length === KEY_CHARS;
const isId = (v: unknown): v is B64 => typeof v === 'string' && v.length === 24;
const isSeq = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT;
const isWrapped = (v: unknown): v is Wrapped => isObj(v) && isKey(v.to) && typeof v.w === 'string' && v.w.length < 200;
const isAttachment = (v: unknown): v is Attachment =>
  isObj(v) &&
  isId(v.id) &&
  Number.isSafeInteger(v.size) &&
  (v.size as number) > 0 &&
  (v.size as number) <= HARD_MAX_FILE_MB * 1024 * 1024 &&
  Array.isArray(v.chunks) &&
  v.chunks.length === Math.ceil((v.size as number) / CHUNK_SIZE) &&
  v.chunks.every(isId);
export const isFileMeta = (v: unknown): v is FileMeta =>
  isObj(v) && typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 200 && typeof v.mime === 'string' && v.mime.length <= 100 && isKey(v.key);
const isSealed = (v: unknown): v is Sealed =>
  isObj(v) && Array.isArray(v.keys) && v.keys.length <= 200 && v.keys.every(isWrapped) && typeof v.ct === 'string';

const KINDS = new Set<string>([
  'cert', 'revoke', 'mute', 'unmute', 'lock', 'slow', 'pin', 'rules', 'post', 'announce', 'chit', 'chitOk', 'chitNo', 'dm', 'ebpost',
]);

function isEventShape(v: unknown): v is Event {
  return (
    isObj(v) &&
    isId(v.id) &&
    isKey(v.a) &&
    typeof v.s === 'string' &&
    v.s.length <= 24 &&
    v.s !== ALL &&
    isSeq(v.n) &&
    isObj(v.h) &&
    Number.isSafeInteger(v.h.t) &&
    Number.isSafeInteger(v.h.c) &&
    (v.h.c as number) >= 0 &&
    typeof v.k === 'string' &&
    KINDS.has(v.k) &&
    isObj(v.b) &&
    typeof v.sig === 'string'
  );
}

/** Shape check for each kind's body, so a hostile device can't crash anyone's view. */
export function validBody(kind: Kind, b: unknown): boolean {
  if (!isObj(b)) return false;
  switch (kind) {
    case 'cert':
      return (
        isKey(b.sub) &&
        isKey(b.box) &&
        (b.role === 'secretariat' || b.role === 'eb' || b.role === 'delegate' || b.role === 'observer') &&
        (b.com === undefined || typeof b.com === 'string') &&
        typeof b.name === 'string' &&
        b.name.length > 0 &&
        b.name.length <= 80
      );
    case 'revoke':
      return isKey(b.sub) && isObj(b.from) && Object.values(b.from).every(isSeq);
    case 'mute':
    case 'unmute':
      return isKey(b.sub) && isSeq(b.from);
    case 'lock':
      return typeof b.on === 'boolean';
    case 'slow':
      return Number.isSafeInteger(b.sec) && (b.sec as number) >= 0 && (b.sec as number) <= 3600;
    case 'pin':
      return isId(b.ev) && typeof b.on === 'boolean';
    case 'rules':
      return (
        Number.isSafeInteger(b.maxMB) &&
        (b.maxMB as number) >= 1 &&
        (b.maxMB as number) <= HARD_MAX_FILE_MB &&
        Array.isArray(b.block) &&
        b.block.length <= 50 &&
        b.block.every((x) => typeof x === 'string' && /^[a-z0-9]{1,10}$/.test(x))
      );
    case 'post':
    case 'announce':
      // A file's meta and chunk list come together; text may be empty only with a file.
      if ((b.att === undefined) !== (b.file === undefined)) return false;
      if (b.att !== undefined && !(isAttachment(b.att) && isFileMeta(b.file))) return false;
      return (isText(b.text) || (b.text === '' && b.att !== undefined)) && (b.re === undefined || isId(b.re));
    case 'chit':
      return isSealed(b.sealed);
    case 'ebpost':
      return isSealed(b.sealed) && (b.att === undefined || isAttachment(b.att));
    case 'chitOk':
      return isId(b.chit) && isWrapped(b.key);
    case 'chitNo':
      return isId(b.chit);
    case 'dm':
      return isKey(b.with) && isSealed(b.sealed) && (b.att === undefined || isAttachment(b.att));
  }
}
