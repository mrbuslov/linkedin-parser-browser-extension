// Exercises the real background.js glue: the stored-count comparison, the
// settings gate and the serialization that stops two LinkedIn tabs from
// notifying twice about one message. dbGet/dbSet are replaced after load, so
// IndexedDB is never touched.

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
      action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
      tabs: { query: () => Promise.resolve(sandbox._tabs ?? []), update: () => Promise.resolve(), create: (args) => { sandbox._createdTab = args; return Promise.resolve(); }, onUpdated: { addListener: () => {} } },
      windows: { update: () => Promise.resolve() },
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const files = ['core/schema-v2.js', 'core/visit-queue-simple.js', 'core/settings.js', 'core/message-watch.js', 'background.js'];
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

let sw;
beforeEach(() => { sw = loadServiceWorker(); });

describe('handleMessagingObserved', () => {
  it('takes a baseline on the first report and notifies on the next increase', async () => {
    const store = withStore(sw.sandbox, {});
    expect(await sw.sandbox.handleMessagingObserved({ unread: 2, top: TOP })).toMatchObject({ notified: false });
    expect(sw.created).toHaveLength(0);
    expect(store.messageWatch.lastUnread).toBe(2);

    const result = await sw.sandbox.handleMessagingObserved({ unread: 3, top: { ...TOP, time: '9:30 AM', preview: 'Alice: one more' } });
    expect(result).toMatchObject({ notified: true, unread: 3 });
    expect(sw.created).toHaveLength(1);
    expect(sw.created[0].options).toMatchObject({ title: 'Alice Example', message: 'Alice: one more' });
    expect(sw.created[0].id.startsWith('lit-msg:')).toBe(true);
  });

  it('two tabs reporting the same new message notify once', async () => {
    withStore(sw.sandbox, { messageWatch: { lastUnread: 0, lastConversationKey: null, updatedAt: 1 } });
    await Promise.all([
      sw.sandbox.handleMessagingObserved({ unread: 1, top: TOP }),
      sw.sandbox.handleMessagingObserved({ unread: 1, top: TOP }),
    ]);
    expect(sw.created).toHaveLength(1);
  });

  it('stays silent while the toggle is off but keeps the baseline current', async () => {
    const store = withStore(sw.sandbox, {
      settings: { messageNotifications: false },
      messageWatch: { lastUnread: 0, lastConversationKey: null, updatedAt: 1 },
    });
    expect(await sw.sandbox.handleMessagingObserved({ unread: 1, top: TOP })).toMatchObject({ notified: false, mutedBySettings: true });
    expect(sw.created).toHaveLength(0);
    expect(store.messageWatch.lastUnread).toBe(1);
  });

  it('rejects a malformed report instead of notifying', async () => {
    withStore(sw.sandbox, {});
    await expect(sw.sandbox.handleMessagingObserved({ unread: 'many', top: null })).rejects.toThrow(TypeError);
  });
});

describe('notification self-test', () => {
  it('sends a notification and reports the permission level', async () => {
    withStore(sw.sandbox, {});
    const result = await sw.sandbox.runNotificationSelfTest();
    expect(result).toMatchObject({ level: 'granted', messageNotifications: true });
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
  it('opens messaging for our notifications and ignores other extensions ids', async () => {
    withStore(sw.sandbox, {});
    sw.sandbox._onNotificationClick('lit-msg:123-1');
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.sandbox._createdTab).toEqual({ url: 'https://www.linkedin.com/messaging/' });

    sw.sandbox._createdTab = undefined;
    sw.sandbox._onNotificationClick('some-other-notification');
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.sandbox._createdTab).toBeUndefined();
  });
});
