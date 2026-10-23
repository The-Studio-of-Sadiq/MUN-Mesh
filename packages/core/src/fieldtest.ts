import type { B64 } from './bytes';
import type { MeshNode } from './node';
import type { Replica } from './replica';
import { GLOBAL, type Event, type ReportBody } from './types';

/**
 * Field tests at a real venue. The Secretariat's laptop sends a numbered
 * ping every few seconds; every device notes when each one arrived and, once
 * a minute, publishes a short report. The Secretariat's console adds the
 * reports up: who's reachable, how many pings each device got, how long they
 * took. Latency is measured with each device's own clock, so it is only as
 * good as the clocks agree (phones are usually within a second); delivery
 * counts don't depend on clocks.
 */

export const PING_EVERY_MS = 10_000;
export const REPORT_EVERY_MS = 60_000;

/** Runs on every device: remembers ping arrivals and reports them. */
export class FieldTestReporter {
  private readonly node: MeshNode;
  private readonly opts: { platform: string; relay: boolean; links: () => { tcp: number; nearby: number }; now: () => number; everyMs?: number };
  private pending: { test: string; got: [number, number][] } | null = null;
  private lastReport = 0;

  constructor(node: MeshNode, opts: FieldTestReporter['opts']) {
    this.node = node;
    this.opts = opts;
    node.onEvent((e) => {
      if (e.k !== 'ping') return;
      const b = (e as Event<'ping'>).b;
      if (this.pending && this.pending.test !== b.test) this.report();
      this.pending ??= { test: b.test, got: [] };
      this.pending.got.push([b.seq, Math.round(this.opts.now() - e.h.t)]);
    });
  }

  /** Call every few seconds; reports when due. */
  tick(): void {
    if (this.pending && this.opts.now() - this.lastReport >= (this.opts.everyMs ?? REPORT_EVERY_MS)) this.report();
  }

  private report(): void {
    const p = this.pending;
    this.pending = null;
    if (!p || !p.got.length) return;
    this.lastReport = this.opts.now();
    const me = this.node.replica.auth.member(this.node.key);
    const scope = me?.role === 'secretariat' ? GLOBAL : me?.com;
    if (!scope) return;
    const links = this.opts.links();
    const body: ReportBody = {
      test: p.test,
      got: p.got.slice(-500),
      tcp: links.tcp,
      nearby: links.nearby,
      stored: this.node.replica.store.size,
      platform: this.opts.platform,
      relay: this.opts.relay,
    };
    try {
      this.node.publish(scope, 'report', body);
    } catch {
      // Not (or no longer) a member: nothing to report.
    }
  }
}

export interface DeviceResult {
  key: B64;
  name: string;
  com: string;
  platform: string;
  relay: boolean;
  /** Pings received, and pings sent while it was taking part. */
  received: number;
  expected: number;
  p50: number;
  p95: number;
  max: number;
  tcp: number;
  nearby: number;
  stored: number;
  /** When its latest report was written (its clock). */
  lastReport: number;
}

export interface GroupResult {
  devices: number;
  /** Received ÷ expected, over all devices in the group. */
  delivery: number;
  p50: number;
  p95: number;
  max: number;
}

export interface FieldTestSummary {
  test: string;
  pings: number;
  startedAt: number;
  lastPingAt: number;
  overall: GroupResult;
  committees: (GroupResult & { com: string })[];
  devices: DeviceResult[];
}

const pct = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0);

/** Field tests in this replica, newest first. */
export function fieldTests(replica: Replica): string[] {
  const latest = new Map<string, number>();
  for (const e of replica.store.events(GLOBAL)) {
    if (e.k === 'ping') latest.set((e as Event<'ping'>).b.test, Math.max(latest.get((e as Event<'ping'>).b.test) ?? 0, e.h.t));
  }
  return [...latest].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

/** Adds up a test's reports. Run on a device that keeps every scope (the Secretariat's laptop). */
export function summarizeFieldTest(replica: Replica, test: string): FieldTestSummary {
  const pings = replica.store.events(GLOBAL).filter((e): e is Event<'ping'> => e.k === 'ping' && (e as Event<'ping'>).b.test === test);
  const sentAt = new Map(pings.map((p) => [p.b.seq, p.h.t]));
  const seqs = [...sentAt.keys()].sort((a, b) => a - b);

  type Seen = { reports: Event<'report'>[]; got: Map<number, number> };
  const byDevice = new Map<B64, Seen>();
  for (const scope of replica.store.scopes()) {
    for (const e of replica.store.events(scope)) {
      if (e.k !== 'report' || (e as Event<'report'>).b.test !== test) continue;
      const d: Seen = byDevice.get(e.a) ?? { reports: [], got: new Map() };
      d.reports.push(e as Event<'report'>);
      for (const [seq, ms] of (e as Event<'report'>).b.got) if (sentAt.has(seq)) d.got.set(seq, ms);
      byDevice.set(e.a, d);
    }
  }

  const devices: DeviceResult[] = [];
  for (const [key, d] of byDevice) {
    d.reports.sort((a, b) => a.h.t - b.h.t);
    const last = d.reports[d.reports.length - 1]!;
    // Expected: pings sent from the first one it got until its latest report (it can't
    // have heard pings sent before it joined, or after it last reported).
    const first = Math.min(...d.got.keys());
    const expected = seqs.filter((s) => s >= first && sentAt.get(s)! <= last.h.t).length;
    const delays = [...d.got.values()].sort((a, b) => a - b);
    const member = replica.auth.member(key);
    devices.push({
      key,
      name: member?.name ?? 'Unknown',
      com: last.s,
      platform: last.b.platform,
      relay: last.b.relay,
      received: d.got.size,
      expected: Math.max(expected, d.got.size),
      p50: pct(delays, 0.5),
      p95: pct(delays, 0.95),
      max: delays[delays.length - 1] ?? 0,
      tcp: last.b.tcp,
      nearby: last.b.nearby,
      stored: last.b.stored,
      lastReport: last.h.t,
    });
  }
  devices.sort((a, b) => a.com.localeCompare(b.com) || a.name.localeCompare(b.name));

  const group = (list: DeviceResult[]): GroupResult => {
    const delays = [...byDevice]
      .filter(([k]) => list.some((d) => d.key === k))
      .flatMap(([, d]) => [...d.got.values()])
      .sort((a, b) => a - b);
    const received = list.reduce((n, d) => n + d.received, 0);
    const expected = list.reduce((n, d) => n + d.expected, 0);
    return { devices: list.length, delivery: expected ? received / expected : 0, p50: pct(delays, 0.5), p95: pct(delays, 0.95), max: delays[delays.length - 1] ?? 0 };
  };
  const coms = [...new Set(devices.map((d) => d.com))].sort();
  return {
    test,
    pings: pings.length,
    startedAt: pings.length ? Math.min(...pings.map((p) => p.h.t)) : 0,
    lastPingAt: pings.length ? Math.max(...pings.map((p) => p.h.t)) : 0,
    overall: group(devices),
    committees: coms.map((com) => ({ com, ...group(devices.filter((d) => d.com === com)) })),
    devices,
  };
}

/** The Secretariat's side: sends pings while a test runs. */
export class FieldTestRunner {
  private readonly node: MeshNode;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  test: string | null = null;

  constructor(node: MeshNode) {
    this.node = node;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(test = `t${Date.now().toString(36)}`, everyMs = PING_EVERY_MS): string {
    this.stop();
    this.test = test;
    this.seq = 0;
    const ping = () => this.node.publish(GLOBAL, 'ping', { test, seq: this.seq++ });
    ping();
    this.timer = setInterval(ping, everyMs);
    return test;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
