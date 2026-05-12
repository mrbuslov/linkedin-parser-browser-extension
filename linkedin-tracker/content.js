// Runs on linkedin.com/mynetwork/invitation-manager/sent/.
// Parser based on the tested console script: anchor on [role="listitem"] (stable
// across LinkedIn rebrandings since ARIA roles are accessibility-mandated),
// then pull the /in/ link, three <p> elements (name / headline / sent info),
// and the avatar img.

console.log('[LI Tracker] content script INJECTED at', location.href);

const DAY_MS = 86400000;
const STABLE_ROUNDS_TO_STOP = 3;
const HARD_LIMIT_ITERATIONS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.random() * (max - min) + min;

function normalizeProfileUrl(href) {
  const u = new URL(href, location.origin);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
}

function parseCards() {
  const cards = document.querySelectorAll('[role="listitem"]');
  const result = new Map();
  for (const card of cards) {
    const link = card.querySelector('a[href*="/in/"]');
    if (!link) continue;
    const profileUrl = normalizeProfileUrl(link.href);
    if (result.has(profileUrl)) continue;

    const paragraphs = [...card.querySelectorAll('p')]
      .map((p) => p.textContent.trim())
      .filter(Boolean);
    const img = card.querySelector('img');

    result.set(profileUrl, {
      profileUrl,
      name: paragraphs[0] || '',
      headline: paragraphs[1] || '',
      sentDateRelative: paragraphs[2] || '',
      avatar: img?.src || '',
    });
  }
  return Array.from(result.values());
}

async function waitForFirstCard(maxWaitMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (document.querySelector('[role="listitem"]')) return true;
    await sleep(500);
  }
  return false;
}

// Bring the last card into view. Works no matter which DOM ancestor is the
// scroll container — window, <main>, or a custom overflow div — because the
// browser figures out the right one for scrollIntoView.
function scrollToLastCard() {
  const items = document.querySelectorAll('[role="listitem"]');
  if (items.length === 0) return;
  items[items.length - 1].scrollIntoView({ block: 'end', behavior: 'smooth' });
}

async function autoScroll() {
  if (!(await waitForFirstCard())) {
    console.warn('[LI Tracker] no [role="listitem"] appeared within 20s — list may be empty');
    return [];
  }

  let stableRounds = 0;
  let lastCount = 0;
  let iter = 0;

  while (stableRounds < STABLE_ROUNDS_TO_STOP && iter < HARD_LIMIT_ITERATIONS) {
    iter++;
    const cards = parseCards();
    const added = cards.length - lastCount;
    console.log(`[LI Tracker] tick ${iter}: total ${cards.length}, new ${added}`);

    scrollToLastCard();

    await sleep(rand(1500, 2500));

    if (added === 0) {
      stableRounds++;
      // wiggle to trigger lazy-load
      window.scrollBy(0, -300);
      await sleep(rand(400, 700));
      scrollToLastCard();
      await sleep(rand(600, 1000));
    } else {
      stableRounds = 0;
    }

    lastCount = cards.length;
  }

  return parseCards();
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
      existing.avatar = item.avatar || existing.avatar;
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
    console.log('[LI Tracker] starting scan, auto-scrolling...');
    const snapshot = await autoScroll();
    console.log(`[LI Tracker] parsed ${snapshot.length} invitations`);

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
