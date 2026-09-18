// Runs the real profile.js bundle (manifest order) in jsdom against a simulated
// service worker and checks the bulk-queue driver's reaction to each scenario.
// Run: `npm run smoke:queue`

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const ROOT = resolve(import.meta.dirname, '../linkedin-tracker');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));
const bundle = manifest.content_scripts.find((c) => c.js.includes('profile.js')).js;
const Q = (await import(resolve(ROOT, 'core/visit-queue-simple.js'))).default;

const TAB_ID = 5;
const PROFILE = 'https://www.linkedin.com/in/preetachandran/';
const OTHER = 'https://www.linkedin.com/in/someone-else/';
const SETTLE_MS = 1500;

const uncaught = [];
process.on('unhandledRejection', (e) => uncaught.push(String(e?.message ?? e)));

const currentSw = (store, msg, sender) => {
  if (msg.type === 'DB_GET') {
    return { ok: true, value: Object.fromEntries([].concat(msg.keys).map((k) => [k, store[k] ?? null])) };
  }
  if (msg.type === 'DB_SET') {
    Object.assign(store, msg.data);
    return { ok: true };
  }
  if (msg.type === 'GET_OWN_TAB_ID') return { ok: true, value: sender.tabId };
  return undefined;
};

const tabIdFailingSw = (store, msg, sender) =>
  msg.type === 'GET_OWN_TAB_ID' ? { ok: false, error: 'simulated failure' } : currentSw(store, msg, sender);

// Service worker older than the {ok, value} reply envelope: raw DB_GET payload, no GET_OWN_TAB_ID.
const outdatedSw = (store, msg) => {
  if (msg.type === 'DB_GET') return Object.fromEntries([].concat(msg.keys).map((k) => [k, store[k] ?? null]));
  if (msg.type === 'DB_SET') {
    Object.assign(store, msg.data);
    return true;
  }
  return undefined;
};

async function runPage({ url, tabId, pageStartedAt, queue, sw }) {
  uncaught.length = 0;
  const store = { visitQueueSimple: queue };
  const logs = [];
  const dom = new JSDOM('<html><body><main></main></body></html>', { url, runScripts: 'outside-only' });
  const win = dom.window;
  Object.defineProperty(win.performance, 'timeOrigin', { value: pageStartedAt });
  win.chrome = {
    runtime: {
      getManifest: () => ({ version: manifest.version }),
      onMessage: { addListener() {} },
      sendMessage: async (msg) => sw(store, msg, { tabId }),
    },
  };
  const record = (level) => (...args) => logs.push(`${level} ${args.map(String).join(' ')}`);
  win.console = { log: record('log'), info: record('info'), warn: record('warn'), error: record('error') };
  const ctx = dom.getInternalVMContext();
  for (const file of bundle) vm.runInContext(readFileSync(resolve(ROOT, file), 'utf8'), ctx, { filename: file });
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  win.close();
  return {
    queue: store.visitQueueSimple,
    logs: logs.filter((l) => l.includes('LI Tracker/queue')),
    uncaught: uncaught.slice(),
  };
}

const freshQueue = (urls, now) => ({ ...Q.createQueue(urls, now, 1), tabId: TAB_ID });

const scenarios = [
  {
    name: 'fresh queue page starts reading',
    run: (now) => runPage({ url: PROFILE, tabId: TAB_ID, pageStartedAt: now + 100, queue: freshQueue([PROFILE], now), sw: currentSw }),
    check: ({ queue, logs }) =>
      logs.some((l) => l.includes('reading')) && Q.isActive(queue) && queue.awaitingLandingFor === null,
  },
  {
    name: 'page open before Start ignores the queue',
    run: (now) => runPage({ url: PROFILE, tabId: TAB_ID, pageStartedAt: now - 60_000, queue: freshQueue([PROFILE], now), sw: currentSw }),
    check: ({ queue, logs }) => logs.length === 0 && Q.isActive(queue) && queue.awaitingLandingFor === PROFILE,
  },
  {
    name: 'redirected landing is accepted',
    run: (now) => runPage({ url: OTHER, tabId: TAB_ID, pageStartedAt: now + 100, queue: freshQueue([PROFILE], now), sw: currentSw }),
    check: ({ queue, logs }) => logs.some((l) => l.includes('redirect accepted')) && queue.landedUrl === OTHER,
  },
  {
    name: 'another tab never drives the queue',
    run: (now) => runPage({ url: PROFILE, tabId: TAB_ID + 1, pageStartedAt: now + 100, queue: freshQueue([PROFILE], now), sw: currentSw }),
    check: ({ queue, logs }) => logs.length === 0 && queue.awaitingLandingFor === PROFILE,
  },
  {
    name: 'driver crash pauses the queue with the error instead of wiping it',
    run: (now) => runPage({ url: PROFILE, tabId: TAB_ID, pageStartedAt: now + 100, queue: freshQueue([PROFILE], now), sw: tabIdFailingSw }),
    check: ({ queue, logs }) =>
      logs.some((l) => l.startsWith('error') && l.includes('driver crashed'))
      && Q.isPaused(queue) && queue.error.includes('simulated failure') && queue.urls[0] === PROFILE,
  },
  {
    name: 'outdated service worker leaves the queue untouched and fails loudly with a reload hint',
    run: (now) => runPage({ url: PROFILE, tabId: TAB_ID, pageStartedAt: now + 100, queue: freshQueue([PROFILE], now), sw: outdatedSw }),
    check: ({ queue, uncaught }) =>
      uncaught.some((e) => e.includes('reload the extension')) && Q.isActive(queue) && queue.awaitingLandingFor === PROFILE,
  },
];

let failed = 0;
for (const s of scenarios) {
  const result = await s.run(Date.now());
  const ok = s.check(result);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.name}`);
  if (!ok) {
    console.log(`      queue: ${JSON.stringify(result.queue)}`);
    for (const l of [...result.logs, ...result.uncaught]) console.log(`      ${l}`);
  }
}
console.log(`\n${scenarios.length - failed}/${scenarios.length} passed`);
process.exit(failed ? 1 : 0);
