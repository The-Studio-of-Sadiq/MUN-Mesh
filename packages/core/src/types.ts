import type { B64 } from './bytes';
import type { Sealed, Wrapped } from './crypto';
import type { Hlc } from './hlc';

/**
 * Created once by the Secretariat. Its hash is the conference id; every
 * device gets it from the join QR code (or roster file) and trusts the root
 * key in it, and nothing else, as the source of authority.
 */
export interface Conference {
  name: string;
  /** Secretariat root signing key. */
  root: B64;
  /** Root's box key, so sealed EB messages can include the Secretariat. */
  rootBox: B64;
  committees: Committee[];
  /** Epoch ms; makes two conferences with the same name distinct. */
  created: number;
}

export interface Committee {
  /** Short id used as the committee's scope, e.g. "disec". */
  id: string;
  name: string;
}

/**
 * Every event lives in one scope, and each device keeps the scopes it
 * subscribes to: its committee and `global`; hubs and bridges keep all.
 */
export const GLOBAL = 'global';
/** EB-to-EB channel across committees. Only EB and Secretariat devices keep it. */
export const EB_SCOPE = 'eb';
/** Subscribe to every scope: hubs (EB laptops) and bridge devices. */
export const ALL = '*';

/**
 * secretariat: runs the conference; can do anything anywhere.
 * eb: chair / co-chair / rapporteur of one committee; moderates it.
 * delegate: speaks for a country in one committee.
 * observer: reads the committee channel (press, faculty).
 */
export type Role = 'secretariat' | 'eb' | 'delegate' | 'observer';

export const MAX_TEXT = 4000;

export interface CertBody {
  /** The certified device's signing key. */
  sub: B64;
  /** Its box key, for messages sealed to it. */
  box: B64;
  role: Role;
  /** Committee id; required for eb, delegate and observer. */
  com?: string;
  /** Display name: country for delegates, person's name for EB. */
  name: string;
}

export interface RevokeBody {
  sub: B64;
  /**
   * Per scope, the first sequence number to drop. The revoker sets it from
   * what they had seen, so earlier messages stay and anything later is
   * refused everywhere. Scopes missing here drop everything.
   */
  from: Record<string, number>;
}

/**
 * Lock or unlock the committee channel for delegates. `from`: per delegate,
 * the first sequence number it applies to (what the EB had seen of them, plus
 * one), so a delegate can't dodge it by backdating a post. Delegates not listed
 * are covered from their first post. Locks without `from` fall back to timestamps.
 */
export interface LockBody {
  on: boolean;
  from?: Record<B64, number>;
}

/** `from`: first sequence number (in this committee's scope) the change applies to. */
export interface MuteBody {
  sub: B64;
  from: number;
}

// ── Files ──
// A file is encrypted with its own random key and split into chunks named by
// the hash of their ciphertext, so any device can check and relay a chunk
// without reading it. The event carries the chunk list (`Attachment`); the
// name, type and key (`FileMeta`) sit in the body of a public post, or inside
// the sealed content of a private one.

export const CHUNK_SIZE = 256 * 1024;
/** Per-file limit unless a committee's EB sets another (up to the hard limit). */
export const DEFAULT_MAX_FILE_MB = 25;
export const HARD_MAX_FILE_MB = 100;

export interface Attachment {
  /** Hash of the size and chunk list; names the file everywhere. */
  id: B64;
  /** Bytes before encryption. */
  size: number;
  /** Chunk ids in order. */
  chunks: B64[];
}

export interface FileMeta {
  name: string;
  /** MIME type, e.g. "application/pdf"; may be empty if unknown. */
  mime: string;
  /** The file key. */
  key: B64;
}

export interface PostBody {
  /** May be empty when the post is just a file. */
  text: string;
  /** Event id this replies to. */
  re?: string;
  att?: Attachment;
  file?: FileMeta;
}

export interface SealedBody {
  sealed: Sealed;
  /** Chunk list of a file whose name and key are inside the sealed content (`SealedContent.file`). */
  att?: Attachment;
}

/** What a sealed DM or EB message opens to. */
export interface SealedContent {
  text: string;
  file?: FileMeta;
}

export interface PingBody {
  /** Names the test run, so runs on the same day don't mix. */
  test: string;
  seq: number;
}

export interface ReportBody {
  test: string;
  /** Pings received since the last report: [seq, ms from sending to arrival, by this device's clock]. */
  got: [number, number][];
  /** Links right now, over the network and over Nearby. */
  tcp: number;
  nearby: number;
  /** Events this device holds. */
  stored: number;
  /** "android", "ios", "windows" or "web". */
  platform: string;
  relay: boolean;
}

/** A committee's file rules, set by its EB. */
export interface RulesBody {
  maxMB: number;
  /** Blocked file extensions, lower case without the dot, e.g. ["exe", "apk"]. */
  block: string[];
}

/** Sealed to the committee's EB and the sender. Opens to `ChitContent`. */
export type ChitBody = SealedBody;
export interface ChitContent {
  /** Recipient delegate's signing key. */
  to: B64;
  text: string;
}

export interface ChitOkBody {
  chit: B64;
  /** The chit's content key, wrapped for the recipient. */
  key: Wrapped;
}

/** Private thread between one delegate and the committee's EB. Opens to `SealedContent`. */
export interface DmBody extends SealedBody {
  /** The delegate's signing key (the thread). */
  with: B64;
}

export interface Bodies {
  cert: CertBody;
  revoke: RevokeBody;
  mute: MuteBody;
  unmute: MuteBody;
  lock: LockBody;
  /** Seconds between a delegate's posts; 0 turns it off. */
  slow: { sec: number };
  pin: { ev: B64; on: boolean };
  rules: RulesBody;
  /** Field test: a numbered ping from the Secretariat, every few seconds while a test runs. */
  ping: PingBody;
  /** Field test: what one device saw since its last report. */
  report: ReportBody;
  post: PostBody;
  announce: PostBody;
  chit: ChitBody;
  chitOk: ChitOkBody;
  chitNo: { chit: B64 };
  dm: DmBody;
  /** EB-to-EB message, sealed to all EB and Secretariat devices. Opens to `SealedContent`. */
  ebpost: SealedBody;
}

export type Kind = keyof Bodies;

export interface Event<K extends Kind = Kind> {
  /** Hash of the signed fields; identifies the event everywhere. */
  id: B64;
  /** Author's signing key. */
  a: B64;
  /** Scope. */
  s: string;
  /** Author's sequence number in this scope, from 1, no gaps. */
  n: number;
  h: Hlc;
  k: K;
  b: Bodies[K];
  sig: B64;
}
