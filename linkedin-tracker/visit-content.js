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

  // Inject the floating widget so user can pause/cancel from the tab
  // without opening the popup. Rendered once per page load.
  injectVisitWidget(visitQueue);

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

  // Optional: click the "Contact info" button. Opt-in via
  // settings.clickContactInfo — default OFF. Synthetic .click() has
  // isTrusted=false which LinkedIn may log, but the modal DOES open
  // (React handlers don't check isTrusted). Only useful for 1st-degree
  // connections; for others the button either doesn't exist or the
  // modal is empty.
  if (visitQueue.settings && visitQueue.settings.clickContactInfo) {
    await tryClickContactInfo();
  }

  chrome.runtime.sendMessage({ type: 'VISIT_CAPTURE_DONE', url: running.url }).catch(() => {});
})();

async function tryClickContactInfo() {
  // Selector strategy: LinkedIn's Contact info button lives in the
  // top card and has an anchor with href ending in /overlay/contact-info/
  // OR a button with data-view-name including "contact-info". Both
  // patterns rotate; anchor is the more stable of the two.
  const anchor = document.querySelector(
    'a[href*="/overlay/contact-info/"], [data-view-name*="contact-info"]',
  );
  if (!anchor) return;
  try {
    anchor.click();
  } catch { return; }
  // Wait up to 4s for the modal DOM to appear — LITContactsModal
  // auto-parses when it does, no coordination needed here.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (document.querySelector('.artdeco-modal[aria-labelledby*="contact"], section.pv-contact-info')) {
      await sleep(1500); // let modal fully render + LITContactsModal parse
      return;
    }
    await sleep(200);
  }
}

async function isQueueStillRunning() {
  const { visitQueue } = await dbGet('visitQueue');
  return visitQueue && visitQueue.status === 'running';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Floating cancel widget — same shape as visit-feed.js. Kept inline
// (not in core/) because there's no shared module system for content
// scripts and the widget's tiny surface doesn't warrant one.
function injectVisitWidget(visitQueue) {
  if (document.getElementById('lit-visit-widget')) return;
  const w = document.createElement('div');
  w.id = 'lit-visit-widget';
  w.style.cssText = [
    'position:fixed', 'top:80px', 'right:16px', 'z-index:2147483647',
    'background:#0a66c2', 'color:#fff', 'font-family:-apple-system,sans-serif',
    'font-size:13px', 'padding:10px 12px', 'border-radius:8px',
    'box-shadow:0 4px 12px rgba(0,0,0,0.2)', 'min-width:220px',
    'display:flex', 'flex-direction:column', 'gap:8px',
  ].join(';');

  const visited = visitQueue.items.filter((i) => i.status === 'visited').length;
  const total   = visitQueue.items.length;
  const remaining = total - visited;

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700;font-size:12px';
  title.textContent = '🤖 Bulk visit running';
  w.appendChild(title);

  const p = document.createElement('div');
  p.style.cssText = 'font-size:11px;opacity:0.9';
  p.textContent = `Progress: ${visited} / ${total} · ${remaining} left`;
  w.appendChild(p);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px';

  const pauseBtn = document.createElement('button');
  pauseBtn.textContent = 'Pause';
  pauseBtn.style.cssText = _widgetBtn('#fff', '#0a66c2');
  pauseBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'VISIT_QUEUE_PAUSE' }).catch(() => {});
    w.remove();
  });
  row.appendChild(pauseBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel queue';
  cancelBtn.style.cssText = _widgetBtn('#d02b1e', '#fff');
  cancelBtn.addEventListener('click', () => {
    if (!confirm('Cancel the queue? Remaining items will be marked as skipped.')) return;
    chrome.runtime.sendMessage({ type: 'VISIT_QUEUE_CANCEL' }).catch(() => {});
    w.remove();
  });
  row.appendChild(cancelBtn);

  w.appendChild(row);
  document.body.appendChild(w);
}

function _widgetBtn(bg, fg) {
  return [
    `background:${bg}`, `color:${fg}`, 'border:none', 'border-radius:5px',
    'padding:6px 10px', 'cursor:pointer', 'font-size:11px', 'font-weight:600',
    'flex:1',
  ].join(';');
}
