// Shared client wrapper. Loaded into content.js, profile.js, and popup.js.
// The actual IndexedDB lives in the service worker (background.js) because
// content scripts run in the LinkedIn page origin, not in the extension origin
// — so they can't see extension-scoped IDB directly. All reads/writes are
// forwarded via chrome.runtime.sendMessage to the service worker.

async function dbGet(keys) {
  const response = await chrome.runtime.sendMessage({ type: 'DB_GET', keys });
  return response || {};
}

async function dbSet(data) {
  await chrome.runtime.sendMessage({ type: 'DB_SET', data });
}

async function dbClear() {
  await chrome.runtime.sendMessage({ type: 'DB_CLEAR' });
}
