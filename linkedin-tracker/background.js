// Service worker. Owns the IndexedDB store and forwards all reads/writes
// from other extension contexts. On every write, broadcasts a DB_CHANGED
// message so the popup can live-rerender. Also refreshes the toolbar badge
// when `contacts` changes and pops a notification when SCAN_DONE arrives.
//
// On startup, runs the v1 → v2 storage migration if needed (idempotent).
// This ensures content scripts and the popup can always assume unified
// `contacts` shape, regardless of who woke up first after an update.

importScripts('core/schema-v2.js');

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
    await dbSet(migrated);
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
