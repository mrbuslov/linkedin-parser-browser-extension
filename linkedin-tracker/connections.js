// Parser for linkedin.com/mynetwork/invite-connect/connections/
// The canonical "who has accepted my invitations + everyone in my network"
// list, with LinkedIn-provided `Connected on DATE` strings. We use these dates
// as the source of truth for `acceptedAt`, overriding our /sent/-based guesses.

console.log('[LI Tracker] connections script INJECTED at', location.href);

dbSet({ scanInProgress: null });

const DAY_MS = 86400000;
const STABLE_ROUNDS_TO_STOP = 4;
const HARD_LIMIT_ITERATIONS = 800;

let cancelRequested = false;
let scanInFlight = false;

class ScanCancelled extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.random() * (max - min) + min;

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

// Multi-locale month parser. LinkedIn locales we've seen: English ("May 24, 2026"),
// Russian ("24 мая 2026 г."), Ukrainian ("24 травня 2026 р."), German.
const MONTH_INDEX = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
  января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5,
  июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11,
  січня: 0, лютого: 1, березня: 2, квітня: 3, травня: 4, червня: 5,
  липня: 6, серпня: 7, вересня: 8, жовтня: 9, листопада: 10, грудня: 11,
  januar: 0, februar: 1, märz: 2, mai: 4, juni: 5, juli: 6, oktober: 9, dezember: 11,
};

function parseConnectedDate(text) {
  if (!text) return null;

  // Native parser handles English ("May 24, 2026") even with prefix words
  const native = Date.parse(text.replace(/^[^\d\w]*[a-zа-яёі]+\s+/i, ''));
  if (!isNaN(native)) return native;
  const native2 = Date.parse(text);
  if (!isNaN(native2)) return native2;

  // Manual extraction: find month name + 4-digit year + 1-2 digit day
  const lower = text.toLowerCase();
  let monthIdx = -1;
  for (const [name, idx] of Object.entries(MONTH_INDEX)) {
    if (new RegExp(`(?:^|[^a-zа-яёі])${name}(?:[^a-zа-яёі]|$)`, 'i').test(lower)) {
      monthIdx = idx;
      break;
    }
  }
  if (monthIdx === -1) return null;

  const yearMatch = text.match(/\b(20\d{2})\b/);
  if (!yearMatch) return null;
  const year = parseInt(yearMatch[1], 10);

  const numbers = (text.match(/\b\d{1,2}\b/g) || []).map((n) => parseInt(n, 10));
  const day = numbers.find((n) => n >= 1 && n <= 31);
  if (!day) return null;

  return new Date(year, monthIdx, day).getTime();
}

// Find profile name links in the connection grid. Each card has a profile link
// (sometimes two: one on avatar, one on name) — dedupe by profileUrl.
function findCards() {
  const byUrl = new Map();
  for (const link of document.querySelectorAll('a[href*="/in/"]')) {
    const text = (link.textContent || '').trim();
    if (!text) continue;
    if (text.length > 100) continue;  // skip non-name links with rich content
    const url = normalizeProfileUrl(link.href);
    if (!byUrl.has(url)) byUrl.set(url, link);
  }
  return byUrl;
}

function findCardContainer(link) {
  // Walk up until we find a container that includes a "Connected on" / "В контактах с" string
  let node = link.parentElement;
  for (let i = 0; i < 10 && node; i++, node = node.parentElement) {
    const t = (node.textContent || '');
    if (/connected\s+on|в\s+контактах\s+с|у\s+контактах\s+з|verbunden\s+seit/i.test(t)) {
      return node;
    }
  }
  // Fallback: a fixed depth ancestor
  node = link;
  for (let i = 0; i < 5 && node.parentElement; i++) node = node.parentElement;
  return node;
}

function parseCard(link) {
  const profileUrl = normalizeProfileUrl(link.href);
  const card = findCardContainer(link);
  const cardText = card.textContent || '';

  // Name: try the link text first, fall back to first <p> with class hint
  const name = (link.textContent || '').trim();
  if (!name) return null;

  // Headline: shortest non-name, non-date text in the card
  let headline = '';
  for (const p of card.querySelectorAll('p, span')) {
    if (p.children.length > 0) continue;
    const t = (p.textContent || '').trim();
    if (!t || t.length < 4 || t.length > 200) continue;
    if (t === name) continue;
    if (/connected\s+on|в\s+контактах|verbunden\s+seit/i.test(t)) continue;
    if (/^message$|^more$/i.test(t)) continue;
    headline = t;
    break;
  }

  // "Connected on" line — try multiple language patterns
  let dateText = '';
  for (const p of card.querySelectorAll('p')) {
    const t = (p.textContent || '').trim();
    if (/connected\s+on|в\s+контактах\s+с|у\s+контактах\s+з|verbunden\s+seit/i.test(t)) {
      dateText = t;
      break;
    }
  }
  const connectedAt = parseConnectedDate(dateText);

  // Avatar: img inside the card with profile-photo URL pattern
  let avatar = '';
  for (const img of card.querySelectorAll('img[src]')) {
    if (img.src.includes('profile-displayphoto') || img.src.includes('profile-framedphoto')) {
      avatar = img.src;
      break;
    }
  }

  return { profileUrl, name, headline, avatar, connectedAt, dateText };
}

async function autoScroll() {
  let stableRounds = 0;
  let lastCount = 0;
  let iter = 0;

  while (stableRounds < STABLE_ROUNDS_TO_STOP && iter < HARD_LIMIT_ITERATIONS) {
    iter++;
    const cards = findCards();
    const added = cards.size - lastCount;
    console.log(`[LI Tracker] connections tick ${iter}: total ${cards.size}, new ${added}`);

    const last = Array.from(cards.values()).pop();
    if (last) last.scrollIntoView({ block: 'end' });

    await cancellableSleep(rand(2000, 3500));

    if (added === 0) {
      stableRounds++;
      window.scrollBy(0, -300);
      await cancellableSleep(rand(500, 900));
      if (last) last.scrollIntoView({ block: 'end' });
      await cancellableSleep(rand(800, 1400));
    } else {
      stableRounds = 0;
    }

    lastCount = cards.size;
  }

  return findCards();
}

async function mergeIntoAccepted(links) {
  const { accepted = {}, sentInvitations = {} } = await dbGet(['accepted', 'sentInvitations']);
  const now = Date.now();
  let touched = 0;

  for (const link of links.values()) {
    const item = parseCard(link);
    if (!item) continue;

    // LinkedIn says they're connected → remove from sentInvitations if there
    if (sentInvitations[item.profileUrl]) {
      delete sentInvitations[item.profileUrl];
    }

    const existing = accepted[item.profileUrl];
    const linkedinAcceptedAt = item.connectedAt || existing?.acceptedAt || now;
    const firstSeenAt = existing?.firstSeenAt || linkedinAcceptedAt;

    accepted[item.profileUrl] = {
      ...(existing || {}),
      profileUrl: item.profileUrl,
      name: item.name || existing?.name || '',
      headline: item.headline || existing?.headline || '',
      avatar: item.avatar || existing?.avatar || '',
      acceptedAt: linkedinAcceptedAt,
      firstSeenAt,
      daysPending: Math.floor((linkedinAcceptedAt - firstSeenAt) / DAY_MS),
      marked: existing?.marked ?? false,
      markedAt: existing?.markedAt ?? null,
      verified: 'accepted',
      verifiedAt: now,
      connectedOnText: item.dateText || existing?.connectedOnText || '',
      // Clear the autoMarked flag — they're now confirmed via canonical source
      autoMarked: false,
      addedFrom: existing?.addedFrom || 'connections-page',
    };
    touched++;
  }

  await dbSet({ accepted, sentInvitations });
  return touched;
}

async function updateScanState(patch) {
  const { scanState = {} } = await dbGet('scanState');
  scanState.connections = { ...(scanState.connections || {}), ...patch };
  await dbSet({ scanState });
}

async function runScan() {
  if (scanInFlight) return;
  scanInFlight = true;
  cancelRequested = false;
  await dbSet({ scanInProgress: 'connections' });
  try {
    console.log('[LI Tracker] starting connections scan...');
    const links = await autoScroll();
    console.log(`[LI Tracker] parsed ${links.size} connections`);

    if (links.size === 0) {
      await updateScanState({
        lastScannedAt: Date.now(),
        lastCount: 0,
        lastError: 'Nothing parsed — page may be empty, or LinkedIn changed its DOM.',
      });
      return;
    }

    const touched = await mergeIntoAccepted(links);
    console.log(`[LI Tracker] merged ${touched} connections into accepted`);
    await updateScanState({
      lastScannedAt: Date.now(),
      lastCount: links.size,
      lastError: null,
    });
  } catch (err) {
    if (err instanceof ScanCancelled) {
      console.log('[LI Tracker] scan cancelled by user');
      await updateScanState({ lastScannedAt: Date.now(), lastError: 'Cancelled by user' });
    } else {
      console.error('[LI Tracker] connections scan failed:', err);
      await updateScanState({
        lastScannedAt: Date.now(),
        lastError: `${err.name || 'Error'}: ${err.message || String(err)}`,
      });
    }
  } finally {
    scanInFlight = false;
    cancelRequested = false;
    await dbSet({ scanInProgress: null });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'TOGGLE_SCAN') {
    if (scanInFlight) cancelRequested = true;
    else runScan();
  }
});
