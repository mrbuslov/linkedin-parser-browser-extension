import { describe, it, expect } from 'vitest';
const Q = require('../linkedin-tracker/core/visit-queue.js');
const H = require('../linkedin-tracker/core/humanizer.js');

// End-to-end simulation of a Bulk Visit Queue lifecycle. NO Chrome
// APIs — we drive the state machine directly, using seeded humanizer
// to make timing decisions. This catches "state machine + humanizer
// integration bugs" that unit tests miss: e.g., batch break isn't
// taken when it should be, or feed break resets the wrong counter.
//
// The runner (visit-runner.js in service worker) will follow this
// exact loop pattern — building it here first lets us shake out the
// logic before touching real tabs.

const NOW = Date.UTC(2026, 6, 2, 12, 0, 0);
const DAY = 86_400_000;

function baseSettings(overrides = {}) {
  return {
    windowStart: '00:00', // no window gating in most tests
    windowEnd:   '23:59',
    tzOffsetMin: 0,
    dailyCap: 30,
    skipRecentDays: 30,
    skipFirstDegree: true,
    batchSize: 3,
    betweenMeanSec: 60,
    warmupDays: 0,
    ...overrides,
  };
}

// Simulate the runner loop against the in-memory state machine.
// `simClock` advances by the humanizer's returned delays. Returns
// { finalQueue, events } where events is an ordered log of visits/
// breaks. NO real chrome.tabs — we pretend every visit succeeds.
function simulate({ queue, settings, seed, maxIters = 200 }) {
  const rand = H.mulberry32(seed);
  const events = [];
  let clock = queue.createdAt;
  let q = Q.start(queue);
  let iters = 0;

  while (q.status === 'running' && iters++ < maxIters) {
    const idx = Q.nextRunnable({ queue: q, now: clock, humanizer: H });
    if (idx === -1) {
      // Nothing runnable now. If items are still queued, we hit a
      // constraint — advance clock past it and try again.
      const anyQueued = q.items.some((i) => i.status === 'queued');
      if (!anyQueued) break;
      // Constraint could be: outside window OR daily cap OR nothing.
      // For sim purposes: jump to next window open OR next UTC day.
      const nextWindow = H.msUntilWindow({
        now: clock, windowStart: settings.windowStart,
        windowEnd: settings.windowEnd, tzOffsetMin: settings.tzOffsetMin,
      });
      const capReached = Q.todayVisited(q, clock) >= Q.effectiveDailyCap(q, clock, H);
      if (capReached) {
        // Jump to next midnight local
        const local = new Date(clock + settings.tzOffsetMin * 60_000);
        const nextMidnight = Date.UTC(
          local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1
        ) - settings.tzOffsetMin * 60_000;
        clock = nextMidnight;
        events.push({ type: 'day_boundary', at: clock });
      } else if (nextWindow > 0) {
        clock += nextWindow;
        events.push({ type: 'window_wait', at: clock });
      } else {
        break;
      }
      continue;
    }

    // Between-visit pause
    const pause = H.betweenVisits({
      meanSec: settings.betweenMeanSec, minSec: 30, maxSec: 300, rand,
    });
    clock += pause;
    q = Q.markRunning(q, idx, clock);
    events.push({ type: 'visit_start', url: q.items[idx].url, at: clock });

    // Reading dwell (fake profile size)
    const dwell = H.readingTime({
      headlineLen: 60, aboutLen: 800, experienceCount: 4, rand,
    });
    clock += dwell;
    q = Q.markVisited(q, idx, clock);
    events.push({ type: 'visit_done', url: q.items[idx].url, at: clock });

    // Batch break?
    if (Q.STATUS && H.shouldBreak({
      visitsSinceBreak: q.stats.visitsSinceBreak, batchSize: settings.batchSize,
    })) {
      const breakMs = H.batchBreak({ rand, medianMin: 20, minMin: 10, maxMin: 45 });
      clock += breakMs;
      q = Q.recordBatchBreak(q, clock);
      events.push({ type: 'batch_break', at: clock, durationMs: breakMs });
    }

    // Feed break?
    if (H.shouldFeedBreak({
      visitsSinceFeed: q.stats.visitsSinceFeed, rand, minInterval: 5, maxInterval: 10,
    })) {
      clock += 30_000; // 30s feed browse
      q = Q.recordFeedBreak(q, clock);
      events.push({ type: 'feed_break', at: clock });
    }
  }

  return { finalQueue: q, events, endClock: clock };
}

describe('integration: full queue lifecycle', () => {
  it('4-item queue with no skips completes cleanly', () => {
    const rawInput = ['a', 'b', 'c', 'd'].map((v) =>
      `https://linkedin.com/in/${v}`).join('\n');
    const settings = baseSettings();
    const queue = Q.buildQueue({
      rawInput, contacts: {}, settings, now: NOW, seed: 100,
    });
    const { finalQueue, events } = simulate({ queue, settings, seed: 100 });
    expect(finalQueue.status).toBe('completed');
    expect(finalQueue.items.every((i) => i.status === 'visited')).toBe(true);
    expect(events.filter((e) => e.type === 'visit_done')).toHaveLength(4);
  });

  it('daily cap boundary — 5 items with cap=2, spans multiple days', () => {
    const rawInput = ['a', 'b', 'c', 'd', 'e'].map((v) =>
      `https://linkedin.com/in/${v}`).join('\n');
    const settings = baseSettings({ dailyCap: 2, batchSize: 10 });
    const queue = Q.buildQueue({
      rawInput, contacts: {}, settings, now: NOW, seed: 200,
    });
    const { finalQueue, events } = simulate({ queue, settings, seed: 200 });
    expect(finalQueue.status).toBe('completed');
    expect(finalQueue.items.every((i) => i.status === 'visited')).toBe(true);
    // Should have crossed at least 2 day boundaries (ceil(5/2)=3 days)
    const dayBoundaries = events.filter((e) => e.type === 'day_boundary');
    expect(dayBoundaries.length).toBeGreaterThanOrEqual(2);
  });

  it('window boundary — queue pauses at end of window and resumes next day', () => {
    // Narrow 30-min window; 20 items with mean ~2.4min each cannot
    // fit in one window → forces at least one window_wait event.
    const start = Date.UTC(2026, 6, 2, 9, 10, 0); // 10 min into window
    const rawInput = Array.from({ length: 20 }, (_, i) =>
      `https://linkedin.com/in/user${i}`).join('\n');
    const settings = baseSettings({
      windowStart: '09:00', windowEnd: '09:30',
      dailyCap: 50, batchSize: 100, betweenMeanSec: 60,
    });
    const queue = Q.buildQueue({
      rawInput, contacts: {}, settings, now: start, seed: 300,
    });
    const { finalQueue, events } = simulate({ queue, settings, seed: 300, maxIters: 300 });
    expect(finalQueue.status).toBe('completed');
    // Must have had at least one window_wait event OR day_boundary
    const gaps = events.filter((e) => e.type === 'window_wait' || e.type === 'day_boundary');
    expect(gaps.length).toBeGreaterThan(0);
  });

  it('all pre-skipped items → queue completes immediately', () => {
    const rawInput = ['a', 'b'].map((v) =>
      `https://linkedin.com/in/${v}`).join('\n');
    const contacts = {
      'https://www.linkedin.com/in/a/': { status: 'accepted' },
      'https://www.linkedin.com/in/b/': { status: 'accepted' },
    };
    const settings = baseSettings();
    const queue = Q.buildQueue({
      rawInput, contacts, settings, now: NOW, seed: 400,
    });
    // Every item is already skipped at build time
    expect(queue.items.every((i) => i.status === 'skipped')).toBe(true);
    // Simulator sees no queued items, exits quickly
    const { finalQueue } = simulate({ queue, settings, seed: 400 });
    // Note: buildQueue sets status='idle' — start() flips to 'running'.
    // If no items runnable and none queued, loop breaks with status still running.
    // In real runner, allTerminal() check on start would trigger COMPLETED —
    // but here we're testing raw state machine, so we accept 'running' as
    // "correctly noticed nothing to do".
    expect(['running', 'completed']).toContain(finalQueue.status);
    expect(finalQueue.items.every((i) => i.status === 'skipped')).toBe(true);
  });

  it('batch break kicks in after batchSize visits', () => {
    const rawInput = Array.from({ length: 8 }, (_, i) =>
      `https://linkedin.com/in/user${i}`).join('\n');
    const settings = baseSettings({ batchSize: 3 });
    const queue = Q.buildQueue({
      rawInput, contacts: {}, settings, now: NOW, seed: 500,
    });
    const { events } = simulate({ queue, settings, seed: 500 });
    const breaks = events.filter((e) => e.type === 'batch_break');
    // 8 items with batchSize=3 → break after 3, after 6. Feed break may
    // cause resets so at least one batch break expected.
    expect(breaks.length).toBeGreaterThanOrEqual(1);
    // Break durations within configured min/max
    for (const b of breaks) {
      expect(b.durationMs).toBeGreaterThanOrEqual(10 * 60_000);
      expect(b.durationMs).toBeLessThanOrEqual(45 * 60_000);
    }
  });

  it('warmup mode — first 7 days uses reduced cap', () => {
    const rawInput = Array.from({ length: 20 }, (_, i) =>
      `https://linkedin.com/in/warmuser${i}`).join('\n');
    const settings = baseSettings({
      dailyCap: 30, warmupDays: 7, batchSize: 100, betweenMeanSec: 30,
    });
    const queue = Q.buildQueue({
      rawInput, contacts: {}, settings, now: NOW, seed: 600,
    });
    const { events } = simulate({ queue, settings, seed: 600, maxIters: 500 });
    // With warmup: cap = 30 * 0.3 = 9/day. 20 items → at least 2 day boundaries.
    const dayBoundaries = events.filter((e) => e.type === 'day_boundary');
    expect(dayBoundaries.length).toBeGreaterThanOrEqual(2);
  });

  it('cancel mid-flight marks unfinished items as skipped/canceled', () => {
    const rawInput = ['a', 'b', 'c'].map((v) =>
      `https://linkedin.com/in/${v}`).join('\n');
    const settings = baseSettings();
    let queue = Q.buildQueue({
      rawInput, contacts: {}, settings, now: NOW, seed: 700,
    });
    queue = Q.start(queue);
    queue = Q.markRunning(queue, 0, NOW + 1000);
    queue = Q.markVisited(queue, 0, NOW + 60_000);
    // Cancel with items b and c still queued
    queue = Q.cancel(queue, NOW + 61_000);
    expect(queue.status).toBe('completed');
    expect(queue.items[0].status).toBe('visited');
    expect(queue.items[1].status).toBe('skipped');
    expect(queue.items[1].skipReason).toBe('canceled');
    expect(queue.items[2].status).toBe('skipped');
    expect(queue.items[2].skipReason).toBe('canceled');
  });

  it('failed items still count toward completion', () => {
    const rawInput = ['a', 'b'].map((v) =>
      `https://linkedin.com/in/${v}`).join('\n');
    const settings = baseSettings();
    let queue = Q.buildQueue({
      rawInput, contacts: {}, settings, now: NOW, seed: 800,
    });
    queue = Q.start(queue);
    queue = Q.markRunning(queue, 0, NOW + 1000);
    queue = Q.markFailed(queue, 0, NOW + 5000, 'timeout');
    queue = Q.markRunning(queue, 1, NOW + 60_000);
    queue = Q.markVisited(queue, 1, NOW + 120_000);
    expect(queue.status).toBe('completed');
    expect(queue.items[0].status).toBe('failed');
    expect(queue.items[1].status).toBe('visited');
  });

  it('archived history summary is accurate', () => {
    const rawInput = ['a', 'b', 'c'].map((v) =>
      `https://linkedin.com/in/${v}`).join('\n');
    const contacts = {
      'https://www.linkedin.com/in/a/': { status: 'accepted' }, // pre-skipped
    };
    const settings = baseSettings();
    let queue = Q.buildQueue({
      rawInput, contacts, settings, now: NOW, seed: 900,
    });
    const { finalQueue } = simulate({ queue, settings, seed: 900 });
    const history = Q.archiveToHistory([], finalQueue, NOW + 3600_000);
    expect(history[0].itemCount).toBe(3);
    expect(history[0].visitedCount).toBe(2); // b and c
    expect(history[0].skippedCount).toBe(1); // a
    expect(history[0].failedCount).toBe(0);
  });

  it('deterministic replay: same seed → same event sequence', () => {
    const rawInput = ['a', 'b', 'c', 'd', 'e'].map((v) =>
      `https://linkedin.com/in/${v}`).join('\n');
    const settings = baseSettings();
    const q1 = Q.buildQueue({
      rawInput, contacts: {}, settings, now: NOW, seed: 42,
    });
    const q2 = Q.buildQueue({
      rawInput, contacts: {}, settings, now: NOW, seed: 42,
    });
    const r1 = simulate({ queue: q1, settings, seed: 42 });
    const r2 = simulate({ queue: q2, settings, seed: 42 });
    expect(r1.events).toEqual(r2.events);
    expect(r1.endClock).toBe(r2.endClock);
  });
});
