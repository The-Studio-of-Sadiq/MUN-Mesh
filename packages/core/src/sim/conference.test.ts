import { describe, expect, it } from 'vitest';
import { createNodeCrypto } from '../crypto/node';
import { runConferenceScenario } from './conference';

// A small conference with every failure mode; `npm run harness` runs the full 500-device one.
describe('conference scenario', () => {
  for (const seed of [1, 2]) {
    it(`converges with seed ${seed}`, () => {
      const report = runConferenceScenario({ committees: 3, delegates: 16, minutes: 10, seed, crypto: createNodeCrypto() });
      expect(report.checks.filter((c) => !c.ok)).toEqual([]);
      expect(report.steadyLatencyMs.p99).toBeLessThan(1000);
    }, 120_000);
  }
});
