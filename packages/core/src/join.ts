import { canonicalJson, fromB64, fromUtf8, toB64, utf8, type B64 } from './bytes';
import type { Crypto, Identity } from './crypto';
import { checkConference } from './event';
import type { Conference, Role } from './types';

/**
 * A device asking to be let in. Not an event (it has no cert yet), but signed
 * with the key it wants certified, so nobody can request on its behalf. It
 * spreads through the mesh until an EB (or the Secretariat, for staff)
 * approves it by issuing a cert.
 */
export interface JoinRequest {
  sign: B64;
  box: B64;
  /** Country for delegates, person's name for staff. */
  name: string;
  role: Role;
  com?: string;
  /** Roster code from the Secretariat, if the delegate was given one. */
  code?: string;
  /** Epoch ms; a newer request from the same key replaces an older one. */
  at: number;
  sig: B64;
}

export type JoinFields = Omit<JoinRequest, 'sign' | 'box' | 'at' | 'sig'>;

const joinBytes = (confId: string, r: Omit<JoinRequest, 'sig'>) =>
  utf8(canonicalJson({ c: confId, sign: r.sign, box: r.box, name: r.name, role: r.role, com: r.com, code: r.code, at: r.at }));

export function createJoinRequest(crypto: Crypto, confId: string, identity: Identity, fields: JoinFields, at: number): JoinRequest {
  const unsigned = { ...fields, sign: toB64(identity.sign.pub), box: toB64(identity.box.pub), at };
  return { ...unsigned, sig: toB64(crypto.sign(joinBytes(confId, unsigned), identity.sign.secret)) };
}

export function checkJoinRequest(crypto: Crypto, confId: string, raw: unknown): raw is JoinRequest {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!str(r.sign, 43) || !str(r.box, 43) || !str(r.name, 80) || !str(r.sig, 86)) return false;
  if (!['delegate', 'observer', 'eb', 'secretariat'].includes(r.role as string)) return false;
  if (r.com !== undefined && !str(r.com, 24)) return false;
  if (r.code !== undefined && !str(r.code, 40)) return false;
  if (!Number.isSafeInteger(r.at)) return false;
  try {
    return crypto.verify(fromB64(r.sig as string), joinBytes(confId, r as unknown as JoinRequest), fromB64(r.sign as string));
  } catch {
    return false;
  }
}

/**
 * Short code a person reads aloud so the EB can match a request on screen to
 * the device in front of them (first characters of the key, grouped).
 */
export const keyFingerprint = (key: B64) => key.slice(0, 8).toUpperCase().replace(/(.{4})/, '$1-');

// ── Invites (QR codes) ────────────────────────────────────────────────────────

export const INVITE_PREFIX = 'mun://join?i=';

/** Everything a new device needs: the conference, which committee, and where hubs listen. */
export interface Invite {
  conf: Conference;
  com?: string;
  /** "host:port" of hubs to try first. */
  hubs: string[];
}

export function encodeInvite(invite: Invite): string {
  return INVITE_PREFIX + toB64(utf8(JSON.stringify(invite)));
}

/** Accepts a full `mun://join?i=…` link or just the code after `i=`. Null if it isn't a valid invite. */
export function parseInvite(text: string): Invite | null {
  const trimmed = text.trim();
  const code = trimmed.startsWith(INVITE_PREFIX) ? trimmed.slice(INVITE_PREFIX.length) : trimmed;
  try {
    const raw = JSON.parse(fromUtf8(fromB64(code))) as Invite;
    if (!raw || typeof raw !== 'object' || !raw.conf || !Array.isArray(raw.hubs)) return null;
    checkConference(raw.conf);
    if (raw.com !== undefined && !raw.conf.committees.some((c) => c.id === raw.com)) return null;
    return { conf: raw.conf, com: raw.com, hubs: raw.hubs.filter(isHostPort).slice(0, 16) };
  } catch {
    return null;
  }
}

export function isHostPort(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 64) return false;
  const m = /^([\w.-]+):(\d{1,5})$/.exec(v);
  return !!m && Number(m[2]) > 0 && Number(m[2]) < 65536;
}

export function splitHostPort(v: string): { host: string; port: number } {
  const i = v.lastIndexOf(':');
  return { host: v.slice(0, i), port: Number(v.slice(i + 1)) };
}

// ── LAN discovery ────────────────────────────────────────────────────────────

export const DEFAULT_PORT = 47900;
export const BEACON_PORT = 47901;

/** Broadcast by hubs every few seconds so laptops on the same network find each other. */
export interface Beacon {
  /** Conference id. */
  c: string;
  /** TCP port the hub listens on (the address is the packet's source). */
  p: number;
  /** Hub's signing key, to skip connecting to ourselves. */
  n: B64;
}

export const encodeBeacon = (b: Beacon): string => `MUN1 ${JSON.stringify(b)}`;

export function parseBeacon(text: string): Beacon | null {
  if (!text.startsWith('MUN1 ') || text.length > 300) return null;
  try {
    const b = JSON.parse(text.slice(5)) as Beacon;
    return typeof b.c === 'string' && Number.isInteger(b.p) && b.p > 0 && b.p < 65536 && typeof b.n === 'string' ? b : null;
  } catch {
    return null;
  }
}
