import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { canonicalJson, fromB64, toB64, utf8, type B64, type Bytes } from './bytes';
import type { Crypto } from './crypto';
import { compareHlc } from './hlc';
import type { FileWire, MeshNode } from './node';
import { authorize } from './permissions';
import type { Replica } from './replica';
import { ALL, CHUNK_SIZE, DEFAULT_MAX_FILE_MB, type Attachment, type Event, type FileMeta, type RulesBody } from './types';

const ID_BYTES = 18;

// ── Encryption ──

/** Chunk i's nonce: the index, big-endian, at the end of 24 bytes. Keys are never reused across files. */
function nonceFor(index: number): Bytes {
  const n = new Uint8Array(24);
  new DataView(n.buffer).setUint32(20, index);
  return n;
}

export const chunkId = (crypto: Crypto, ct: Bytes): B64 => toB64(crypto.sha256(ct).subarray(0, ID_BYTES));

export function attachmentId(crypto: Crypto, size: number, chunks: B64[]): B64 {
  return toB64(crypto.sha256(utf8(canonicalJson({ size, chunks }))).subarray(0, ID_BYTES));
}

/** Encrypts a file with a fresh key and splits it into chunks named by their hash. */
export function encryptFile(crypto: Crypto, data: Bytes): { att: Attachment; key: B64; chunks: Map<B64, Bytes> } {
  if (data.length === 0) throw new Error('empty file');
  const key = randomBytes(32);
  const chunks = new Map<B64, Bytes>();
  const ids: B64[] = [];
  for (let i = 0, off = 0; off < data.length; i++, off += CHUNK_SIZE) {
    const ct = xchacha20poly1305(key, nonceFor(i)).encrypt(data.subarray(off, off + CHUNK_SIZE));
    const id = chunkId(crypto, ct);
    ids.push(id);
    chunks.set(id, ct);
  }
  return { att: { id: attachmentId(crypto, data.length, ids), size: data.length, chunks: ids }, key: toB64(key), chunks };
}

/** Joins and decrypts a file. Null if a chunk is missing or doesn't decrypt. */
export async function assembleFile(att: Attachment, key: B64, get: (id: B64) => Promise<Bytes | null>): Promise<Bytes | null> {
  const out = new Uint8Array(att.size);
  const k = fromB64(key);
  let off = 0;
  for (let i = 0; i < att.chunks.length; i++) {
    const ct = await get(att.chunks[i]!);
    if (!ct) return null;
    let pt: Bytes;
    try {
      pt = xchacha20poly1305(k, nonceFor(i)).decrypt(ct);
    } catch {
      return null;
    }
    if (off + pt.length > att.size) return null;
    out.set(pt, off);
    off += pt.length;
  }
  return off === att.size ? out : null;
}

// ── Rules ──

export const DEFAULT_RULES: RulesBody = { maxMB: DEFAULT_MAX_FILE_MB, block: [] };

/** A committee's file rules: its EB's latest `rules` event, or the defaults. */
export function fileRules(replica: Replica, scope: string): RulesBody {
  let latest: Event<'rules'> | null = null;
  for (const e of replica.store.events(scope)) {
    if (e.k !== 'rules') continue;
    const m = replica.auth.memberAt(e.a, e.h);
    if (!m || authorize(replica.auth, m, e) !== null || replica.auth.isRevoked(e.a, scope, e.n)) continue;
    if (!latest || compareHlc(e.h, latest.h) > 0 || (compareHlc(e.h, latest.h) === 0 && e.id > latest.id)) latest = e as Event<'rules'>;
  }
  return latest ? latest.b : DEFAULT_RULES;
}

export type FileRefusal = 'tooLarge' | 'blockedType';

export const extensionOf = (name: string) => (/\.([a-z0-9]{1,10})$/i.exec(name)?.[1] ?? '').toLowerCase();

/** Why a file can't be sent or fetched under these rules, or null if it can. The type check needs the name. */
export function checkFile(rules: RulesBody, size: number, name?: string): FileRefusal | null {
  if (size > rules.maxMB * 1024 * 1024) return 'tooLarge';
  if (name !== undefined && rules.block.includes(extensionOf(name))) return 'blockedType';
  return null;
}

// ── Chunk storage ──

/** Where a device keeps chunks: files on disk in the apps, memory in tests. */
export interface ChunkStore {
  list(): Promise<B64[]>;
  get(id: B64): Promise<Bytes | null>;
  put(id: B64, data: Bytes): Promise<void>;
}

export class MemoryChunkStore implements ChunkStore {
  readonly data = new Map<B64, Bytes>();
  async list() {
    return [...this.data.keys()];
  }
  async get(id: B64) {
    return this.data.get(id) ?? null;
  }
  async put(id: B64, data: Bytes) {
    this.data.set(id, data);
  }
}

// ── Transfer ──

export interface FileStatus {
  id: B64;
  size: number;
  have: number;
  total: number;
  done: boolean;
  wanted: boolean;
}

interface Tracked {
  att: Attachment;
  scopes: Set<string>;
  wanted: boolean;
  /** Not fetched because of the committee's rules. */
  refused: boolean;
}

export interface FileManagerOptions {
  node: MeshNode;
  store: ChunkStore;
  now: () => number;
  /**
   * Fetch a file as soon as it's seen? Hubs fetch everything the rules allow
   * (they serve the room); phones only small files, the rest on tap.
   */
  autoFetch: (att: Attachment, scope: string) => boolean;
  /** Chunk requests outstanding per neighbour. */
  inFlightPerPeer?: number;
  /** A request unanswered this long is asked of someone else. */
  timeoutMs?: number;
}

/** A neighbour that doesn't have a chunk isn't asked again for this long... */
const LACK_MS = 10_000;
/** ...unless it said it's fetching it: then ask again soon. */
const SOON_MS = 2_000;
/** A neighbour that asked for a chunk gets it pushed if it arrives within this time. */
const ASKED_MS = 10_000;

/**
 * Moves file chunks between neighbours. A device asks for the chunks it
 * lacks, hubs first. Asked for a chunk it doesn't have, a device that knows
 * the file starts fetching it too and says "ask again soon"; when the chunk
 * arrives it pushes it to whoever asked. Nobody ever waits on anybody, so
 * requests can't go round in circles, and a file still spreads hop by hop
 * across any number of devices. Chunks are stored one by one, so an
 * interrupted download carries on where it stopped.
 */
export class FileManager {
  private readonly node: MeshNode;
  private readonly store: ChunkStore;
  private readonly opts: FileManagerOptions;
  private readonly have = new Set<B64>();
  private readonly files = new Map<B64, Tracked>();
  /** Chunk id → files it belongs to. */
  private readonly owners = new Map<B64, B64[]>();
  private readonly inFlight = new Map<B64, { peer: string; at: number }>();
  private readonly perPeer = new Map<string, number>();
  /** `${peer}|${chunk}` → until when not to ask that peer for that chunk. */
  private readonly lacks = new Map<string, number>();
  /** Chunk → neighbours that recently asked for it, and when. */
  private readonly askedBy = new Map<B64, Map<string, number>>();
  private readonly listeners = new Set<(fileId: B64) => void>();
  private readonly storing = new Set<B64>();

  constructor(opts: FileManagerOptions) {
    this.opts = opts;
    this.node = opts.node;
    this.store = opts.store;
  }

  async start(): Promise<void> {
    for (const id of await this.store.list()) this.have.add(id);
    const replica = this.node.replica;
    for (const scope of replica.store.scopes()) for (const e of replica.store.events(scope)) this.track(e);
    this.node.onEvent((e) => {
      this.track(e);
      this.schedule();
    });
    this.node.onWire((peer, msg) => this.onWire(peer, msg));
    this.node.onDisconnect((peer) => this.dropPeer(peer));
    this.node.onPeer(() => this.schedule());
    this.schedule();
  }

  /** Called whenever a file's progress changes. */
  onProgress(listener: (fileId: B64) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Encrypts and stores a file of ours, ready to be attached to an event. */
  async addLocal(data: Bytes): Promise<{ att: Attachment; key: B64 }> {
    const { att, key, chunks } = encryptFile(this.node.replica.crypto, data);
    for (const [id, ct] of chunks) {
      await this.store.put(id, ct);
      this.have.add(id);
    }
    return { att, key };
  }

  /** Starts (or resumes) downloading a file. */
  want(fileId: B64): void {
    const f = this.files.get(fileId);
    if (!f || f.wanted) return;
    f.wanted = true;
    this.schedule();
    this.changed(fileId);
  }

  status(fileId: B64): FileStatus | null {
    const f = this.files.get(fileId);
    if (!f) return null;
    const have = f.att.chunks.filter((c) => this.have.has(c)).length;
    return { id: fileId, size: f.att.size, have, total: f.att.chunks.length, done: have === f.att.chunks.length, wanted: f.wanted };
  }

  /** The file's bytes, if complete. */
  async read(att: Attachment, meta: FileMeta): Promise<Bytes | null> {
    return assembleFile(att, meta.key, (id) => this.store.get(id));
  }

  /** Call every second or so: retries timed-out requests and asks for more. */
  tick(): void {
    const now = this.opts.now();
    const timeout = this.opts.timeoutMs ?? 20_000;
    for (const [chunk, req] of this.inFlight) {
      if (now - req.at < timeout) continue;
      this.inFlight.delete(chunk);
      this.release(req.peer);
      this.lacks.set(`${req.peer}|${chunk}`, now + LACK_MS);
    }
    for (const [k, until] of this.lacks) if (until <= now) this.lacks.delete(k);
    for (const [chunk, peers] of this.askedBy) {
      for (const [peer, at] of peers) if (now - at >= ASKED_MS) peers.delete(peer);
      if (!peers.size) this.askedBy.delete(chunk);
    }
    this.schedule();
  }

  private track(e: Event): void {
    const att = (e.b as { att?: Attachment }).att;
    if (!att) return;
    if (attachmentId(this.node.replica.crypto, att.size, att.chunks) !== att.id) return;
    let f = this.files.get(att.id);
    if (!f) {
      f = { att, scopes: new Set(), wanted: false, refused: false };
      this.files.set(att.id, f);
      for (const c of att.chunks) {
        const list = this.owners.get(c) ?? [];
        list.push(att.id);
        this.owners.set(c, list);
      }
    }
    f.scopes.add(e.s);
    const name = (e.b as { file?: FileMeta }).file?.name;
    f.refused = checkFile(fileRules(this.node.replica, e.s), att.size, name) !== null;
    if (!f.wanted && !f.refused && this.opts.autoFetch(att, e.s)) f.wanted = true;
    this.changed(att.id);
  }

  private complete(f: Tracked): boolean {
    return f.att.chunks.every((c) => this.have.has(c));
  }

  /** Neighbours that may have a chunk of this file and aren't busy: hubs first, then the least loaded. */
  private candidates(f: Tracked, chunk: B64): string[] {
    const now = this.opts.now();
    const cap = this.opts.inFlightPerPeer ?? 6;
    return this.node
      .neighbours()
      .filter((n) => {
        if ((this.perPeer.get(n.id) ?? 0) >= cap) return false;
        if ((this.lacks.get(`${n.id}|${chunk}`) ?? 0) > now) return false;
        const subs = this.node.peerSubs(n.id);
        return subs === ALL || (!!subs && [...f.scopes].some((s) => subs.includes(s)));
      })
      .map((n) => n.id)
      .sort((a, b) => {
        const hubA = this.node.peerSubs(a) === ALL ? 0 : 1;
        const hubB = this.node.peerSubs(b) === ALL ? 0 : 1;
        return hubA - hubB || (this.perPeer.get(a) ?? 0) - (this.perPeer.get(b) ?? 0);
      });
  }

  private schedule(): void {
    const batches = new Map<string, B64[]>();
    for (const f of this.files.values()) {
      if (!f.wanted || f.refused || this.complete(f)) continue;
      for (const chunk of f.att.chunks) {
        if (this.have.has(chunk) || this.storing.has(chunk) || this.inFlight.has(chunk)) continue;
        const peer = this.candidates(f, chunk)[0];
        if (!peer) continue;
        this.inFlight.set(chunk, { peer, at: this.opts.now() });
        this.perPeer.set(peer, (this.perPeer.get(peer) ?? 0) + 1);
        const list = batches.get(peer) ?? [];
        list.push(chunk);
        batches.set(peer, list);
      }
    }
    for (const [peer, ids] of batches) this.node.sendTo(peer, { t: 'want', c: ids });
  }

  private onWire(peer: string, msg: FileWire): void {
    switch (msg.t) {
      case 'want': {
        if (!Array.isArray(msg.c)) return;
        const now = this.opts.now();
        const none: B64[] = [];
        const soon: B64[] = [];
        // Fetch on someone else's behalf only as a hub or bridge, or for another
        // phone (a Nearby chain). A phone on Wi-Fi asked by a hub just says no,
        // rather than downloading a file its owner never asked for.
        const relays =
          this.node.neighbours().length > 1 && (this.node.replica.subs === ALL || this.node.peerSubs(peer) !== ALL);
        for (const id of msg.c.slice(0, 64)) {
          if (typeof id !== 'string') continue;
          if (this.have.has(id)) {
            void this.store.get(id).then((d) => {
              if (d) this.node.sendTo(peer, { t: 'chunk', id, d: toB64(d) });
              else this.node.sendTo(peer, { t: 'nochunk', c: [id] });
            });
            continue;
          }
          // A chunk of a file we know: fetch it too, and push it to them when it arrives.
          const f = (this.owners.get(id) ?? []).map((fid) => this.files.get(fid)!).find((x) => !x.refused);
          if (f && relays) {
            f.wanted = true;
            const peers = this.askedBy.get(id) ?? new Map<string, number>();
            peers.set(peer, now);
            this.askedBy.set(id, peers);
            soon.push(id);
          } else none.push(id);
        }
        if (none.length) this.node.sendTo(peer, { t: 'nochunk', c: none });
        if (soon.length) this.node.sendTo(peer, { t: 'nochunk', c: soon, soon: true });
        this.schedule();
        return;
      }
      case 'chunk': {
        if (typeof msg.id !== 'string' || typeof msg.d !== 'string') return;
        const req = this.inFlight.get(msg.id);
        if (req?.peer === peer) {
          this.inFlight.delete(msg.id);
          this.release(peer);
        }
        if (this.have.has(msg.id) || this.storing.has(msg.id) || !this.owners.has(msg.id)) return;
        let data: Bytes;
        try {
          data = fromB64(msg.d);
        } catch {
          return;
        }
        if (chunkId(this.node.replica.crypto, data) !== msg.id) {
          // Corrupt or forged: don't ask that neighbour for it again soon.
          this.lacks.set(`${peer}|${msg.id}`, this.opts.now() + LACK_MS);
          this.schedule();
          return;
        }
        // A request for it elsewhere is now moot.
        if (req && req.peer !== peer) {
          this.inFlight.delete(msg.id);
          this.release(req.peer);
        }
        this.storing.add(msg.id);
        void this.store.put(msg.id, data).then(() => {
          this.storing.delete(msg.id);
          this.have.add(msg.id);
          const asked = this.askedBy.get(msg.id);
          this.askedBy.delete(msg.id);
          for (const p of asked?.keys() ?? []) if (p !== peer) this.node.sendTo(p, { t: 'chunk', id: msg.id, d: msg.d });
          for (const fid of this.owners.get(msg.id) ?? []) this.changed(fid);
          this.schedule();
        });
        return;
      }
      case 'nochunk': {
        if (!Array.isArray(msg.c)) return;
        const until = this.opts.now() + (msg.soon ? SOON_MS : LACK_MS);
        for (const id of msg.c) {
          if (typeof id !== 'string') continue;
          this.lacks.set(`${peer}|${id}`, until);
          if (this.inFlight.get(id)?.peer === peer) {
            this.inFlight.delete(id);
            this.release(peer);
          }
        }
        this.schedule();
        return;
      }
    }
  }

  private release(peer: string): void {
    const n = (this.perPeer.get(peer) ?? 1) - 1;
    if (n <= 0) this.perPeer.delete(peer);
    else this.perPeer.set(peer, n);
  }

  private dropPeer(peer: string): void {
    for (const [chunk, req] of this.inFlight) if (req.peer === peer) this.inFlight.delete(chunk);
    this.perPeer.delete(peer);
    for (const [chunk, peers] of this.askedBy) {
      peers.delete(peer);
      if (!peers.size) this.askedBy.delete(chunk);
    }
    this.schedule();
  }

  private changed(fileId: B64): void {
    for (const l of this.listeners) l(fileId);
  }
}
