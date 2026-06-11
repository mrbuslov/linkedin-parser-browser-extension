// Runs on every linkedin.com/in/* page visit.
// Pure logic lives in core/detect.js (status detection) and core/profile-state.js
// (state transitions). This file is the DOM-scraping + persistence layer.

console.log('[LI Tracker] profile script loaded:', location.pathname);

// Strip the trailing-whitespace-trimmed `name` from the start of `text` if
// present. Case-insensitive, allows an optional separator after the name.
// Returns `text` unchanged if the prefix doesn't match. Same helper also
// lives in popup.js for defensive render-time cleanup of legacy records.
function stripNamePrefix(text, name) {
  if (!text || !name) return text || '';
  const trimmed = text.trim();
  if (trimmed.toLowerCase().startsWith(name.toLowerCase())) {
    return trimmed.slice(name.length).replace(/^[\s·•|—-]+/, '').trim();
  }
  return trimmed;
}

// Mutual-connections link. LinkedIn renders an anchor whose href is a
// search URL with two stable query parameters:
//   connectionOf=<urn>  — the viewed profile's member URN
//   network=["F"]       — filter to FIRST-degree network only ⇒ MUTUAL
//                         (the other link on the page has network=["F","S"]
//                          which is "all her connections", not mutuals)
// We anchor on both parameters; nothing else is needed. Scope to top-card
// keeps us from picking up the sidebar "People who follow X also follow"
// widgets which have similar-looking search links but with different
// network filters.
function extractMutuals(scope) {
  for (const a of scope.querySelectorAll('a[href*="connectionOf="]')) {
    if (!a.href || !/^https?:/i.test(a.href)) continue;
    const url = new URL(a.href);
    if (url.searchParams.get('network') !== '["F"]') continue;
    const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
    return { mutualsUrl: a.href, mutualsText: text };
  }
  return null;
}

// parseMutualsCount lives in core/popup-logic.js so tests in jsdom can pin
// the regression cases without dragging in profile.js (which calls
// chrome.* APIs at module load). Content scripts see it on globalThis via
// the popup-logic.js script tag in manifest.json's /in/* content_scripts.
const parseMutualsCount = (typeof LITPopupLogic !== 'undefined' && LITPopupLogic.parseMutualsCount)
  ? LITPopupLogic.parseMutualsCount
  : () => null;

// Location lives in a row with exactly three <p> children:
//   <p>City, Country</p>  <p>·</p>  <p><a href="#">Contact info</a></p>
// The "·" + href="#" anchor combo is unique to the profile top card and
// doesn't get localized, so this survives across languages and class renames.
// Scoped to the top-card container to avoid grabbing similar structures
// from sidebar widgets ("People you may know" etc).
function extractLocation(scope) {
  const root = scope || document.querySelector('main') || document.body;
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
  // Scope: the profile top-card. Everything we extract (heading, headline,
  // location, avatar) lives inside this bounded region. Without scoping, the
  // headline scan grabbed garbage like "Video Player is loading." from the
  // page's autoplay video, location grabbed sidebar widgets with similar
  // structure, etc. If we can't identify the top-card, we degrade to root
  // — but that's the rare "LinkedIn changed structure radically" case.
  const scope = LITDetect.findTopCardContainer(root) || root;
  const heading = scope.querySelector('h1') || scope.querySelector('h2');

  // Prefer canonical name from the RSC payload — survives any DOM weirdness
  // (long-headline-stuck-to-name, missing h2 mid-render, locale variants).
  // Falls back to heading text when payload is absent (SPA navigations).
  let name = '';
  let memberId = '';
  let vanityName = '';
  const rscBasics = LITRSC.findProfileBasics(LITRSC.extractRSCTextCached(document));
  if (rscBasics) {
    name = `${rscBasics.firstName} ${rscBasics.lastName}`.trim();
    memberId  = rscBasics.memberId  || '';
    vanityName = rscBasics.vanityName || '';
  }
  if (!name) name = (heading?.textContent || '').trim();
  if (!name) return null;

  // Expose stripNamePrefix for the shared headline extractor in popup-logic.
  globalThis.LITStripName = stripNamePrefix;
  const headline = LITPopupLogic.extractHeadlineFromScope(scope, heading, name);

  // Avatar: LinkedIn profile photos always carry `profile-displayphoto` in their
  // URL — language-stable and survives class renames. Scope to top-card so we
  // don't pick up a mutual-connection's avatar from the sidebar.
  let avatar = '';
  for (const img of scope.querySelectorAll('img[src]')) {
    if (img.src.includes('profile-displayphoto')) {
      avatar = img.src;
      break;
    }
  }
  if (!avatar && heading) {
    let parent = heading.parentElement;
    for (let i = 0; i < 6 && parent && !avatar; i++) {
      const img = parent.querySelector('img[src]');
      if (img?.src && !img.src.startsWith('data:')) avatar = img.src;
      parent = parent.parentElement;
    }
  }

  const location = extractLocation(scope);
  const country = parseCountry(location);
  const mutuals = extractMutuals(scope) || {};
  const mutualsCount = parseMutualsCount(mutuals.mutualsText);

  return {
    profileUrl: LITUrl.normalizeProfileUrl(window.location.href),
    name,
    headline,
    avatar,
    location,
    country,
    memberId,
    vanityName,
    mutualsUrl: mutuals.mutualsUrl || '',
    mutualsText: mutuals.mutualsText || '',
    mutualsCount: mutualsCount,
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

  if (contactInfo) {
    showCaptureToast(contactInfo);
    // Bust the nudge cache so the next tick re-reads storage and hides the
    // chip if we just captured email/phone/website.
    nudgeCache = { url: null, hasContacts: null };
  }

  console.log(`[LI Tracker] visited ${info.name} (${status})`);
}

// LinkedIn-style in-page confirmation that runs only when the user has actually
// opened the Contact info overlay and we just saved fresh fields. Dedup by
// stringified payload so we don't spam on every poll tick while the overlay
// is open. We use the MAX z-index (2147483647) because the contact-info modal
// itself sits on a backdrop with its own high z-index — anything lower hides
// the toast behind the dim layer.
let lastToastKey = '';
function showCaptureToast(contactInfo) {
  const key = JSON.stringify(contactInfo);
  if (key === lastToastKey) return;
  lastToastKey = key;

  const FIELD_DEFS = [
    ['email',    '📧', 'email'],
    ['phone',    '📞', 'phone'],
    ['website',  '🌐', 'website'],
    ['address',  '📍', 'address'],
    ['birthday', '🎂', 'birthday'],
  ];
  const captured = FIELD_DEFS.filter(([k]) => contactInfo[k]);
  if (captured.length === 0) return;

  // Use the Popover API in `manual` mode to put the toast in the BROWSER'S
  // top layer. LinkedIn's Contact-info overlay opens via the native
  // `<dialog>.showModal()` API which is itself in the top layer; nothing
  // rendered with plain `position: fixed` — regardless of z-index — can
  // appear above a top-layer element. Popover-API elements are in the same
  // top layer, so we coexist with the modal. Chrome 114+ supports this by
  // default; the extension targets current Chrome only.
  let node = document.getElementById('lit-capture-toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'lit-capture-toast';
    node.setAttribute('popover', 'manual');
    Object.assign(node.style, {
      position: 'fixed', bottom: '24px', right: '24px',
      top: 'auto', left: 'auto',
      margin: '0',
      display: 'flex', alignItems: 'flex-start', gap: '14px',
      background: '#ffffff', color: '#111',
      padding: '18px 22px', borderRadius: '12px',
      fontSize: '14px', fontWeight: '500',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      lineHeight: '1.4',
      border: '1px solid rgba(0, 0, 0, 0.08)',
      boxShadow: '0 10px 32px rgba(0, 0, 0, 0.18), 0 4px 12px rgba(0, 0, 0, 0.10)',
      maxWidth: '380px',
      opacity: '0', transition: 'opacity 0.22s ease-out, transform 0.22s ease-out',
      transform: 'translateY(10px)',
      pointerEvents: 'none',
    });
    document.body.append(node);
  }

  // White LinkedIn-style: green ✓ in a circle, title in dark text, chips
  // below. Mirrors LinkedIn's own action confirmations (e.g. "Connection
  // request sent").
  node.innerHTML = '';
  const checkEl = document.createElement('span');
  checkEl.textContent = '✓';
  Object.assign(checkEl.style, {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '28px', height: '28px', borderRadius: '50%',
    background: '#057642', color: '#fff',
    fontSize: '16px', fontWeight: '700', lineHeight: '1',
    flexShrink: '0', marginTop: '1px',
  });
  const bodyEl = document.createElement('div');
  Object.assign(bodyEl.style, { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0' });
  const titleEl = document.createElement('div');
  titleEl.textContent = `Contact info saved (${captured.length} field${captured.length > 1 ? 's' : ''})`;
  Object.assign(titleEl.style, { fontWeight: '600', color: '#111', fontSize: '14px' });
  const chipsEl = document.createElement('div');
  Object.assign(chipsEl.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' });
  for (const [, emoji, label] of captured) {
    const chip = document.createElement('span');
    chip.textContent = `${emoji} ${label}`;
    Object.assign(chip.style, {
      background: '#f3f2ef', color: '#444',
      padding: '3px 9px', borderRadius: '12px',
      fontSize: '12px', fontWeight: '500',
    });
    chipsEl.append(chip);
  }
  bodyEl.append(titleEl, chipsEl);
  node.append(checkEl, bodyEl);

  // Push into top layer if not already showing. The showPopover() call is
  // idempotent in the sense that calling it on an already-showing popover
  // throws; we guard with the data flag.
  if (!node._showing) {
    try { node.showPopover(); node._showing = true; } catch { /* older Chrome */ }
  }
  node.style.opacity = '1';
  node.style.transform = 'translateY(0)';
  clearTimeout(node._hideT);
  node._hideT = setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(10px)';
    setTimeout(() => {
      if (node._showing) {
        try { node.hidePopover(); } catch { /* noop */ }
        node._showing = false;
      }
    }, 250);
  }, 2800);
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

// CRM nudge: a native browser tooltip attached to LinkedIn's "Contact info"
// link on 1st-degree profiles where we haven't yet captured email/phone/
// website. Less intrusive than a visible chip — only appears on hover and
// uses the browser's standard title-attribute tooltip. We mark the link
// with `data-lit-nudge="1"` so we know to clean it up when contacts are
// saved (and so we don't trample a `title` LinkedIn ever decides to add).
const NUDGE_TOOLTIP =
  '💾 Click to save contact info to your local CRM. Nothing leaves your device.';
let nudgeCache = { url: null, hasContacts: null };

function findContactInfoLink() {
  // Same heuristic as extractLocation: the row has exactly three <p>
  // children — city, "·" separator, then a <p> wrapping <a href="#">.
  const root = document.querySelector('main') || document.body;
  for (const div of root.querySelectorAll('div')) {
    const ps = Array.from(div.children).filter((c) => c.tagName === 'P');
    if (ps.length !== 3) continue;
    if (ps[1].textContent.trim() !== '·') continue;
    const link = ps[2].querySelector('a[href="#"]');
    if (link) return link;
  }
  return null;
}

function removeNudge(link) {
  const target = link || document.querySelector('[data-lit-nudge="1"]');
  if (!target) return;
  if (target.dataset.litNudge === '1') {
    target.removeAttribute('title');
    delete target.dataset.litNudge;
  }
}

function showNudge(link) {
  if (!link) return;
  if (link.dataset.litNudge === '1') return;  // already wired
  link.setAttribute('title', NUDGE_TOOLTIP);
  link.dataset.litNudge = '1';
}

async function updateCRMNudge(profileUrl, status) {
  if (status !== 'connected') {
    removeNudge();
    return;
  }
  // Re-check storage only on URL change — same-profile ticks reuse the cache.
  // Cache is invalidated by persistVisit() after a successful contact-info
  // save, so the tooltip is removed as soon as the parser captures data.
  if (nudgeCache.url !== profileUrl) {
    const stored = await dbGet(['contacts', 'accepted']);
    const rec = (stored.contacts || {})[profileUrl] || (stored.accepted || {})[profileUrl] || {};
    nudgeCache = {
      url: profileUrl,
      hasContacts: Boolean(rec.email || rec.phone || rec.website),
    };
  }
  const link = findContactInfoLink();
  if (nudgeCache.hasContacts) {
    removeNudge(link);
  } else {
    showNudge(link);
  }
}

async function tick() {
  // SPA-navigation gate: the content script keeps running after the user
  // navigates away from /in/* (e.g. into /search/results/people/). The
  // script's poll tick would otherwise read the current URL — now the
  // search URL — and write a bogus contact entry keyed by that URL. We
  // observed exactly this in real data: a record under
  // `https://www.linkedin.com/in/.../` was duplicated as
  // `https://www.linkedin.com/search/results/people/`.
  if (!LITUrl.isProfilePath(window.location.pathname)) return;

  const info = extractProfileInfo();
  const root = document.querySelector('main') || document.body;
  const status = LITDetect.detectConnectionStatus(root);
  if (!info || !status) return;

  // Render the CRM nudge on 1st-degree profiles with no saved contacts.
  // Done OUTSIDE the dedup short-circuit below so the chip survives across
  // ticks even when status/contactsKey are unchanged.
  await updateCRMNudge(info.profileUrl, status);
  const contactsKey = contactsFingerprint(LITContactsModal.parseContactsModal(document));
  if (lastDetected.url === info.profileUrl
      && lastDetected.status === status
      && lastDetected.contactsKey === contactsKey) return;
  lastDetected = { url: info.profileUrl, status, contactsKey };
  await persistVisit();
}

setInterval(tick, POLL_INTERVAL_MS);
tick();
