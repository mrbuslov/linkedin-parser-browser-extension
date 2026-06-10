// Parser for LinkedIn's Next.js RSC (React Server Components) payload.
//
// LinkedIn ships canonical profile data — including networkDistance (1/2/3 for
// connection degree), firstName/lastName, vanityName, memberId — embedded
// directly in the SSR HTML inside <script> tags of the form:
//
//   self.__next_f.push([1, "<escaped JSON chunk>"])
//
// Multiple chunks are streamed and concatenate into one big RSC payload. We
// don't need to fully parse the tree — for our purposes, regex extraction of
// the few fields we care about is reliable enough and orders of magnitude
// cheaper than parsing the whole thing.
//
// Reading is content-script safe: we just walk <script>.textContent. No MAIN-
// world injection, no extra manifest permissions, no fetch interception.

function extractRSCText(doc) {
  const docArg = doc || (typeof document !== 'undefined' ? document : null);
  if (!docArg) return '';
  let buf = '';
  for (const s of docArg.querySelectorAll('script')) {
    const txt = s.textContent || '';
    if (!txt.includes('__next_f.push')) continue;
    // The payload is the JSON-string argument of `[1, "..."]` — pull it out
    // with a regex that handles the standard JS string escaping.
    const re = /self\.__next_f\.push\(\[1,\s*"((?:\\.|[^"\\])*)"\s*\]\)/g;
    let m;
    while ((m = re.exec(txt)) !== null) {
      buf += unescapeJsString(m[1]);
    }
  }
  return buf;
}

// URL-keyed cache for the parsed RSC text. The payload is frozen for the
// lifetime of a single page load — LinkedIn embeds it once via SSR — so
// re-parsing 1.5 MB of script bytes on every 250 ms poll tick is pure waste.
// We invalidate on URL change to handle SPA navigation: when LinkedIn pushes
// a new profile in-place via `history.pushState`, fresh `__next_f.push(...)`
// chunks get appended to the existing <script> tags, and Alice's data sits
// before Bob's in DOM order. A URL-keyed cache makes us re-read from the
// DOM exactly when the profile actually changed, never per tick.
let _rscCache = { key: null, payload: '' };

function extractRSCTextCached(doc) {
  const docArg = doc || (typeof document !== 'undefined' ? document : null);
  if (!docArg) return '';
  const win = docArg.defaultView;
  const key = (win && win.location && win.location.href) || '';
  if (_rscCache.key === key && _rscCache.payload) return _rscCache.payload;
  const payload = extractRSCText(docArg);
  _rscCache = { key, payload };
  return payload;
}

function resetRSCCache() {
  _rscCache = { key: null, payload: '' };
}

// Minimal JS-style string unescaping. The RSC chunks use standard backslash
// escapes (\", \\, \n, \t, \uXXXX). We don't JSON.parse because the result
// isn't a JSON document — it's a Flight stream — and any single character
// outside the escapes can break a full parse.
function unescapeJsString(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, hex, ch) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    if (ch === '"') return '"';
    if (ch === '\\') return '\\';
    if (ch === '/') return '/';
    return ch;
  });
}

// Canonical degree-of-connection: 1 = 1st degree (real connection),
// 2 = 2nd degree, 3 = 3rd degree, null if not found.
//
// Multiple `networkDistance` entries can appear in the same payload (LinkedIn
// uses it for both the viewed profile AND ancillary contexts like mutual-
// connections lists or "People you may know" recommendations). We anchor on
// `vieweeMemberUrn` — that key uniquely identifies the top-card profile —
// then take the FIRST `networkDistance` that appears after the anchor.
//
// We deliberately do NOT couple to neighboring fields (`viewerPrivacySetting`,
// field order, etc.) — LinkedIn's Flight stream is free to reorder them, and
// a hardcoded "field A, then B, then C" pattern will silently break the
// moment they do. Anchor + nearest match downstream survives reorderings.
function findNetworkDistance(payload) {
  if (!payload) return null;
  const anchor = payload.indexOf('"vieweeMemberUrn"');
  if (anchor !== -1) {
    // Search a generous window past the anchor for the first networkDistance.
    // 4 KB easily covers the full top-card profile object even with photos,
    // headline, action lists, etc. — and stays clear of unrelated objects.
    const window = payload.slice(anchor, anchor + 4096);
    const m = window.match(/"networkDistance":(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  // No anchor or anchor without nearby distance → last-resort loose match.
  // Risky on pages that list multiple people, but profile pages have at most
  // one independent context, so this is fine as a safety net.
  const loose = payload.match(/"networkDistance":(\d+)/);
  return loose ? parseInt(loose[1], 10) : null;
}

// Profile basics: firstName, lastName, vanityName, memberId. Used as the
// canonical source on /in/* pages. Returns null if the payload doesn't carry
// a recognizable profile shape (e.g. user is on a non-profile page).
function findProfileBasics(payload) {
  if (!payload) return null;
  const fn = payload.match(/"firstName":"([^"]{1,200})"/);
  const ln = payload.match(/"lastName":"([^"]{1,200})"/);
  const van = payload.match(/"vanityName":"([a-zA-Z0-9._-]{1,150})"/);
  const mid = payload.match(/"memberUrn":\{"memberId":"(\d+)"/) || payload.match(/"vieweeMemberUrn":"urn:li:member:(\d+)"/);
  if (!fn && !ln && !van && !mid) return null;
  return {
    firstName: fn ? fn[1] : '',
    lastName:  ln ? ln[1] : '',
    vanityName: van ? van[1] : '',
    memberId:  mid ? mid[1] : '',
  };
}

// What primary actions LinkedIn renders on this page (CONNECT, FOLLOW,
// WITHDRAW_INVITATION, UNFOLLOW). Useful for catching "Pending" state — a
// WITHDRAW_INVITATION action means an invite is currently outstanding.
function findActionTypes(payload) {
  if (!payload) return new Set();
  const types = new Set();
  for (const m of payload.matchAll(/"actionTypeToLegacyControlName":\{([^}]{1,500})\}/g)) {
    const inner = m[1];
    for (const a of inner.matchAll(/"([A-Z_]{3,40})"/g)) types.add(a[1]);
  }
  return types;
}

// Higher-level: take the payload, return our normalized status string. This
// is what detect.js plugs into its existing decision tree.
function detectStatusFromRSC(payload) {
  if (!payload) return null;
  const actions = findActionTypes(payload);
  // Pending invite: LinkedIn renders a Withdraw control on the top card.
  if (actions.has('WITHDRAW_INVITATION') || actions.has('WITHDRAWN')) return 'pending';
  const distance = findNetworkDistance(payload);
  if (distance == null) return null;
  if (distance === 1) return 'connected';
  return 'not_connected';
}

const LITRSC = {
  extractRSCText,
  extractRSCTextCached,
  resetRSCCache,
  findNetworkDistance,
  findProfileBasics,
  findActionTypes,
  detectStatusFromRSC,
  unescapeJsString,
};
if (typeof globalThis !== 'undefined') globalThis.LITRSC = LITRSC;
if (typeof module !== 'undefined' && module.exports) module.exports = LITRSC;
