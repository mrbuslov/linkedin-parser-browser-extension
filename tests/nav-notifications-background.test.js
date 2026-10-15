// Exercises the real background.js glue: stored-count comparison, the
// per-counter settings gate, quiet hours, the toolbar badge and the
// serialization that stops two LinkedIn tabs from notifying twice about one
// message. dbGet/dbSet are replaced after load, so IndexedDB is never touched.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(__dirname, '../linkedin-tracker');

function loadServiceWorker() {
  const created = [];
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    Promise, JSON, Object, Array, Set, Map, Date, Math, Number, String, RegExp, URL,
    TypeError, Error, RangeError,
    importScripts: () => {},
    indexedDB: { open: () => { throw new Error('IndexedDB is not available in this test'); } },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => { sandbox._onMessage = fn; } },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        getURL: (p) => `chrome-extension://test/${p}`,
        getManifest: () => ({ version: 'test' }),
      },
      notifications: {
        create: (id, options) => { created.push({ id, options }); return Promise.resolve(id); },
        clear: () => Promise.resolve(true),
        getPermissionLevel: () => Promise.resolve(sandbox._permissionLevel ?? 'granted'),
        onClicked: { addListener: (fn) => { sandbox._onNotificationClick = fn; } },
      },
      action: {
        setBadgeText: (args) => { sandbox._badge = args.text; return Promise.resolve(); },
        setBadgeBackgroundColor: () => Promise.resolve(),
        setTitle: () => Promise.resolve(),
      },
      tabs: { query: () => Promise.resolve(sandbox._tabs ?? []), update: () => Promise.resolve(), create: (args) => { sandbox._createdTab = args; return Promise.resolve(); }, onUpdated: { addListener: () => {} } },
      windows: { update: () => Promise.resolve() },
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const files = ['core/schema-v2.js', 'core/visit-queue-simple.js', 'core/settings.js', 'core/nav-watch.js', 'background.js'];
  for (const file of files) vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), sandbox, { filename: file });
  return { sandbox, created };
}

function withStore(sandbox, store) {
  sandbox.dbGet = (keys) => {
    const list = keys === null ? Object.keys(store) : [].concat(keys);
    return Promise.resolve(Object.fromEntries(list.map((k) => [k, store[k]])));
  };
  sandbox.dbSet = (data) => { Object.assign(store, data); return Promise.resolve(); };
  return store;
}

const TOP = { name: 'Alice Example', time: '9:22 AM', preview: 'Alice: sure' };
const counts = (messages, invitations = 0, activity = 0) => ({ messages, invitations, activity });
const storedAt = (messages, invitations = 0, activity = 0, key = null) => ({
  messages: { lastCount: messages, lastConversationKey: key, updatedAt: 1 },
  invitations: { lastCount: invitations, lastConversationKey: key, updatedAt: 1 },
  activity: { lastCount: activity, lastConversationKey: key, updatedAt: 1 },
});

let sw;
beforeEach(() => { sw = loadServiceWorker(); });

describe('handleNavObserved', () => {
  it('takes a baseline on the first report and notifies on the next increase', async () => {
    const store = withStore(sw.sandbox, {});
    expect(await sw.sandbox.handleNavObserved({ counts: counts(2), top: TOP })).toMatchObject({ notified: [] });
    expect(sw.created).toHaveLength(0);
    expect(store.navWatch.messages.lastCount).toBe(2);

    const result = await sw.sandbox.handleNavObserved({
      counts: counts(3), top: { ...TOP, time: '9:30 AM', preview: 'Alice: one more' },
    });
    expect(result.notified).toEqual(['messages']);
    expect(sw.created).toHaveLength(1);
    expect(sw.created[0].options).toMatchObject({ title: 'Alice Example', message: 'Alice: one more' });
    expect(sw.created[0].id.startsWith('lit-nav:messages:')).toBe(true);
  });

  it('notifies per counter that grew', async () => {
    withStore(sw.sandbox, { navWatch: storedAt(0, 0, 0), settings: { activityNotifications: true } });
    const result = await sw.sandbox.handleNavObserved({ counts: counts(1, 2, 3), top: TOP });
    expect(result.notified).toEqual(['messages', 'invitations', 'activity']);
    expect(sw.created.map((n) => n.options.message)).toEqual(['Alice: sure', '2 new invitations', '3 new notifications']);
  });

  it('two tabs reporting the same new message notify once', async () => {
    withStore(sw.sandbox, { navWatch: storedAt(0) });
    await Promise.all([
      sw.sandbox.handleNavObserved({ counts: counts(1), top: TOP }),
      sw.sandbox.handleNavObserved({ counts: counts(1), top: TOP }),
    ]);
    expect(sw.created).toHaveLength(1);
  });

  it('respects the per-counter toggles but keeps every baseline current', async () => {
    const store = withStore(sw.sandbox, {
      settings: { messageNotifications: false, invitationNotifications: true },
      navWatch: storedAt(0, 0, 0),
    });
    const result = await sw.sandbox.handleNavObserved({ counts: counts(1, 1, 1), top: TOP });
    expect(result.notified).toEqual(['invitations']);
    expect(result.pending).toEqual(['messages', 'invitations', 'activity']);
    expect(store.navWatch.messages.lastCount).toBe(1);
  });

  it('counts silently during quiet hours', async () => {
    const store = withStore(sw.sandbox, {
      settings: { quietHoursEnabled: true, quietHoursStart: '00:00', quietHoursEnd: '23:59' },
      navWatch: storedAt(0),
    });
    const result = await sw.sandbox.handleNavObserved({ counts: counts(1), top: TOP });
    expect(result).toMatchObject({ notified: [], quietHours: true });
    expect(sw.created).toHaveLength(0);
    expect(store.navWatch.messages.lastCount).toBe(1);
  });

  it('rejects a malformed report instead of notifying', async () => {
    withStore(sw.sandbox, {});
    await expect(sw.sandbox.handleNavObserved({ counts: { messages: 'many' }, top: null })).rejects.toThrow(TypeError);
  });
});

describe('toolbar badge', () => {
  it('shows people waiting for a welcome message by default', async () => {
    withStore(sw.sandbox, {
      contacts: { a: { status: 'accepted' }, b: { status: 'accepted', marked: true }, c: { status: 'visited' } },
      navWatch: storedAt(4, 4, 4),
    });
    await sw.sandbox.refreshBadge();
    expect(sw.sandbox._badge).toBe('1');
  });

  it('switches to the LinkedIn counts when the user asks for it', async () => {
    withStore(sw.sandbox, {
      contacts: { a: { status: 'accepted' } },
      navWatch: storedAt(4, 3, 9),
      settings: { badgeShowsLinkedInCounts: true },
    });
    await sw.sandbox.refreshBadge();
    expect(sw.sandbox._badge).toBe('7');
  });

  it('is refreshed as part of handling a report', async () => {
    withStore(sw.sandbox, { navWatch: storedAt(0), settings: { badgeShowsLinkedInCounts: true } });
    await sw.sandbox.handleNavObserved({ counts: counts(2, 1), top: TOP });
    expect(sw.sandbox._badge).toBe('3');
  });
});

describe('notification self-test', () => {
  it('sends a notification and reports permission, enabled counters and quiet hours', async () => {
    withStore(sw.sandbox, {});
    const result = await sw.sandbox.runNotificationSelfTest();
    expect(result).toMatchObject({ level: 'granted', quietHours: false });
    expect(result.enabled).toEqual(['messages', 'invitations']);
    expect(sw.created).toHaveLength(1);
  });

  it('raises with the permission level when Chrome blocks notifications', async () => {
    withStore(sw.sandbox, {});
    sw.sandbox._permissionLevel = 'denied';
    await expect(sw.sandbox.runNotificationSelfTest()).rejects.toThrow(/denied/);
    expect(sw.created).toHaveLength(0);
  });
});

describe('notification click', () => {
  it('opens the page the notification came from and ignores other ids', async () => {
    withStore(sw.sandbox, {});
    sw.sandbox._onNotificationClick('lit-nav:invitations:123-1');
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.sandbox._createdTab).toEqual({ url: 'https://www.linkedin.com/mynetwork/' });

    sw.sandbox._createdTab = undefined;
    sw.sandbox._onNotificationClick('lit-nav:messages:124-2');
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.sandbox._createdTab).toEqual({ url: 'https://www.linkedin.com/messaging/' });

    sw.sandbox._createdTab = undefined;
    sw.sandbox._onNotificationClick('some-other-notification');
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.sandbox._createdTab).toBeUndefined();
  });

  it('raises on a notification id carrying an unknown target', () => {
    withStore(sw.sandbox, {});
    expect(() => sw.sandbox._onNotificationClick('lit-nav:inbox:1-1')).toThrow(/unknown target/);
  });
});
