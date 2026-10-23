// Runs a whole simulated conference against the real mesh code and checks
// every device ends up agreeing. Usage:
//   npm run harness -- [--committees 10] [--delegates 48] [--minutes 30] [--seed 1] [--json report.json]
import { writeFileSync } from 'node:fs';
import { createNodeCrypto } from '../src/crypto/node';
import { runConferenceScenario } from '../src/sim/conference';

const args = process.argv.slice(2);
const arg = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const jsonAt = args.indexOf('--json');

const report = runConferenceScenario({
  committees: arg('committees', 10),
  delegates: arg('delegates', 48),
  minutes: arg('minutes', 30),
  seed: arg('seed', 1),
  crypto: createNodeCrypto(),
  log: (line) => console.log(line),
});

const fmt = (l: { p50: number; p95: number; p99: number; max: number; under1s: number }) =>
  `p50 ${l.p50} ms · p95 ${l.p95} ms · p99 ${l.p99} ms · max ${l.max} ms · ${l.under1s}% under 1 s`;
const events = Object.entries(report.events).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(`
Devices      ${report.nodes} (${report.links} links)
Events       ${events}; ${report.refused} refused at publish
Deliveries   ${report.deliveries}
Latency      all:    ${fmt(report.latencyMs)}
             steady: ${fmt(report.steadyLatencyMs)}  (no drop-offs, outside the partition)
Settled      ${(report.settleMs / 1000).toFixed(1)} s after activity stopped
Traffic      ${report.traffic.messages} messages, ${report.traffic.megabytes} MB, ${report.traffic.dropped} lost in flight
             ${Object.entries(report.traffic.byType).map(([k, v]) => `${k}: ${v.messages} msgs / ${v.megabytes} MB`).join(' · ')}
Wall time    ${(report.wallMs / 1000).toFixed(1)} s

Checks`);
for (const c of report.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
console.log(report.ok ? '\nAll checks passed.' : '\nSome checks FAILED.');
if (jsonAt >= 0) writeFileSync(args[jsonAt + 1]!, JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
