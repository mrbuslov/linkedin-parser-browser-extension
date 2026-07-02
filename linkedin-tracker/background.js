// Service worker. Owns the IndexedDB store and forwards all reads/writes
// from other extension contexts. On every write, broadcasts a DB_CHANGED
// message so the popup can live-rerender. Also refreshes the toolbar badge
// when `contacts` changes and pops a notification when SCAN_DONE arrives.
//
// On startup, runs the v1 → v2 storage migration if needed (idempotent).
// This ensures content scripts and the popup can always assume unified
// `contacts` shape, regardless of who woke up first after an update.

importScripts('core/schema-v2.js');

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

chrome.runtime.onInstalled.addListener(async () => {
  await runStorageMigration();
  refreshBadge();
});
chrome.runtime.onStartup.addListener(async () => {
  await runStorageMigration();
  refreshBadge();
});
// Also run on service-worker cold start (e.g., first message wakes it up).
runStorageMigration();

// ===========================================================================
// Bulk Visit Queue — service-worker glue. DISABLED for 1.3.0.
// ===========================================================================
// The entire section is dead-code-eliminated via `if (false) { ... }`.
// Re-enable in 1.3.1 by (1) restoring the tabs/alarms/idle/webNavigation
// permissions in manifest.json, (2) re-adding importScripts of
// humanizer/visit-queue/visit-runner, (3) removing the `if (false)`
// wrapper below, (4) restoring the VISIT_QUEUE_* message handlers in
// the onMessage listener above, (5) adding visit-content.js back to
// the /in/* content_scripts bundle and the /feed/* bundle back to
// manifest, (6) unhiding the 🤖 tab + <section id="visits-panel"> in
// popup.html and the Bulk Visit block in popup.js.
if (false) {
// Thin adapter between the pure LITVisitRunner.plan() and Chrome APIs.
// Every message from popup / content script becomes an event fed into
// plan(); the returned action list is applied here. The runner owns
// zero state directly — everything lives in storage under `visitQueue`
// (and gets persisted on every action list that includes PERSIST).
//
// One dedicated tab handles all visits — created on first UPDATE_TAB
// action, reused for every subsequent visit, closed on CLOSE_TAB.
// tabId is kept in memory (visitTabId); after SW restart we look it
// up from the running queue's stored tabId or open a fresh tab.

const VISIT_ALARM = 'lit-visit-tick';
let visitTabId = null;

async function getVisitQueueState() {
  const { visitQueue } = await dbGet('visitQueue');
  return visitQueue ? { queue: visitQueue } : null;
}

async function persistQueueState(state) {
  await dbSet({ visitQueue: state.queue });
}

async function applyAction(action, state) {
  switch (action.type) {
    case 'OPEN_TAB':
    case 'UPDATE_TAB': {
      const url = action.url;
      if (visitTabId != null) {
        try {
          await chrome.tabs.update(visitTabId, { url, active: true });
          break;
        } catch {
          visitTabId = null; // tab was closed by user
        }
      }
      const tab = await chrome.tabs.create({ url, active: true });
      visitTabId = tab.id;
      break;
    }
    case 'CLOSE_TAB':
      if (visitTabId != null) {
        try { await chrome.tabs.remove(visitTabId); } catch { /* already closed */ }
        visitTabId = null;
      }
      break;
    case 'SCHEDULE_TICK': {
      const when = Date.now() + Math.max(1000, action.delayMs);
      chrome.alarms.create(VISIT_ALARM, { when });
      break;
    }
    case 'PERSIST':
      await persistQueueState(state);
      break;
    case 'ARCHIVE': {
      const { visitQueueHistory = [] } = await dbGet('visitQueueHistory');
      const nextHistory = LITVisitQueue.archiveToHistory(visitQueueHistory, action.queue, Date.now());
      await dbSet({ visitQueueHistory: nextHistory });
      break;
    }
    case 'NOTIFY_USER':
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: action.title,
        message: action.body,
        priority: 2,
      });
      break;
    case 'LOG':
      console.log(`[LI Tracker/visit] ${action.message}`);
      break;
    default:
      console.warn(`[LI Tracker/visit] unknown action ${action.type}`);
  }
}

let visitHandleLock = Promise.resolve();
async function visitRunnerHandle(event) {
  // Serialize event processing — plan() is pure but action application
  // includes async chrome API calls and IDB writes. Racing two events
  // could double-open tabs or race state writes.
  visitHandleLock = visitHandleLock.then(async () => {
    const state = await getVisitQueueState();
    if (!state) {
      console.warn('[LI Tracker/visit] event received but no queue exists', event.type);
      return;
    }
    const deps = {
      humanizer:  LITHumanizer,
      visitQueue: LITVisitQueue,
    };
    const { newState, actions } = LITVisitRunner.plan(state, event, deps);
    for (const action of actions) {
      await applyAction(action, newState);
    }
    // Emit change so popup live-rerenders
    chrome.runtime.sendMessage({ type: 'VISIT_QUEUE_CHANGED' }).catch(() => {});
  }).catch((e) => {
    console.error('[LI Tracker/visit] handler crashed:', e);
  });
  return visitHandleLock;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === VISIT_ALARM) {
    visitRunnerHandle({ type: 'TICK', now: Date.now() });
  }
});

// User activity detection — chrome.idle fires 'active' when user returns.
// If queue is running, defer next visit by IDLE_PAUSE_MS.
if (chrome.idle && chrome.idle.setDetectionInterval) {
  chrome.idle.setDetectionInterval(60); // 60s minimum
  chrome.idle.onStateChanged.addListener(async (newState) => {
    if (newState !== 'active') return;
    const state = await getVisitQueueState();
    if (!state || state.queue.status !== 'running') return;
    visitRunnerHandle({ type: 'IDLE_DETECTED', now: Date.now() });
  });
}

// Health-signal watcher — detect LinkedIn's /checkpoint/ or /uas/
// redirect on the visit tab specifically. On seeing one, pipe a
// HEALTH_ALARM event.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  if (visitTabId == null || details.tabId !== visitTabId) return;
  const url = details.url || '';
  if (/\/checkpoint\/|\/uas\/|\/error\//i.test(url)) {
    visitRunnerHandle({
      type: 'HEALTH_ALARM',
      now: Date.now(),
      signal: new URL(url).pathname,
    });
  }
});

// On SW cold start, if a queue is running, resume ticking. Chrome
// alarms survive SW restarts, but if the alarm fired while we were
// dead we need to catch up.
async function resumeVisitQueueIfNeeded() {
  const state = await getVisitQueueState();
  if (!state) return;
  if (state.queue.status === 'running') {
    chrome.alarms.create(VISIT_ALARM, { when: Date.now() + 5000 });
    console.log('[LI Tracker/visit] resumed running queue after SW restart');
  }
}
resumeVisitQueueIfNeeded();
} // end if(false) — bulk-visit-queue disabled block
