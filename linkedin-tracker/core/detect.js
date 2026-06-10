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

  // The detector combines two sources because each has a blind spot:
  //
  //   RSC payload — frozen at page-load time. Authoritative for canonical
  //     network degree (1st / 2nd / 3rd) which doesn't change without a
  //     reload. Blind to user actions performed since the page rendered.
  //
  //   DOM polling — real-time. Catches the user clicking Connect → Pending
  //     button appears, Withdraw → Pending button vanishes, etc. Susceptible
  //     to transient mid-render states and language/structure quirks (the
  //     entire class of bugs Mira reported).
  //
  // Priority rule: a DOM Pending button trumps everything (the user just sent
  // an invite — most common real-time event). Otherwise RSC's networkDistance
  // is the ground truth: distance=1 ⇒ connected, ≥2 ⇒ not_connected. Only when
  // RSC is unavailable (SPA navigation never reloaded the page) do we fall
  // back to the pure DOM heuristics.
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
  //    flipped to Pending. RSC payload is stale at this point — DOM is right.
  if (hasPending) return 'pending';

  // 2) RSC ground truth for connection degree. Doesn't change without a page
  //    reload, so it's the canonical "are they 1st degree" answer.
  if (rscDistance === 1) return 'connected';
  if (rscDistance != null && rscDistance >= 2) return 'not_connected';

  // 3) RSC unavailable (SPA navigation kept the previous page's payload, or
  //    LinkedIn changed its bundling). Fall back to the DOM-only heuristics.
  if (hasFollow || hasConnect || hasInviteLink) return 'not_connected';

  const messageLink = root.querySelector('a[href*="/messaging/compose/"]');
  if (messageLink && isVisible(messageLink)) return 'connected';

  return null;
}

const LITDetect = { detectConnectionStatus, isVisible };
if (typeof globalThis !== 'undefined') globalThis.LITDetect = LITDetect;
if (typeof module !== 'undefined' && module.exports) module.exports = LITDetect;
