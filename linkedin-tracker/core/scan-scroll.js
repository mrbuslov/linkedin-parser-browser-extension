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

const LITScanScroll = { humanizedScanScroll };
if (typeof globalThis !== 'undefined') globalThis.LITScanScroll = LITScanScroll;
if (typeof module !== 'undefined' && module.exports) module.exports = LITScanScroll;

})();
