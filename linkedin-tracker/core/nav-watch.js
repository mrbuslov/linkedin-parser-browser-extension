// Watches LinkedIn's own nav counters in the DOM of a page the user already
// has open. Pure functions over a Document so tests/fixtures/ can pin them.

(function () {

const NAV_TARGETS = Object.freeze([
  Object.freeze({
    key: 'messages',
    hrefFragment: '/messaging',
    settingKey: 'messageNotifications',
    noun: 'message',
    openUrl: 'https://www.linkedin.com/messaging/',
  }),
  Object.freeze({
    key: 'invitations',
    hrefFragment: '/mynetwork',
    settingKey: 'invitationNotifications',
    noun: 'invitation',
    openUrl: 'https://www.linkedin.com/mynetwork/',
  }),
  Object.freeze({
    key: 'activity',
    hrefFragment: '/notifications',
    settingKey: 'activityNotifications',
    noun: 'notification',
    openUrl: 'https://www.linkedin.com/notifications/',
  }),
]);

const TARGET_BY_KEY = Object.freeze(Object.fromEntries(NAV_TARGETS.map((t) => [t.key, t])));
const MIN_CONVERSATION_ROWS = 3;
const MAX_BADGE_COUNT = 99;

// Digits survive localization, the words around them do not.
function firstInteger(text) {
  const match = /\d+/.exec(text || '');
  return match ? Number(match[0]) : null;
}

// The feed links /mynetwork from sidebar cards too, so the nav is the scope.
function findNavLink(doc, hrefFragment) {
  for (const link of doc.querySelectorAll(`a[href*="${hrefFragment}"]`)) {
    if (link.closest('header, nav')) return link;
  }
  return null;
}

// Two LinkedIn shells: React (feed, /in/*, search) keeps the count in the
// link's own aria-label, Ember (/messaging/*) marks itself with <li-icon> and
// puts the count in the artdeco badge inside the link, an absent badge
// meaning nothing pending. Neither shape → null, so the caller skips instead
// of inventing a count.
function readLinkCount(link) {
  const ariaLabel = link.getAttribute('aria-label');
  if (ariaLabel) return firstInteger(ariaLabel);
  if (!link.querySelector('li-icon')) return null;
  const badgeCount = firstInteger(link.textContent);
  return badgeCount === null ? 0 : badgeCount;
}

function readCounts(doc) {
  const counts = {};
  for (const target of NAV_TARGETS) {
    const link = findNavLink(doc, target.hrefFragment);
    counts[target.key] = link === null ? null : readLinkCount(link);
  }
  return counts;
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
  const counts = readCounts(doc);
  if (NAV_TARGETS.every((target) => counts[target.key] === null)) return null;
  return { counts, top: readTopConversation(doc) };
}

function conversationKey(top) {
  return top ? `${top.name}|${top.time}|${top.preview}` : null;
}

function assertObserved(observed) {
  if (!observed || typeof observed !== 'object') {
    throw new TypeError(`observed: expected an object, got ${typeof observed}`);
  }
  const unknownTargets = Object.keys(observed.counts ?? {}).filter((key) => !(key in TARGET_BY_KEY));
  if (unknownTargets.length > 0) {
    throw new Error(`observed.counts: unknown targets ${unknownTargets.join(', ')}`);
  }
  for (const target of NAV_TARGETS) {
    const count = observed.counts?.[target.key];
    if (count === null || count === undefined) continue;
    if (!Number.isInteger(count) || count < 0) {
      throw new TypeError(`observed.counts.${target.key}: expected a non-negative integer, got ${count}`);
    }
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

function plural(count, noun) {
  return `${count} new ${noun}${count === 1 ? '' : 's'}`;
}

// First observation per target is a baseline: what is already pending is not news.
function nextNavState(previous, observed, now) {
  assertObserved(observed);
  if (!Number.isFinite(now)) throw new TypeError(`now: expected a finite number, got ${now}`);
  const key = conversationKey(observed.top);
  const state = {};
  const notifications = [];
  for (const target of NAV_TARGETS) {
    const count = observed.counts[target.key];
    const before = previous?.[target.key] ?? null;
    if (count === null || count === undefined) {
      state[target.key] = before;
      continue;
    }
    state[target.key] = { lastCount: count, lastConversationKey: key, updatedAt: now };
    if (before === null) continue;
    if (!Number.isInteger(before.lastCount) || before.lastCount < 0) {
      throw new TypeError(`navWatch.${target.key}.lastCount: expected a non-negative integer, got ${before.lastCount}`);
    }
    if (count <= before.lastCount) continue;
    const enrich = target.key === 'messages' && key !== null && key !== before.lastConversationKey;
    notifications.push({
      key: target.key,
      title: enrich ? observed.top.name : 'LinkedIn',
      body: enrich ? observed.top.preview : plural(count, target.noun),
    });
  }
  return { notifications, state };
}

function enabledInboxTotal(state, settings) {
  let total = 0;
  for (const target of NAV_TARGETS) {
    if (!settings[target.settingKey]) continue;
    total += state?.[target.key]?.lastCount ?? 0;
  }
  return total;
}

function inboxBadgeText(state, settings) {
  const total = enabledInboxTotal(state, settings);
  if (total === 0) return '';
  return total > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(total);
}

function minutesOfDay(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

// Windows wrap midnight (22:00 → 09:00 is the point of the feature).
function isWithinQuietHours(date, settings) {
  if (!settings.quietHoursEnabled) return false;
  const start = minutesOfDay(settings.quietHoursStart);
  const end = minutesOfDay(settings.quietHoursEnd);
  if (start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

const LITNavWatch = {
  NAV_TARGETS,
  TARGET_BY_KEY,
  readCounts,
  readTopConversation,
  observe,
  conversationKey,
  nextNavState,
  inboxBadgeText,
  isWithinQuietHours,
};
if (typeof globalThis !== 'undefined') globalThis.LITNavWatch = LITNavWatch;
if (typeof module !== 'undefined' && module.exports) module.exports = LITNavWatch;

})();
