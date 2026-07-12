import { describe, it, expect } from 'vitest';
const { humanizedScanScroll, humanizedReadingScroll } = require('../linkedin-tracker/core/scan-scroll.js');

// Deterministic-ish LCG so we can seed the helper for repeatable steps.
function seededRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4_294_967_296;
  };
}

// A synchronous "sleep" that just records the requested delay — the
// tests never need real time to pass.
function fakeSleep() {
  const delays = [];
  return {
    sleep: (ms) => { delays.push(ms); return Promise.resolve(); },
    delays,
  };
}

// Tiny fake scroll container. Exposes scrollTop / scrollHeight /
// clientHeight — the same shape humanizedScanScroll reads through.
function fakeContainer({ height = 5000, viewport = 800, startTop = 0 } = {}) {
  return {
    scrollTop: startTop,
    scrollHeight: height,
    clientHeight: viewport,
  };
}

describe('humanizedScanScroll — targeted container', () => {
  it('takes 4-10 chunks per call', async () => {
    for (let seed = 1; seed < 30; seed++) {
      const c = fakeContainer();
      const { sleep } = fakeSleep();
      const steps = await humanizedScanScroll(c, { rand: seededRand(seed), sleep });
      expect(steps.length).toBeGreaterThanOrEqual(1);
      // 4-10 chunks is the target — allow lower bound because early
      // termination is legal when remaining <=20.
      expect(steps.length).toBeLessThanOrEqual(10);
    }
  });

  it('mixes chunk-size classes (big / steady / tiny) across seeds', async () => {
    const seen = new Set();
    for (let seed = 1; seed <= 60; seed++) {
      const c = fakeContainer();
      const { sleep } = fakeSleep();
      const steps = await humanizedScanScroll(c, { rand: seededRand(seed), sleep });
      for (const s of steps) seen.add(s.sizeClass);
    }
    expect(seen.has('big')).toBe(true);
    expect(seen.has('steady')).toBe(true);
    expect(seen.has('tiny')).toBe(true);
  });

  it('mixes pause classes (fast / normal / reading) across seeds', async () => {
    const seen = new Set();
    for (let seed = 1; seed <= 60; seed++) {
      const c = fakeContainer();
      const { sleep } = fakeSleep();
      const steps = await humanizedScanScroll(c, { rand: seededRand(seed), sleep });
      for (const s of steps) seen.add(s.pauseClass);
    }
    expect(seen.has('fast')).toBe(true);
    expect(seen.has('normal')).toBe(true);
    expect(seen.has('reading')).toBe(true);
  });

  it('occasionally includes a backward micro-wobble (~15% of steps overall)', async () => {
    let wobbleSteps = 0;
    let totalSteps = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const c = fakeContainer();
      const { sleep } = fakeSleep();
      const steps = await humanizedScanScroll(c, { rand: seededRand(seed), sleep });
      for (const s of steps) {
        totalSteps++;
        if (s.wobble < 0) wobbleSteps++;
      }
    }
    const rate = wobbleSteps / totalSteps;
    // Target ~15%, allow a wide envelope for stochastic sampling.
    expect(rate).toBeGreaterThan(0.05);
    expect(rate).toBeLessThan(0.30);
  });

  it('final hard-scroll lands at or near the bottom', async () => {
    for (let seed = 1; seed < 20; seed++) {
      const c = fakeContainer({ height: 6000, viewport: 900 });
      const { sleep } = fakeSleep();
      await humanizedScanScroll(c, { rand: seededRand(seed), sleep });
      // hardBottom sets scrollTop = scrollHeight — browser clamps in
      // real life, we just check the value we wrote is at least the
      // max scroll position (6000).
      expect(c.scrollTop).toBeGreaterThanOrEqual(6000 - 100);
    }
  });

  it('respects finalHardScroll: false (skips terminal jump)', async () => {
    const c = fakeContainer({ height: 6000, viewport: 900 });
    const { sleep } = fakeSleep();
    await humanizedScanScroll(c, {
      rand: seededRand(42), sleep, finalHardScroll: false,
    });
    expect(c.scrollTop).toBeLessThan(6000);
  });

  it('stops early when isCancelled returns true', async () => {
    const c = fakeContainer();
    const { sleep, delays } = fakeSleep();
    let ticks = 0;
    const steps = await humanizedScanScroll(c, {
      rand: seededRand(7), sleep,
      isCancelled: () => ++ticks >= 3,
    });
    // With cancellation after ~3 ticks, we see at most 2-3 recorded
    // steps (each step increments `ticks` twice — once at loop-top,
    // once inside optional wobble block).
    expect(steps.length).toBeLessThan(4);
    // Sleeps recorded should be similarly bounded.
    expect(delays.length).toBeLessThan(6);
  });

  it('net motion is downward across many seeds (chunks advance past wobbles)', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const c = fakeContainer({ height: 8000, viewport: 800, startTop: 0 });
      const { sleep } = fakeSleep();
      await humanizedScanScroll(c, {
        rand: seededRand(seed), sleep, finalHardScroll: false,
      });
      // Even without the final hard-scroll, net progress should be
      // meaningfully positive.
      expect(c.scrollTop).toBeGreaterThan(0);
    }
  });

  it('exits without scrolling when already at bottom', async () => {
    const c = fakeContainer({ height: 5000, viewport: 800, startTop: 4200 });
    const { sleep, delays } = fakeSleep();
    const steps = await humanizedScanScroll(c, {
      rand: seededRand(3), sleep, finalHardScroll: false,
    });
    // No room to scroll — should return an empty or near-empty step
    // list. Some seeds may record 1-2 steps due to wobble mechanics
    // before the guard fires.
    expect(steps.length).toBeLessThan(3);
    expect(delays.length).toBeLessThan(10);
  });

  it('each chunk is ANIMATED — records many mini-step sleeps in addition to the post-chunk pause', async () => {
    // Old (broken) implementation did one instant scrollBy per chunk
    // → total sleeps ≈ chunk count. New implementation animates each
    // chunk via ~60fps mini-steps → total sleeps ≈ chunk_count *
    // ~20-40, dominating the count. This test guards that the mini-
    // step loop is actually running.
    const c = fakeContainer({ height: 8000, viewport: 800 });
    const { sleep, delays } = fakeSleep();
    const steps = await humanizedScanScroll(c, {
      rand: seededRand(1), sleep,
    });
    // At least ~10 mini-sleeps per chunk on average.
    expect(delays.length).toBeGreaterThan(steps.length * 8);
  });

  it('reports durationMs per chunk in the correct band per size class', async () => {
    const seenByClass = { big: [], steady: [], tiny: [] };
    for (let seed = 1; seed <= 40; seed++) {
      const c = fakeContainer({ height: 8000, viewport: 800 });
      const { sleep } = fakeSleep();
      const steps = await humanizedScanScroll(c, { rand: seededRand(seed), sleep });
      for (const s of steps) {
        if (seenByClass[s.sizeClass]) seenByClass[s.sizeClass].push(s.durationMs);
      }
    }
    // Band sanity — big is the longest, tiny is the shortest.
    if (seenByClass.big.length && seenByClass.tiny.length) {
      const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      expect(avg(seenByClass.big)).toBeGreaterThan(avg(seenByClass.tiny));
    }
    // Each class stays within its declared band.
    for (const d of seenByClass.big)    { expect(d).toBeGreaterThanOrEqual(250); expect(d).toBeLessThanOrEqual(500); }
    for (const d of seenByClass.steady) { expect(d).toBeGreaterThanOrEqual(180); expect(d).toBeLessThanOrEqual(380); }
    for (const d of seenByClass.tiny)   { expect(d).toBeGreaterThanOrEqual(80);  expect(d).toBeLessThanOrEqual(220); }
  });

  it('animated mini-steps use ease-in-out (mid-chunk progress > linear)', async () => {
    // The ease function 2t² for t<0.5 → at t=0.25, ease=0.125 (vs
    // linear 0.25). So the chunk's scrollTop at ~25% of duration
    // should be LESS than 25% of delta. We verify by intercepting the
    // scrollTop mutations.
    const positions = [];
    const c = {
      scrollHeight: 10_000, clientHeight: 800,
      _top: 0,
      get scrollTop() { return this._top; },
      set scrollTop(v) { this._top = v; positions.push(v); },
    };
    const { sleep } = fakeSleep();
    // Seed 100 usually produces a 'big' first chunk — enough motion
    // to see the ease curve clearly.
    await humanizedScanScroll(c, {
      rand: seededRand(100), sleep, finalHardScroll: false,
    });
    // With ease-in-out, the position sequence should be strictly
    // increasing and NOT linear — the per-step deltas should grow
    // then shrink. Verify by checking at least one adjacent pair
    // where later delta < earlier delta (deceleration phase).
    const deltas = [];
    for (let i = 1; i < positions.length; i++) {
      deltas.push(positions[i] - positions[i - 1]);
    }
    // Find the peak — mid-chunk deltas should be larger than start.
    const maxDelta = Math.max(...deltas);
    const firstDelta = deltas[0];
    expect(maxDelta).toBeGreaterThan(firstDelta);
  });
});

describe('humanizedScanScroll — window scroll fallback', () => {
  // When target=null the helper reads window.scrollY / window.innerHeight
  // and calls window.scrollBy / window.scrollTo. jsdom supplies these
  // stubs by default.
  it('runs against the window without throwing', async () => {
    const originalScrollBy = window.scrollBy;
    const originalScrollTo = window.scrollTo;
    let scrollByCalls = 0;
    let scrollToCalls = 0;
    window.scrollBy = () => { scrollByCalls++; };
    window.scrollTo = () => { scrollToCalls++; };
    try {
      const { sleep } = fakeSleep();
      await humanizedScanScroll(null, { rand: seededRand(1), sleep });
      // In jsdom, document.documentElement.scrollHeight is 0 — so
      // getMax() returns 0 and the loop exits immediately. What we
      // really guard here is that the null-target branch doesn't
      // throw and the terminal hard-scroll still fires.
      expect(scrollToCalls).toBeGreaterThanOrEqual(1);
    } finally {
      window.scrollBy = originalScrollBy;
      window.scrollTo = originalScrollTo;
    }
  });
});

// Fake clock — advances by explicit ticks so we can simulate totalMs
// budget without actually waiting. sleep() advances the clock too.
function fakeClock() {
  let t = 0;
  const now = () => t;
  const sleep = (ms) => { t += ms; return Promise.resolve(); };
  return { now, sleep };
}

describe('humanizedReadingScroll — bidirectional reading pattern for /in/* profile pages', () => {
  it('respects the totalMs time budget', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const c = fakeContainer({ height: 8000, viewport: 900 });
      const { now, sleep } = fakeClock();
      await humanizedReadingScroll(c, { rand: seededRand(seed), sleep, now, totalMs: 20_000 });
      // No sensible way to overshoot far beyond budget — one final chunk
      // may push us slightly past. Assert within [budget, budget * 1.5].
      expect(now()).toBeGreaterThanOrEqual(19_500);
      expect(now()).toBeLessThan(30_000);
    }
  });

  it('emits scrolls in BOTH directions across seeds (bidirectional guarantee)', async () => {
    // Real bug motivation: humanizedScanScroll only ever went down.
    // Real reader behaviour includes back-up passes. If this test ever
    // fails after a refactor, we've regressed reading-mode to scan-mode.
    let downSteps = 0;
    let upSteps = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const c = fakeContainer({ height: 8000, viewport: 900, startTop: 4000 });
      const { now, sleep } = fakeClock();
      const steps = await humanizedReadingScroll(c, {
        rand: seededRand(seed), sleep, now, totalMs: 25_000,
      });
      for (const s of steps) {
        if (s.direction > 0) downSteps++;
        else if (s.direction < 0) upSteps++;
      }
    }
    // At mid-scroll starting position (top=4000, max≈7100 so ratio~0.56)
    // the 65/35 split should give us plenty of both.
    expect(downSteps).toBeGreaterThan(0);
    expect(upSteps).toBeGreaterThan(0);
    // Down should be majority overall (65% target).
    expect(downSteps).toBeGreaterThan(upSteps);
  });

  it('near TOP: always scrolls DOWN (never negative direction)', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const c = fakeContainer({ height: 10_000, viewport: 900, startTop: 100 });
      const { now, sleep } = fakeClock();
      const steps = await humanizedReadingScroll(c, {
        rand: seededRand(seed), sleep, now, totalMs: 8_000,
      });
      // First step near-top must be downward. After it moves us off
      // the near-top edge, later steps CAN reverse. Just check the very
      // first step's direction.
      if (steps.length > 0) {
        expect(steps[0].direction).toBe(1);
      }
    }
  });

  it('near BOTTOM: always scrolls UP (never positive direction)', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const c = fakeContainer({ height: 8000, viewport: 900, startTop: 6900 });
      const { now, sleep } = fakeClock();
      const steps = await humanizedReadingScroll(c, {
        rand: seededRand(seed), sleep, now, totalMs: 8_000,
      });
      if (steps.length > 0) {
        expect(steps[0].direction).toBe(-1);
      }
    }
  });

  it('mixes all THREE size classes (big / medium / tiny) across seeds', async () => {
    const seen = new Set();
    for (let seed = 1; seed <= 30; seed++) {
      const c = fakeContainer({ height: 8000, viewport: 900 });
      const { now, sleep } = fakeClock();
      const steps = await humanizedReadingScroll(c, {
        rand: seededRand(seed), sleep, now, totalMs: 20_000,
      });
      for (const s of steps) seen.add(s.sizeClass);
    }
    expect(seen.has('big')).toBe(true);
    expect(seen.has('medium')).toBe(true);
    expect(seen.has('tiny')).toBe(true);
  });

  it('mixes all THREE pause classes including "engaged" long-linger', async () => {
    // "Engaged" is the 10% tail — "stopped on a post for 3-8s". User's
    // explicit request: "sometimes linger on some block". If this
    // regresses, the reader behaviour goes back to fast-scan pattern.
    const seen = new Set();
    for (let seed = 1; seed <= 60; seed++) {
      const c = fakeContainer({ height: 8000, viewport: 900 });
      const { now, sleep } = fakeClock();
      const steps = await humanizedReadingScroll(c, {
        rand: seededRand(seed), sleep, now, totalMs: 30_000,
      });
      for (const s of steps) seen.add(s.pauseClass);
    }
    expect(seen.has('glance')).toBe(true);
    expect(seen.has('reading')).toBe(true);
    expect(seen.has('engaged')).toBe(true);
  });

  it('uses target.scrollTop when target is provided (NOT window)', async () => {
    // Regression: my initial 1.3.3 shipped humanizedScanScroll(null, ...)
    // for the bulk-visit queue. On LinkedIn profile pages whose real
    // scroll is on an internal container, window.scrollBy is a silent
    // no-op — nothing moved. Passing target explicitly (from
    // findScanScrollContainer) is the fix. This test guards the target
    // path — if we ever regress to window-only, target.scrollTop stays
    // at 0 and the assertion fails.
    const c = fakeContainer({ height: 8000, viewport: 900, startTop: 0 });
    const { now, sleep } = fakeClock();
    await humanizedReadingScroll(c, {
      rand: seededRand(42), sleep, now, totalMs: 15_000,
    });
    expect(c.scrollTop).toBeGreaterThan(0);
  });

  it('cancellation stops the loop mid-flight', async () => {
    const c = fakeContainer({ height: 8000, viewport: 900 });
    const { now, sleep } = fakeClock();
    let ticks = 0;
    const steps = await humanizedReadingScroll(c, {
      rand: seededRand(1), sleep, now, totalMs: 60_000,
      isCancelled: () => ++ticks >= 3,
    });
    // With cancellation firing quickly, we shouldn't have completed many
    // full chunks.
    expect(steps.length).toBeLessThan(5);
  });

  it('no-scroll room case: idles without throwing', async () => {
    // Container fits fully in viewport — nothing to scroll. Loop should
    // idle for the totalMs budget and return an empty step list.
    const c = fakeContainer({ height: 900, viewport: 900 });
    const { now, sleep } = fakeClock();
    const steps = await humanizedReadingScroll(c, {
      rand: seededRand(1), sleep, now, totalMs: 5_000,
    });
    expect(steps).toEqual([]);
    // Time should still advance to (near) totalMs via the idle sleep.
    expect(now()).toBeGreaterThanOrEqual(5_000);
  });
});
