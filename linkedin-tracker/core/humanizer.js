// Pure humanization primitives for the Bulk Visit Queue.
//
// Every stochastic function takes an explicit `rand` closure returning
// [0, 1). This makes tests fully deterministic (seeded PRNG) and lets
// the runner log a session seed for post-mortem debugging ("why did
// queue wait 12 minutes between visits at 14:32?" — replay the seed).
//
// Distributions are chosen to look human, not uniform:
//   - Reading time / batch break — log-normal (fat right tail: most
//     values near median, occasional very long dwell)
//   - Between-visit pause — exponential (memoryless, models "waiting
//     for something interesting" behaviour)
//   - Scroll plan — sequence of variable-velocity chunks with
//     occasional backward step ("re-read") and pause ("distracted")
//
// Zero fallbacks by design: every required parameter throws when
// missing. Callers must be explicit — a silent default here would hide
// bugs in the runner for months.
//
// Wrapped in IIFE — top-level SEC/MIN identifiers must not leak into
// popup.html / SW importScripts shared scope. See visit-queue.js
// header for full rationale.

(function () {

const SEC = 1_000;
const MIN = 60_000;

// Mulberry32 — small, fast, deterministic 32-bit PRNG. Perfect for
// humanization (we don't need cryptographic randomness). Same seed +
// same call sequence → identical output, which is what tests rely on.
function mulberry32(seed) {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new TypeError(`mulberry32: seed must be a finite number, got ${seed}`);
  }
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function requireRand(rand, fn) {
  if (typeof rand !== 'function') {
    throw new TypeError(`${fn}: rand must be a () => number in [0,1); got ${typeof rand}`);
  }
}

// Log-normal via Box-Muller. Returns ms centred near medianMs with
// spread controlled by sigma (typical values 0.25-0.5).
function logNormal(rand, medianMs, sigma) {
  requireRand(rand, 'logNormal');
  const u1 = 1 - rand();
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return medianMs * Math.exp(sigma * z);
}

// How long we stay on a profile before moving on. Base "arrival read"
// time plus scaling by content volume, jittered log-normally, clamped.
function readingTime({
  headlineLen = 0,
  aboutLen = 0,
  experienceCount = 0,
  rand,
  minMs = 15 * SEC,
  maxMs = 4 * MIN,
}) {
  requireRand(rand, 'readingTime');
  const base = 20 * SEC;
  const scaled = base
    + 0.05 * SEC * headlineLen        // 20 chars ≈ 1s
    + 0.02 * SEC * aboutLen           // 500 chars ≈ 10s
    + 4 * SEC * experienceCount;      // each role ≈ 4s
  const jittered = logNormal(rand, scaled, 0.35);
  return Math.max(minMs, Math.min(maxMs, Math.round(jittered)));
}

// Pause between two consecutive profile visits. Exponential — models
// a person hesitating "hmm what next", occasionally deciding fast,
// occasionally lingering. meanSec is the exponential's mean.
function betweenVisits({ meanSec = 90, minSec = 30, maxSec = 5 * 60, rand }) {
  requireRand(rand, 'betweenVisits');
  const u = 1 - rand();
  const raw = -Math.log(u) * meanSec * SEC;
  return Math.max(minSec * SEC, Math.min(maxSec * SEC, Math.round(raw)));
}

// Long pause between batches. 15-45 min log-normal by default —
// "took a break, got coffee, came back".
function batchBreak({ rand, medianMin = 25, minMin = 15, maxMin = 60 }) {
  requireRand(rand, 'batchBreak');
  const jittered = logNormal(rand, medianMin * MIN, 0.4);
  return Math.max(minMin * MIN, Math.min(maxMin * MIN, Math.round(jittered)));
}

// Scroll plan — full round trip like a real profile viewer:
//   1) Scroll DOWN to bottom with variable velocity + occasional
//      short backward jitter ("re-read") + occasional pauses
//      ("distracted, reading a specific section")
//   2) Long dwell at the bottom (3-10s — "took in the last section")
//   3) Scroll UP back to top, faster and in bigger chunks than the
//      way down (people flick back up rather than crawl), with an
//      occasional stop halfway ("wanted to re-check something")
//   4) Short dwell at the top
//
// Each step is `{delta, ms}`. Positive delta = down, negative = up,
// zero delta with ms > 0 = pause. Duration is proportional to |delta|
// with variable "velocity" — a 300px chunk might take 600ms or 1500ms.
function scrollPlan({
  pageHeight,
  rand,
  backwardChance = 0.12,
  pauseChance = 0.20,
  maxSteps = 80,
}) {
  requireRand(rand, 'scrollPlan');
  if (typeof pageHeight !== 'number' || pageHeight <= 0) {
    throw new RangeError(`scrollPlan: pageHeight must be > 0, got ${pageHeight}`);
  }
  const steps = [];
  // ── Phase 1: DOWN — variable-velocity descent to ~85-100% of page.
  let scrolled = 0;
  const downTarget = pageHeight * (0.85 + 0.15 * rand());
  while (scrolled < downTarget && steps.length < maxSteps - 10) {
    if (steps.length > 0 && rand() < pauseChance) {
      steps.push({ delta: 0, ms: 300 + Math.round(rand() * 1500) });
    }
    const back = rand() < backwardChance && scrolled > 400;
    const delta = back
      ? -(80 + Math.round(rand() * 200))
      :  (150 + Math.round(rand() * 400));
    const ms = Math.round(Math.abs(delta) * (2 + 3 * rand()));
    steps.push({ delta, ms });
    scrolled += delta;
    if (scrolled < 0) scrolled = 0;
  }
  // ── Phase 2: BOTTOM dwell (3-10s reading the final section).
  steps.push({ delta: 0, ms: 3000 + Math.round(rand() * 7000) });

  // ── Phase 3: UP — return to top. Bigger chunks than descent
  // (people flick back up faster), with occasional pauses.
  let returned = 0;
  const upTarget = scrolled * 0.95; // most of the way back
  while (returned < upTarget && steps.length < maxSteps - 2) {
    // Occasional pause on the way up
    if (steps.length > 0 && rand() < 0.15) {
      steps.push({ delta: 0, ms: 400 + Math.round(rand() * 2000) });
    }
    const delta = -(250 + Math.round(rand() * 550)); // 250-800px flick up
    const ms = Math.round(Math.abs(delta) * (1 + 2 * rand())); // faster than down
    steps.push({ delta, ms });
    returned += Math.abs(delta);
  }
  // ── Phase 4: TOP dwell (1-3s "back at the beginning").
  steps.push({ delta: 0, ms: 1000 + Math.round(rand() * 2000) });
  return steps;
}

// Time-of-day gate. windowStart/End are "HH:MM". tzOffsetMin is offset
// from UTC in minutes, positive east (e.g., Kyiv summer = 180).
function _parseHHMM(s, name) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m) throw new RangeError(`${name}: expected "HH:MM", got ${JSON.stringify(s)}`);
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) {
    throw new RangeError(`${name}: out of range "${s}"`);
  }
  return h * 60 + mm;
}

function isWithinWindow({ now, windowStart, windowEnd, tzOffsetMin = 0 }) {
  if (typeof now !== 'number') throw new TypeError(`isWithinWindow: now must be ms epoch, got ${typeof now}`);
  const start = _parseHHMM(windowStart, 'windowStart');
  const end = _parseHHMM(windowEnd, 'windowEnd');
  const local = new Date(now + tzOffsetMin * MIN);
  const localMins = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (start === end) return false;
  if (start < end) return localMins >= start && localMins < end;
  return localMins >= start || localMins < end;
}

// Ms until the window reopens. If already inside, returns 0.
function msUntilWindow({ now, windowStart, windowEnd, tzOffsetMin = 0 }) {
  if (isWithinWindow({ now, windowStart, windowEnd, tzOffsetMin })) return 0;
  const start = _parseHHMM(windowStart, 'windowStart');
  const local = new Date(now + tzOffsetMin * MIN);
  const localMins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const secondsPast = local.getUTCSeconds() * 1000 + local.getUTCMilliseconds();
  let deltaMins;
  if (localMins < start) deltaMins = start - localMins;
  else deltaMins = (24 * 60 - localMins) + start;
  return deltaMins * MIN - secondsPast;
}

// Should we take a batch break now? Simple counter check.
function shouldBreak({ visitsSinceBreak, batchSize }) {
  if (typeof visitsSinceBreak !== 'number' || visitsSinceBreak < 0) {
    throw new RangeError(`shouldBreak: visitsSinceBreak must be >= 0, got ${visitsSinceBreak}`);
  }
  if (typeof batchSize !== 'number' || batchSize < 1) {
    throw new RangeError(`shouldBreak: batchSize must be >= 1, got ${batchSize}`);
  }
  return visitsSinceBreak >= batchSize;
}

// Feed-break scheduler. Below minInterval never. At/above maxInterval
// always. In between, probability rises linearly toward 1.0.
function shouldFeedBreak({
  visitsSinceFeed,
  rand,
  minInterval = 5,
  maxInterval = 12,
}) {
  requireRand(rand, 'shouldFeedBreak');
  if (visitsSinceFeed < minInterval) return false;
  if (visitsSinceFeed >= maxInterval) return true;
  const ratio = (visitsSinceFeed - minInterval) / (maxInterval - minInterval);
  return rand() < ratio;
}

// Warmup: first 7 days after queue creation cap at 30% of configured
// speed. Returns effective factor to multiply dailyCap by.
function warmupFactor({ now, warmupUntil }) {
  if (typeof now !== 'number') throw new TypeError('warmupFactor: now must be ms epoch');
  if (warmupUntil === null || warmupUntil === undefined) return 1.0;
  if (now >= warmupUntil) return 1.0;
  return 0.3;
}

// Zone classification for the popup counter. Returns UI-ready shape.
function safetyZone({ todayVisited, dailyCap }) {
  if (typeof todayVisited !== 'number' || todayVisited < 0) {
    throw new RangeError(`safetyZone: todayVisited must be >= 0, got ${todayVisited}`);
  }
  if (typeof dailyCap !== 'number' || dailyCap < 1) {
    throw new RangeError(`safetyZone: dailyCap must be >= 1, got ${dailyCap}`);
  }
  const pct = todayVisited / dailyCap;
  const remaining = Math.max(0, dailyCap - todayVisited);
  if (pct >= 1.0)  return { zone: 'blocked', emoji: '🛑', label: 'Daily limit reached', pct, remaining };
  if (pct >= 0.85) return { zone: 'red',     emoji: '🔴', label: 'At limit',            pct, remaining };
  if (pct >= 0.66) return { zone: 'orange',  emoji: '🟠', label: 'Warning',             pct, remaining };
  if (pct >= 0.33) return { zone: 'yellow',  emoji: '🟡', label: 'Moderate',            pct, remaining };
  return             { zone: 'green',   emoji: '🟢', label: 'Safe',                pct, remaining };
}

const LITHumanizer = {
  mulberry32,
  logNormal,
  readingTime,
  betweenVisits,
  batchBreak,
  scrollPlan,
  isWithinWindow,
  msUntilWindow,
  shouldBreak,
  shouldFeedBreak,
  warmupFactor,
  safetyZone,
};
if (typeof globalThis !== 'undefined') globalThis.LITHumanizer = LITHumanizer;
if (typeof module !== 'undefined' && module.exports) module.exports = LITHumanizer;

})();
