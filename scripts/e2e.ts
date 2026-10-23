// End-to-end run of the real Windows app: launches the Secretariat and two
// EB laptops as separate Electron profiles, clicks through their UI over the
// DevTools protocol, connects scripted "phones" (the real core over TCP), and
// checks messages, chits and announcements flow between them.
//
//   npm run export:web -w app        (once, or after UI changes)
//   node --import ./scripts/register-ts.mjs scripts/e2e.ts [outDir]
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  Device,
  FieldTestReporter,
  FileManager,
  MemoryChunkStore,
  MeshNode,
  fileOf,
  fileRules,
  createIdentity,
  parseInvite,
  post,
  readChit,
  scopeView,
  sendChit,
  type Event,
} from '@mun/core';
import { createNodeCrypto, nodeTransport } from '@mun/core/node';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'e2e-out'));
const DATA = path.join(OUT, 'profiles');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const crypto = createNodeCrypto();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => Promise<T | false | null | undefined> | T | false | null | undefined, ms = 20_000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < ms) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

const results: { step: string; ok: boolean; detail?: string }[] = [];
function check(step: string, ok: boolean, detail?: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
}

// ── A tiny DevTools client ──

// Helpers injected into the page: find inputs by placeholder and buttons by their text.
const HELPERS = `globalThis.__t ??= {
  buttons(text) { return [...document.querySelectorAll('[role=button]')].filter((e) => e.innerText.trim() === text); },
  click(text, i = 0) { const b = this.buttons(text)[i]; if (!b) throw new Error('no button: ' + text); b.click(); return true; },
  clickStarting(text) { const b = [...document.querySelectorAll('[role=button]')].find((e) => e.innerText.trim().startsWith(text)); if (!b) throw new Error('no button: ' + text); b.click(); return true; },
  fill(placeholder, value) {
    const el = [...document.querySelectorAll('input,textarea')].find((e) => e.placeholder === placeholder);
    if (!el) throw new Error('no field: ' + placeholder);
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
  key(k) { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); return true; },
  text() { return document.body.innerText; },
};`;

class Page {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<number, (v: { result?: unknown; error?: { message: string } }) => void>();
  readonly name: string;
  readonly proc: ChildProcess;
  private constructor(name: string, proc: ChildProcess) {
    this.name = name;
    this.proc = proc;
  }

  static async launch(name: string, port: number): Promise<Page> {
    const proc = spawn(ELECTRON, [`--remote-debugging-port=${port}`, path.join(ROOT, 'apps', 'desktop'), `--profile=${name}`], {
      env: { ...process.env, MUN_USER_DATA: DATA },
      stdio: 'ignore',
    });
    const page = new Page(name, proc);
    const target = await waitFor(`${name} DevTools`, async () => {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      return list.find((t) => t.type === 'page' && t.url.startsWith('app://'));
    });
    page.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      page.ws.onopen = r;
      page.ws.onerror = j;
    });
    page.ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id !== undefined) page.waiting.get(msg.id)?.(msg);
    };
    await waitFor(`${name} UI`, () => page.eval<boolean>('document.body.innerText.length > 20'));
    return page;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<{ result?: unknown; error?: { message: string } }> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.waiting.set(id, r));
  }

  async eval<T>(expression: string): Promise<T> {
    const res = (await this.send('Runtime.evaluate', { expression: `${HELPERS}\n${expression}`, awaitPromise: true, returnByValue: true })) as {
      result?: { result: { value: T }; exceptionDetails?: { exception?: { description?: string } } };
    };
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'page error');
    return res.result!.result.value;
  }

  text = () => this.eval<string>('__t.text()');
  click = (label: string, i = 0) => this.eval(`__t.click(${JSON.stringify(label)}, ${i})`);
  fill = (placeholder: string, value: string) => this.eval(`__t.fill(${JSON.stringify(placeholder)}, ${JSON.stringify(value)})`);

  async shot(file: string) {
    const res = (await this.send('Page.captureScreenshot', { format: 'png' })) as { result: { data: string } };
    writeFileSync(path.join(OUT, file), Buffer.from(res.result.data, 'base64'));
  }

  close() {
    this.ws?.close();
    this.proc.kill();
  }
}

// ── Scripted phones ──

async function phone(invite: string, name: string, code?: string) {
  const inv = parseInvite(invite)!;
  const node = new MeshNode({ conf: inv.conf, identity: createIdentity(), subs: [inv.com!], now: Date.now, crypto });
  const device = new Device({ node, transport: nodeTransport, listenPort: null, maxOutbound: 3 });
  // Like the phone app: small files arrive by themselves, bigger ones on request.
  const files = new FileManager({ node, store: new MemoryChunkStore(), now: Date.now, autoFetch: (att) => att.size <= 2 * 1024 * 1024 });
  await files.start();
  // Reports every 5 s here (60 s in the apps) so the field-test step is quick.
  const reporter = new FieldTestReporter(node, { platform: 'bot', relay: false, links: () => ({ tcp: node.neighbours().length, nearby: 0 }), now: Date.now, everyMs: 5000 });
  const timer = setInterval(() => {
    files.tick();
    reporter.tick();
  }, 1000);
  for (const h of inv.hubs) device.addAddress(h, 'invite');
  await device.start();
  node.requestJoin({ name, role: 'delegate', com: inv.com!, ...(code ? { code } : {}) });
  return { node, device, files, timer, com: inv.com!, name };
}

function testBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}
type Phone = Awaited<ReturnType<typeof phone>>;
const member = (p: Phone) => p.node.replica.auth.roles(p.node.key).length > 0;
const hasText = (p: Phone, scope: string, text: string) =>
  p.node.replica.store.events(scope).some((e) => (e as Event<'post'>).b.text === text);

/** Pastes a roster ("code, name" per line) into an EB console's Join panel and imports it. */
async function importRoster(page: Page, roster: string) {
  await page.eval(`__t.click([...document.querySelectorAll('[role=button]')].map(e => e.innerText.trim()).find(t => t.startsWith('Join')))`);
  await page.fill('FR-7Q2, France\nUS-K91, United States', roster);
  await page.click('Import roster');
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  const pages: Page[] = [];
  const phones: Phone[] = [];
  try {
    // 1. Secretariat creates the conference through the UI.
    const sec = await Page.launch('sec', 9311);
    pages.push(sec);
    await sec.click('Create a conference');
    await sec.fill('e.g. Dhaka MUN 2026', 'E2E MUN');
    await sec.fill('DISEC — Disarmament and International Security\nUNSC — Security Council\nUNHRC — Human Rights Council', 'DISEC — Disarmament\nUNSC — Security Council');
    await sec.click('Create');
    await waitFor('Secretariat console', async () => (await sec.text()).includes('EB channel'));
    check('Secretariat creates the conference', true);
    const staffInvite = await sec.eval<string>('munSession.invite()');

    // 2. Two EB laptops ask to join; the Secretariat approves them in its Join panel.
    const ebs: Page[] = [];
    for (const [name, port, com] of [['eb-disec', 9312, 'DISEC'], ['eb-unsc', 9313, 'UNSC']] as const) {
      const eb = await Page.launch(name, port);
      pages.push(eb);
      ebs.push(eb);
      await eb.fill('mun://join?i=…', staffInvite);
      await eb.click('Continue');
      await waitFor(`${name} join form`, async () => (await eb.text()).includes('I am'));
      await eb.click('Executive Board');
      await eb.click(com);
      await eb.fill('e.g. Ayesha Rahman', `${com} Chair`);
      await eb.click('Ask to join');
      await waitFor(`${name} waiting`, async () => (await eb.text()).includes('Waiting for approval'));
    }
    await sec.eval(`__t.click([...document.querySelectorAll('[role=button]')].map(e => e.innerText.trim()).find(t => t.startsWith('Join')))`);
    await waitFor('both EB requests at the Secretariat', async () => (await sec.eval<number>('munSession.approvable().length')) === 2);
    await sec.shot('1-secretariat-requests.png');
    await sec.click('Approve');
    // Wait for the screen, not just the session: clicking a stale button would approve the same request twice.
    await waitFor('one request left on screen', async () => (await sec.text()).includes('ASKING TO JOIN (1)') || (await sec.text()).includes('Asking to join (1)'));
    await sec.click('Approve');
    const [ebDisec, ebUnsc] = ebs as [Page, Page];
    for (const eb of ebs) await waitFor(`${eb.name} console`, async () => (await eb.text()).includes('Chits'));
    check('Secretariat approves both EB laptops from its console', true);

    // 3. Phones join DISEC: two with roster codes (let in automatically), one approved by hand.
    await ebDisec.eval(`__t.click([...document.querySelectorAll('[role=button]')].map(e => e.innerText.trim()).find(t => t.startsWith('Join')))`);
    await ebDisec.fill('FR-7Q2, France\nUS-K91, United States', 'FR-1, France\nKE-2, Kenya');
    await ebDisec.click('Import roster');
    const disecInvite = await ebDisec.eval<string>(`munSession.invite('disec')`);
    const unscInvite = await ebUnsc.eval<string>(`munSession.invite('unsc')`);
    const france = await phone(disecInvite, 'france-phone', 'FR-1');
    const kenya = await phone(disecInvite, 'kenya-phone', 'KE-2');
    const peru = await phone(disecInvite, 'Peru');
    const japan = await phone(unscInvite, 'Japan');
    phones.push(france, kenya, peru, japan);
    await waitFor('roster phones let in', () => member(france) && member(kenya));
    check(
      'roster codes let delegates in under the roster name',
      france.node.replica.auth.member(france.node.key)?.name === 'France' && kenya.node.replica.auth.member(kenya.node.key)?.name === 'Kenya',
    );
    await waitFor('Peru request on the EB laptop', async () => (await ebDisec.text()).includes('Peru'));
    await ebDisec.shot('2-eb-join-requests.png');
    await ebDisec.click('Approve');
    await ebUnsc.eval(`__t.click([...document.querySelectorAll('[role=button]')].map(e => e.innerText.trim()).find(t => t.startsWith('Join')))`);
    await waitFor('Japan request', async () => (await ebUnsc.text()).includes('Japan'));
    await ebUnsc.click('Approve');
    await waitFor('Peru and Japan let in', () => member(peru) && member(japan));
    check('EB approves a delegate from the console', true);

    // 4. Committee chat both ways.
    post(france.node, 'disec', 'France opens the debate.');
    await waitFor('France’s post on the EB console', async () => (await ebDisec.text()).includes('France opens the debate.'));
    await ebDisec.click('Chits');
    await ebDisec.fill('Message the committee…', 'Welcome, delegates.');
    await ebDisec.click('Send');
    await waitFor('EB post on phones', () => hasText(peru, 'disec', 'Welcome, delegates.'));
    check('committee messages flow between the EB console and phones', true);

    // 5. A chit through the EB queue, approved with the keyboard.
    sendChit(france.node, 'disec', kenya.node.key, 'Support clause 4?');
    await waitFor('chit in the EB queue', async () => (await ebDisec.text()).includes('Support clause 4?'));
    await ebDisec.shot('3-eb-chit-queue.png');
    const before = scopeView(kenya.node.replica, 'disec').chits[0];
    check('the recipient can’t read a chit before approval', !!before && !readChit(kenya.node, before));
    await ebDisec.eval(`__t.key('a')`);
    await waitFor('Kenya reads the approved chit', () => {
      const c = scopeView(kenya.node.replica, 'disec').chits[0];
      return c?.status === 'approved' && readChit(kenya.node, c)?.text === 'Support clause 4?';
    });
    check('pressing A approves the chit and Kenya can read it', true);

    // 6. Moderation from the roster: mute Peru.
    await ebDisec.click('Peru');
    await ebDisec.click('Mute');
    await waitFor('Peru sees the mute', () => scopeView(peru.node.replica, 'disec').muted.includes(peru.node.key));
    post(peru.node, 'disec', 'Peru shouts.');
    await waitFor('muted post hidden on the EB console', async () => (await ebDisec.text()).toLowerCase().includes('hidden: sent while muted'));
    check('a mute from the console reaches the delegate and hides their posts', !scopeView(france.node.replica, 'disec').posts.some((p) => p.b.text === 'Peru shouts.'));

    // 7. Across committees: EB channel and a conference announcement.
    await ebDisec.click('EB channel');
    await ebDisec.fill('Message all EBs and the Secretariat…', 'DISEC breaks at 11.');
    await ebDisec.click('Send');
    await ebUnsc.click('EB channel');
    await waitFor('UNSC chair reads the EB message', async () => (await ebUnsc.text()).includes('DISEC breaks at 11.'));
    await sec.click('Conference announcements');
    await sec.fill('Announce to the whole conference…', 'Lunch is at 1 pm.');
    await sec.click('Announce');
    await waitFor('announcement on phones in both committees', () => hasText(peru, 'global', 'Lunch is at 1 pm.') && hasText(japan, 'global', 'Lunch is at 1 pm.'));
    check('EB channel and Secretariat announcements cross committees', true);
    check('delegates never receive the EB channel', france.node.replica.store.events('eb').length === 0);

    // 8. A delegate on a laptop: the delegate screen.
    const delegatePage = await Page.launch('delegate', 9314);
    pages.push(delegatePage);
    await delegatePage.fill('mun://join?i=…', disecInvite);
    await delegatePage.click('Continue');
    await waitFor('join form', async () => (await delegatePage.text()).includes('I am'));
    await delegatePage.fill('e.g. France', 'Brazil');
    await delegatePage.click('Ask to join');
    await ebDisec.click('DISEC — Disarmament');
    await waitFor('Brazil request', async () => {
      await ebDisec.eval(`__t.click([...document.querySelectorAll('[role=button]')].map(e => e.innerText.trim()).find(t => t.startsWith('Join')))`);
      return (await ebDisec.text()).includes('Brazil');
    });
    await ebDisec.click('Approve');
    await waitFor('delegate screen', async () => (await delegatePage.text()).includes('Pass a chit') || (await delegatePage.text()).includes('Committee'));
    await waitFor('history on the new laptop', async () => (await delegatePage.text()).includes('France opens the debate.'));
    await delegatePage.shot('5-delegate-laptop.png');
    check('a laptop delegate joins and receives the history', true);

    // 9. Files: a phone shares a 3 MB file; the hub keeps it; another phone downloads it on request.
    const paper = testBytes(3 * 1024 * 1024, 11);
    const up = await france.files.addLocal(paper);
    const filePost = post(france.node, 'disec', 'Our working paper', {
      file: { ...up, name: 'working-paper.pdf', mime: 'application/pdf' },
    });
    await ebDisec.click('DISEC — Disarmament');
    await waitFor('the EB laptop has the whole file', async () => (await ebDisec.eval<boolean>(`!!munSession.files.status('${up.att.id}')?.done`)), 60_000);
    await waitFor('file card on the console', async () => (await ebDisec.text()).includes('working-paper.pdf'));
    await ebDisec.shot('8-eb-file.png');
    check('the hub fetched the file by itself and shows it in the chat', true);
    await waitFor('Kenya sees the post', () => kenya.node.replica.store.has(filePost.id));
    check('a 3 MB file isn’t pushed to phones uninvited', !kenya.files.status(up.att.id)!.wanted);
    kenya.files.want(up.att.id);
    await waitFor('Kenya downloads the file', () => kenya.files.status(up.att.id)?.done, 60_000);
    const got = fileOf(kenya.node, kenya.node.replica.store.get(filePost.id)!)!;
    const back = await kenya.files.read(got.att, got.meta);
    check('the downloaded file matches byte for byte', !!back && Buffer.compare(back, paper) === 0);

    // The EB attaches a file from the console's session; phones fetch small ones automatically.
    const agendaId = await ebDisec.eval<string>(`(async () => {
      const data = new Uint8Array(200000); for (let i = 0; i < data.length; i++) data[i] = i % 251;
      const f = await munSession.prepareFile({ name: 'agenda.txt', mime: 'text/plain', data }, 'disec');
      munSession.node.publish('disec', 'announce', { text: 'Today’s agenda', att: f.att, file: { name: f.name, mime: f.mime, key: f.key } });
      return f.att.id;
    })()`);
    await waitFor('Peru receives the EB’s small file by itself', () => peru.files.status(agendaId)?.done, 60_000);
    check('a small file from the EB reaches phones without a tap', true);

    // File rules set from the console reach the phones.
    await ebDisec.eval(`__t.click([...document.querySelectorAll('[role=button]')].map(e => e.innerText.trim()).find(t => t.startsWith('Files: up to')))`);
    await ebDisec.fill('exe, apk, bat', 'exe, apk');
    await ebDisec.eval(`(() => { const el = [...document.querySelectorAll('input')].find(e => e.value === '25'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '1'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await ebDisec.click('Save rules');
    await waitFor('rules reach France', () => fileRules(france.node.replica, 'disec').maxMB === 1);
    check('file rules from the console reach the phones', fileRules(france.node.replica, 'disec').block.join(',') === 'exe,apk');

    // 10. Restart the DISEC chair's laptop: its history survives and it reconnects.
    await ebDisec.shot('4-eb-console.png');
    await sec.shot('6-secretariat-console.png');
    ebDisec.close();
    pages.splice(pages.indexOf(ebDisec), 1);
    await sleep(1500);
    post(france.node, 'disec', 'Posted while the chair was restarting.');
    const reopened = await Page.launch('eb-disec', 9315);
    pages.push(reopened);
    await waitFor('chair console after restart', async () => (await reopened.text()).includes('Welcome, delegates.'), 30_000);
    await waitFor('missed message after restart', async () => (await reopened.text()).includes('Posted while the chair was restarting.'), 30_000);
    check('the chair’s laptop keeps its history across a restart and catches up', true);
    await reopened.shot('7-eb-after-restart.png');

    // 11. Moderation through the console, across hops: lock, remove a delegate, remove an EB laptop.
    await reopened.click('Lock channel');
    await waitFor('France sees the lock', () => scopeView(france.node.replica, 'disec').locked);
    post(france.node, 'disec', 'Talking during the lock');
    await waitFor('locked post hidden on the console', async () => (await reopened.text()).toLowerCase().includes('hidden: sent while locked'));
    check('a lock from the console hides posts made during it', !scopeView(kenya.node.replica, 'disec').posts.some((p) => p.b.text === 'Talking during the lock'));
    await reopened.click('Locked — unlock');
    await waitFor('unlocked', () => !scopeView(france.node.replica, 'disec').locked);

    // Roster rows also hold badges (EB, MUTED), so match the start of their text.
    await reopened.eval(`__t.clickStarting('Peru')`);
    await reopened.click('Remove…');
    await reopened.click('Confirm: remove device');
    await waitFor('Peru learns it was removed', () => peru.node.replica.auth.isRemoved(peru.node.key));
    await sleep(2000);
    const afterKick = post(france.node, 'disec', 'Said after Peru was removed');
    await sleep(3000);
    check('a removed delegate is cut off and hears nothing more', !peru.node.replica.store.has(afterKick.id) && peru.node.neighbours().length === 0);

    await sec.click('UNSC — Security Council');
    await waitFor('UNSC chair in the Secretariat roster', async () => (await sec.text()).includes('UNSC Chair'));
    await sec.eval(`__t.clickStarting('UNSC Chair')`);
    await sec.click('Remove…');
    await sec.click('Confirm: remove device');
    await waitFor('the UNSC laptop shows it was removed', async () => (await ebUnsc.text()).includes('You’ve been removed'), 30_000);
    await ebUnsc.shot('9-eb-removed.png');
    check('the Secretariat removes an EB laptop from its console', true);

    // 12. Field test from the Secretariat's console, and the load generator's bots joining by roster.
    await sec.click('DISEC — Disarmament');
    await sec.click('Field test');
    await sec.click('Start a test');
    await waitFor('reports from phones in the panel', async () => {
      const text = await sec.text();
      return text.includes('France · bot') && text.includes('Kenya · bot');
    }, 40_000);
    await sec.shot('10-field-test.png');
    check('the field test panel shows phones’ reports', true);
    await sec.click('Stop test');

    await importRoster(reopened, [1, 2, 3, 4, 5].map((n) => `BOT-0${n}, Bot 0${n}`).join('\n'));
    const botsInvite = await reopened.eval<string>(`munSession.invite('disec')`);
    const bots = spawn(process.execPath, ['--no-warnings', '--import', './scripts/register-ts.mjs', 'scripts/bots.ts', '--invite', botsInvite, '--count', '5', '--every', '5'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    try {
      await waitFor('five bots let in', async () => (await reopened.eval<number>(
        `munSession.node.replica.auth.all().filter((m) => m.name.startsWith('Bot ')).length`,
      )) === 5, 60_000);
      await waitFor('bots chatting', async () => (await reopened.text()).includes('Bot 0'), 30_000);
      check('the load generator’s bots join by roster and chat', true);
    } finally {
      bots.kill();
    }
  } catch (e) {
    check('run completed', false, e instanceof Error ? e.message : String(e));
    for (const p of pages) await p.shot(`failure-${p.name}.png`).catch(() => {});
  } finally {
    for (const p of phones) {
      clearInterval(p.timer);
      p.device.stop();
    }
    for (const p of pages) p.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} step(s) FAILED. Screenshots in ${OUT}` : `\nAll steps passed. Screenshots in ${OUT}`);
  process.exit(failed ? 1 : 0);
}

void main();
