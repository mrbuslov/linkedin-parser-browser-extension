// Runs on linkedin.com/mynetwork/invitation-manager/sent/.
// Auto-scrolls to load the full list, parses invitation cards, then diffs against
// the previous snapshot in chrome.storage.local. Anything missing now = accepted.

const SCROLL_STEP_MS = 800;
const SCROLL_STABLE_TICKS = 3;
const DAY_MS = 86400000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeProfileUrl(href) {
  // strip query/hash and trailing slash variations so the same person always gets the same key
  const u = new URL(href, location.origin);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
}

// LinkedIn rotates CSS class hashes, so we anchor on stable attributes (data-view-name,
// the /in/ link) and fall back to structure. If both fail, we surface that loudly.
function findInvitationCards() {
  const byDataView = document.querySelectorAll('[data-view-name*="invitation"]');
  if (byDataView.length) return Array.from(byDataView);

  const cards = new Set();
  for (const link of document.querySelectorAll('a[href*="/in/"]')) {
    const card = link.closest('li, [class*="invitation"]');
    if (card) cards.add(card);
  }
  return Array.from(cards);
}

function parseCard(card) {
  const profileLink = card.querySelector('a[href*="/in/"]');
  if (!profileLink) return null;

  const profileUrl = normalizeProfileUrl(profileLink.href);

  const nameFromLink = (profileLink.textContent || '').trim();
  const nameFromAttr = card.querySelector('[class*="title"], [class*="name"]')?.textContent?.trim() || '';
  const name = nameFromLink || nameFromAttr;

  const headline = card.querySelector('[class*="subtitle"], [class*="headline"], [class*="occupation"]')?.textContent?.trim() || '';
  const sentDateRelative = card.querySelector('time, [class*="time"], [class*="sent"], [class*="caption"]')?.textContent?.trim() || '';

  if (!name) return null;
  return { profileUrl, name, headline, sentDateRelative };
}

async function loadEntireList() {
  let prevCount = -1;
  let stableTicks = 0;
  while (stableTicks < SCROLL_STABLE_TICKS) {
    const count = findInvitationCards().length;
    if (count === prevCount) {
      stableTicks++;
    } else {
      stableTicks = 0;
      prevCount = count;
    }
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(SCROLL_STEP_MS);
  }
  return findInvitationCards();
}

function snapshotFromCards(cards) {
  const byUrl = new Map();
  for (const card of cards) {
    const item = parseCard(card);
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
  if (scanInFlight) return;
  scanInFlight = true;
  try {
    console.log('[LI Tracker] scrolling to load all invitations...');
    const cards = await loadEntireList();
    const snapshot = snapshotFromCards(cards);
    console.log(`[LI Tracker] parsed ${snapshot.length} cards from ${cards.length} DOM nodes`);

    if (snapshot.length === 0) {
      console.warn('[LI Tracker] no cards parsed — selectors may be stale or the list is empty');
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

// Kick off once the first card appears. MutationObserver is more reliable than a
// fixed timeout because LinkedIn renders the list async after document_idle.
function waitForFirstCardThenScan() {
  if (findInvitationCards().length > 0) {
    runScan();
    return;
  }
  const obs = new MutationObserver(() => {
    if (findInvitationCards().length > 0) {
      obs.disconnect();
      runScan();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  // bail after 30s so we don't observe forever on an empty page
  setTimeout(() => obs.disconnect(), 30000);
}

waitForFirstCardThenScan();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'RESCAN') runScan();
});
