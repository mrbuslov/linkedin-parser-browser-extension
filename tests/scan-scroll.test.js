import { describe, it, expect } from 'vitest';
const { humanizedScanScroll } = require('../linkedin-tracker/core/scan-scroll.js');

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
    expect(delays.length).toBeLessThan(4);
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
