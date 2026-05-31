// Runs on every linkedin.com/in/* page visit.
// Pure logic lives in core/detect.js (status detection) and core/profile-state.js
// (state transitions). This file is the DOM-scraping + persistence layer.

console.log('[LI Tracker] profile script loaded:', location.pathname);

// Location lives in a row with exactly three <p> children:
//   <p>City, Country</p>  <p>·</p>  <p><a href="#">Contact info</a></p>
// The "·" + href="#" anchor combo is unique to the profile top card and
// doesn't get localized, so this survives across languages and class renames.
function extractLocation() {
  const root = document.querySelector('main') || document.body;
  for (const div of root.querySelectorAll('div')) {
    const ps = Array.from(div.children).filter((c) => c.tagName === 'P');
    if (ps.length !== 3) continue;
    if (ps[1].textContent.trim() !== '·') continue;
    if (!ps[2].querySelector('a[href="#"]')) continue;
    const text = ps[0].textContent.trim();
    if (text && text.length < 200) return text;
  }
  return '';
}

function parseCountry(location) {
  if (!location) return '';
  const parts = location.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : '';
}

function extractProfileInfo() {
  const root = document.querySelector('main') || document.body;
  const heading = root.querySelector('h1') || root.querySelector('h2');
  const name = (heading?.textContent || '').trim();
  if (!name) return null;

  let headline = '';
  for (const node of root.querySelectorAll('div, span, p')) {
    if (node.children.length > 0) continue;
    const t = (node.textContent || '').trim();
    if (!t || t.length < 3 || t.length > 200) continue;
    if (t === name) continue;
    if (heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
      headline = t;
      break;
    }
  }

  // Avatar: LinkedIn profile photos always carry `profile-displayphoto` in their
  // URL — language-stable and survives class renames.
  let avatar = '';
  for (const img of root.querySelectorAll('img[src]')) {
    if (img.src.includes('profile-displayphoto')) {
      avatar = img.src;
      break;
    }
  }
  if (!avatar) {
    let parent = heading.parentElement;
    for (let i = 0; i < 6 && parent && !avatar; i++) {
      const img = parent.querySelector('img[src]');
      if (img?.src && !img.src.startsWith('data:')) avatar = img.src;
      parent = parent.parentElement;
    }
  }

  const location = extractLocation();
  const country = parseCountry(location);

  return {
    profileUrl: LITUrl.normalizeProfileUrl(window.location.href),
    name,
    headline,
    avatar,
    location,
    country,
  };
}

async function persistVisit() {
  const info = extractProfileInfo();
  const root = document.querySelector('main') || document.body;
  const status = LITDetect.detectConnectionStatus(root);
  if (!info || !status) return;

  // Honor the opt-in capture toggle (P1.2). If the user disabled auto-save,
  // we still record acceptance verifications (accepted/sentInvitations) but
  // skip writing to the `contacts` store. The acceptance bookkeeping is data
  // integrity; the contacts log is the recruiter-objected "auto-CRM" piece.
  const settings = await dbGet('settings');
  const autoCapture = settings.settings?.autoCaptureProfiles !== false;

  const stored = await dbGet(['contacts', 'accepted', 'sentInvitations']);
  const result = LITProfileState.applyProfileVisit(stored, info, status, Date.now());

  const patch = {};
  if (autoCapture) patch.contacts = result.contacts;
  if (result.acceptedChanged) patch.accepted = result.accepted;
  if (result.sentChanged) patch.sentInvitations = result.sentInvitations;
  if (Object.keys(patch).length > 0) await dbSet(patch);

  console.log(`[LI Tracker] visited ${info.name} (${status})`);
}

// Simple poll loop: every POLL_INTERVAL_MS we re-detect status and persist if
// it changed since the last commit. LinkedIn renders the profile top card
// incrementally — buttons appear/swap during the first few seconds — so any
// single point-in-time read can be wrong. Polling means "the LATEST snapshot
// wins": a transient mid-render false positive gets self-corrected on the next
// tick a quarter-second later. Cheaper than it sounds (querySelector is
// microseconds), no network, no LinkedIn-side detection surface.
//
// Safety net for destructive changes lives one layer deeper: in
// applyProfileVisit, entries with `connectedOnText` (canonical /connections/
// scan) are immune to downgrades from a profile visit. So even a transient
// mid-tick false positive can't damage a confirmed connection.
const POLL_INTERVAL_MS = 250;
let lastDetected = { url: null, status: null };

async function tick() {
  const info = extractProfileInfo();
  const root = document.querySelector('main') || document.body;
  const status = LITDetect.detectConnectionStatus(root);
  if (!info || !status) return;
  if (lastDetected.url === info.profileUrl && lastDetected.status === status) return;
  lastDetected = { url: info.profileUrl, status };
  await persistVisit();
}

setInterval(tick, POLL_INTERVAL_MS);
tick();
