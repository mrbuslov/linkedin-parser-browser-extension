// New-message detection, read from the DOM of a LinkedIn page the user already
// has open. Pure functions over a Document so tests/fixtures/ can pin them.

(function () {

const MESSAGING_LINK_SELECTOR = 'a[href*="/messaging"]';
const MESSAGING_URL = 'https://www.linkedin.com/messaging/';
const MIN_CONVERSATION_ROWS = 3;

// Digits are the same in every locale; the words around them are not.
function firstInteger(text) {
  const match = /\d+/.exec(text || '');
  return match ? Number(match[0]) : null;
}

// Two LinkedIn shells, both read off the nav link to /messaging/:
//   1) React (feed, /in/*, search): count sits in the link's own aria-label.
//   2) Ember (/messaging/*): no aria-label; <li-icon> marks the shell and the
//      artdeco badge holds the count, absent badge meaning nothing unread.
// Neither shape → null, so the caller skips instead of inventing a count.
function readUnreadCount(doc) {
  const link = doc.querySelector(MESSAGING_LINK_SELECTOR);
  if (!link) return null;
  const ariaLabel = link.getAttribute('aria-label');
  if (ariaLabel) return firstInteger(ariaLabel);
  if (!link.querySelector('li-icon')) return null;
  const badgeCount = firstInteger(link.textContent);
  return badgeCount === null ? 0 : badgeCount;
}

function conversationRows(list) {
  return [...list.children].filter(
    (row) => row.tagName === 'LI' && row.querySelector('h3') && row.querySelector('time'),
  );
}

function findConversationList(doc) {
  for (const list of doc.querySelectorAll('ul')) {
    if (conversationRows(list).length >= MIN_CONVERSATION_ROWS) return list;
  }
  return null;
}

// The row prints its timestamp twice (<time>, then a plain element) before the snippet.
function readPreview(row) {
  const time = row.querySelector('time');
  const timeText = time.textContent.replace(/\s+/g, ' ').trim();
  const leaves = [...row.querySelectorAll('*')].filter(
    (el) => el.children.length === 0 && el.textContent.trim().length > 0,
  );
  const timeIndex = leaves.findIndex((el) => el === time || time.contains(el));
  for (const leaf of leaves.slice(timeIndex + 1)) {
    if (leaf.closest('[aria-hidden="true"]')) continue;
    const text = leaf.textContent.replace(/\s+/g, ' ').trim();
    if (text && text !== timeText) return text;
  }
  return null;
}

function readTopConversation(doc) {
  const list = findConversationList(doc);
  if (!list) return null;
  const [row] = conversationRows(list);
  if (!row) return null;
  const name = row.querySelector('h3').textContent.replace(/\s+/g, ' ').trim();
  const time = row.querySelector('time').textContent.replace(/\s+/g, ' ').trim();
  const preview = readPreview(row);
  if (!name || !time || !preview) return null;
  return { name, time, preview };
}

function observe(doc) {
  const unread = readUnreadCount(doc);
  if (unread === null) return null;
  return { unread, top: readTopConversation(doc) };
}

function conversationKey(top) {
  return top ? `${top.name}|${top.time}|${top.preview}` : null;
}

function assertObserved(observed) {
  if (!observed || typeof observed !== 'object') {
    throw new TypeError(`observed: expected an object, got ${typeof observed}`);
  }
  if (!Number.isInteger(observed.unread) || observed.unread < 0) {
    throw new TypeError(`observed.unread: expected a non-negative integer, got ${observed.unread}`);
  }
  const { top } = observed;
  if (top === null || top === undefined) return;
  for (const field of ['name', 'time', 'preview']) {
    if (typeof top[field] !== 'string' || top[field].length === 0) {
      throw new TypeError(`observed.top.${field}: expected a non-empty string, got ${top[field]}`);
    }
  }
  const unknown = Object.keys(top).filter((key) => !['name', 'time', 'preview'].includes(key));
  if (unknown.length > 0) throw new Error(`observed.top: unknown keys ${unknown.join(', ')}`);
}

function assertPrevious(previous) {
  if (!Number.isInteger(previous.lastUnread) || previous.lastUnread < 0) {
    throw new TypeError(`messageWatch.lastUnread: expected a non-negative integer, got ${previous.lastUnread}`);
  }
}

// First observation is a baseline: mail already unread at startup is not news.
function nextWatchState(previous, observed, now) {
  assertObserved(observed);
  if (!Number.isFinite(now)) throw new TypeError(`now: expected a finite number, got ${now}`);
  const key = conversationKey(observed.top);
  const state = { lastUnread: observed.unread, lastConversationKey: key, updatedAt: now };
  if (previous === null || previous === undefined) return { notification: null, state };
  assertPrevious(previous);
  if (observed.unread <= previous.lastUnread) return { notification: null, state };
  const topIsNew = key !== null && key !== previous.lastConversationKey;
  const notification = topIsNew
    ? { title: observed.top.name, body: observed.top.preview }
    : { title: 'New LinkedIn message', body: `${observed.unread} unread conversation${observed.unread === 1 ? '' : 's'}` };
  return { notification, state };
}

const LITMessageWatch = {
  MESSAGING_URL,
  readUnreadCount,
  readTopConversation,
  observe,
  conversationKey,
  nextWatchState,
};
if (typeof globalThis !== 'undefined') globalThis.LITMessageWatch = LITMessageWatch;
if (typeof module !== 'undefined' && module.exports) module.exports = LITMessageWatch;

})();
