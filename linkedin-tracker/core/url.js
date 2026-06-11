// Profile URL normalizer. Used in every content script — must produce the SAME
// canonical form everywhere, since profileUrl is the primary key for our stores.
// Strips query/hash, ensures trailing slash. No origin rewriting (LinkedIn serves
// the same profile from www. and locale subdomains; in practice content scripts
// run from www.linkedin.com so it's stable).
//
// Also supports `mailto:` URLs — used as identifier for /sent/ invitations that
// went to an email address (recipient has no LinkedIn profile yet, or LinkedIn's
// "you-must-know-them" wall hid the /in/ link). Lowercased and trimmed.
function normalizeProfileUrl(href) {
  if (typeof href === 'string' && href.toLowerCase().startsWith('mailto:')) {
    return `mailto:${href.slice(7).trim().toLowerCase()}`;
  }
  const u = new URL(href, 'https://www.linkedin.com');
  // For /in/<vanity>/... URLs collapse anything after the vanity slug. LinkedIn
  // appends sub-paths for overlays/widgets while keeping the same person —
  // e.g. opening "Contact info" changes the URL to
  //   /in/zhenyamogila/overlay/contact-info/
  // — and we want both to resolve to the canonical /in/zhenyamogila/.
  // The vanity slug itself is the first segment after /in/.
  const inMatch = u.pathname.match(/^\/in\/([^/]+)/);
  if (inMatch) {
    return `${u.origin}/in/${inMatch[1]}/`;
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
}

// True iff `pathname` looks like it belongs to a profile (/in/<vanity>...).
// Used by content scripts to gate writes: SPA navigation can carry a script
// past its match pattern (the script keeps running after the user navigates
// to /search/results/people/), and we must NOT persist anything in that
// state — observed real-world bug: a contact got saved under key
// `/search/results/people/`. Overlay sub-paths like
// /in/<vanity>/overlay/contact-info/ are allowed because the user is still
// on the same profile when they open the contact-info modal.
function isProfilePath(pathname) {
  return /^\/in\/[^/]+/.test(pathname || '');
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

function isEmailKey(profileUrl) {
  return typeof profileUrl === 'string' && profileUrl.startsWith('mailto:');
}

function extractEmail(text) {
  if (!text) return null;
  const m = text.match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}

// LinkedIn wraps every external URL in a safety redirect of the form
// `https://www.linkedin.com/safety/go/?url=<urlencoded>&urlhash=…&isSdui=true`.
// Strip the wrapper so we store/copy the actual destination URL.
// Returns the input unchanged when it's not a safety-go URL.
function decodeLinkedInRedirect(href) {
  if (!href) return href;
  const u = new URL(href, 'https://www.linkedin.com');
  if (!u.pathname.startsWith('/safety/go')) return href;
  const target = u.searchParams.get('url');
  return target || href;
}

// Extract a LinkedIn member URN (encoded "ACoA..." form) from a URL's
// `connectionOf=` query parameter. Used to identify whose mutuals page the
// user is currently viewing on `/search/results/people/?...connectionOf=...`.
// Returns null when the param is missing or doesn't contain a recognizable
// URN. No fallback parsing — the URN format starts with "ACoA" and uses
// `[A-Za-z0-9_-]`; anything else is rejected.
function extractURNFromConnectionOf(href) {
  if (!href) return null;
  const u = new URL(href, 'https://www.linkedin.com');
  const param = u.searchParams.get('connectionOf');
  if (!param) return null;
  const m = param.match(/(ACoA[A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// True iff `pathname` is a LinkedIn people-search results page.
function isPeopleSearchPath(pathname) {
  return /^\/search\/results\/people\/?$/.test(pathname || '');
}

// Dual-mode export: Node/Vitest gets a CJS module, classic-script content scripts
// see `LITUrl` on globalThis (set unconditionally so order of script loading in
// manifest doesn't matter).
const LITUrl = { normalizeProfileUrl, isEmailKey, extractEmail, decodeLinkedInRedirect, isProfilePath, extractURNFromConnectionOf, isPeopleSearchPath, EMAIL_RE };
if (typeof globalThis !== 'undefined') globalThis.LITUrl = LITUrl;
if (typeof module !== 'undefined' && module.exports) module.exports = LITUrl;
