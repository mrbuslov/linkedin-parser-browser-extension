// Sensor half of new-message notifications: reports what the page shows to the
// service worker, which owns the decision so two open tabs cannot notify twice.

const MESSAGE_POLL_INTERVAL_MS = 3000;
const MESSAGE_MUTATION_DEBOUNCE_MS = 400;

let lastReportedFingerprint = null;
let anchorsMissingLogged = false;
let debounceTimer = null;

async function reportMessagingState() {
  const observed = LITMessageWatch.observe(document);
  if (!observed) {
    if (!anchorsMissingLogged) {
      anchorsMissingLogged = true;
      console.warn('[LI Tracker/messages] messaging badge anchor not found on this page — unread count unreadable');
    }
    return;
  }
  anchorsMissingLogged = false;
  const fingerprint = JSON.stringify(observed);
  if (fingerprint === lastReportedFingerprint) return;
  lastReportedFingerprint = fingerprint;
  await swRequest({ type: 'MESSAGING_OBSERVED', observed });
}

function scheduleReport() {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    reportMessagingState();
  }, MESSAGE_MUTATION_DEBOUNCE_MS);
}

setInterval(reportMessagingState, MESSAGE_POLL_INTERVAL_MS);
new MutationObserver(scheduleReport).observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributeFilter: ['aria-label'],
});
reportMessagingState();
