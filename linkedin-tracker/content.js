// Runs on linkedin.com/mynetwork/invitation-manager/sent/.
// LinkedIn ships fully obfuscated CSS classes and doesn't expose data-view-name
// on this page, so we anchor on the only stable thing: `<a href="/in/...">` links
// inside <main>. Everything else (name, headline, "Sent X ago") is pulled from
// the link's text and the nearest card-shaped ancestor.

console.log('[LI Tracker] content script INJECTED at', location.href);

const SCROLL_STEP_MS = 800;
const SCROLL_STABLE_TICKS = 3;
const SCROLL_MAX_TICKS = 60;
const INITIAL_RENDER_DELAY_MS = 1500;
const DAY_MS = 86400000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeProfileUrl(href) {
  const u = new URL(href, location.origin);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
}

const TIME_RE = /(sent[^.\n]*ago|\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago)/i;

// A profile link counts as a sent-invitation card only if some ancestor within
// 8 levels contains "Sent ... ago" or "N day(s) ago". This filters out the
// header/nav links to your own profile and the "people you may know" sidebar.
function isInsideInviteCard(link) {
  let node = link.parentElement;
  for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
    if (TIME_RE.test(node.textContent || '')) return true;
  }
  return false;
}

// Get every link to a profile that lives inside an invitation card, deduped
// by profile URL. Same person can have avatar+name links — we keep the first
// one with non-empty text content.
function findProfileLinks() {
  const byUrl = new Map();
  for (const link of document.querySelectorAll('a[href*="/in/"]')) {
    const text = (link.textContent || '').trim();
    if (!text) continue;
    if (!isInsideInviteCard(link)) continue;
    const url = normalizeProfileUrl(link.href);
    if (!byUrl.has(url)) byUrl.set(url, link);
  }
  return Array.from(byUrl.values());
}

// Walk up a few levels until we hit a block that contains a "Sent ... ago"
// or "N day(s) ago" string. That's our card.
function findCardContainer(link) {
  let node = link.parentElement;
  for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
    if (TIME_RE.test(node.textContent || '')) return node;
  }
  node = link;
  for (let i = 0; i < 5 && node.parentElement; i++) node = node.parentElement;
  return node;
}

function parseFromLink(link) {
  const profileUrl = normalizeProfileUrl(link.href);
  const name = (link.textContent || '').trim();
  if (!name) return null;

  const card = findCardContainer(link);
  const cardText = card.textContent || '';

  const timeMatch = cardText.match(/sent[^.\n]*?ago/i)
    || cardText.match(/\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  const sentDateRelative = timeMatch ? timeMatch[0].trim().replace(/\s+/g, ' ') : '';

  // Headline = the shortest descendant text that's not the name, not the time,
  // and not obvious UI chrome ("Withdraw", "Message").
  let headline = '';
  const SKIP = /^(withdraw|message|connect|pending|follow|more|invitation sent|·)$/i;
  for (const node of card.querySelectorAll('span, p, div')) {
    if (node.children.length > 0) continue;
    const t = (node.textContent || '').trim();
    if (!t || t.length < 3 || t.length > 200) continue;
    if (t === name || name.includes(t) || t.includes(name)) continue;
    if (sentDateRelative && t.includes(sentDateRelative)) continue;
    if (SKIP.test(t)) continue;
    headline = t;
    break;
  }

  return { profileUrl, name, headline, sentDateRelative };
}

async function loadEntireList() {
  let prevCount = -1;
  let stableTicks = 0;
  for (let tick = 0; tick < SCROLL_MAX_TICKS && stableTicks < SCROLL_STABLE_TICKS; tick++) {
    const count = findProfileLinks().length;
    if (count === prevCount) {
      stableTicks++;
    } else {
      stableTicks = 0;
      prevCount = count;
      console.log(`[LI Tracker] scroll tick ${tick}: ${count} profile links visible`);
    }
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(SCROLL_STEP_MS);
  }
  window.scrollTo(0, 0);
  return findProfileLinks();
}

function buildSnapshot(links) {
  const byUrl = new Map();
  for (const link of links) {
    const item = parseFromLink(link);
    if (item && !byUrl.has(item.profileUrl)) byUrl.set(item.profileUrl, item);
  }
  return Array.from(byUrl.values());
}

async function diffAndPersist(snapshot) {
  const stored = await chrome.storage.local.get(['sentInvitations', 'accepted', 'scanHistory']);
  const pending = stored.sentInvitations || {};
  const accepted = stored.accepted || {};
  const history = stored.scanHistory || [];

  const currentUrls = new Set(snapshot.map((x) => x.profileUrl));
  const now = Date.now();
  const newlyAccepted = [];
  const newlyPending = [];

  for (const [url, item] of Object.entries(pending)) {
    if (currentUrls.has(url)) continue;
    const entry = {
      ...item,
      acceptedAt: now,
      daysPending: Math.floor((now - item.firstSeenAt) / DAY_MS),
      welcomeMessageSent: false,
      welcomeMessageSentAt: null,
      verified: null,
    };
    accepted[url] = entry;
    newlyAccepted.push(entry);
    delete pending[url];
  }

  for (const item of snapshot) {
    const existing = pending[item.profileUrl];
    if (existing) {
      existing.lastSeenAt = now;
      existing.sentDateRelative = item.sentDateRelative || existing.sentDateRelative;
      existing.name = item.name || existing.name;
      existing.headline = item.headline || existing.headline;
    } else {
      pending[item.profileUrl] = {
        ...item,
        firstSeenAt: now,
        lastSeenAt: now,
        notes: '',
        tags: [],
      };
      newlyPending.push(pending[item.profileUrl]);
    }
  }

  const newHistory = [
    ...history,
    { timestamp: now, pendingCount: snapshot.length, newAccepted: newlyAccepted.length },
  ].slice(-100);

  await chrome.storage.local.set({
    sentInvitations: pending,
    accepted,
    scanHistory: newHistory,
  });

  return { newlyAccepted, newlyPending, pendingCount: snapshot.length };
}

let scanInFlight = false;

async function runScan() {
  if (scanInFlight) {
    console.log('[LI Tracker] scan already in progress, skipping');
    return;
  }
  scanInFlight = true;
  try {
    console.log('[LI Tracker] waiting for initial render...');
    await sleep(INITIAL_RENDER_DELAY_MS);

    console.log('[LI Tracker] scrolling to load all invitations...');
    const links = await loadEntireList();
    const snapshot = buildSnapshot(links);
    console.log(`[LI Tracker] parsed ${snapshot.length} invitations from ${links.length} profile links`);

    if (snapshot.length === 0) {
      console.warn('[LI Tracker] nothing parsed — page may be empty or selectors are stale');
      return;
    }

    const result = await diffAndPersist(snapshot);
    console.log('[LI Tracker] scan complete:', result);

    chrome.runtime.sendMessage({
      type: 'SCAN_DONE',
      pendingCount: result.pendingCount,
      newlyAcceptedCount: result.newlyAccepted.length,
      newlyAccepted: result.newlyAccepted,
    });
  } finally {
    scanInFlight = false;
  }
}

runScan();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'RESCAN') runScan();
});
