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
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
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

// Dual-mode export: Node/Vitest gets a CJS module, classic-script content scripts
// see `LITUrl` on globalThis (set unconditionally so order of script loading in
// manifest doesn't matter).
const LITUrl = { normalizeProfileUrl, isEmailKey, extractEmail, EMAIL_RE };
if (typeof globalThis !== 'undefined') globalThis.LITUrl = LITUrl;
if (typeof module !== 'undefined' && module.exports) module.exports = LITUrl;
