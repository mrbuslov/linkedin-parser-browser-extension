// Runs on every linkedin.com/in/* page visit.
//   1. Saves the visited profile to `contacts` (name/headline/avatar/connected/visited time).
//   2. If the person is already in `accepted` → updates `verified` ✓/✗.
//   3. If they're connected but NOT in `accepted` → adds them as a ghost
//      (an accepted connection we never tracked via the /sent/ page).

console.log('[LI Tracker] profile script loaded:', location.pathname);

function normalizeProfileUrl(href) {
  const u = new URL(href, location.origin);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
}

// Cross-language: rather than matching button text in N languages, look for a
// visible link to `/messaging/` in the profile top card — LinkedIn only renders
// that for people you're connected to (and the URL is the same in every locale).
// LinkedIn renders the Message link for EVERY profile (1st/2nd/3rd) — for non-1st
// it's the InMail entry point. So messaging-link presence alone is not a "connected"
// signal. Instead we check for the primary-action buttons that are ONLY shown for
// non-connections (Follow, Connect, Pending) and only fall back to Message as proof
// of connection when none of those are present.
function detectConnectionStatus() {
  const root = document.querySelector('main') || document.body;
  if (!root.querySelector('h1, h2')) return null;

  const buttons = root.querySelectorAll('button');
  let hasFollow = false, hasConnect = false, hasPending = false;
  for (const btn of buttons) {
    if (btn.offsetParent === null) continue;
    const text = (btn.textContent || '').trim().toLowerCase();
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    // English + Russian + Ukrainian + a few common languages
    if (/^(follow|following|подписаться|вы подписаны|підписатися|ви підписані|folgen|seguir|suivre)$/.test(text)
        || /^(follow|подписаться|підписатися)\s/.test(aria)) hasFollow = true;
    if (/^(connect|установить контакт|встановити контакт|vernetzen|conectar)$/.test(text)
        || /\binvite\b.*\bconnect\b/.test(aria)) hasConnect = true;
    if (/^(pending|в ожидании|очікує|ожидает|очікування|ausstehend|pendiente)$/.test(text)
        || /\bpending\b/.test(aria)) hasPending = true;
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

  let acceptedChanged = false;
  const entry = accepted[profileUrl];

  if (entry) {
    // Self-heal: if this entry was auto-added by profile.js (autoMarked flag)
    // and we now confirm they're NOT a connection, delete it — it was a wrong add
    // from the old buggy detector that treated InMail-able profiles as connected.
    if (entry.autoMarked && status !== 'connected') {
      delete accepted[profileUrl];
      acceptedChanged = true;
      console.log(`[LI Tracker] removed wrongly-added contact: ${info.name} (status: ${status})`);
    } else {
      // Update verified flag based on real-time status
      const newVerified = status === 'connected' ? 'accepted'
        : status === 'pending' ? null  // pending = our sent invite, not a verdict
        : 'declined';
      if (newVerified !== null && entry.verified !== newVerified) {
        entry.verified = newVerified;
        entry.verifiedAt = now;
        acceptedChanged = true;
      }
      // Refresh metadata
      if (info.avatar && !entry.avatar) entry.avatar = info.avatar;
      if (info.headline && !entry.headline) entry.headline = info.headline;
      if (info.location && !entry.location) entry.location = info.location;
      if (info.country && !entry.country) entry.country = info.country;
    }
  }

  let sentChanged = false;
  if (status === 'pending') {
    // You sent them an invite from the profile page — surface them in Pending immediately
    const existing = sentInvitations[profileUrl];
    if (existing) {
      existing.lastSeenAt = now;
      existing.name = info.name || existing.name;
      existing.headline = info.headline || existing.headline;
      existing.avatar = info.avatar || existing.avatar;
      sentChanged = true;
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
      sentChanged = true;
      console.log(`[LI Tracker] new pending invite captured from profile: ${info.name}`);
    }
  }


  if (!entry && status === 'connected') {
    // Connected but never appeared in our /sent/ scans — pre-existing contact.
    // Auto-mark so they go straight to Marked, not the Accepted "to handle" list.
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
