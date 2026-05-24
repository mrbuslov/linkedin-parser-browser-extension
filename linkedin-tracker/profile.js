// Runs on every linkedin.com/in/* page visit.
//   1. Saves the visited profile to `contacts` (name/headline/avatar/connected/visited time).
//   2. If the person is already in `accepted` → updates `verified` ✓/✗.
//   3. If they're connected but NOT in `accepted` → adds them as a ghost
//      (an accepted connection we never tracked via the /sent/ page).

console.log('[LI Tracker] profile script loaded:', location.pathname);

const DAY_MS = 86400000;

function normalizeProfileUrl(href) {
  const u = new URL(href, location.origin);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
}

// LinkedIn renders the Message link on EVERY profile (1st/2nd/3rd) — for non-1st
// it's the InMail entry point. So Message alone isn't a "connected" signal. We
// check the primary-action buttons that are ONLY shown for non-connections (Follow,
// Connect, Pending) first and only fall back to Message when none of those are present.
//
// Text matching is `startsWith` (\b) not strict equality (`$`) — LinkedIn often
// embeds hidden screen-reader text inside the button ("Pending\nClick to withdraw…"),
// and localized labels can be longer than the English single word ("Очікує на розгляд").
const FOLLOW_TEXT_RE   = /^(follow|following|подписаться|вы\s+подписаны|підписатися|ви\s+підписані|folgen|seguir|suivre)\b/i;
const CONNECT_TEXT_RE  = /^(connect|установить\s+контакт|встановити\s+контакт|vernetzen|conectar|se\s+connecter)\b/i;
const PENDING_TEXT_RE  = /^(pending|в\s*ожидании|очікує|очікування|ожидает|ausstehend|pendiente|en\s+attente)\b/i;
const PENDING_ARIA_RE  = /\b(pending|очікує|очікування|ожидает|в\s*ожидании|ausstehend|pendiente)\b/i;
const WITHDRAW_ARIA_RE = /(withdraw|invit|запрош|приглаш|отозвать|скасувати|zurückziehen|retirar)/i;

function detectConnectionStatus() {
  const root = document.querySelector('main') || document.body;
  if (!root.querySelector('h1, h2')) return null;

  // <button>, <a>, plus role="button" — LinkedIn uses all three for top-card actions.
  // Pending is usually <a aria-label="Pending, click to withdraw invitation…">.
  const actions = root.querySelectorAll('button, a, [role="button"]');
  let hasFollow = false, hasConnect = false, hasPending = false;
  for (const btn of actions) {
    if (btn.offsetParent === null) continue;
    const text = (btn.textContent || '').trim();
    if (text.length > 80) continue;  // skip long blocks that happen to contain a keyword
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();

    if (FOLLOW_TEXT_RE.test(text) || /^(follow|подписаться|підписатися)\s/.test(aria)) hasFollow = true;
    if (CONNECT_TEXT_RE.test(text) || /\binvite\b.*\bconnect\b/.test(aria)
        || /пригласить.*контакт|запросити.*контакт/.test(aria)) hasConnect = true;
    if (PENDING_TEXT_RE.test(text)
        || (PENDING_ARIA_RE.test(aria) && WITHDRAW_ARIA_RE.test(aria))) hasPending = true;
  }

  // URL-based Connect detection works regardless of UI language
  const inviteLink = root.querySelector('a[href*="/preload/custom-invite/"]');
  const hasInviteLink = inviteLink && inviteLink.offsetParent !== null;

  if (hasPending) return 'pending';
  if (hasFollow || hasConnect || hasInviteLink) return 'not_connected';

  // No Follow/Connect/Pending → confirm via Message link presence
  const messageLink = root.querySelector('a[href*="/messaging/compose/"]');
  if (messageLink && messageLink.offsetParent !== null) return 'connected';

  return null;
}

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

  // Headline: shortest direct-text descendant that comes after the heading in DOM order
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

  // Avatar: LinkedIn profile photos always have `profile-displayphoto` in the
  // image URL — works across languages and survives class renames. If we can't
  // find one (rare — when the user has no photo), fall back to the first image
  // near the heading, which may be a company logo but at least isn't blank.
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

  return { name, headline, avatar, location, country };
}

async function persistVisit() {
  const profileUrl = normalizeProfileUrl(location.href);
  const info = extractProfileInfo();
  const status = detectConnectionStatus();
  if (!info || !status) return;

  const now = Date.now();
  const stored = await dbGet(['contacts', 'accepted', 'sentInvitations']);
  const contacts = stored.contacts || {};
  const accepted = stored.accepted || {};
  const sentInvitations = stored.sentInvitations || {};

  const prev = contacts[profileUrl] || {};
  contacts[profileUrl] = {
    profileUrl,
    name: info.name,
    headline: info.headline || prev.headline || '',
    avatar: info.avatar || prev.avatar || '',
    location: info.location || prev.location || '',
    country: info.country || prev.country || '',
    connected: status === 'connected',
    visitedAt: now,
    firstSeenAt: prev.firstSeenAt || now,
  };

  // Invariant: a profile lives in ONE bucket at a time — sentInvitations OR
  // accepted OR neither (only in contacts). The current LinkedIn status decides
  // which one; we clean up any stale entries in the other buckets.
  let acceptedChanged = false;
  let sentChanged = false;

  const refreshMetadata = (target) => {
    let changed = false;
    if (info.avatar && !target.avatar)   { target.avatar = info.avatar; changed = true; }
    if (info.headline && !target.headline) { target.headline = info.headline; changed = true; }
    if (info.location && !target.location) { target.location = info.location; changed = true; }
    if (info.country && !target.country)   { target.country = info.country; changed = true; }
    return changed;
  };

  if (status === 'pending') {
    // Should be in sentInvitations only. If a stale accepted entry exists (e.g.,
    // previously declined or removed, now re-invited), drop it so we don't show
    // them in both Pending and Accepted at once.
    if (accepted[profileUrl]) {
      delete accepted[profileUrl];
      acceptedChanged = true;
      console.log(`[LI Tracker] cleared stale accepted entry on re-invite: ${info.name}`);
    }
    const existing = sentInvitations[profileUrl];
    if (existing) {
      existing.lastSeenAt = now;
      existing.name = info.name || existing.name;
      existing.headline = info.headline || existing.headline;
      existing.avatar = info.avatar || existing.avatar;
    } else {
      sentInvitations[profileUrl] = {
        profileUrl,
        name: info.name,
        headline: info.headline || '',
        avatar: info.avatar || '',
        sentDateRelative: '',
        firstSeenAt: now,
        lastSeenAt: now,
        notes: '',
        tags: [],
        addedFrom: 'profile',
      };
      console.log(`[LI Tracker] new pending invite captured from profile: ${info.name}`);
    }
    sentChanged = true;
  } else if (status === 'connected') {
    // Should be in accepted only. Promote from sentInvitations if present.
    if (sentInvitations[profileUrl]) {
      const sentEntry = sentInvitations[profileUrl];
      const existingAccepted = accepted[profileUrl];
      accepted[profileUrl] = {
        ...sentEntry,
        ...(existingAccepted || {}),
        profileUrl,
        name: info.name || sentEntry.name,
        acceptedAt: existingAccepted?.acceptedAt || now,
        daysPending: Math.floor(((existingAccepted?.acceptedAt || now) - sentEntry.firstSeenAt) / DAY_MS),
        marked: existingAccepted?.marked || false,
        markedAt: existingAccepted?.markedAt || null,
        verified: 'accepted',
        verifiedAt: now,
      };
      delete sentInvitations[profileUrl];
      sentChanged = true;
      acceptedChanged = true;
      console.log(`[LI Tracker] promoted pending → accepted: ${info.name}`);
    } else if (accepted[profileUrl]) {
      // Already in accepted — update verified + refresh metadata
      const entry = accepted[profileUrl];
      if (entry.verified !== 'accepted') {
        entry.verified = 'accepted';
        entry.verifiedAt = now;
        acceptedChanged = true;
      }
      if (refreshMetadata(entry)) acceptedChanged = true;
    } else {
      // Brand-new connected person never in our tracking → pre-existing contact.
      accepted[profileUrl] = {
        profileUrl,
        name: info.name,
        headline: info.headline || '',
        avatar: info.avatar || '',
        location: info.location || '',
        country: info.country || '',
        acceptedAt: now,
        daysPending: 0,
        marked: true,
        markedAt: now,
        verified: 'accepted',
        verifiedAt: now,
        autoMarked: true,
      };
      acceptedChanged = true;
      console.log(`[LI Tracker] auto-marked pre-existing contact: ${info.name}`);
    }
  } else {
    // status === 'not_connected' — should be in neither sentInvitations nor accepted.
    if (sentInvitations[profileUrl]) {
      delete sentInvitations[profileUrl];
      sentChanged = true;
      console.log(`[LI Tracker] removed from pending (withdrew): ${info.name}`);
    }
    const entry = accepted[profileUrl];
    if (entry) {
      // If they were ever confirmed accepted, this is a removed connection (by us
      // or by them) — drop the entry rather than mark "declined" (which would imply
      // they rejected our invite, which isn't the case here).
      // Also drop autoMarked entries that were never real (legacy wrong-adds).
      if (entry.verified === 'accepted' || entry.autoMarked) {
        delete accepted[profileUrl];
        acceptedChanged = true;
        console.log(`[LI Tracker] removed accepted entry (no longer connected): ${info.name}`);
      } else if (entry.verified !== 'declined') {
        // Was tracked via /sent/ flow, never confirmed → person declined our invite
        entry.verified = 'declined';
        entry.verifiedAt = now;
        acceptedChanged = true;
        if (refreshMetadata(entry)) {} // already true
      }
    }
  }

  await dbSet({
    contacts,
    ...(acceptedChanged ? { accepted } : {}),
    ...(sentChanged ? { sentInvitations } : {}),
  });
  console.log(`[LI Tracker] visited ${info.name} (${status})`);
}

// Always-on observer: catches both the initial render delay AND in-page status
// changes (e.g. you click Connect — button becomes Pending, mutation fires, we
// re-persist). Debounced so we don't run on every micro-mutation.
let lastDetected = { url: null, status: null };

async function tick() {
  const info = extractProfileInfo();
  const status = detectConnectionStatus();
  if (!info || !status) return;
  const url = normalizeProfileUrl(location.href);
  if (lastDetected.url === url && lastDetected.status === status) return;
  lastDetected = { url, status };
  await persistVisit();
}

let scheduled = null;
const observer = new MutationObserver(() => {
  clearTimeout(scheduled);
  scheduled = setTimeout(tick, 500);
});
observer.observe(document.body, { childList: true, subtree: true });
tick();
