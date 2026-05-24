// Profile URL normalizer. Used in every content script — must produce the SAME
// canonical form everywhere, since profileUrl is the primary key for our stores.
// Strips query/hash, lowercases the path, ensures trailing slash. No origin
// rewriting (LinkedIn serves the same profile from www. and locale subdomains
// like ua. — we leave that to the caller; in practice content scripts run from
// www.linkedin.com so it's stable).
function normalizeProfileUrl(href) {
  const u = new URL(href, 'https://www.linkedin.com');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
}

// Dual-mode export: Node/Vitest gets a CJS module, classic-script content scripts
// see `LITUrl` on globalThis (set unconditionally so order of script loading in
// manifest doesn't matter).
const LITUrl = { normalizeProfileUrl };
if (typeof globalThis !== 'undefined') globalThis.LITUrl = LITUrl;
if (typeof module !== 'undefined' && module.exports) module.exports = LITUrl;
