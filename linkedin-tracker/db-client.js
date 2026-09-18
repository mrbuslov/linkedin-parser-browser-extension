// Shared client wrapper. Loaded into content.js, profile.js, and popup.js.
// The actual IndexedDB lives in the service worker (background.js) because
// content scripts run in the LinkedIn page origin, not in the extension origin
// — so they can't see extension-scoped IDB directly. All reads/writes are
// forwarded via chrome.runtime.sendMessage to the service worker.

// Every service-worker handler replies { ok: true, value } or { ok: false, error }.
async function swRequest(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (typeof res?.ok !== 'boolean') {
    const got = JSON.stringify(res)?.slice(0, 200);
    throw new Error(`${message.type}: service worker replied ${got} instead of {ok, ...} — it is running outdated code, reload the extension in chrome://extensions`);
  }
  if (!res.ok) throw new Error(`${message.type} failed in service worker: ${res.error}`);
  return res.value;
}

async function dbGet(keys) {
  return swRequest({ type: 'DB_GET', keys });
}

async function dbSet(data) {
  await swRequest({ type: 'DB_SET', data });
}

async function dbDelete(keys) {
  await swRequest({ type: 'DB_DELETE', keys });
}

async function dbClear() {
  await swRequest({ type: 'DB_CLEAR' });
}

// Expose explicitly so other content scripts (loaded later via manifest)
// can see them, and so ESLint stops warning "defined but never used".
globalThis.swRequest = swRequest;
globalThis.dbGet = dbGet;
globalThis.dbSet = dbSet;
globalThis.dbDelete = dbDelete;
globalThis.dbClear = dbClear;
