// Humanized scroll for scan and reading passes. Replaces instant
// scrollTop=scrollHeight teleport with 60fps animated chunks +
// variable pauses so intersection observers see continuous motion.
// Pure-ish: injected `rand` and `sleep` for testability.

(function () {

// If document itself is scrollable (docExcess > 200), use window
// scroll. Otherwise pick the largest inner overflow:auto/scroll —
// LinkedIn's newer /sent/ and /connections/ put scroll on an inner
// wrapper while window's doc-height ≈ viewport.
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

// Animate scroll delta over durationMs via 60fps mini-steps — trusted
// scroll events fire between steps so intersection observers see
// continuous motion.
// `await isCancelled()` — not `if (isCancelled())`. Async isCancelled
// returns Promise (truthy) → without await, loop short-circuits every
// step and applyDelta never fires while the caller's per-chunk log
// still ticks. Silently broken; do not undo the await.
async function _animatedScrollBy(applyDelta, delta, durationMs, sleep, isCancelled) {
  const stepMs = 16; // ~60fps
  const stepCount = Math.max(6, Math.round(durationMs / stepMs));
  let prevScrolled = 0;
  for (let i = 1; i <= stepCount; i++) {
    if (await isCancelled()) return;
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

// Bidirectional humanized scroll for the bulk-visit queue on /in/*.
// Unlike humanizedScanScroll (one-directional, chunk-count budget),
// this runs for a time budget with random-direction chunks and
// glance/reading/engaged pauses — mimics a real reader. Direction
// biased to 65% down in the middle, forced at page edges.
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
  // opts.applyDelta lets the caller route writes through the page-world
  // bridge — see page-scroll-bridge.js.
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
