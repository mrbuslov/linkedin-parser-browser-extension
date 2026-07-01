// Bulk Visit Queue — per-tab controller.
//
// Runs on every /in/* page (registered in manifest). Wakes up ONLY when
// (a) a running queue exists, (b) the currently-running item's URL
// matches this tab's URL. Otherwise it stays dormant — normal profile
// visits from the user's own browsing are untouched.
//
// Responsibilities:
//   1) Detect LinkedIn health signals (/checkpoint/, /uas/, /error/)
//      and pipe HEALTH_ALARM to the SW immediately.
//   2) Wait ~3s for the underlying profile.js + LITContactsModal to
//      parse — those run automatically because the profile URL matches
//      their content-script registration.
//   3) Execute humanizer.scrollPlan() — variable-velocity scrollBy loop.
//   4) Reading dwell (humanizer.readingTime) after scroll finishes.
//   5) Signal VISIT_CAPTURE_DONE to the SW.
//
// The SW's plan() function decides what happens next. This script is
// pure I/O — no state, no persistence.

(async function visitContentMain() {
  // Health signals BEFORE anything else — if we landed on /checkpoint/,
  // the profile URL never existed here in the first place.
  const path = location.pathname || '';
  if (/^\/(checkpoint|uas|error)(\/|$)/i.test(path)) {
    chrome.runtime.sendMessage({ type: 'VISIT_HEALTH_ALARM', signal: path }).catch(() => {});
    return;
  }

  // Only act when there's an active running queue whose current item
  // matches this URL. Otherwise this is a normal user browsing session.
  const { visitQueue } = await dbGet('visitQueue');
  if (!visitQueue || visitQueue.status !== 'running') return;

  const runningIdx = visitQueue.items.findIndex((i) => i.status === 'running');
  if (runningIdx === -1) return;
  const running = visitQueue.items[runningIdx];

  // The tab was opened at /in/{vanity}/overlay/contact-info/ — after
  // LinkedIn redirect / normalization the pathname is one of:
  //   /in/{vanity}/overlay/contact-info/
  //   /in/{vanity}/
  // Either way it starts with running.url's /in/{vanity}/ segment.
  const runningPath = new URL(running.url).pathname;
  if (!location.pathname.startsWith(runningPath)) return;

  // Give profile.js + LITContactsModal time to hydrate. They run on
  // document_idle; give them a beat to parse RSC/DOM and dbSet.
  await sleep(3000);

  // Build a seeded PRNG per visit so each profile gets its own
  // scroll+dwell pattern deterministically from queue seed + index.
  const rand = LITHumanizer.mulberry32((visitQueue.seed >>> 0) ^ ((runningIdx + 1) * 0x9E3779B9));

  // Sample content dimensions BEFORE scroll for reading-time calc.
  const contentDims = {
    headlineLen: (document.querySelector('h1')?.textContent || '').length,
    aboutLen:    (document.querySelector('[data-view-name="profile-component-entity"] .display-flex')?.textContent || '').length,
    experienceCount: document.querySelectorAll('[data-view-name="profile-component-entity"]').length,
  };

  // Execute scroll plan — real scrolls trigger real scroll events with
  // isTrusted=true (because we're actually scrolling, not dispatching
  // a synthetic event). LinkedIn sees this as a human reading.
  const pageHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
    2000,
  );
  const plan = LITHumanizer.scrollPlan({ pageHeight, rand });
  for (const step of plan) {
    if (step.delta !== 0) {
      window.scrollBy({ top: step.delta, behavior: 'auto' });
    }
    await sleep(step.ms);
    // Between steps, check if queue is still running — if user paused
    // via popup, we abort scrolling early.
    if (await isQueueStillRunning() === false) return;
  }

  // Reading dwell after scroll — scaled to content volume.
  const dwell = LITHumanizer.readingTime({ ...contentDims, rand });
  await sleep(dwell);

  // Final check before signaling done.
  if (await isQueueStillRunning() === false) return;

  chrome.runtime.sendMessage({ type: 'VISIT_CAPTURE_DONE' }).catch(() => {});
})();

async function isQueueStillRunning() {
  const { visitQueue } = await dbGet('visitQueue');
  return visitQueue && visitQueue.status === 'running';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
