import { describe, it, expect } from 'vitest';
const H = require('../linkedin-tracker/core/humanizer.js');

const SEC = 1000;
const MIN = 60_000;

describe('mulberry32 PRNG', () => {
  it('is deterministic for a given seed', () => {
    const r1 = H.mulberry32(42);
    const r2 = H.mulberry32(42);
    for (let i = 0; i < 100; i++) expect(r1()).toBe(r2());
  });

  it('produces different streams for different seeds', () => {
    const r1 = H.mulberry32(1);
    const r2 = H.mulberry32(2);
    const s1 = Array.from({ length: 20 }, () => r1());
    const s2 = Array.from({ length: 20 }, () => r2());
    expect(s1).not.toEqual(s2);
  });

  it('output stays in [0, 1)', () => {
    const r = H.mulberry32(12345);
    for (let i = 0; i < 5000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('throws on non-numeric seed', () => {
    expect(() => H.mulberry32('42')).toThrow(/finite number/);
    expect(() => H.mulberry32(NaN)).toThrow(/finite number/);
  });
});

describe('readingTime', () => {
  it('scales monotonically with content volume (median over N samples)', () => {
    // Log-normal is noisy per-sample; average over many seeds.
    function medianFor(cfg) {
      const samples = [];
      for (let s = 1; s <= 200; s++) {
        samples.push(H.readingTime({ ...cfg, rand: H.mulberry32(s) }));
      }
      samples.sort((a, b) => a - b);
      return samples[100];
    }
    const small = medianFor({ headlineLen: 20, aboutLen: 100, experienceCount: 1 });
    const large = medianFor({ headlineLen: 100, aboutLen: 2000, experienceCount: 8 });
    expect(large).toBeGreaterThan(small);
  });

  it('clamps to [minMs, maxMs]', () => {
    for (let s = 1; s < 500; s++) {
      const v = H.readingTime({
        headlineLen: 0, aboutLen: 0, experienceCount: 0,
        rand: H.mulberry32(s), minMs: 10 * SEC, maxMs: 30 * SEC,
      });
      expect(v).toBeGreaterThanOrEqual(10 * SEC);
      expect(v).toBeLessThanOrEqual(30 * SEC);
    }
  });

  it('deterministic per seed', () => {
    const cfg = { headlineLen: 50, aboutLen: 500, experienceCount: 3 };
    const a = H.readingTime({ ...cfg, rand: H.mulberry32(7) });
    const b = H.readingTime({ ...cfg, rand: H.mulberry32(7) });
    expect(a).toBe(b);
  });

  it('throws without rand', () => {
    expect(() => H.readingTime({})).toThrow(/rand must be/);
  });
});

describe('betweenVisits', () => {
  it('always within [minSec*SEC, maxSec*SEC]', () => {
    for (let s = 1; s < 500; s++) {
      const v = H.betweenVisits({
        meanSec: 60, minSec: 20, maxSec: 180, rand: H.mulberry32(s),
      });
      expect(v).toBeGreaterThanOrEqual(20 * SEC);
      expect(v).toBeLessThanOrEqual(180 * SEC);
    }
  });

  it('mean of samples is close to configured meanSec (within 30%)', () => {
    let sum = 0;
    const N = 5000;
    for (let s = 1; s <= N; s++) {
      sum += H.betweenVisits({
        meanSec: 90, minSec: 1, maxSec: 10 * 60, rand: H.mulberry32(s),
      });
    }
    const meanMs = sum / N;
    // Truncated exponential; empirical mean should be within 30% of 90s.
    expect(meanMs).toBeGreaterThan(60 * SEC);
    expect(meanMs).toBeLessThan(130 * SEC);
  });
});

describe('batchBreak', () => {
  it('within [minMin*MIN, maxMin*MIN]', () => {
    for (let s = 1; s < 500; s++) {
      const v = H.batchBreak({
        rand: H.mulberry32(s), medianMin: 25, minMin: 15, maxMin: 60,
      });
      expect(v).toBeGreaterThanOrEqual(15 * MIN);
      expect(v).toBeLessThanOrEqual(60 * MIN);
    }
  });
});

describe('scrollPlan — round trip', () => {
  it('descends to about page-height (85-100% target)', () => {
    const steps = H.scrollPlan({ pageHeight: 5000, rand: H.mulberry32(1) });
    // Sum only the DESCENT phase (before the first bottom dwell)
    // — that phase's forward deltas should exceed ~70% of pageHeight.
    const firstLongPause = steps.findIndex((s) => s.delta === 0 && s.ms >= 3000);
    const descentSteps = firstLongPause >= 0 ? steps.slice(0, firstLongPause) : steps;
    const forwardTotal = descentSteps
      .filter((s) => s.delta > 0)
      .reduce((a, s) => a + s.delta, 0);
    expect(forwardTotal).toBeGreaterThan(5000 * 0.7);
  });

  it('EVERY plan includes an explicit return-trip (net negative deltas after bottom dwell)', () => {
    for (let s = 1; s <= 50; s++) {
      const steps = H.scrollPlan({ pageHeight: 4000, rand: H.mulberry32(s) });
      // Find the bottom-dwell marker (first 0-delta with ms >= 3000)
      const bottomIdx = steps.findIndex((x) => x.delta === 0 && x.ms >= 3000);
      expect(bottomIdx).toBeGreaterThan(0);
      const afterBottom = steps.slice(bottomIdx + 1);
      const returnDelta = afterBottom.reduce((a, s2) => a + s2.delta, 0);
      // Post-bottom, net motion is UPward (negative)
      expect(returnDelta).toBeLessThan(-1000);
    }
  });

  it('return trip is faster than descent (bigger chunks, shorter times)', () => {
    // Sample many seeds — up-chunks should on average have larger
    // |delta| than down-chunks.
    let downMag = 0, upMag = 0, downN = 0, upN = 0;
    for (let s = 1; s <= 30; s++) {
      const steps = H.scrollPlan({ pageHeight: 5000, rand: H.mulberry32(s) });
      const bottomIdx = steps.findIndex((x) => x.delta === 0 && x.ms >= 3000);
      for (let i = 0; i < steps.length; i++) {
        if (steps[i].delta === 0) continue;
        if (i < bottomIdx && steps[i].delta > 0) { downMag += steps[i].delta; downN++; }
        if (i > bottomIdx && steps[i].delta < 0) { upMag += -steps[i].delta; upN++; }
      }
    }
    expect(upMag / upN).toBeGreaterThan(downMag / downN);
  });

  it('ends with a top-dwell (0 delta, 1-3s pause)', () => {
    for (let s = 1; s <= 20; s++) {
      const steps = H.scrollPlan({ pageHeight: 4000, rand: H.mulberry32(s) });
      const last = steps[steps.length - 1];
      expect(last.delta).toBe(0);
      expect(last.ms).toBeGreaterThanOrEqual(1000);
      expect(last.ms).toBeLessThanOrEqual(3000);
    }
  });

  it('descent contains occasional pauses (0-delta with short ms)', () => {
    let sawShortPause = false;
    for (let s = 1; s < 100 && !sawShortPause; s++) {
      const steps = H.scrollPlan({ pageHeight: 4000, rand: H.mulberry32(s) });
      const bottomIdx = steps.findIndex((x) => x.delta === 0 && x.ms >= 3000);
      const descent = steps.slice(0, bottomIdx);
      if (descent.some((x) => x.delta === 0 && x.ms > 0 && x.ms < 2000)) sawShortPause = true;
    }
    expect(sawShortPause).toBe(true);
  });

  it('respects maxSteps cap', () => {
    const steps = H.scrollPlan({ pageHeight: 999999, rand: H.mulberry32(1), maxSteps: 10 });
    expect(steps.length).toBeLessThanOrEqual(10);
  });

  it('deterministic per seed', () => {
    const a = H.scrollPlan({ pageHeight: 3000, rand: H.mulberry32(9) });
    const b = H.scrollPlan({ pageHeight: 3000, rand: H.mulberry32(9) });
    expect(a).toEqual(b);
  });

  it('throws on invalid pageHeight', () => {
    expect(() => H.scrollPlan({ pageHeight: 0, rand: H.mulberry32(1) })).toThrow(/pageHeight/);
    expect(() => H.scrollPlan({ pageHeight: -1, rand: H.mulberry32(1) })).toThrow(/pageHeight/);
  });
});

describe('isWithinWindow', () => {
  // 2026-07-02 in UTC, we'll set tzOffsetMin to make it "local time"
  // Base: 2026-07-02 12:00 UTC
  const noon = Date.UTC(2026, 6, 2, 12, 0, 0);

  it('inside standard 09:00-21:00 window', () => {
    expect(H.isWithinWindow({
      now: noon, windowStart: '09:00', windowEnd: '21:00', tzOffsetMin: 0,
    })).toBe(true);
  });

  it('outside 09:00-21:00 window at 03:00 UTC', () => {
    const threeAm = Date.UTC(2026, 6, 2, 3, 0, 0);
    expect(H.isWithinWindow({
      now: threeAm, windowStart: '09:00', windowEnd: '21:00', tzOffsetMin: 0,
    })).toBe(false);
  });

  it('respects timezone offset', () => {
    // At 03:00 UTC with +6:00 offset, local is 09:00 → inside window
    const threeAm = Date.UTC(2026, 6, 2, 3, 0, 0);
    expect(H.isWithinWindow({
      now: threeAm, windowStart: '09:00', windowEnd: '21:00', tzOffsetMin: 360,
    })).toBe(true);
  });

  it('midnight-crossing window 22:00-02:00', () => {
    const oneAm = Date.UTC(2026, 6, 2, 1, 0, 0);
    expect(H.isWithinWindow({
      now: oneAm, windowStart: '22:00', windowEnd: '02:00', tzOffsetMin: 0,
    })).toBe(true);
    const noonUtc = Date.UTC(2026, 6, 2, 12, 0, 0);
    expect(H.isWithinWindow({
      now: noonUtc, windowStart: '22:00', windowEnd: '02:00', tzOffsetMin: 0,
    })).toBe(false);
    const eleventhirty = Date.UTC(2026, 6, 2, 23, 30, 0);
    expect(H.isWithinWindow({
      now: eleventhirty, windowStart: '22:00', windowEnd: '02:00', tzOffsetMin: 0,
    })).toBe(true);
  });

  it('boundary: exactly at start is INSIDE, exactly at end is OUTSIDE', () => {
    const nineAm = Date.UTC(2026, 6, 2, 9, 0, 0);
    expect(H.isWithinWindow({
      now: nineAm, windowStart: '09:00', windowEnd: '21:00', tzOffsetMin: 0,
    })).toBe(true);
    const ninePm = Date.UTC(2026, 6, 2, 21, 0, 0);
    expect(H.isWithinWindow({
      now: ninePm, windowStart: '09:00', windowEnd: '21:00', tzOffsetMin: 0,
    })).toBe(false);
  });

  it('throws on malformed window string', () => {
    expect(() => H.isWithinWindow({
      now: noon, windowStart: 'bogus', windowEnd: '21:00',
    })).toThrow(/HH:MM/);
    expect(() => H.isWithinWindow({
      now: noon, windowStart: '25:00', windowEnd: '21:00',
    })).toThrow(/out of range/);
  });
});

describe('msUntilWindow', () => {
  it('returns 0 when currently inside window', () => {
    const noon = Date.UTC(2026, 6, 2, 12, 0, 0);
    expect(H.msUntilWindow({
      now: noon, windowStart: '09:00', windowEnd: '21:00',
    })).toBe(0);
  });

  it('returns positive delta to next open when outside', () => {
    // 05:00 UTC — 4 hours until 09:00
    const fiveAm = Date.UTC(2026, 6, 2, 5, 0, 0);
    const delta = H.msUntilWindow({
      now: fiveAm, windowStart: '09:00', windowEnd: '21:00',
    });
    expect(delta).toBe(4 * 60 * MIN);
  });

  it('wraps to next day when now is past end', () => {
    // 22:00 UTC — 11 hours until 09:00 next day
    const tenPm = Date.UTC(2026, 6, 2, 22, 0, 0);
    const delta = H.msUntilWindow({
      now: tenPm, windowStart: '09:00', windowEnd: '21:00',
    });
    expect(delta).toBe(11 * 60 * MIN);
  });
});

describe('shouldBreak', () => {
  it('true when visitsSinceBreak >= batchSize', () => {
    expect(H.shouldBreak({ visitsSinceBreak: 5, batchSize: 5 })).toBe(true);
    expect(H.shouldBreak({ visitsSinceBreak: 8, batchSize: 5 })).toBe(true);
  });
  it('false when visitsSinceBreak < batchSize', () => {
    expect(H.shouldBreak({ visitsSinceBreak: 0, batchSize: 5 })).toBe(false);
    expect(H.shouldBreak({ visitsSinceBreak: 4, batchSize: 5 })).toBe(false);
  });
  it('throws on invalid inputs', () => {
    expect(() => H.shouldBreak({ visitsSinceBreak: -1, batchSize: 5 })).toThrow();
    expect(() => H.shouldBreak({ visitsSinceBreak: 0, batchSize: 0 })).toThrow();
  });
});

describe('shouldFeedBreak', () => {
  it('never true below minInterval', () => {
    for (let s = 1; s < 50; s++) {
      expect(H.shouldFeedBreak({
        visitsSinceFeed: 3, rand: H.mulberry32(s), minInterval: 5, maxInterval: 12,
      })).toBe(false);
    }
  });
  it('always true at/above maxInterval', () => {
    for (let s = 1; s < 50; s++) {
      expect(H.shouldFeedBreak({
        visitsSinceFeed: 12, rand: H.mulberry32(s), minInterval: 5, maxInterval: 12,
      })).toBe(true);
      expect(H.shouldFeedBreak({
        visitsSinceFeed: 20, rand: H.mulberry32(s), minInterval: 5, maxInterval: 12,
      })).toBe(true);
    }
  });
  it('probability rises between min and max (some yes, some no)', () => {
    let yes = 0;
    for (let s = 1; s <= 200; s++) {
      if (H.shouldFeedBreak({
        visitsSinceFeed: 8, rand: H.mulberry32(s), minInterval: 5, maxInterval: 12,
      })) yes++;
    }
    // At 8/12 → ratio = 0.42 → expect ~40% but stochastic. Allow 20-70%.
    expect(yes).toBeGreaterThan(40);
    expect(yes).toBeLessThan(140);
  });
});

describe('warmupFactor', () => {
  it('returns 1.0 when warmupUntil is null', () => {
    expect(H.warmupFactor({ now: Date.UTC(2026, 6, 2), warmupUntil: null })).toBe(1.0);
  });
  it('returns 0.3 during warmup period', () => {
    const now = Date.UTC(2026, 6, 2);
    const later = now + 7 * 86_400_000;
    expect(H.warmupFactor({ now, warmupUntil: later })).toBe(0.3);
  });
  it('returns 1.0 after warmupUntil passes', () => {
    const now = Date.UTC(2026, 6, 10);
    const earlier = Date.UTC(2026, 6, 2);
    expect(H.warmupFactor({ now, warmupUntil: earlier })).toBe(1.0);
  });
});

describe('safetyZone', () => {
  it('🟢 safe below 33%', () => {
    const z = H.safetyZone({ todayVisited: 5, dailyCap: 30 });
    expect(z.zone).toBe('green');
    expect(z.emoji).toBe('🟢');
    expect(z.remaining).toBe(25);
  });
  it('🟡 moderate at 33-66%', () => {
    expect(H.safetyZone({ todayVisited: 15, dailyCap: 30 }).zone).toBe('yellow');
  });
  it('🟠 warning at 66-85%', () => {
    expect(H.safetyZone({ todayVisited: 22, dailyCap: 30 }).zone).toBe('orange');
  });
  it('🔴 at-limit 85-100%', () => {
    expect(H.safetyZone({ todayVisited: 27, dailyCap: 30 }).zone).toBe('red');
  });
  it('🛑 blocked at 100%+', () => {
    const z = H.safetyZone({ todayVisited: 30, dailyCap: 30 });
    expect(z.zone).toBe('blocked');
    expect(z.emoji).toBe('🛑');
    expect(z.remaining).toBe(0);
  });
  it('remaining never negative', () => {
    expect(H.safetyZone({ todayVisited: 100, dailyCap: 30 }).remaining).toBe(0);
  });
  it('throws on invalid inputs', () => {
    expect(() => H.safetyZone({ todayVisited: -1, dailyCap: 30 })).toThrow();
    expect(() => H.safetyZone({ todayVisited: 5, dailyCap: 0 })).toThrow();
  });
});
