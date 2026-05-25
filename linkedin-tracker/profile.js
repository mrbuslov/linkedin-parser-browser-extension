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

// Always-on observer catches both the initial render delay AND in-page status
// changes (you click Connect → button becomes Pending → mutation fires → we
// re-persist). Debounced so we don't run on every micro-mutation.
let lastDetected = { url: null, status: null };
let pendingDestructiveConfirm = null;
const STABILITY_DELAY_MS = 1500;

// Decide whether the detected status would be a destructive change vs current
// storage. Destructive = removes or downgrades an existing entry (delete from
// accepted, demote to declined, remove from sentInvitations, etc.). For these
// cases we require the detection to be stable over ~1.5s — LinkedIn's profile
// top card sometimes briefly renders a Connect button on a 1st-degree contact
// before settling on Message, and we don't want to nuke real data on that flash.
async function isDestructiveChange(profileUrl, status) {
  if (status === 'connected') return false;
  const { accepted = {}, sentInvitations = {} } = await dbGet(['accepted', 'sentInvitations']);
  const inAccepted = !!accepted[profileUrl];
  const inPending = !!sentInvitations[profileUrl];
  if (status === 'not_connected') return inAccepted || inPending;
  if (status === 'pending') return inAccepted;
  return false;
}

async function tick() {
  const info = extractProfileInfo();
  const root = document.querySelector('main') || document.body;
  const status = LITDetect.detectConnectionStatus(root);
  if (!info || !status) return;
  if (lastDetected.url === info.profileUrl && lastDetected.status === status) return;

  if (await isDestructiveChange(info.profileUrl, status)) {
    clearTimeout(pendingDestructiveConfirm);
    pendingDestructiveConfirm = setTimeout(async () => {
      const root2 = document.querySelector('main') || document.body;
      const status2 = LITDetect.detectConnectionStatus(root2);
      // Only commit if the destructive status is still the verdict after the
      // delay — protects against transient mid-render false positives.
      if (status2 === status) {
        lastDetected = { url: info.profileUrl, status };
        await persistVisit();
      }
    }, STABILITY_DELAY_MS);
    return;
  }

  lastDetected = { url: info.profileUrl, status };
  await persistVisit();
}

let scheduled = null;
const observer = new MutationObserver(() => {
  clearTimeout(scheduled);
  scheduled = setTimeout(tick, 500);
});
observer.observe(document.body, { childList: true, subtree: true });
tick();
