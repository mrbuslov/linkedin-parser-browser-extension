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
    if (text) return text;
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

  // Prefer canonical name from the RSC payload — survives any DOM weirdness
  // (long-headline-stuck-to-name, missing h2 mid-render, locale variants).
  // Falls back to heading text when payload is absent (SPA navigations).
  let name = '';
  const rscBasics = LITRSC.findProfileBasics(LITRSC.extractRSCTextCached(document));
  if (rscBasics) {
    name = `${rscBasics.firstName} ${rscBasics.lastName}`.trim();
  }
  if (!name) name = (heading?.textContent || '').trim();
  if (!name) return null;

  let headline = '';
  for (const node of root.querySelectorAll('div, span, p')) {
    if (node.children.length > 0) continue;
    const t = (node.textContent || '').trim();
    if (!t || t.length < 3) continue;
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

  // Contact info overlay: parsed if the user has it open. Null otherwise —
  // applyProfileVisit treats null as "no fresh data, keep previously stored
  // fields as-is".
  const contactInfo = LITContactsModal.parseContactsModal(document);

  const stored = await dbGet(['contacts', 'accepted', 'sentInvitations']);
  const result = LITProfileState.applyProfileVisit(stored, info, status, Date.now(), contactInfo);

  const patch = {};
  if (autoCapture) patch.contacts = result.contacts;
  if (result.acceptedChanged) patch.accepted = result.accepted;
  if (result.sentChanged) patch.sentInvitations = result.sentInvitations;
  if (Object.keys(patch).length > 0) await dbSet(patch);

  if (contactInfo) showCaptureToast(contactInfo);

  console.log(`[LI Tracker] visited ${info.name} (${status})`);
}

// Tiny in-page confirmation that runs only when the user has actually opened
// the Contact info overlay and we just saved fresh fields. Dedup by stringified
// payload so we don't spam on every poll tick while the overlay is open.
let lastToastKey = '';
function showCaptureToast(contactInfo) {
  const key = JSON.stringify(contactInfo);
  if (key === lastToastKey) return;
  lastToastKey = key;

  const captured = ['email', 'phone', 'website', 'address', 'birthday']
    .filter((k) => contactInfo[k])
    .map((k) => ({ email: '📧', phone: '📞', website: '🌐', address: '📍', birthday: '🎂' }[k]))
    .join(' ');
  if (!captured) return;

  let node = document.getElementById('lit-capture-toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'lit-capture-toast';
    Object.assign(node.style, {
      position: 'fixed', bottom: '20px', right: '20px',
      background: '#1e7e34', color: '#fff',
      padding: '10px 14px', borderRadius: '8px',
      fontSize: '13px', fontFamily: '-apple-system, sans-serif',
      boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
      zIndex: '999999',
      opacity: '0', transition: 'opacity 0.2s, transform 0.2s',
      transform: 'translateY(8px)',
      pointerEvents: 'none',
    });
    document.body.append(node);
  }
  node.textContent = `✓ Contact info saved — ${captured}`;
  node.style.opacity = '1';
  node.style.transform = 'translateY(0)';
  clearTimeout(node._hideT);
  node._hideT = setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
  }, 2200);
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
let lastDetected = { url: null, status: null, contactsKey: '' };

// Cheap stable hash of the contact-info fields so we re-persist exactly when
// the user opens or edits the overlay, and not on every quiet tick. Empty
// string ⇒ overlay not open / no parseable data.
function contactsFingerprint(info) {
  if (!info) return '';
  return [info.email, info.phone, info.website, info.address, info.birthday, info.connectedSinceText]
    .map((v) => v || '').join('|');
}

async function tick() {
  const info = extractProfileInfo();
  const root = document.querySelector('main') || document.body;
  const status = LITDetect.detectConnectionStatus(root);
  if (!info || !status) return;
  const contactsKey = contactsFingerprint(LITContactsModal.parseContactsModal(document));
  if (lastDetected.url === info.profileUrl
      && lastDetected.status === status
      && lastDetected.contactsKey === contactsKey) return;
  lastDetected = { url: info.profileUrl, status, contactsKey };
  await persistVisit();
}

setInterval(tick, POLL_INTERVAL_MS);
tick();
