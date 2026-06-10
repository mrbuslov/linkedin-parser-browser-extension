// Connection-status detector for a LinkedIn /in/* profile page.
// Returns one of: 'connected' | 'not_connected' | 'pending' | null.
//
// Strategy: look for the primary-action buttons that are ONLY rendered for
// non-connections (Follow, Connect, Pending). The Message link alone is NOT
// a "connected" signal — LinkedIn renders it on every profile for InMail too.
//
// Text matching is `startsWith` (\b), not exact (`$`) — LinkedIn often embeds
// hidden screen-reader text inside the button ("Pending\nClick to withdraw…"),
// and localized labels can be longer than English ("Очікує на розгляд").

// We can't use \b for Cyrillic — JS regex word boundary is ASCII-only. Instead
// we normalize whitespace and check prefix-with-terminator (space/punct/end).
const FOLLOW_PREFIXES  = ['follow', 'following', 'подписаться', 'вы подписаны', 'підписатися', 'ви підписані', 'folgen', 'seguir', 'suivre'];
const CONNECT_PREFIXES = ['connect', 'установить контакт', 'встановити контакт', 'vernetzen', 'conectar', 'se connecter'];
const PENDING_PREFIXES = ['pending', 'в ожидании', 'очікує', 'очікування', 'ожидает', 'ausstehend', 'pendiente', 'en attente'];

const PENDING_ARIA_SUBSTRS  = ['pending', 'очікує', 'очікування', 'ожидает', 'в ожидании', 'ausstehend', 'pendiente'];
const WITHDRAW_ARIA_SUBSTRS = ['withdraw', 'invit', 'запрош', 'приглаш', 'отозвать', 'скасувати', 'zurückziehen', 'retirar'];

function normWhitespace(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function matchesPrefix(text, prefixes) {
  const t = normWhitespace(text);
  if (!t) return false;
  for (const p of prefixes) {
    if (t === p) return true;
    if (t.startsWith(p + ' ') || t.startsWith(p + ',') || t.startsWith(p + '.')) return true;
  }
  return false;
}

function containsAny(text, needles) {
  const t = normWhitespace(text);
  return needles.some((n) => t.includes(n));
}

// Degree-of-connection from a DOM-rendered accessibility marker. LinkedIn
// always tags the profile top-card name/avatar with an aria-label of the form
// "<Name> <opt-Premium-Profile> <1st|2nd|3rd>" so screen readers announce the
// connection degree. This is more reliable than the RSC payload — LinkedIn
// doesn't ship RSC for every profile shape (Premium accounts in particular
// were observed missing the `__next_f.push(...)` chunks entirely) — and the
// aria-label exists across all profile variants because accessibility is
// non-negotiable. We anchor on the trailing token only, not on the user's
// name, so localization quirks don't matter.
const ARIA_DEGREE_RE = /\b(1st|2nd|3rd)\b\s*$/i;
const LOCALIZED_DEGREE_PATTERNS = [
  { re: /\bсв.*?1.*?степ/i,  d: 1 },  // RU "связь 1-й степени"
  { re: /\bзв.*?1.*?ступ/i,  d: 1 },  // UA "зв'язок 1-го ступеня"
  { re: /\b1\.\s*[Gg]rad/,   d: 1 },  // DE "1. Grad"
];

function findDegreeFromAria(root) {
  for (const node of root.querySelectorAll('[aria-label]')) {
    const aria = node.getAttribute('aria-label') || '';
    const m = aria.match(ARIA_DEGREE_RE);
    if (m) {
      const tok = m[1].toLowerCase();
      if (tok === '1st') return 1;
      if (tok === '2nd') return 2;
      if (tok === '3rd') return 3;
    }
    for (const { re, d } of LOCALIZED_DEGREE_PATTERNS) {
      if (re.test(aria)) return d;
    }
  }
  return null;
}

// Visibility check that works in both Chrome (real layout) and jsdom (no layout).
// We DON'T use offsetParent because jsdom always reports null. We check `hidden`
// and computed display/visibility — covers the common ways LinkedIn hides UI.
function isVisible(el) {
  if (el.hidden) return false;
  const win = el.ownerDocument && el.ownerDocument.defaultView;
  if (win && typeof win.getComputedStyle === 'function') {
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function detectConnectionStatus(root) {
  if (!root || !root.querySelector('h1, h2')) return null;

  // The detector now combines THREE sources, each with a blind spot:
  //
  //   DOM aria-label degree — LinkedIn renders the connection degree (1st /
  //     2nd / 3rd) into the profile top-card's aria-label for screen readers.
  //     Format: "<Name> [Premium Profile] <1st|2nd|3rd>". This is the most
  //     reliable signal — accessibility is non-negotiable so LinkedIn won't
  //     remove it — and it works across every profile shape we've seen.
  //     Discovered this after a Premium-account profile shipped no RSC
  //     payload at all and the previous detector mis-read her as 2nd-degree.
  //
  //   RSC payload — frozen at page-load time. Authoritative when present.
  //     Some profile variants (notably Premium) ship without it, so it can't
  //     be the only ground truth.
  //
  //   DOM polling — real-time. Catches the user clicking Connect → Pending
  //     button appears, Withdraw → Pending button vanishes, etc.
  //
  // Priority rule: DOM Pending button trumps everything (user just sent an
  // invite). Then the aria-label degree (most reliable when present). Then
  // RSC. Then a pure-DOM fallback for cases where none of the above fired.
  const ariaDegree = findDegreeFromAria(root);

  let rscDistance = null;
  if (typeof LITRSC !== 'undefined' && root.ownerDocument) {
    // Cached read — RSC payload is frozen for the page's lifetime, no point
    // re-parsing 1.5 MB every 250 ms tick. Cache invalidates on URL change
    // so SPA navigation between profiles still picks up the new payload.
    const payload = LITRSC.extractRSCTextCached
      ? LITRSC.extractRSCTextCached(root.ownerDocument)
      : LITRSC.extractRSCText(root.ownerDocument);
    rscDistance = LITRSC.findNetworkDistance(payload);
  }

  const actions = root.querySelectorAll('button, a, [role="button"]');
  let hasFollow = false, hasConnect = false, hasPending = false;
  for (const btn of actions) {
    if (!isVisible(btn)) continue;
    const text = (btn.textContent || '').trim();
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();

    if (matchesPrefix(text, FOLLOW_PREFIXES)) hasFollow = true;
    if (matchesPrefix(text, CONNECT_PREFIXES)
        || /\binvite\b.*\bconnect\b/.test(aria)
        || containsAny(aria, ['пригласить', 'запросити'])) hasConnect = true;
    if (matchesPrefix(text, PENDING_PREFIXES)
        || (containsAny(aria, PENDING_ARIA_SUBSTRS) && containsAny(aria, WITHDRAW_ARIA_SUBSTRS))) hasPending = true;
  }

  const inviteLink = root.querySelector('a[href*="/preload/custom-invite/"]');
  const hasInviteLink = inviteLink != null && isVisible(inviteLink);

  // 1) Real-time DOM Pending wins: user just sent an invite and the button
  //    flipped to Pending. Both RSC and aria-label degree are stale here.
  if (hasPending) return 'pending';

  // 2) DOM aria-label degree — the most reliable canonical signal. Works
  //    even when LinkedIn ships no RSC payload (Premium profiles). The
  //    1st/2nd/3rd token is in there for screen-reader accessibility.
  if (ariaDegree === 1) return 'connected';
  if (ariaDegree != null && ariaDegree >= 2) return 'not_connected';

  // 3) RSC ground truth (when aria-label didn't surface a degree). Same
  //    semantics as before.
  if (rscDistance === 1) return 'connected';
  if (rscDistance != null && rscDistance >= 2) return 'not_connected';

  // 4) Neither aria nor RSC told us anything definitive. Fall back to pure
  //    DOM heuristics. Risky for 1st-degree contacts with Follow enabled
  //    (Creator mode renders a Follow button next to Message), but that's
  //    why aria/RSC come first.
  if (hasFollow || hasConnect || hasInviteLink) return 'not_connected';

  const messageLink = root.querySelector('a[href*="/messaging/compose/"]');
  if (messageLink && isVisible(messageLink)) return 'connected';

  return null;
}

const LITDetect = { detectConnectionStatus, isVisible, findDegreeFromAria };
if (typeof globalThis !== 'undefined') globalThis.LITDetect = LITDetect;
if (typeof module !== 'undefined' && module.exports) module.exports = LITDetect;
