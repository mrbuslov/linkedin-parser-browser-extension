// Parser for LinkedIn's people-search results page. Used by the
// search-mutuals content script to collect the list of mutual connections
// when the user navigates to `/search/results/people/?...connectionOf=...`.
//
// Deterministic per-card anchor (per project CLAUDE.md):
//   `<div componentkey="SearchResults<URN>">` — LinkedIn's own internal
//   identifier for a search-result card. The URN is the canonical member
//   ID (`ACoA…` shape). LinkedIn also renders a SECOND componentkey on
//   the snippet sub-area as `SearchResultssnippet_<URN>` — we filter that
//   out so the same card doesn't count twice.
//
// Why this matters: the previous version scanned ALL `<a href="/in/...">`
// in the page, which swept up names from sidebar widgets, "people who
// connect at X also follow", and the carousel of "X mutual connections"
// rendered inside each result card. The user saw the connections-of-
// connections rather than the actual result list. Anchoring on the
// SearchResults<URN> wrapper bounds the scope to ONE card per URN.
//
// Inside each card, we take the FIRST `<a href="/in/<vanity>/">` — that's
// the name link. Subsequent /in/ anchors in the same card are noise
// (mutual-connection chips, "Followed by …" lines, sidebar items).
//
// Returns: array of { name, profileUrl, avatar } in document order.

const URN_CK_RE = /^SearchResults(ACoA[A-Za-z0-9_-]+)$/;

// Clean a single name string captured from a search result link.
//   1) Cut everything starting at the degree marker " • 1st"/" • 2nd"/
//      " • 3rd". On wide-link captures the headline is often glued
//      directly after "1st" with no separator ("• 1stCommunication
//      consultant…"); this still catches it because we anchor on the
//      bullet+digit pattern, no trailing word-boundary needed.
//   2) Strip the standalone "Premium" badge token.
//   3) Dedup an immediately-doubled name. LinkedIn renders the SR-only
//      accessible label AND the visible text inside the same anchor;
//      `textContent` concatenates them as "Foo Bar Foo Bar". When the
//      first half equals the second half (word-for-word), keep one.
function sanitizeName(raw) {
  if (!raw) return '';
  let s = raw
    .replace(/\s*•\s*(?:1st|2nd|3rd).*$/i, '')
    .replace(/\s+Premium\b/, '')
    .trim();
  const parts = s.split(/\s+/);
  if (parts.length >= 2 && parts.length % 2 === 0) {
    const half = parts.length / 2;
    const a = parts.slice(0, half).join(' ');
    const b = parts.slice(half).join(' ');
    if (a === b) s = a;
  }
  return s;
}

function extractMutualsList(root, normalizeFn) {
  if (!root) return [];
  const normalize = normalizeFn || ((s) => s);
  const list = [];
  const seenUrl = new Set();
  const seenCards = new Set();

  // Seed on `componentkey="SearchResults<URN>"` — one per result card.
  // The componentkey sits on an inner element (avatar wrapper area), NOT
  // the card root. Walk up to the surrounding `[role="listitem"]` to get
  // the actual card bounds. Inside that scope, the FIRST `<a href="/in/">`
  // with non-empty visible text is the result's name link; subsequent /in/
  // anchors are the mutual-connection chips and snippet links (noise).
  for (const seed of root.querySelectorAll('[componentkey]')) {
    const ck = seed.getAttribute('componentkey') || '';
    if (!URN_CK_RE.test(ck)) continue;
    const card = seed.closest('[role="listitem"]');
    if (!card || seenCards.has(card)) continue;
    seenCards.add(card);

    // Result URL: the FIRST `/in/<vanity>/` anchor in the card is always
    // the card's own subject (the avatar wrapper points to it, the name
    // link points to it). Subsequent anchors point at mutual-connection
    // chips (different vanities). Anchor on the first link's href.
    const links = card.querySelectorAll('a[href*="/in/"]');
    if (!links.length) continue;
    const resultHref = links[0].getAttribute('href') || links[0].href || '';
    if (!/\/in\/[^/]+/.test(resultHref)) continue;
    const profileUrl = normalize(links[0].href || resultHref);
    if (seenUrl.has(profileUrl)) continue;

    // Name text: SHORTEST textContent among the anchors that point at the
    // result URL. LinkedIn renders 2-3 anchors per card to the same
    // profile — the photo wrapper (empty text), the name-only link (just
    // the visible name), and sometimes a wider link that wraps
    // name+headline+location+followers+mutual-snippet glued together.
    // Shortest non-empty text = the name-only link.
    let nameText = '';
    for (const a of links) {
      const aHref = a.getAttribute('href') || a.href || '';
      if (normalize(a.href || aHref) !== profileUrl) continue;
      const t = (a.textContent || '').trim().replace(/\s+/g, ' ');
      if (t.length < 2) continue;
      if (!nameText || t.length < nameText.length) nameText = t;
    }
    if (!nameText) continue;
    const cleanName = sanitizeName(nameText);
    if (!cleanName || cleanName.length < 2) continue;

    const imgEl = card.querySelector('img[src*="profile-displayphoto"]');
    const avatar = (imgEl && imgEl.src) ? imgEl.src : '';

    seenUrl.add(profileUrl);
    list.push({ name: cleanName, profileUrl, avatar });
  }

  // Backwards-compat path: when the URN-componentkey anchor is absent (a
  // unit test passes a hand-written DOM, or LinkedIn changes the wrapper
  // attribute name), fall back to the legacy per-anchor scan WITHOUT the
  // sidebar-noise problem — caller is expected to have already scoped to
  // a sub-DOM (e.g. <main>) where only real results live.
  if (list.length === 0) {
    for (const a of root.querySelectorAll('a[href*="/in/"]')) {
      const href = a.getAttribute('href') || a.href || '';
      if (!/\/in\/[^/]+/.test(href)) continue;
      const profileUrl = normalize(a.href || href);
      if (seenUrl.has(profileUrl)) continue;
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
      if (!text || text.length < 2) continue;
      const cleanName = sanitizeName(text);
      if (!cleanName || cleanName.length < 2) continue;
      // Find an avatar in any of the link's ancestor containers (5 levels).
      let avatar = '';
      let node = a.parentElement;
      for (let i = 0; i < 5 && node && !avatar; i++) {
        const img = node.querySelector('img[src*="profile-displayphoto"]');
        if (img && img.src) avatar = img.src;
        node = node.parentElement;
      }
      seenUrl.add(profileUrl);
      list.push({ name: cleanName, profileUrl, avatar });
    }
  }

  return list;
}

const LITSearchResults = { extractMutualsList };
if (typeof globalThis !== 'undefined') globalThis.LITSearchResults = LITSearchResults;
if (typeof module !== 'undefined' && module.exports) module.exports = LITSearchResults;
