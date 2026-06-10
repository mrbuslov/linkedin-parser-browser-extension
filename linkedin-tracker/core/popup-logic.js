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

const LITPopupLogic = { shouldShowDeclinedWarning, cleanHeadline };
if (typeof globalThis !== 'undefined') globalThis.LITPopupLogic = LITPopupLogic;
if (typeof module !== 'undefined' && module.exports) module.exports = LITPopupLogic;
