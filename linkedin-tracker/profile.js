// Runs on linkedin.com/in/*. If the profile owner is in our `accepted` list,
// detect whether they're actually connected (Message button visible) or not
// (Connect/Pending visible = they declined or we withdrew). Writes the result
// back to accepted[url].verified so the popup can show ✓ / ✗.

function normalizeProfileUrl(href) {
  const u = new URL(href, location.origin);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
}

// Look only inside the profile's main section so we don't false-match the
// "Message" item in nav, the messaging widget, or sidebar promos.
function detectConnectionStatus() {
  const root = document.querySelector('main') || document.body;
  const buttons = root.querySelectorAll('button, a[role="button"]');

  let hasMessage = false;
  let hasConnect = false;
  let hasPending = false;

  for (const btn of buttons) {
    if (btn.offsetParent === null) continue;
    const text = (btn.textContent || '').trim().toLowerCase();
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const combined = `${text} ${aria}`;

    if (/(^|\s)message(\s|$)/.test(combined)) hasMessage = true;
    if (/(^|\s)connect(\s|$)/.test(combined)) hasConnect = true;
    if (/(^|\s)pending(\s|$)/.test(combined)) hasPending = true;
  }

  if (hasMessage) return 'accepted';
  if (hasConnect || hasPending) return 'declined';
  return null;
}

async function maybeVerifyProfile() {
  const profileUrl = normalizeProfileUrl(location.href);
  const { accepted = {} } = await chrome.storage.local.get('accepted');
  const entry = accepted[profileUrl];
  if (!entry) return;

  const status = detectConnectionStatus();
  if (!status) return;
  if (entry.verified === status) return;

  entry.verified = status;
  entry.verifiedAt = Date.now();
  await chrome.storage.local.set({ accepted });
  console.log(`[LI Tracker] verified ${entry.name}: ${status}`);
  chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
}

// LinkedIn is a SPA and the action buttons appear async. Poll the DOM via
// MutationObserver until we can make a determination, then stop.
function waitAndVerify() {
  if (detectConnectionStatus()) {
    maybeVerifyProfile();
    return;
  }
  const obs = new MutationObserver(() => {
    if (detectConnectionStatus()) {
      obs.disconnect();
      maybeVerifyProfile();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 20000);
}

waitAndVerify();
