// Parser for LinkedIn's people-search results page. Used by the
// search-mutuals content script to collect the list of mutual connections
// when the user navigates to `/search/results/people/?...connectionOf=...`.
//
// Deterministic anchors only (per project CLAUDE.md):
//   1) Profile URL — `<a href="https://www.linkedin.com/in/<vanity>/">`.
//      The /in/<vanity>/ pattern is LinkedIn's canonical profile URL
//      structure; nothing else uses it.
//   2) Name — the `<a>` element's `textContent`, normalized.
//   3) Avatar — `<img src>` with `profile-displayphoto` in the URL.
//      Same anchor we use on profile pages — language-stable, class-stable.
//
// Dedupe by canonical profileUrl (each result has multiple anchors —
// name link + avatar link — they all point at the same /in/...).
// Returns an array of { name, profileUrl, avatar } (avatar may be '').

function extractMutualsList(root, normalizeFn) {
  if (!root) return [];
  const seen = new Set();
  const list = [];
  for (const a of root.querySelectorAll('a[href*="/in/"]')) {
    const href = a.href;
    if (!href || !/\/in\/[^/]+/.test(href)) continue;
    const normalize = normalizeFn || ((s) => s);
    const profileUrl = normalize(href);
    if (seen.has(profileUrl)) continue;
    const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
    // Skip anchors with no readable name (image-wrapper anchors render
    // empty textContent). We pick up the named anchor for the same profile
    // on a later iteration.
    if (!text || text.length < 2) continue;
    // LinkedIn appends extra labels in the name anchor's text:
    //   "Usman Kiyani Premium • 1st"
    // Strip the "• 1st"/"• 2nd"/"• 3rd" degree marker and the "Premium"
    // badge label from the displayed name.
    const cleanName = text
      .replace(/\s*•\s*(1st|2nd|3rd)\b/i, '')
      .replace(/\s+Premium\b/, '')
      .trim();
    if (!cleanName) continue;
    seen.add(profileUrl);
    list.push({ name: cleanName, profileUrl });
  }
  // Pick up avatars in a second pass — anchor result entries to their
  // figures by walking up to the nearest shared container.
  for (const item of list) {
    // Find any <img src*=profile-displayphoto> that lives inside or near
    // an <a href> for this profile. We pick the first match in document
    // order; LinkedIn renders one avatar per card.
    for (const a of root.querySelectorAll(`a[href*="/in/"]`)) {
      if (!a.href || normalizeFn(a.href) !== item.profileUrl) continue;
      // Walk up 5 ancestors looking for an <img> in any descendant.
      let node = a.parentElement;
      for (let i = 0; i < 5 && node; i++) {
        const img = node.querySelector('img[src*="profile-displayphoto"]');
        if (img && img.src) { item.avatar = img.src; break; }
        node = node.parentElement;
      }
      if (item.avatar) break;
    }
    if (!item.avatar) item.avatar = '';
  }
  return list;
}

const LITSearchResults = { extractMutualsList };
if (typeof globalThis !== 'undefined') globalThis.LITSearchResults = LITSearchResults;
if (typeof module !== 'undefined' && module.exports) module.exports = LITSearchResults;
