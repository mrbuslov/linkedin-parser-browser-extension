// Pure decision helpers used by popup.js. Extracted into core/ so they can be
// unit-tested in jsdom without dragging in the rest of popup.js (which calls
// chrome.* APIs at module load).

function shouldShowDeclinedWarning(declinedCount, connectionsScanState) {
  if (declinedCount <= 0) return false;
  if (connectionsScanState && connectionsScanState.lastScannedAt) return false;
  return true;
}

const LITPopupLogic = { shouldShowDeclinedWarning };
if (typeof globalThis !== 'undefined') globalThis.LITPopupLogic = LITPopupLogic;
if (typeof module !== 'undefined' && module.exports) module.exports = LITPopupLogic;
