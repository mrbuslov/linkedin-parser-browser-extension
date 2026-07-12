// Pure decision helpers used by popup.js. Extracted into core/ so they can be
// unit-tested in jsdom without dragging in the rest of popup.js (which calls
// chrome.* APIs at module load).

function shouldShowDeclinedWarning(declinedCount, connectionsScanState) {
  if (declinedCount <= 0) return false;
  if (connectionsScanState && connectionsScanState.lastScannedAt) return false;
  return true;
}

// Defensive cleanup for `headline` field: legacy records have the name
// glued to the headline ("Daniil StankevichFullstack developer | …")
// because LinkedIn ships an accessibility text node that combines both.
// Extractor now strips at source, but old data is already dirty — this
// runs at render time too. Idempotent: clean data passes through.
function cleanHeadline(headline, name) {
  if (!headline || !name) return headline || '';
  const t = headline.trim();
  if (t.toLowerCase().startsWith(name.toLowerCase())) {
    return t.slice(name.length).replace(/^[\s·•|—-]+/, '').trim();
  }
  return t;
}

// Detect and correct the "name and headline got swapped" case in legacy
// records. LinkedIn sometimes ships an accessibility text node like
//   "Daniil StankevichFullstack developer | React/Angular/NestJS"
// where the real name + headline are glued. An older extractor stored the
// glued text as `name` and the clean name as `headline`. Symptom in the
// popup: the row's name cell shows the long glued blob.
//
// Detection: `name` starts with `headline` AND is longer than `headline`.
// That's the unambiguous signature — clean records never satisfy both.
//
// Returns { name, headline } — same shape, possibly corrected. Idempotent:
// already-clean records pass through unchanged.
function fixSwappedNameHeadline(record) {
  const name = (record && record.name) || '';
  const headline = (record && record.headline) || '';
  if (!name || !headline) return { name, headline };
  if (name.length > headline.length
      && name.toLowerCase().startsWith(headline.toLowerCase())) {
    const realHeadline = name.slice(headline.length)
      .replace(/^[\s·•|—-]+/, '').trim();
    return { name: headline, headline: realHeadline };
  }
  return { name, headline };
}

// Extract the headline text from a top-card DOM scope. Pure function —
// takes the scope element, the heading (h1/h2) it found, and the resolved
// name. Returns the cleaned headline string or '' when none found.
//
// Deterministic skip rules (each anchored on a stable LinkedIn-or-upstream
// marker, never a guess):
//   1) DEGREE_BADGE — "· 1st"/"· 2nd"/"· 3rd"/localized variants. LinkedIn
//      renders the degree as a text node right after the heading.
//   2) video.js elements (class prefix `vjs-*`). LinkedIn embeds cover
//      videos using video.js (videojs.com); the loading-spinner span
//      contains "Video Player is loading." which would otherwise be
//      grabbed as headline. Regression: Clare Suttie's profile, 2026-06-11.
//   3) The name itself (LinkedIn sometimes renders an SR-only span with
//      just the name; or a span with name+headline glued — stripNamePrefix
//      handles the glued case).
function extractHeadlineFromScope(scope, heading, name) {
  if (!scope || !name) return '';
  const DEGREE_BADGE_RE = /^[·•・]\s*(1st|2nd|3rd|1-?[йгi]|2-?[йгi]|3-?[йгi])\b/i;
  for (const node of scope.querySelectorAll('div, span, p')) {
    if (node.children.length > 0) continue;
    const t = (node.textContent || '').trim();
    if (!t || t.length < 3) continue;
    if (t === name) continue;
    if (DEGREE_BADGE_RE.test(t)) continue;
    if (node.closest && node.closest('[class*="vjs-"]')) continue;
    if (!heading || (heading.compareDocumentPosition(node) & 4 /* FOLLOWING */)) {
      // stripNamePrefix is defined globally by profile.js content script;
      // for jsdom tests it's re-implemented inline below since it's tiny.
      const stripper = (typeof globalThis !== 'undefined' && globalThis.LITStripName)
        || ((text, n) => {
          const tr = (text || '').trim();
          if (tr.toLowerCase().startsWith(n.toLowerCase())) {
            return tr.slice(n.length).replace(/^[\s·•|—-]+/, '').trim();
          }
          return tr;
        });
      const h = stripper(t, name);
      if (h) return h;
    }
  }
  return '';
}

// Manual demote: user clicks − on a Pending row to say "this invitation
// is no longer active on LinkedIn" (they deleted it via LinkedIn's UI and
// we didn't catch the click, or it was cleaned up out-of-band). Semantics
// mirror what diffSentInvitations would do if it saw a fresh withdraw
// stamp: status → declined, both declinedAt and withdrawnAt stamped now
// (unless withdrawnAt was already set).
function demoteToDeclined(record, now) {
  if (!record) return record;
  return {
    ...record,
    status: 'declined',
    declinedAt: now,
    withdrawnAt: record.withdrawnAt || now,
  };
}

// Manual demote: user clicks − on an Accepted row to say "this person is
// not actually in my network". Sets status → visited and CLEARS the
// anti-downgrade guards (firstConnectedAt AND connectedOnText/Date) —
// without clearing them, the next profile-page visit would re-elevate
// through profile-state.js:337, silently undoing the user's decision.
// Historical daysPending is preserved. If a future /connections/ scan
// sees them as truly connected, merge-connections will restore accepted
// with fresh canonical data — that's the intended behaviour: user's
// manual demote is a one-off correction, LinkedIn's canonical scan wins.
function demoteToVisited(record, now) {
  if (!record) return record;
  return {
    ...record,
    status: 'visited',
    acceptedAt: null,
    verifiedAt: null,
    firstConnectedAt: null,
    connectedOnText: '',
    connectedOnDate: '',
    visitedAt: now,
  };
}

// Decide whether to show the contextual "your store has N pending, last
// scan captured only M" info banner in the Pending tab. Mirrors the
// partial-scan guard in diff-sent.js (SANITY_SHRINK_RATIO=0.5,
// SANITY_MIN_PREV=5) — banner shows exactly when the guard would have
// suppressed the missing→accepted diff. Educates the user about why
// records didn't auto-clear and points them at the − button.
function shouldShowScanGap(pendingCount, lastScanCount) {
  if (pendingCount <= 5) return false;
  if (lastScanCount == null) return false;
  return lastScanCount < pendingCount * 0.5;
}

// Format an ETA-in-ms as a short human-readable string. Used by the
// 🚶 Bulk Visit panel to show "~14 min remaining" or "~2h 15min
// remaining" so the user doesn't have to guess how long a 525-URL run
// will take. Rounds to the nearest minute above 1min; small values
// (<1min) collapse to "<1 min".
function formatEta(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '<1 min';
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return '<1 min';
  if (totalMin < 60) return `~${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `~${h}h` : `~${h}h ${m}min`;
}

// Parse the mutual-connections count from the anchor's text content.
//   "Anton, Mikhail and 79 other mutual connections" → 81
//   "and 12 other mutual connections"                 → 12
//   "5 mutual connections"                            → 5
// Returns null when the text doesn't carry a deterministic count — caller
// MUST treat null as "not known" and not substitute a guess.
function parseMutualsCount(text) {
  if (!text) return null;
  const others = text.match(/\band\s+(\d+)\s+other\b/i);
  if (others) {
    const n = parseInt(others[1], 10);
    const before = text.split(/\band\s+\d+\s+other\b/i)[0];
    const names = before.split(',').map((s) => s.trim()).filter(Boolean).length;
    return n + names;
  }
  const single = text.match(/(\d+)\s+mutual/i);
  if (single) return parseInt(single[1], 10);
  return null;
}

const LITPopupLogic = {
  shouldShowDeclinedWarning,
  cleanHeadline,
  fixSwappedNameHeadline,
  parseMutualsCount,
  extractHeadlineFromScope,
  demoteToDeclined,
  demoteToVisited,
  shouldShowScanGap,
  formatEta,
};
if (typeof globalThis !== 'undefined') globalThis.LITPopupLogic = LITPopupLogic;
if (typeof module !== 'undefined' && module.exports) module.exports = LITPopupLogic;
