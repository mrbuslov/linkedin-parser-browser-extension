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
// chrome.* APIs at module load). Content scripts call it directly via the
// `LITPopupLogic.parseMutualsCount(...)` namespace — NO local `const` or
// `function` re-declaration here. ALL content-script files load into one
// shared global scope, and a top-level `const X` here clashes with
// `function X` in popup-logic.js → SyntaxError → entire profile.js fails
// to parse → nothing runs. Same trap previously blew up cleanHeadline.
// Calls below use `LITPopupLogic.parseMutualsCount(...)` form.

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

  // Avatar: pin to LinkedIn's own accessibility anchor — every profile page
  // renders exactly ONE `aria-label="Profile photo"` element. When the user
  // has a photo, that element contains an `<img src=…profile-displayphoto…>`
  // — that IS the canonical profile photo URL. When the user has NO photo
  // (LinkedIn renders a default `<svg id="person-accent-…">` placeholder
  // instead), the element contains no img → we record avatar="". Anything
  // else in scope tagged with `profile-displayphoto` is from a sidebar
  // widget / featured-item carousel / etc. and would be wrong.
  //
  // Real failure this rule prevents: a profile with NO photo where the
  // legacy "first profile-displayphoto in main" picker grabbed a stranger's
  // avatar from a "People who view this profile also view" carousel inside
  // the top card and stored it as the user's avatar (Costa Vasili case).
  let avatar = '';
  // avatarConfirmed=true means we have an AFFIRMATIVE answer (either a real
  // URL or a verified "no photo" SVG placeholder). avatarConfirmed=false
  // means we couldn't find the canonical anchor — fall back to the legacy
  // pick and treat the result as best-effort (don't overwrite a stored
  // good value with our guess).
  //
  // Inside the `aria-label="Profile photo"` anchor LinkedIn renders both a
  // person-accent SVG placeholder AND the actual <img> overlaid on top
  // (placeholder hides via CSS once the img has loaded). We accept the
  // photo whether it's a plain `profile-displayphoto` (no badge) OR a
  // `profile-framedphoto` (LinkedIn Hiring/OpenToWork/Verified frame
  // around the photo — same actual user image, different URL path).
  // Both patterns share the `profile-` prefix and live on
  // media.licdn.com; the anchor scope is already narrow enough that any
  // `<img src*=licdn.com>` inside it IS the user's avatar.
  let avatarConfirmed = false;
  const photoAnchor = root.querySelector('[aria-label="Profile photo"]');
  if (photoAnchor) {
    avatarConfirmed = true;
    const img = photoAnchor.querySelector('img[src*=".licdn.com/"]');
    if (img && img.src) avatar = img.src;
    // Else: avatar stays '' — the user has no profile photo. The empty
    // string is the AFFIRMATIVE answer; refreshMetadata writes it back to
    // clear any stale wrong avatar we may have captured previously.
  } else {
    // Anchor missing entirely (LinkedIn changed the aria-label or DOM
    // hasn't hydrated). Fall back to the legacy in-scope pick. Not
    // confirmed — if stale, future tick with the anchor present will fix it.
    for (const img of scope.querySelectorAll('img[src]')) {
      if (/profile-(display|framed)photo/.test(img.src)) {
        avatar = img.src;
        break;
      }
    }
  }

  const location = extractLocation(scope);
  const country = parseCountry(location);
  const mutuals = extractMutuals(scope) || {};
  const mutualsCount = LITPopupLogic.parseMutualsCount(mutuals.mutualsText);

  // Activity scope is the FULL <main>, not the top-card. The Activity card
  // sits below the top card in the page DOM tree, so scoping to top-card
  // would miss every post. The parser bounds itself by finding <h2>Activity</h2>.
  const activity = LITActivityParser.extractActivity(root, name, Date.now());

  // urnId — LinkedIn's encrypted member URN. Preferred source is the URL
  // itself when the profile was reached via /in/<urn>/. Fallback source
  // is mutualsUrl's `connectionOf=[URN]` param (mutuals-page URL is
  // anchored on THIS record's URN, so it reveals it even for vanity URLs).
  // Populated at write time so cross-URL dedup by urnId works on future
  // visits — real-world regression 2026-07-12 where Joe Dougherty ended
  // up as two records (accepted at /joedougherty/, visited at /ACoA.../).
  const profileUrlNorm = LITUrl.normalizeProfileUrl(window.location.href);
  const urnFromUrl = LITUrl.extractUrnFromProfileUrl(profileUrlNorm);
  const urnFromMutuals = LITUrl.extractURNFromConnectionOf(mutuals.mutualsUrl || '');
  const urnId = urnFromUrl || urnFromMutuals || undefined;

  return {
    profileUrl: profileUrlNorm,
    name,
    headline,
    avatar,
    avatarConfirmed,
    location,
    country,
    memberId,
    vanityName,
    urnId,
    mutualsUrl: mutuals.mutualsUrl || '',
    mutualsText: mutuals.mutualsText || '',
    mutualsCount: mutualsCount,
    lastActivityAt: activity.lastActivityAt,
    lastPostAt:     activity.lastPostAt,
    recentActivity: activity.recentActivity,
  };
}

async function persistVisit() {
  const info = extractProfileInfo();
  const root = document.querySelector('main') || document.body;
  const status = LITDetect.detectConnectionStatus(root);
  if (!info || !status) return;

  // Honor the opt-in capture toggle (P1.2). autoCaptureProfiles gates
  // status='visited' writes (someone we visited but never invited); we
  // ALWAYS write status='pending' / 'accepted' / 'declined' because
  // those are bookkeeping (invite tracking is data integrity, not the
  // recruiter-objected "auto-CRM" piece).
  const settings = await dbGet('settings');
  const autoCapture = settings.settings?.autoCaptureProfiles !== false;

  // Contact info overlay: parsed if the user has it open. Null otherwise —
  // applyProfileVisit treats null as "no fresh data, keep previously stored
  // fields as-is".
  const contactInfo = LITContactsModal.parseContactsModal(document);

  const stored = await dbGet(['contacts', 'schemaVersion']);
  const result = LITProfileState.applyProfileVisit(stored, info, status, Date.now(), contactInfo);

  // If autoCapture is OFF and the ONLY new record we'd be writing is a
  // 'visited' one (no invite tracking involved), skip the write.
  const wroteRecord = result.contacts[info.profileUrl];
  const isVisitedOnly = wroteRecord && wroteRecord.status === 'visited';
  if (result.changed && (autoCapture || !isVisitedOnly)) {
    await dbSet({ contacts: result.contacts });
  }

  if (contactInfo) {
    showCaptureToast(contactInfo);
    // Bust the nudge cache so the next tick re-reads storage and hides the
    // chip if we just captured email/phone/website.
    nudgeCache = { url: null, hasContacts: null };
  }

  const { contacts: stored2 = {} } = await dbGet('contacts');
  const rec = stored2[info.profileUrl] || {};
  console.log(`[LI Tracker] visited ${info.name} (${status})`);
  console.log(`[LI Tracker]   fresh avatar : ${info.avatar?.slice(0, 90) || '(empty)'}`);
  console.log(`[LI Tracker]   stored avatar: ${rec.avatar?.slice(0, 90) || '(empty)'}`);
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
let lastDetected = { url: null, status: null, contactsKey: '', activityKey: '' };

// Cheap stable hash of the contact-info fields so we re-persist exactly when
// the user opens or edits the overlay, and not on every quiet tick. Empty
// string ⇒ overlay not open / no parseable data.
function contactsFingerprint(info) {
  if (!info) return '';
  return [info.email, info.phone, info.website, info.address, info.birthday, info.connectedSinceText]
    .map((v) => v || '').join('|');
}

// Activity fingerprint: comma-joined URN ids of the parsed recentActivity[].
// Why this exists: LinkedIn renders the Activity card INCREMENTALLY. tick #1
// after page load typically catches `<h2>Activity</h2>` before any feed
// children have hydrated → recentActivity=[]. tick #2 (~250ms later) sees the
// 10 SSR-rendered cards. Without including activity in the dedup key, the
// status+contactsKey check short-circuits tick #2 and the fresh, non-empty
// activity NEVER gets persisted. That was reported as "I see posts on the
// LinkedIn profile but the extension shows none for this person".
function activityFingerprint(info) {
  if (!info || !Array.isArray(info.recentActivity)) return '';
  return info.recentActivity.map((c) => c.urnActivityId).join(',');
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
    const { contacts = {} } = await dbGet('contacts');
    const rec = contacts[profileUrl] || {};
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
  const activityKey = activityFingerprint(info);
  const dedupSkip = lastDetected.url === info.profileUrl
    && lastDetected.status === status
    && lastDetected.contactsKey === contactsKey
    && lastDetected.activityKey === activityKey;
  if (!dedupSkip) {
    lastDetected = { url: info.profileUrl, status, contactsKey, activityKey };
    await persistVisit();
  }

  // Bulk-visit queue driver (1.3.3). If the popup started a queue and
  // THIS URL is the expected target, do a humanized dwell + scroll and
  // self-navigate to the next URL. Guarded so we don't re-fire on every
  // 250ms setInterval tick. Uses persistVisit above to capture the
  // profile BEFORE the queue advances.
  runQueueTickIfApplicable(info.profileUrl);
}

// Module-scope guards for the queue driver — reset on page unload
// (fresh profile.js instance per page load).
let queueRunning = false;
let queueRunUrl  = null;

async function runQueueTickIfApplicable(currentProfileUrl) {
  if (queueRunning) return;
  if (queueRunUrl === currentProfileUrl) return; // already ran on this URL

  const { visitQueueSimple: state } = await dbGet('visitQueueSimple');
  if (!LITVisitQueueSimple.isActive(state)) return;
  if (!LITVisitQueueSimple.isExpectedUrl(state, currentProfileUrl)) return;

  queueRunning = true;
  queueRunUrl  = currentProfileUrl;

  try {
    console.log(`[LI Tracker/queue] ${state.currentIndex + 1}/${state.urls.length} — reading ${currentProfileUrl}`);

    // Humanized scroll — real users don't jump to the bottom. This also
    // triggers LinkedIn's lazy-load of the Activity card so the next
    // setInterval tick captures fresh posts before we advance.
    // finalHardScroll:false — we're NOT triggering a "load more" fence,
    // we're MIMICKING a reader; the terminal jump reads as robotic.
    await LITScanScroll.humanizedScanScroll(null, {
      finalHardScroll: false,
      isCancelled: async () => {
        const { visitQueueSimple: s } = await dbGet('visitQueueSimple');
        return !s || s.cancelRequested;
      },
    });

    // Log-normal reading dwell + exponential between-visit pause. Real
    // reading behaviour: most people scan a profile in ~30-60s, some get
    // stuck reading a good post for minutes. Between visits, memoryless
    // gap ("phone rang / stopped for tea / clicked something else").
    const rand = Math.random; // stateless — determinism is via seededPRNG at test time
    const dwellMs = LITVisitQueueSimple.logNormalDwellMs(rand, 45_000, 0.5, 15_000, 4 * 60_000);
    const pauseMs = LITVisitQueueSimple.exponentialPauseMs(rand, 60_000, 20_000, 3 * 60_000);
    const totalMs = dwellMs + pauseMs;
    console.log(`[LI Tracker/queue] dwell ${Math.round(dwellMs / 1000)}s + pause ${Math.round(pauseMs / 1000)}s = ${Math.round(totalMs / 1000)}s`);

    // Cancellable sleep. Checks the queue state every second so a
    // popup-initiated cancel takes effect within ~1s of the click.
    const CHECK_INTERVAL_MS = 1000;
    for (let elapsed = 0; elapsed < totalMs; elapsed += CHECK_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, Math.min(CHECK_INTERVAL_MS, totalMs - elapsed)));
      const { visitQueueSimple: s } = await dbGet('visitQueueSimple');
      if (!s || s.cancelRequested) {
        console.log('[LI Tracker/queue] cancelled during wait');
        if (s && s.cancelRequested) await dbSet({ visitQueueSimple: null });
        return;
      }
    }

    // Re-read state (someone else might have written meanwhile) and
    // advance to the next URL. If we've hit the end, clear the queue.
    const { visitQueueSimple: latest } = await dbGet('visitQueueSimple');
    if (!LITVisitQueueSimple.isActive(latest)) {
      if (latest && latest.cancelRequested) await dbSet({ visitQueueSimple: null });
      return;
    }
    const result = LITVisitQueueSimple.advance(latest, Date.now());
    if (result.done) {
      console.log('[LI Tracker/queue] queue complete');
      await dbSet({ visitQueueSimple: null });
      return;
    }
    await dbSet({ visitQueueSimple: result.state });
    console.log(`[LI Tracker/queue] → ${result.nextUrl}`);
    window.location.href = result.nextUrl;
  } catch (err) {
    console.error('[LI Tracker/queue] driver crashed:', err);
    // Clear queue on crash so the user isn't stuck in a broken state.
    await dbSet({ visitQueueSimple: null });
  } finally {
    queueRunning = false;
  }
}

setInterval(tick, POLL_INTERVAL_MS);
tick();
