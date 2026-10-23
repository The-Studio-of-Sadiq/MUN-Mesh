/**
 * Hybrid logical clock: wall-clock ms plus a counter. Orders events
 * consistently across devices whose clocks disagree, and never runs backwards
 * on one device. https://cse.buffalo.edu/tech-reports/2014-04.pdf
 */
export interface Hlc {
  /** Milliseconds (wall clock, or the largest seen). */
  t: number;
  /** Tie-breaker within the same millisecond. */
  c: number;
}

/** A remote timestamp more than this far ahead of our clock doesn't drag it forward. */
export const MAX_DRIFT_MS = 5 * 60_000;

export function compareHlc(a: Hlc, b: Hlc): number {
  return a.t - b.t || a.c - b.c;
}

export class HlcClock {
  private last: Hlc = { t: 0, c: 0 };
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Timestamp for a new local event. */
  tick(): Hlc {
    const wall = Math.floor(this.now());
    this.last = wall > this.last.t ? { t: wall, c: 0 } : { t: this.last.t, c: this.last.c + 1 };
    return this.last;
  }

  /** Move past a timestamp seen on a received event. */
  observe(remote: Hlc): void {
    if (remote.t > this.now() + MAX_DRIFT_MS) return;
    if (compareHlc(remote, this.last) > 0) this.last = { t: remote.t, c: remote.c };
  }
}
