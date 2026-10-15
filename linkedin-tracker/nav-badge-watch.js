// Sensor half of LinkedIn notifications: reports what the page shows to the
// service worker, which owns the decision so two open tabs cannot notify twice.

const NAV_POLL_INTERVAL_MS = 3000;
const NAV_MUTATION_DEBOUNCE_MS = 400;

let lastReportedFingerprint = null;
let anchorsMissingLogged = false;
let navDebounceTimer = null;

async function reportNavState() {
  const observed = LITNavWatch.observe(document);
  if (!observed) {
    if (!anchorsMissingLogged) {
      anchorsMissingLogged = true;
      console.warn('[LI Tracker/nav] no LinkedIn nav counters on this page — nothing to watch');
    }
    return;
  }
  anchorsMissingLogged = false;
  const fingerprint = JSON.stringify(observed);
  if (fingerprint === lastReportedFingerprint) return;
  lastReportedFingerprint = fingerprint;
  await swRequest({ type: 'NAV_OBSERVED', observed });
}

function scheduleNavReport() {
  if (navDebounceTimer) return;
  navDebounceTimer = setTimeout(() => {
    navDebounceTimer = null;
    reportNavState();
  }, NAV_MUTATION_DEBOUNCE_MS);
}

setInterval(reportNavState, NAV_POLL_INTERVAL_MS);
new MutationObserver(scheduleNavReport).observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributeFilter: ['aria-label'],
});
reportNavState();
