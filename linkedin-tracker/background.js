// Service worker. Owns the IndexedDB store and forwards all reads/writes
// from other extension contexts. On every write, broadcasts a DB_CHANGED
// message so the popup can live-rerender. Also refreshes the toolbar badge
// when `contacts` changes and pops a notification when SCAN_DONE arrives.
//
// On startup, runs the v1 → v2 storage migration if needed (idempotent).
// This ensures content scripts and the popup can always assume unified
// `contacts` shape, regardless of who woke up first after an update.

importScripts('core/schema-v2.js', 'core/visit-queue-simple.js');

// Bulk Visit Queue disabled for the 1.3.0 Chrome Web Store submission —
// the tabs/alarms/idle/webNavigation permissions triggered a
// justification round we're not ready to defend yet. The pure-logic
// modules (core/humanizer.js, core/visit-queue.js, core/visit-runner.js)
// and content scripts (visit-content.js, visit-feed.js) remain in the
// repo so 1.3.1 can re-enable the feature without a re-implementation.
// The service-worker glue that wired them into chrome.tabs / alarms /
// idle / webNavigation is commented out below.

const DB_NAME = 'linkedin-tracker';
const DB_VERSION = 1;
const STORE = 'kv';

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function dbGet(keys) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);

    if (keys == null) {
      const result = {};
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          result[cursor.key] = cursor.value;
          cursor.continue();
        } else {
          resolve(result);
        }
      };
      req.onerror = () => reject(req.error);
      return;
    }

    const keyList = Array.isArray(keys) ? keys : [keys];
    const result = {};
    let remaining = keyList.length;
    if (remaining === 0) { resolve(result); return; }
    for (const key of keyList) {
      const r = store.get(key);
      r.onsuccess = () => {
        if (r.result !== undefined) result[key] = r.result;
        if (--remaining === 0) resolve(result);
      };
      r.onerror = () => reject(r.error);
    }
  });
}

async function dbSet(data) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const [k, v] of Object.entries(data)) store.put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  notifyChange(Object.keys(data));
}

async function dbDelete(keys) {
  const keyList = Array.isArray(keys) ? keys : [keys];
  if (keyList.length === 0) return;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const k of keyList) store.delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  notifyChange(keyList);
}

async function dbClear() {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  notifyChange(['*']);
}

function notifyChange(keys) {
  // Goes to popup and other extension pages. Content scripts don't subscribe.
  chrome.runtime.sendMessage({ type: 'DB_CHANGED', keys }).catch(() => {});
  if (keys.includes('contacts') || keys.includes('*')) refreshBadge();
}

async function refreshBadge() {
  const { contacts = {} } = await dbGet('contacts');
  // Badge counts UNMARKED accepted people who need a welcome message. In v2
  // that's status='accepted' && !marked && !welcomeMessageSent. Declined
  // (was verified='declined') is now status='declined' which is out of scope.
  const unmarked = Object.values(contacts)
    .filter((x) => x.status === 'accepted' && !x.marked && !x.welcomeMessageSent)
    .length;
  await chrome.action.setBadgeText({ text: unmarked > 0 ? String(unmarked) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#0a66c2' });
}

function notifyNewlyAccepted(newlyAccepted) {
  if (!newlyAccepted || newlyAccepted.length === 0) return;
  const first = newlyAccepted[0];
  const title = newlyAccepted.length === 1
    ? `${first.name} accepted your invite`
    : `${newlyAccepted.length} new connections accepted`;
  const message = newlyAccepted.length === 1
    ? 'Time to write a welcome message.'
    : `Including ${first.name}${newlyAccepted.length > 1 ? ` and ${newlyAccepted.length - 1} more` : ''}.`;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
    priority: 1,
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'DB_GET') {
    dbGet(msg.keys).then(sendResponse, (e) => { console.error('[LI Tracker] DB_GET', e); sendResponse({}); });
    return true;
  }
  if (msg?.type === 'DB_SET') {
    dbSet(msg.data).then(() => sendResponse(true), (e) => { console.error('[LI Tracker] DB_SET', e); sendResponse(false); });
    return true;
  }
  if (msg?.type === 'DB_DELETE') {
    dbDelete(msg.keys).then(() => sendResponse(true), (e) => { console.error('[LI Tracker] DB_DELETE', e); sendResponse(false); });
    return true;
  }
  if (msg?.type === 'DB_CLEAR') {
    dbClear().then(() => sendResponse(true), (e) => { console.error('[LI Tracker] DB_CLEAR', e); sendResponse(false); });
    return true;
  }
  if (msg?.type === 'SCAN_DONE') {
    notifyNewlyAccepted(msg.newlyAccepted);
    refreshBadge();
    return;
  }
  if (msg?.type === 'REFRESH_BADGE') {
    refreshBadge();
    return;
  }
  // Bulk Visit Queue message handlers — disabled with the rest of the
  // feature for 1.3.0. See the note near importScripts at the top.
});

// One-time v1 → v2 storage migration. Idempotent: if storage is already
// v2 (schemaVersion=2), migrateToV2 returns the input unchanged. Runs on
// extension install/update and on browser startup so that whoever wakes
// up first — service worker before any content script fires — always
// leaves storage in v2 shape. Popup and content scripts still run their
// own migration guard on load as belt-and-suspenders.
async function runStorageMigration() {
  try {
    const stored = await dbGet(null);
    if (LITSchema.isV2(stored)) return;
    const migrated = LITSchema.migrateToV2(stored);
    migrated._backup_v1._migratedAt = Date.now();
    // Atomic: put every migrated top-level key AND delete the legacy
    // ones in a single readwrite tx, so we never end at a half-state
    // (schemaVersion=2 but legacy keys still there — next boot would
    // treat storage as v2 and never clean them up).
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const [k, v] of Object.entries(migrated)) store.put(v, k);
      for (const k of LITSchema.LEGACY_STORE_KEYS) store.delete(k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    notifyChange([...Object.keys(migrated), ...LITSchema.LEGACY_STORE_KEYS]);
    console.log('[LI Tracker] migrated storage to v2 (contacts unified).');
  } catch (err) {
    console.error('[LI Tracker] storage migration failed:', err);
  }
}

// One-shot URN-dedup migration. Idempotent — see popup.js:migrateUrnDedup
// for the full rationale. Runs on SW startup too so the migration lands
// even when the user never opens the popup after upgrade (background
// scans, then popup opens later, would otherwise see stale duplicates).
async function runUrnDedupMigration() {
  try {
    const { contacts = {} } = await dbGet(['contacts']);
    const result = LITSchema.runUrnDedupMigration(contacts);
    if (result.backfilled === 0 && result.deduped === 0 && result.repaired === 0) return;
    await dbSet({ contacts });
    notifyChange(['contacts']);
    console.log(`[LI Tracker] URN-dedup migration: backfilled ${result.backfilled} urnIds, merged ${result.deduped} duplicates, repaired ${result.repaired} profileUrl mismatches.`);
  } catch (err) {
    console.error('[LI Tracker] URN-dedup migration failed:', err);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await runStorageMigration();
  await runUrnDedupMigration();
  refreshBadge();
});
chrome.runtime.onStartup.addListener(async () => {
  await runStorageMigration();
  await runUrnDedupMigration();
  refreshBadge();
});
// Also run on service-worker cold start (e.g., first message wakes it up).
runStorageMigration();
runUrnDedupMigration();

// Bulk Visit Queue SW glue removed for 1.3.0. To restore in 1.3.1:
//   git show 89090b5:linkedin-tracker/background.js
// contains the reference implementation (lines ~224-386 of that revision).

// ---------- Dead-profile (404) queue skip ----------
//
// The bulk queue is driven by profile.js, a content script scoped to
// https://www.linkedin.com/in/* (manifest.json). A LinkedIn redirect to
// /404/ (deleted/restricted profile) lands the tab OUTSIDE that pattern,
// so profile.js never runs again and the queue stalls on that URL
// forever — nothing else can see the tab get there, so the fix has to
// live in the service worker. No new permission: host_permissions
// already covers linkedin.com, which is what exposes changeInfo.url here.
//
// lastSkippedKey dedupes chrome.tabs.onUpdated firing twice for one
// navigation (both carrying the same url) — same TOCTOU shape as
// profile.js's queueRunning lock (profile.js:502,524-529), claimed
// synchronously before any await.
let lastSkippedKey = null;

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  let dest;
  try {
    dest = new URL(changeInfo.url);
  } catch {
    return;
  }
  if (dest.hostname !== 'www.linkedin.com') return;
  if (!/^\/404\/?$/.test(dest.pathname)) return;
  const key = `${tabId}:${changeInfo.url}`;
  if (lastSkippedKey === key) return;
  lastSkippedKey = key;
  skipDeadProfileInQueue(tabId).catch((err) => {
    console.error('[LI Tracker/queue] 404 skip failed:', err);
  });
});

async function skipDeadProfileInQueue(tabId) {
  const { visitQueueSimple: state } = await dbGet('visitQueueSimple');
  if (!LITVisitQueueSimple.isActive(state)) return;
  if (state.tabId !== tabId) return; // some other LinkedIn tab hit /404/ — not the queue's tab
  const deadUrl = LITVisitQueueSimple.currentTargetUrl(state);
  const result = LITVisitQueueSimple.advance(state, Date.now());
  if (result.done) {
    console.log(`[LI Tracker/queue] ${deadUrl} → 404, queue complete (was last profile)`);
    await dbSet({ visitQueueSimple: null });
    return;
  }
  console.log(`[LI Tracker/queue] ${deadUrl} → 404, skipping to ${result.nextUrl}`);
  await dbSet({ visitQueueSimple: { ...result.state, tabId } });
  await chrome.tabs.update(tabId, { url: result.nextUrl });
}
