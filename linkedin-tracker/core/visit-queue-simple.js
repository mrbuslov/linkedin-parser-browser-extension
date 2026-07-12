// Simplified bulk visit queue — 1.3.3. Motivated by user request: paste a
// list of LinkedIn profile URLs, extension walks through them one by one,
// captures name/headline/position/posts/mutuals into local storage, uses
// humanized scroll + randomized timing to look like a real reader.
//
// KEY DESIGN CONSTRAINT: no new Chrome permissions. Uses ONLY what the
// extension already has (host_permissions for LinkedIn) — the queue is
// driven by profile.js self-navigation, NOT by a service-worker + tabs +
// alarms setup like the shelved 1.2.x Bulk Visit Queue. This means:
//
//   - Popup writes the queue state into IDB and navigates the active tab
//     to the first URL. That's it — popup can close after.
//   - profile.js on each /in/* page checks the queue state at end of its
//     capture pass. If this URL is the "expected next" URL, it does the
//     humanized dwell + between-visit pause + navigates window.location
//     to the next URL. Loops until the queue is empty or cancelled.
//   - Cancel: popup sets `cancelRequested: true` on the queue state.
//     profile.js checks the flag at every wait step and cleanly exits.
//   - Circuit breaker: if the user navigates away from /in/*, profile.js
//     doesn't run → queue silently pauses. Resume happens when they land
//     on an /in/* page that matches the queue's next expected URL.
//
// This file is the PURE state machine. profile.js and popup.js wrap it
// with side effects (IDB reads/writes, sleep, navigation).
//
// Wrapped in IIFE — same reason as the other core/* files (top-level
// identifiers must not leak into content_scripts / popup shared scope).

(function () {

// ---------- URL list parsing ----------

// The one-line-per-URL and comma-separated forms are both common (user
// might paste from a spreadsheet, a text file, or a Slack message). We
// accept whichever they use and produce a clean, deduped list of
// canonical `/in/<slug>/` URLs.
//
// Only linkedin.com/in/... URLs pass. Everything else (feed, search,
// company, ...) is rejected — the queue's purpose is profile capture.
// Vanity slug OR URN-format is fine, both resolve to a profile page.
//
// Returns:
//   { valid: string[], invalid: string[], duplicates: number }
// so the popup can render a preview: "12 valid, 3 skipped as non-profile,
// 2 duplicates dropped".
function parseUrlList(text) {
  if (!text || typeof text !== 'string') return { valid: [], invalid: [], duplicates: 0 };
  // Split on newlines OR commas — user might paste either shape.
  const raw = text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const valid = [];
  const invalid = [];
  const seen = new Set();
  let duplicates = 0;
  for (const line of raw) {
    // Tolerate trailing punctuation from copy-paste.
    const cleaned = line.replace(/[,;)"']+$/, '').trim();
    // Must be a linkedin.com/in/<slug> URL. Vanity or URN both accepted.
    const m = cleaned.match(/^https?:\/\/(?:[a-z]+\.)?linkedin\.com(\/in\/[^/?#]+)/i);
    if (!m) { invalid.push(cleaned); continue; }
    const canonical = `https://www.linkedin.com${m[1].replace(/\/+$/, '')}/`;
    if (seen.has(canonical)) { duplicates++; continue; }
    seen.add(canonical);
    valid.push(canonical);
  }
  return { valid, invalid, duplicates };
}

// ---------- Queue state ----------

// Canonical shape stored in IDB under the `visitQueueSimple` key:
//   {
//     urls:            string[],   // canonical /in/<slug>/ URLs
//     currentIndex:    number,     // 0..urls.length; when === urls.length, queue is done
//     capturedCount:   number,     // number of profiles that finished capture (not just navigated to)
//     startedAt:       number,     // Date.now() when Start was pressed
//     lastAdvancedAt:  number,     // Date.now() of last navigation — for stale-queue detection in UI
//     cancelRequested: boolean,    // set by popup Cancel, cleared by profile.js when honouring
//     seed:            number,     // PRNG seed for reproducible humanization within a run
//   }
//
// null when no queue is active.

function createQueue(urls, now, seed) {
  if (!Array.isArray(urls) || urls.length === 0) return null;
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError(`createQueue: now must be a finite number, got ${now}`);
  }
  return {
    urls: urls.slice(),
    currentIndex: 0,
    capturedCount: 0,
    startedAt: now,
    lastAdvancedAt: now,
    cancelRequested: false,
    seed: typeof seed === 'number' ? seed : Math.floor(Math.random() * 1e9),
  };
}

function isActive(state) {
  if (!state) return false;
  if (state.cancelRequested) return false;
  if (!Array.isArray(state.urls)) return false;
  return state.currentIndex >= 0 && state.currentIndex < state.urls.length;
}

// URL the queue expects to be on RIGHT NOW. profile.js compares this
// against normalizeProfileUrl(location.href) to decide whether it should
// self-navigate at end of capture. Returns null when the queue is done
// or cancelled or empty.
function currentTargetUrl(state) {
  if (!isActive(state)) return null;
  return state.urls[state.currentIndex];
}

// Compute the state AFTER a successful capture + humanized wait on
// currentIndex. Increments capturedCount and moves currentIndex forward.
// If we've hit the end, returns { done: true, state: null } so the caller
// can clear the IDB entry. Otherwise returns { done: false, state, nextUrl }.
function advance(state, now) {
  if (!state) return { done: true, state: null, nextUrl: null };
  if (state.cancelRequested) return { done: true, state: null, nextUrl: null };
  const nextIndex = state.currentIndex + 1;
  const nextState = {
    ...state,
    currentIndex: nextIndex,
    capturedCount: state.capturedCount + 1,
    lastAdvancedAt: now,
  };
  if (nextIndex >= state.urls.length) {
    return { done: true, state: null, nextUrl: null };
  }
  return { done: false, state: nextState, nextUrl: state.urls[nextIndex] };
}

// Set the cancel flag. Caller writes the returned state; profile.js will
// see the flag on its next tick and gracefully bail out (clearing the
// IDB entry once it has done so, so the queue disappears from the popup).
function cancelQueue(state) {
  if (!state) return null;
  return { ...state, cancelRequested: true };
}

// Predicate for profile.js: is THIS URL the one the queue expects right
// now? Uses a lenient equality — accepts either exact match or
// canonical-form match (both /in/joe/ and /in/joe are the same). Note:
// callers should have already normalized their URL via LITUrl.normalizeProfileUrl.
function isExpectedUrl(state, currentUrl) {
  const target = currentTargetUrl(state);
  if (!target || !currentUrl) return false;
  return target === currentUrl
    || target.replace(/\/+$/, '') === currentUrl.replace(/\/+$/, '');
}

// ---------- Humanized timing ----------

// Log-normal draw for dwell time. Real reading times cluster around a
// median with a fat right tail: most profiles read fast, occasional one
// gets "stuck" for minutes ("looking at their activity feed…"). rand is
// a [0, 1) closure — pass Math.random or a seeded PRNG for tests.
//
// medianMs is the CENTRAL tendency. sigma controls the tail width:
// 0.5 = gentle, 1.0 = wild. Clamped to [minMs, maxMs] so we never
// spend an eternity or blitz past.
function logNormalDwellMs(rand, medianMs, sigma, minMs, maxMs) {
  const u1 = Math.max(1e-9, rand());
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); // Box-Muller
  const ms = Math.round(medianMs * Math.exp(sigma * z));
  return Math.max(minMs, Math.min(maxMs, ms));
}

// Exponential draw for between-visit pause. Memoryless — models
// "waiting for something to catch my eye". meanMs is the average.
// Clamped to [minMs, maxMs].
function exponentialPauseMs(rand, meanMs, minMs, maxMs) {
  const u = Math.max(1e-9, 1 - rand()); // avoid log(0)
  const ms = Math.round(-meanMs * Math.log(u));
  return Math.max(minMs, Math.min(maxMs, ms));
}

// Public API.
const LITVisitQueueSimple = {
  parseUrlList,
  createQueue,
  isActive,
  currentTargetUrl,
  advance,
  cancelQueue,
  isExpectedUrl,
  logNormalDwellMs,
  exponentialPauseMs,
};
if (typeof globalThis !== 'undefined') globalThis.LITVisitQueueSimple = LITVisitQueueSimple;
if (typeof module !== 'undefined' && module.exports) module.exports = LITVisitQueueSimple;

})();
