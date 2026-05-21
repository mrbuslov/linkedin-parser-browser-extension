// Runs on linkedin.com/mynetwork/invitation-manager/sent/.
// Parser based on the tested console script: anchor on [role="listitem"] (stable
// across LinkedIn rebrandings since ARIA roles are accessibility-mandated),
// then pull the /in/ link, three <p> elements (name / headline / sent info),
// and the avatar img.

console.log('[LI Tracker] content script INJECTED at', location.href);

// Reset the scanInProgress flag on every injection: if a previous scan died
// because the page was closed mid-flight, the popup would otherwise think it's
// still running.
dbSet({ scanInProgress: false });

const DAY_MS = 86400000;
const STABLE_ROUNDS_TO_STOP = 4;
const HARD_LIMIT_ITERATIONS = 500;
const SANITY_SHRINK_RATIO = 0.5; // if new snapshot < 50% of old pending, treat as partial scan

let cancelRequested = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.random() * (max - min) + min;

class ScanCancelled extends Error {}

// Sleep that wakes up early if the user cancels. Polls in 100ms slices so
// cancellation reacts within ~100ms regardless of the requested sleep length.
async function cancellableSleep(ms) {
  const step = 100;
  let elapsed = 0;
  while (elapsed < ms) {
    if (cancelRequested) throw new ScanCancelled();
    const slice = Math.min(step, ms - elapsed);
    await sleep(slice);
    elapsed += slice;
  }
  if (cancelRequested) throw new ScanCancelled();
}

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
    await cancellableSleep(500);
  }
  return false;
}

// Bring the last card into view. Works no matter which DOM ancestor is the
// scroll container — window, <main>, or a custom overflow div — because the
// browser figures out the right one for scrollIntoView.
function scrollToLastCard() {
  const items = document.querySelectorAll('[role="listitem"]');
  if (items.length === 0) return;
  // behavior:'auto' (instant) instead of 'smooth' so the scroll still works
  // when the LinkedIn tab is in the background (Chrome pauses rAF there, and
  // smooth scrolling depends on it — page wouldn't move).
  items[items.length - 1].scrollIntoView({ block: 'end' });
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

    await cancellableSleep(rand(2000, 3500));
    if (Math.random() < 0.15) await cancellableSleep(rand(2000, 4000));

    if (added === 0) {
      stableRounds++;
      window.scrollBy(0, -300);
      await cancellableSleep(rand(500, 900));
      scrollToLastCard();
      await cancellableSleep(rand(800, 1400));
    } else {
      stableRounds = 0;
    }

    lastCount = cards.length;
  }

  return parseCards();
}

async function diffAndPersist(snapshot) {
  const stored = await dbGet(['sentInvitations', 'accepted', 'scanHistory']);
  const pending = stored.sentInvitations || {};
  const accepted = stored.accepted || {};
  const history = stored.scanHistory || [];

  const currentUrls = new Set(snapshot.map((x) => x.profileUrl));
  const now = Date.now();
  const newlyAccepted = [];
  const newlyPending = [];

  // Sanity check: if we used to track many invites and this scan saw far fewer,
  // it's almost certainly a partial scroll, not 100+ people accepting at once.
  // Skip the "missing = accepted" move in that case — we'll still add new ones,
  // just won't falsely mark anyone as accepted.
  const prevCount = Object.keys(pending).length;
  const partial = prevCount > 5 && snapshot.length < prevCount * SANITY_SHRINK_RATIO;
  if (partial) {
    console.warn(`[LI Tracker] partial scan detected (prev pending: ${prevCount}, this scan: ${snapshot.length}). Skipping "missing→accepted" diff to avoid false positives.`);
  }

  if (!partial) {
    for (const [url, item] of Object.entries(pending)) {
      if (currentUrls.has(url)) continue;
      const entry = {
        ...item,
        acceptedAt: now,
        daysPending: Math.floor((now - item.firstSeenAt) / DAY_MS),
        marked: false,
        markedAt: null,
        verified: null,
      };
      accepted[url] = entry;
      newlyAccepted.push(entry);
      delete pending[url];
    }
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

  await dbSet({
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
  cancelRequested = false;
  await dbSet({ scanInProgress: true });
  try {
    console.log('[LI Tracker] starting scan...');
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
  } catch (err) {
    if (err instanceof ScanCancelled) {
      console.log('[LI Tracker] scan cancelled by user');
    } else {
      throw err;
    }
  } finally {
    scanInFlight = false;
    cancelRequested = false;
    await dbSet({ scanInProgress: false });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'TOGGLE_SCAN') {
    if (scanInFlight) {
      cancelRequested = true;
    } else {
      runScan();
    }
  }
});
