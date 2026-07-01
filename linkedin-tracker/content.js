// Runs on linkedin.com/mynetwork/invitation-manager/sent/.
// Parser anchored on [role="listitem"] — stable across LinkedIn rebrandings
// since ARIA roles are accessibility-mandated.
//
// Pure logic lives in core/diff-sent.js (testable). This file does the DOM
// scraping, auto-scroll, and persistence; it owns side effects only.

console.log('[LI Tracker] content script INJECTED at', location.href);

// Reset scanInProgress on injection: if a previous scan died because the page
// was closed mid-flight, the popup would otherwise think it's still running.
dbSet({ scanInProgress: null });

const STABLE_ROUNDS_TO_STOP = 4;
const HARD_LIMIT_ITERATIONS = 500;

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

function parseCards() {
  const cards = document.querySelectorAll('[role="listitem"]');
  const result = new Map();
  for (const card of cards) {
    const paragraphs = [...card.querySelectorAll('p')]
      .map((p) => p.textContent.trim())
      .filter(Boolean);
    const img = card.querySelector('img');

    const link = card.querySelector('a[href*="/in/"]');
    let profileUrl, name, headline;
    if (link) {
      profileUrl = LITUrl.normalizeProfileUrl(link.href);
      name = paragraphs[0] || '';
      headline = paragraphs[1] || '';
    } else {
      // Email-based invite — LinkedIn's "you must know them" wall, or invitee
      // doesn't have an account yet. No /in/ link, the card text contains the
      // raw email address instead of a name. Key by mailto:<email> so the
      // entry persists alongside profile-based ones in the same store.
      const email = LITUrl.extractEmail(card.textContent || '');
      if (!email) continue;
      profileUrl = `mailto:${email}`;
      name = email;
      headline = '';
    }

    if (result.has(profileUrl)) continue;
    result.set(profileUrl, {
      profileUrl,
      name,
      headline,
      // Date string is usually the LAST paragraph regardless of layout. For
      // email cards there's only [email, sent_date] so [1] is the date.
      sentDateRelative: paragraphs[paragraphs.length - 1] || '',
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

function scrollToLastCard() {
  const items = document.querySelectorAll('[role="listitem"]');
  if (items.length === 0) return;
  // behavior:'auto' (instant) — 'smooth' uses rAF, which Chrome pauses in
  // background tabs, so the page wouldn't move at all.
  items[items.length - 1].scrollIntoView({ block: 'end' });
}

// Withdraw click listener (P0.2). When the user clicks the Withdraw button on
// /sent/, the card disappears just like an accepted one — and our diff would
// misclassify it as accepted. Capture withdraws BEFORE the diff runs so the
// pure function can respect a `withdrawnAt` stamp.
const WITHDRAW_BTN_RE = /^(withdraw|отозвать|скасувати|zurückziehen|retirar)\b/i;
const WITHDRAW_ARIA_RE = /(withdraw|invitation|отозвать|скасувати|запрош|приглаш)/i;

function setupWithdrawListener() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button, a');
    if (!btn) return;
    const text = (btn.textContent || '').trim();
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const isWithdraw = WITHDRAW_BTN_RE.test(text)
      || (WITHDRAW_ARIA_RE.test(aria) && /withdraw|отозвать|скасувати|zurückziehen|retirar/i.test(aria));
    if (!isWithdraw) return;

    const card = btn.closest('[role="listitem"]');
    if (!card) return;
    const link = card.querySelector('a[href*="/in/"]');
    if (!link) return;
    const profileUrl = LITUrl.normalizeProfileUrl(link.href);

    // v2 unified store: stamp withdrawnAt on the pending record so the
    // next /sent/ scan's diff can classify a disappearance correctly
    // (declined within 7 days; assumed accepted after 7).
    const { contacts = {} } = await dbGet('contacts');
    const rec = contacts[profileUrl];
    if (!rec || rec.status !== 'pending') return;
    rec.withdrawnAt = Date.now();
    await dbSet({ contacts });
    console.log(`[LI Tracker] withdraw stamped: ${rec.name}`);
  }, true);
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
  // Defense-in-depth: if v1 storage still lingers (service worker didn't
  // migrate yet, or migration failed), run it in-memory here so this scan
  // doesn't misclassify every pending record as brand new.
  const allStored = await dbGet(null);
  const stored = LITSchema.isV2(allStored) ? allStored : LITSchema.migrateToV2(allStored);
  const result = LITDiffSent.diffSentInvitations(snapshot, stored, Date.now());

  // If migration ran here (not via SW), persist the whole migrated stored
  // so v1 keys are cleared and _backup_v1 is snapshotted. Otherwise write
  // only the touched keys.
  const migratedNow = !LITSchema.isV2(allStored);
  if (migratedNow) {
    stored.contacts = result.contacts;
    stored.scanHistory = result.scanHistory;
    await dbSet(stored);
  } else {
    await dbSet({
      contacts: result.contacts,
      scanHistory: result.scanHistory,
    });
  }

  if (result.partial) {
    console.warn(`[LI Tracker] partial scan detected — skipped missing→accepted diff to avoid false positives`);
  }
  return result;
}

async function updateScanState(patch) {
  const { scanState = {} } = await dbGet('scanState');
  scanState.sent = { ...(scanState.sent || {}), ...patch };
  await dbSet({ scanState });
}

async function runScan() {
  if (scanInFlight) return;
  scanInFlight = true;
  cancelRequested = false;
  await dbSet({ scanInProgress: 'sent' });
  try {
    console.log('[LI Tracker] starting scan...');
    const snapshot = await autoScroll();
    console.log(`[LI Tracker] parsed ${snapshot.length} invitations`);

    if (snapshot.length === 0) {
      await updateScanState({
        lastScannedAt: Date.now(),
        lastCount: 0,
        lastError: 'Nothing parsed — page may be empty, or LinkedIn changed its DOM. Refresh and try again.',
      });
      return;
    }

    const result = await diffAndPersist(snapshot);
    console.log('[LI Tracker] scan complete:', result);
    await updateScanState({
      lastScannedAt: Date.now(),
      lastCount: result.pendingCount,
      lastError: null,
    });

    chrome.runtime.sendMessage({
      type: 'SCAN_DONE',
      pendingCount: result.pendingCount,
      newlyAcceptedCount: result.newlyAccepted.length,
      newlyAccepted: result.newlyAccepted,
    });
  } catch (err) {
    if (err instanceof ScanCancelled) {
      console.log('[LI Tracker] scan cancelled by user');
      await updateScanState({ lastScannedAt: Date.now(), lastError: 'Cancelled by user' });
    } else {
      console.error('[LI Tracker] scan failed:', err);
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

setupWithdrawListener();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'TOGGLE_SCAN') {
    if (scanInFlight) cancelRequested = true;
    else runScan();
  }
});
