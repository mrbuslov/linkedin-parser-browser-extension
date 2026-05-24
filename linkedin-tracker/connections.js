// Parser for linkedin.com/mynetwork/invite-connect/connections/
// Canonical "who has accepted my invitations + everyone in my network" list,
// with LinkedIn-provided `Connected on DATE` strings. Pure merge logic lives
// in core/merge-connections.js; this file does DOM scraping and persistence.

console.log('[LI Tracker] connections script INJECTED at', location.href);

dbSet({ scanInProgress: null });

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

// Find profile name links in the connection grid. Each card has a profile link
// (sometimes two: one on avatar, one on name) — dedupe by profileUrl.
function findCards() {
  const byUrl = new Map();
  for (const link of document.querySelectorAll('a[href*="/in/"]')) {
    const text = (link.textContent || '').trim();
    if (!text) continue;
    if (text.length > 100) continue;  // skip non-name links with rich content
    const url = LITUrl.normalizeProfileUrl(link.href);
    if (!byUrl.has(url)) byUrl.set(url, link);
  }
  return byUrl;
}

function findCardContainer(link) {
  // Walk up until a container that includes a "Connected on" / "В контактах с" string
  let node = link.parentElement;
  for (let i = 0; i < 10 && node; i++, node = node.parentElement) {
    const t = (node.textContent || '');
    if (/connected\s+on|в\s+контактах\s+с|у\s+контактах\s+з|verbunden\s+seit/i.test(t)) {
      return node;
    }
  }
  // Fallback: fixed depth ancestor
  node = link;
  for (let i = 0; i < 5 && node.parentElement; i++) node = node.parentElement;
  return node;
}

function parseCard(link) {
  const profileUrl = LITUrl.normalizeProfileUrl(link.href);
  const card = findCardContainer(link);

  const name = (link.textContent || '').trim();
  if (!name) return null;

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

  let dateText = '';
  for (const p of card.querySelectorAll('p')) {
    const t = (p.textContent || '').trim();
    if (/connected\s+on|в\s+контактах\s+с|у\s+контактах\s+з|verbunden\s+seit/i.test(t)) {
      dateText = t;
      break;
    }
  }
  const connectedAt = LITParseDate.parseConnectedDate(dateText);

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

async function persistConnections(links) {
  const snapshot = [];
  for (const link of links.values()) {
    const item = parseCard(link);
    if (item) snapshot.push(item);
  }
  const stored = await dbGet(['accepted', 'sentInvitations']);
  const result = LITMergeConnections.mergeConnections(snapshot, stored, Date.now());
  await dbSet({ accepted: result.accepted, sentInvitations: result.sentInvitations });
  return result.touched;
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

    const touched = await persistConnections(links);
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
