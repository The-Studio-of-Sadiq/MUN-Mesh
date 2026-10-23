import {
  ALL,
  DEFAULT_PORT,
  Device,
  FileManager,
  MeshNode,
  checkFile,
  fileRules,
  certFor,
  createIdentity,
  encodeBeacon,
  encodeInvite,
  issueCert,
  loadIdentity,
  parseBeacon,
  saveIdentity,
  type Conference,
  type Event,
  type Identity,
  type FileRefusal,
  type JoinRequest,
  type Member,
  type OutgoingFile,
  type Role,
  type StoredIdentity,
} from '@mun/core';
import { discovery } from './platform/discovery';
import { chunkStore, clearChunks, eventLog, kv } from './platform/storage';
import { canHost, transport } from './platform/transport';

/** What this device is in the conference, chosen when it joined (or created it). */
export interface Profile {
  conf: Conference;
  /** Role asked for; for the Secretariat's root laptop, the role it has. */
  role: Role;
  com?: string;
  name: string;
  /** Roster code the delegate entered, sent with the join request. */
  code?: string;
  /** Hub addresses from the invite. */
  hubs: string[];
  /** Keeps every scope and accepts connections: EB and Secretariat laptops, or a laptop bridging two networks. */
  hub: boolean;
}

/** One row of a committee roster the Secretariat handed the EB. */
export interface RosterEntry {
  code: string;
  name: string;
}

const KEYS = { identity: 'identity', profile: 'profile', roster: 'roster', autoApprove: 'autoApprove' };

/** Phones download files up to this size by themselves; bigger ones on tap. */
export const PHONE_AUTO_FETCH_BYTES = 2 * 1024 * 1024;

/** A file picked on this device, before it's encrypted and sent. */
export interface PickedFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

export class FileRefused extends Error {
  readonly reason: FileRefusal;
  readonly maxMB: number;
  constructor(reason: FileRefusal, maxMB: number) {
    super(reason === 'tooLarge' ? `Files in this committee can be up to ${maxMB} MB.` : 'This committee doesn’t accept that type of file.');
    this.reason = reason;
    this.maxMB = maxMB;
  }
}

export async function loadOrCreateIdentity(): Promise<Identity> {
  const raw = await kv.get(KEYS.identity);
  if (raw) return loadIdentity(JSON.parse(raw) as StoredIdentity);
  const id = createIdentity();
  await kv.set(KEYS.identity, JSON.stringify(saveIdentity(id)));
  return id;
}

export async function loadProfile(): Promise<Profile | null> {
  const raw = await kv.get(KEYS.profile);
  return raw ? (JSON.parse(raw) as Profile) : null;
}

/** "code,name" per line; a header row or blank lines are skipped. */
export function parseRoster(text: string): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [code, ...rest] = line.split(',').map((s) => s.trim());
    const name = rest.join(',').replace(/^"|"$/g, '').trim();
    if (!code || !name || /^code$/i.test(code)) continue;
    out.push({ code, name });
  }
  return out;
}

/**
 * The running app: this device's node and connections, its saved events,
 * and what the screens need from them. Screens re-render through `subscribe`.
 */
export class AppSession {
  readonly identity: Identity;
  readonly profile: Profile;
  readonly node: MeshNode;
  readonly device: Device;
  readonly files: FileManager;
  roster: RosterEntry[] = [];
  autoApprove = true;
  /** Requests the EB dismissed on this laptop; they stay hidden until the device asks again. */
  private readonly dismissed = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private logQueue: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private stopBeacons: () => void = () => {};
  private fileTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  private constructor(identity: Identity, profile: Profile) {
    this.identity = identity;
    this.profile = profile;
    const hub = profile.hub && canHost;
    this.node = new MeshNode({ conf: profile.conf, identity, subs: hub ? ALL : [profile.com!], now: Date.now });
    this.device = new Device({
      node: this.node,
      transport,
      listenPort: hub ? DEFAULT_PORT : null,
      // Hubs dial every hub they hear of; phones keep a couple of links.
      maxOutbound: hub ? 32 : 3,
    });
    // Hubs keep every file the rules allow, to serve the room; phones fetch small ones by themselves.
    this.files = new FileManager({
      node: this.node,
      store: chunkStore,
      now: Date.now,
      autoFetch: (att) => hub || att.size <= PHONE_AUTO_FETCH_BYTES,
    });
  }

  /** Resumes the conference this device joined before, if any. */
  static async resume(): Promise<AppSession | null> {
    const profile = await loadProfile();
    if (!profile) return null;
    const session = new AppSession(await loadOrCreateIdentity(), profile);
    await session.start();
    return session;
  }

  /**
   * Starts a new membership. `identity` is given only when the Secretariat
   * creates a conference: its root key becomes this device's key.
   */
  static async begin(profile: Profile, identity?: Identity): Promise<AppSession> {
    if (identity) await kv.set(KEYS.identity, JSON.stringify(saveIdentity(identity)));
    await kv.set(KEYS.profile, JSON.stringify(profile));
    await eventLog.clear();
    const session = new AppSession(identity ?? (await loadOrCreateIdentity()), profile);
    await session.start();
    return session;
  }

  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const [rosterRaw, autoRaw] = await Promise.all([kv.get(KEYS.roster), kv.get(KEYS.autoApprove)]);
    this.roster = rosterRaw ? (JSON.parse(rosterRaw) as RosterEntry[]) : [];
    this.autoApprove = autoRaw !== 'false';

    const saved: Event[] = [];
    for (const line of (await eventLog.read()).split('\n')) {
      if (!line) continue;
      try {
        saved.push(JSON.parse(line) as Event);
      } catch {
        // A line cut short by a crash; the event comes back from a neighbour.
      }
    }
    this.node.restore(saved);
    await this.files.start();
    this.files.onProgress(() => this.changed());
    this.fileTimer = setInterval(() => this.files.tick(), 1000);

    this.node.onEvent((e) => {
      this.logQueue.push(`${JSON.stringify(e)}\n`);
      this.flushSoon();
      this.changed();
    });
    this.node.onJoinRequest((r) => {
      this.maybeAutoApprove(r);
      this.changed();
    });
    this.device.onChange(() => this.changed());

    for (const h of this.profile.hubs) this.device.addAddress(h, 'invite');
    await this.device.start();
    await this.startDiscovery();
    // Ask again on every start until let in (the request may have been lost while alone).
    if (!this.me()) this.node.requestJoin(this.joinFields());
    (globalThis as { munSession?: AppSession }).munSession = this;
  }

  private async startDiscovery(): Promise<void> {
    if (!discovery.available) return;
    await discovery.start();
    const port = this.device.port;
    if (port !== null) await discovery.announce(encodeBeacon({ c: this.node.replica.confId, p: port, n: this.node.key }));
    this.stopBeacons = discovery.onBeacon(({ text, host }) => {
      const b = parseBeacon(text);
      if (b && b.c === this.node.replica.confId && b.n !== this.node.key) this.device.addAddress(`${host}:${b.p}`, 'beacon');
    });
  }

  /** Leaves the conference on this device: forgets its events, profile and keys. */
  async leave(): Promise<void> {
    this.stop();
    await Promise.all([eventLog.clear(), clearChunks(), kv.remove(KEYS.profile), kv.remove(KEYS.identity), kv.remove(KEYS.roster)]);
  }

  stop(): void {
    if (this.fileTimer) clearInterval(this.fileTimer);
    this.stopBeacons();
    void discovery.stop();
    this.device.stop();
    void this.flush();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Who am I ──

  me(): Member | null {
    return this.node.replica.auth.member(this.node.key);
  }

  committeeName(id: string | undefined): string {
    return this.profile.conf.committees.find((c) => c.id === id)?.name ?? id ?? '';
  }

  joinFields() {
    const { name, role, com, code } = this.profile;
    return { name, role, ...(com ? { com } : {}), ...(code ? { code } : {}) };
  }

  /** QR text for new devices: the conference, the committee, and where to find hubs. */
  invite(com?: string): string {
    const status = this.device.status();
    const hubs = new Set(status.addresses);
    for (const n of this.node.neighbours()) for (const a of n.addrs) hubs.add(a);
    for (const h of this.profile.hubs) hubs.add(h);
    return encodeInvite({ conf: this.profile.conf, com, hubs: [...hubs].slice(0, 8) });
  }

  // ── Files ──

  /**
   * Encrypts and stores a picked file, ready to attach. Throws `FileRefused`
   * if the committee's rules don't allow it (the EB channel and global use the defaults).
   */
  async prepareFile(picked: PickedFile, scope: string): Promise<OutgoingFile> {
    const rules = fileRules(this.node.replica, scope);
    const refusal = checkFile(rules, picked.data.length, picked.name);
    if (refusal) throw new FileRefused(refusal, rules.maxMB);
    const { att, key } = await this.files.addLocal(picked.data);
    return { att, key, name: picked.name, mime: picked.mime };
  }

  // ── Approving devices ──

  /** Requests this device may approve: the Secretariat approves staff; an EB, its committee's delegates. */
  approvable(): JoinRequest[] {
    const me = this.me();
    if (!me) return [];
    return this.node.pendingJoins().filter((r) => {
      if ((this.dismissed.get(r.sign) ?? -1) >= r.at) return false;
      if (me.role === 'secretariat') return true;
      return me.role === 'eb' && r.com === me.com && (r.role === 'delegate' || r.role === 'observer');
    });
  }

  approve(r: JoinRequest, name = r.name): Event<'cert'> {
    return issueCert(this.node, certFor({ sign: r.sign, box: r.box }, r.role, name, r.com));
  }

  dismiss(r: JoinRequest): void {
    this.dismissed.set(r.sign, r.at);
    this.changed();
  }

  async setRoster(entries: RosterEntry[]): Promise<void> {
    this.roster = entries;
    await kv.set(KEYS.roster, JSON.stringify(entries));
    for (const r of this.node.pendingJoins()) this.maybeAutoApprove(r);
    this.changed();
  }

  async setAutoApprove(on: boolean): Promise<void> {
    this.autoApprove = on;
    await kv.set(KEYS.autoApprove, String(on));
    if (on) for (const r of this.node.pendingJoins()) this.maybeAutoApprove(r);
    this.changed();
  }

  /** A delegate with a matching roster code is let in under the roster's name. */
  private maybeAutoApprove(r: JoinRequest): void {
    if (!this.autoApprove || !r.code || r.role !== 'delegate') return;
    if (!this.approvable().includes(r)) return;
    const entry = this.roster.find((e) => e.code.toLowerCase() === r.code!.toLowerCase());
    // A code already used by another device isn't reused.
    if (!entry || this.node.replica.auth.all().some((m) => m.com === r.com && m.name === entry.name)) return;
    this.approve(r, entry.name);
  }

  // ── Plumbing ──

  /** Bumped on every change; screens use it to know when to recompute. */
  version = 0;

  private changed(): void {
    this.version++;
    if (this.notifyTimer) return;
    // Coalesce bursts (a sync can bring hundreds of events) into one render.
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const l of this.listeners) l();
    }, 80);
  }

  private flushSoon(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => void this.flush(), 500);
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.logQueue.length) return;
    const text = this.logQueue.join('');
    this.logQueue = [];
    await eventLog.append(text);
  }
}
