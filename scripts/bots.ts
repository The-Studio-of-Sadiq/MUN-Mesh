// Scripted delegates for field tests: real mesh nodes (the same core as the
// apps) on a laptop, over the venue's real network. Lets ~10 real phones plus
// bots make a 50-device test.
//
//   npm run bots -- --invite "mun://join?i=..." [--count 40] [--every 90] [--prefix BOT]
//
// They join with roster codes BOT-01, BOT-02…; paste the roster this prints
// into the EB console (Join → Roster) and they're let in automatically.
// Each posts every ~--every seconds, sends a chit now and then, fetches
// small files, and answers field-test pings. Ctrl+C stops them.
import {
  Device,
  FieldTestReporter,
  FileManager,
  MemoryChunkStore,
  MeshNode,
  createIdentity,
  parseInvite,
  post,
  sendChit,
  type Member,
} from '@mun/core';
import { createNodeCrypto, nodeTransport } from '@mun/core/node';

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const inviteText = arg('invite');
const invite = inviteText ? parseInvite(inviteText) : null;
if (!invite?.com) {
  console.error('Usage: npm run bots -- --invite "<committee join code from the EB console>" [--count 40] [--every 90]');
  process.exit(1);
}
const count = Number(arg('count', '40'));
const everyMs = Number(arg('every', '90')) * 1000;
const prefix = arg('prefix', 'BOT')!;
const crypto = createNodeCrypto();
const pad = (n: number) => String(n).padStart(2, '0');

console.log(`Roster to paste into the EB console (Join → Roster):\n`);
for (let i = 1; i <= count; i++) console.log(`${prefix}-${pad(i)}, ${prefix === 'BOT' ? 'Bot' : prefix} ${pad(i)}`);
console.log('');

interface Bot {
  name: string;
  node: MeshNode;
  device: Device;
  files: FileManager;
  reporter: FieldTestReporter;
}

const bots: Bot[] = [];
for (let i = 1; i <= count; i++) {
  const node = new MeshNode({ conf: invite.conf, identity: createIdentity(), subs: [invite.com], now: Date.now, crypto });
  const device = new Device({ node, transport: nodeTransport, listenPort: null, maxOutbound: 2 });
  const files = new FileManager({ node, store: new MemoryChunkStore(), now: Date.now, autoFetch: (att) => att.size <= 2 * 1024 * 1024 });
  const reporter = new FieldTestReporter(node, {
    platform: 'bot',
    relay: false,
    links: () => ({ tcp: node.neighbours().length, nearby: 0 }),
    now: Date.now,
  });
  for (const h of invite.hubs) device.addAddress(h, 'invite');
  bots.push({ name: `${prefix} ${pad(i)}`, node, device, files, reporter });
}

const isMember = (b: Bot) => b.node.replica.auth.roles(b.node.key).length > 0;
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)]!;
let posts = 0;
let chits = 0;

for (const [i, b] of bots.entries()) {
  // Stagger joins so the EB console isn't hit by everyone at once.
  setTimeout(async () => {
    await b.files.start();
    await b.device.start();
    b.node.requestJoin({ name: b.name, role: 'delegate', com: invite.com!, code: `${prefix}-${pad(i + 1)}` });
  }, i * 300);
}

setInterval(() => {
  for (const b of bots) {
    b.files.tick();
    b.reporter.tick();
    if (!isMember(b) || Math.random() > 1000 / everyMs) continue;
    try {
      if (Math.random() < 0.15) {
        const others = b.node.replica.auth
          .all()
          .filter((m: Member) => m.com === invite.com && m.role === 'delegate' && m.key !== b.node.key);
        if (others.length) {
          sendChit(b.node, invite.com!, pick(others).key, `${b.name}: shall we co-sponsor clause ${1 + Math.floor(Math.random() * 9)}?`);
          chits++;
        }
      } else {
        post(b.node, invite.com!, `${b.name} on the topic, point ${++posts}`);
      }
    } catch {
      // Muted, locked or removed: a real delegate would wait too.
    }
  }
}, 1000);

setInterval(() => {
  const members = bots.filter(isMember).length;
  const linked = bots.filter((b) => b.node.neighbours().length > 0).length;
  console.log(`${new Date().toLocaleTimeString()}  ${members}/${count} let in · ${linked} linked · ${posts} posts · ${chits} chits sent`);
}, 15_000);

process.on('SIGINT', () => {
  for (const b of bots) b.device.stop();
  process.exit(0);
});
