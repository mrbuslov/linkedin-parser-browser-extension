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
function detectConnectionStatus() {
  const root = document.querySelector('main') || document.body;
  // h1 = profile name. If absent, top card hasn't rendered yet.
  if (!root.querySelector('h1')) return null;
  const messageLink = root.querySelector('a[href*="/messaging/"]');
  if (messageLink && messageLink.offsetParent !== null) return 'connected';
  return 'not_connected';
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
  const h1 = root.querySelector('h1');
  const name = (h1?.textContent || '').trim();
  if (!name) return null;

  // Headline: shortest direct-text descendant that comes after the h1 in DOM order
  let headline = '';
  for (const node of root.querySelectorAll('div, span')) {
    if (node.children.length > 0) continue;
    const t = (node.textContent || '').trim();
    if (!t || t.length < 3 || t.length > 200) continue;
    if (t === name) continue;
    if (h1.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
      headline = t;
      break;
    }
  }

  // Avatar: first non-data img within a few ancestor levels of h1
  let avatar = '';
  let parent = h1.parentElement;
  for (let i = 0; i < 6 && parent && !avatar; i++) {
    const img = parent.querySelector('img[src]');
    if (img?.src && !img.src.startsWith('data:')) avatar = img.src;
    parent = parent.parentElement;
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
  const stored = await dbGet(['contacts', 'accepted']);
  const contacts = stored.contacts || {};
  const accepted = stored.accepted || {};

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

  if (accepted[profileUrl]) {
    const newVerified = status === 'connected' ? 'accepted' : 'declined';
    if (accepted[profileUrl].verified !== newVerified) {
      accepted[profileUrl].verified = newVerified;
      accepted[profileUrl].verifiedAt = now;
      acceptedChanged = true;
    }
    // Refresh metadata we now have a better source for
    if (info.avatar && !accepted[profileUrl].avatar) accepted[profileUrl].avatar = info.avatar;
    if (info.headline && !accepted[profileUrl].headline) accepted[profileUrl].headline = info.headline;
    if (info.location && !accepted[profileUrl].location) accepted[profileUrl].location = info.location;
    if (info.country && !accepted[profileUrl].country) accepted[profileUrl].country = info.country;
  } else if (status === 'connected') {
    // Connected but never appeared in our /sent/ scans — still accepted.
    accepted[profileUrl] = {
      profileUrl,
      name: info.name,
      headline: info.headline || '',
      avatar: info.avatar || '',
      location: info.location || '',
      country: info.country || '',
      acceptedAt: now,
      daysPending: 0,
      marked: false,
      markedAt: null,
      verified: 'accepted',
      verifiedAt: now,
    };
    acceptedChanged = true;
    console.log(`[LI Tracker] accepted contact added from profile visit: ${info.name}`);
  }

  await dbSet({
    contacts,
    ...(acceptedChanged ? { accepted } : {}),
  });
  console.log(`[LI Tracker] visited ${info.name} (${status})`);
}

function tryRun() {
  if (extractProfileInfo() && detectConnectionStatus()) {
    persistVisit();
    return true;
  }
  return false;
}

if (!tryRun()) {
  const obs = new MutationObserver(() => {
    if (tryRun()) obs.disconnect();
  });
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 20000);
}
