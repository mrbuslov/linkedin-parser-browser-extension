// Humanized scroll helper for scan content scripts (/sent/ and
// /connections/). Both scanners used to jump straight to the bottom
// (element.scrollTop = scrollHeight or scrollIntoView({block:'end'}))
// once per tick to trigger LinkedIn's lazy-load intersection observer.
// That looks robotic — one instant teleport, no variability, no pauses.
//
// This helper replaces the single jump with a sequence of ANIMATED
// chunks each followed by a pause of variable duration. Each chunk
// itself is animated via ~60fps mini-steps with ease-in-out so the
// motion within a chunk is smooth like a trackpad scroll, NOT a series
// of instant micro-teleports. Occasional (~15% of steps) backward
// micro-wobble mimics a human re-reading a card. Distribution mixes:
//   - "big flick"     — 55-85% of remaining distance in one chunk
//   - "steady scroll" — 20-40% of remaining, most common
//   - "tiny nudge"    — 3-15% of remaining, mimics reading in place
// Post-chunk pause:
//   - "fast" (30%)    — 40-130ms
//   - "normal" (45%)  — 130-380ms
//   - "reading" (25%) — 380-880ms
// A final hard-scroll to bottom always fires so lazy-load still
// triggers reliably — the humanization is on the PATH there, not the
// destination.
//
// Pure-ish: takes an injected `rand` and `sleep` for testability. The
// real scan callers use Math.random and setTimeout by default.
//
// Wrapped in IIFE — same reason as the other core/* files (shared
// script scope in content_scripts and popup means top-level `const`
// would collide across bundles).

(function () {

// Find the element that actually scrolls on this page. LinkedIn's newer
// /connections/ AND /sent/ UIs put an internal scroll on some inner
// wrapper (scrollHeight 40k+, clientHeight ~900) while the window
// itself has doc-height ≈ viewport — window scroll is a no-op. Older
// layouts (or when data is small) may use window scroll. Strategy:
//   1) If document is meaningfully taller than viewport → window scroll
//   2) Otherwise pick the largest overflow:auto/scroll element with
//      real overflow content
//   3) Fall through to null = "use window scroll" (harmless no-op).
function findScanScrollContainer() {
  const docExcess = document.documentElement.scrollHeight - window.innerHeight;
  if (docExcess > 200) return null;

  let best = null;
  let bestExcess = 0;
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue;
    const excess = el.scrollHeight - el.clientHeight;
    if (excess < 200) continue;
    if (excess > bestExcess) { best = el; bestExcess = excess; }
  }
  return best;
}

// Ease-in-out quadratic — accelerate to the midpoint, decelerate to
// the end. Feels like a natural flick.
function _ease(t) {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}

// Animate a scroll delta over durationMs via ~60fps mini-steps. Each
// mini-step is a real scrollBy — the browser fires trusted 'scroll'
// events between them, LinkedIn's intersection observer / react
// listeners see continuous motion instead of one teleport.
async function _animatedScrollBy(applyDelta, delta, durationMs, sleep, isCancelled) {
  const stepMs = 16; // ~60fps
  const stepCount = Math.max(6, Math.round(durationMs / stepMs));
  let prevScrolled = 0;
  for (let i = 1; i <= stepCount; i++) {
    if (isCancelled()) return;
    const progress = _ease(i / stepCount);
    const currentScrolled = delta * progress;
    const stepDelta = currentScrolled - prevScrolled;
    applyDelta(stepDelta);
    prevScrolled = currentScrolled;
    await sleep(stepMs);
  }
}

async function humanizedScanScroll(target, opts = {}) {
  const rand = opts.rand || Math.random;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const isCancelled = opts.isCancelled || (() => false);
  const finalHardScroll = opts.finalHardScroll !== false;
  const log = opts.log || (() => {});

  const getTop = () => target ? target.scrollTop : window.scrollY;
  const getMax = () => target
    ? Math.max(0, target.scrollHeight - target.clientHeight)
    : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const applyDelta = (delta) => {
    if (target) target.scrollTop = Math.max(0, target.scrollTop + delta);
    else window.scrollBy(0, delta);
  };
  const hardBottom = () => {
    if (target) target.scrollTop = target.scrollHeight;
    else window.scrollTo(0, document.documentElement.scrollHeight);
  };

  const totalChunks = 4 + Math.floor(rand() * 7); // 4..10
  const steps = [];

  for (let i = 0; i < totalChunks; i++) {
    if (isCancelled()) return steps;
    const remaining = getMax() - getTop();
    if (remaining <= 20) break;

    // Chunk-size class: big / steady / tiny.
    const sizeRoll = rand();
    let fraction;
    let sizeClass;
    let durationMs;
    if (sizeRoll < 0.40) {
      fraction = 0.55 + rand() * 0.30;
      sizeClass = 'big';
      durationMs = 250 + Math.round(rand() * 250);   // 250-500ms animated
    } else if (sizeRoll < 0.75) {
      fraction = 0.20 + rand() * 0.20;
      sizeClass = 'steady';
      durationMs = 180 + Math.round(rand() * 200);   // 180-380ms
    } else {
      fraction = 0.03 + rand() * 0.12;
      sizeClass = 'tiny';
      durationMs = 80 + Math.round(rand() * 140);    // 80-220ms
    }
    const delta = Math.max(30, Math.round(remaining * fraction));

    // Occasional backward micro-wobble — also animated.
    let wobble = 0;
    if (rand() < 0.15 && getTop() > 200) {
      wobble = -(20 + Math.round(rand() * 40));
      await _animatedScrollBy(applyDelta, wobble, 120 + Math.round(rand() * 120), sleep, isCancelled);
      await sleep(70 + Math.round(rand() * 140));
      if (isCancelled()) return steps;
    }

    await _animatedScrollBy(applyDelta, delta, durationMs, sleep, isCancelled);

    // Post-chunk pause.
    const pauseRoll = rand();
    let pauseMs;
    let pauseClass;
    if (pauseRoll < 0.30) {
      pauseMs = 40 + Math.round(rand() * 90);
      pauseClass = 'fast';
    } else if (pauseRoll < 0.75) {
      pauseMs = 130 + Math.round(rand() * 250);
      pauseClass = 'normal';
    } else {
      pauseMs = 380 + Math.round(rand() * 500);
      pauseClass = 'reading';
    }
    const step = { wobble, delta, durationMs, sizeClass, pauseMs, pauseClass };
    steps.push(step);
    log(step);
    await sleep(pauseMs);
  }

  if (finalHardScroll && !isCancelled()) hardBottom();
  return steps;
}

// Humanized READING scroll for the bulk-visit queue on /in/* profile
// pages. Different behaviour than humanizedScanScroll:
//   - scan-scroll is one-directional (always down toward the terminal
//     load-more fence), used by /sent/ and /connections/ scanners.
//   - reading-scroll is BIDIRECTIONAL — real readers scroll down to see
//     new content, back up to re-read, down again, sometimes linger on
//     a post. Runs for a fixed TIME BUDGET (totalMs) instead of a fixed
//     chunk count. Emits random-direction chunks with random pause
//     classes ("glance" / "reading" / "engaged") until the budget runs
//     out or the caller cancels.
//
// Direction selection: near top → always down; near bottom → always up;
// middle → 65% down / 35% up. Sizes are fractions of VIEWPORT so
// movement scales sensibly on any page length. Each chunk animated via
// the same _animatedScrollBy 60fps mini-step helper — trusted scroll
// events, ease-in-out.
async function humanizedReadingScroll(target, opts = {}) {
  const rand = opts.rand || Math.random;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const isCancelled = opts.isCancelled || (() => false);
  const log = opts.log || (() => {});
  const totalMs = opts.totalMs || 20_000;
  const now = opts.now || (() => Date.now());

  const getTop = () => target ? target.scrollTop : window.scrollY;
  const getMax = () => target
    ? Math.max(0, target.scrollHeight - target.clientHeight)
    : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const getViewport = () => target ? target.clientHeight : window.innerHeight;
  // Caller can override the write path via opts.applyDelta — used by
  // profile.js:runQueueTickIfApplicable to route scroll writes through
  // a page-world postMessage bridge (React's patched scrollTop setter
  // only fires in main world; writes from isolated content-script world
  // go through the NATIVE setter and get reset back by React on the
  // next reconciliation). See linkedin-tracker/page-scroll-bridge.js.
  const applyDelta = opts.applyDelta || ((delta) => {
    if (target) target.scrollTop = Math.max(0, target.scrollTop + delta);
    else window.scrollBy(0, delta);
  });

  const steps = [];
  const startedAt = now();

  while (now() - startedAt < totalMs) {
    if (await isCancelled()) break;

    const max = getMax();
    const top = getTop();

    if (max < 30) {
      // Rare: no scroll room. Just idle a bit and re-check.
      await sleep(500 + Math.round(rand() * 500));
      continue;
    }
    let direction;
    if (top < max * 0.10)      direction = 1;
    else if (top > max * 0.85) direction = -1;
    else                       direction = rand() < 0.65 ? 1 : -1;

    const sizeRoll = rand();
    let sizeClass, fraction, durationMs;
    if (sizeRoll < 0.30) {
      sizeClass  = 'big';
      fraction   = 0.20 + rand() * 0.25;
      durationMs = 400 + Math.round(rand() * 400);
    } else if (sizeRoll < 0.75) {
      sizeClass  = 'medium';
      fraction   = 0.06 + rand() * 0.15;
      durationMs = 220 + Math.round(rand() * 260);
    } else {
      sizeClass  = 'tiny';
      fraction   = 0.02 + rand() * 0.05;
      durationMs = 120 + Math.round(rand() * 150);
    }

    const viewport = getViewport();
    const delta = direction * Math.max(30, Math.round(viewport * fraction));

    await _animatedScrollBy(applyDelta, delta, durationMs, sleep, isCancelled);

    const pauseRoll = rand();
    let pauseMs, pauseClass;
    if (pauseRoll < 0.55) {
      pauseMs   = 500 + Math.round(rand() * 800);
      pauseClass = 'glance';
    } else if (pauseRoll < 0.90) {
      pauseMs   = 1200 + Math.round(rand() * 2000);
      pauseClass = 'reading';
    } else {
      // "Linger on a block" — 3-8s stopped, reading a post.
      pauseMs   = 3000 + Math.round(rand() * 5000);
      pauseClass = 'engaged';
    }

    const step = { direction, delta, sizeClass, durationMs, pauseMs, pauseClass };
    steps.push(step);
    log(step);
    await sleep(pauseMs);
  }

  return steps;
}

const LITScanScroll = { humanizedScanScroll, humanizedReadingScroll, findScanScrollContainer };
if (typeof globalThis !== 'undefined') globalThis.LITScanScroll = LITScanScroll;
if (typeof module !== 'undefined' && module.exports) module.exports = LITScanScroll;

})();
