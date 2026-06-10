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

const LITPopupLogic = { shouldShowDeclinedWarning, cleanHeadline, fixSwappedNameHeadline };
if (typeof globalThis !== 'undefined') globalThis.LITPopupLogic = LITPopupLogic;
if (typeof module !== 'undefined' && module.exports) module.exports = LITPopupLogic;
