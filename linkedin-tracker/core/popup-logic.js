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

const LITPopupLogic = { shouldShowDeclinedWarning, cleanHeadline, fixSwappedNameHeadline, parseMutualsCount };
if (typeof globalThis !== 'undefined') globalThis.LITPopupLogic = LITPopupLogic;
if (typeof module !== 'undefined' && module.exports) module.exports = LITPopupLogic;
