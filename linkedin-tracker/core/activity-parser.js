// Pure parser for the "Activity" section on a LinkedIn /in/<vanity>/ profile.
//
// LinkedIn SSR-renders 10 most-recent activity cards into the DOM at page
// load — no scroll required. We parse the first 5 unique cards (by activity
// URN) and yield three fields the rest of the app consumes:
//   lastActivityAt  → ISO timestamp of the freshest activity (any type)
//   lastPostAt      → ISO timestamp of the freshest OWN post (type === 'post')
//   recentActivity  → up to 5 items, each { urnActivityId, url, author, type,
//                                            text, postedAt, postedAtText }
//
// Stability anchors (in order of trust):
//   1. <h2>Activity</h2> heading text (localized variants in ACTIVITY_HEADINGS)
//   2. <button aria-label="Open control menu for post by <NAME>"> — per-card
//      menu button, anchors author name AND card scope (walk up to a wrapper
//      that also contains the expandable-text-box body)
//   3. <svg aria-label="Visibility: ..."> — visibility icon's parent <p>
//      contains the relative time as its leading text (e.g. "4d •")
//   4. <span data-testid="expandable-text-box"> — the post body. Survived
//      6 fixtures across 3 LinkedIn UI builds.
//   5. urn:li:activity:<id> embedded in any descendant href — canonical ID.
//
// ZERO FALLBACKS: when we can't find one of these anchors on a card, we
// skip the card entirely. We do NOT guess from class names, descendant
// counts, or text patterns. Half-parsed garbage is worse than missing data.

const ACTIVITY_HEADINGS = [
  'Activity',
  'Активность',
  'Активність',
  'Aktivität',
  'Activité',
  'Aktywność',
];

const TIME_UNIT_MS = {
  m:  60_000,           // minute
  h:  3_600_000,        // hour
  d:  86_400_000,       // day
  w:  604_800_000,      // week
  wk: 604_800_000,
  mo: 2_592_000_000,    // 30-day approximation (LinkedIn rounds "X months ago")
  y:  31_536_000_000,   // 365-day approximation
  yr: 31_536_000_000,
};

function parseRelativeTimeMs(text) {
  if (!text) return null;
  const m = text.trim().match(/^(\d+)\s*(mo|wk|yr|d|w|h|m|y)\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return null;
  const ms = TIME_UNIT_MS[m[2].toLowerCase()];
  if (!ms) return null;
  return n * ms;
}

function findActivitySection(root) {
  if (!root) return null;
  const h2s = root.querySelectorAll('h2');
  for (const h2 of h2s) {
    const text = (h2.textContent || '').trim();
    if (!ACTIVITY_HEADINGS.includes(text)) continue;
    // Walk up to a wrapper that contains BOTH the heading and at least one
    // expandable-text-box (the post bodies). This bounds the Activity card.
    let node = h2.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      if (node.querySelector('[data-testid="expandable-text-box"]')) return node;
      node = node.parentElement;
    }
    return null;
  }
  return null;
}

function findCardAnchors(section) {
  return section.querySelectorAll('button[aria-label^="Open control menu for post by "]');
}

function authorFromMenu(menu) {
  const aria = menu.getAttribute('aria-label') || '';
  const m = aria.match(/^Open control menu for post by (.+)$/);
  return m ? m[1].trim() : '';
}

// Walk up from the menu button until we find an ancestor that ALSO contains
// an expandable-text-box. That ancestor is the per-card wrapper. Capped at
// 12 levels — empirically the actual depth is 5-7.
function findCardWrapper(menu, section) {
  let node = menu;
  for (let i = 0; i < 12 && node && node !== section; i++) {
    if (node.querySelector && node.querySelector('[data-testid="expandable-text-box"]')) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function extractURN(wrapper) {
  for (const a of wrapper.querySelectorAll('a[href*="urn:li:activity:"]')) {
    const href = a.getAttribute('href') || a.href || '';
    const m = href.match(/urn:li:activity:(\d+)/);
    if (m) return { id: m[1], url: a.href || href };
  }
  return null;
}

function extractTimeText(wrapper) {
  const vis = wrapper.querySelector('svg[aria-label^="Visibility:"]');
  if (!vis) return null;
  const p = vis.closest('p');
  if (!p) return null;
  const text = (p.textContent || '').trim();
  const m = text.match(/^(\d+\s*(?:mo|wk|yr|d|w|h|m|y))\b/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

function extractBody(wrapper) {
  const box = wrapper.querySelector('[data-testid="expandable-text-box"]');
  if (!box) return '';
  // Strip the trailing "…more" button — its label text leaks into textContent.
  const clone = box.cloneNode(true);
  for (const btn of clone.querySelectorAll('button')) btn.remove();
  return (clone.textContent || '').trim().replace(/\s+/g, ' ');
}

function normName(s) {
  return (s || '').toLowerCase().replace(/\.+$/, '').replace(/\s+/g, ' ').trim();
}

function classifyType(author, ownerName) {
  if (!author || !ownerName) return 'unknown';
  return normName(author) === normName(ownerName) ? 'post' : 'share';
}

function extractActivity(root, ownerName, now) {
  if (now == null || !Number.isFinite(now)) {
    throw new Error('extractActivity: numeric `now` (ms epoch) is required');
  }
  const section = findActivitySection(root);
  if (!section) return { lastActivityAt: null, lastPostAt: null, recentActivity: [] };

  const seen = new Set();
  const cards = [];
  for (const menu of findCardAnchors(section)) {
    const wrapper = findCardWrapper(menu, section);
    if (!wrapper) continue;
    const urn = extractURN(wrapper);
    if (!urn || seen.has(urn.id)) continue;
    const timeText = extractTimeText(wrapper);
    const deltaMs = parseRelativeTimeMs(timeText);
    if (deltaMs == null) continue;
    seen.add(urn.id);

    const author = authorFromMenu(menu);
    const text = extractBody(wrapper);
    const type = classifyType(author, ownerName);
    const postedAt = new Date(now - deltaMs).toISOString();

    cards.push({
      urnActivityId: urn.id,
      url: urn.url,
      author,
      type,
      text,
      postedAt,
      postedAtText: timeText,
    });
    if (cards.length >= 5) break;
  }

  cards.sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  const lastActivityAt = cards.length > 0 ? cards[0].postedAt : null;
  const ownPosts = cards.filter((c) => c.type === 'post');
  const lastPostAt = ownPosts.length > 0 ? ownPosts[0].postedAt : null;

  return { lastActivityAt, lastPostAt, recentActivity: cards };
}

// Merge stored recentActivity[] with a freshly-parsed list. Dedupe by
// urnActivityId; fresh wins (newer text/time). Sort desc by postedAt, cap.
function mergeRecentActivity(existing, fresh, max = 5) {
  const byUrn = new Map();
  for (const c of existing || []) {
    if (c && c.urnActivityId) byUrn.set(c.urnActivityId, c);
  }
  for (const c of fresh || []) {
    if (c && c.urnActivityId) byUrn.set(c.urnActivityId, c);
  }
  return Array.from(byUrn.values())
    .filter((c) => c.postedAt)
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
    .slice(0, max);
}

const LITActivityParser = {
  extractActivity,
  mergeRecentActivity,
  parseRelativeTimeMs,
  findActivitySection,
  ACTIVITY_HEADINGS,
};
if (typeof globalThis !== 'undefined') globalThis.LITActivityParser = LITActivityParser;
if (typeof module !== 'undefined' && module.exports) module.exports = LITActivityParser;
