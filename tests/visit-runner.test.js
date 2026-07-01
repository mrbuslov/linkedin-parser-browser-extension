import { describe, it, expect } from 'vitest';
const R = require('../linkedin-tracker/core/visit-runner.js');
const H = require('../linkedin-tracker/core/humanizer.js');
const Q = require('../linkedin-tracker/core/visit-queue.js');

const NOW = Date.UTC(2026, 6, 2, 12, 0, 0);
const DAY = 86_400_000;
const deps = { humanizer: H, visitQueue: Q };

const BASE_SETTINGS = {
  windowStart: '00:00', windowEnd: '23:59', tzOffsetMin: 0,
  dailyCap: 30, skipRecentDays: 30, skipFirstDegree: true,
  batchSize: 3, betweenMeanSec: 60, warmupDays: 0,
};

function buildState({ urls = ['a', 'b', 'c'], contacts = {}, settings = BASE_SETTINGS, seed = 42 } = {}) {
  const rawInput = urls.map((v) => `https://linkedin.com/in/${v}`).join('\n');
  const queue = Q.buildQueue({ rawInput, contacts, settings, now: NOW, seed });
  return { queue: Q.start(queue) };
}

function findAction(actions, type) {
  return actions.find((a) => a.type === type);
}

describe('plan — TICK starts next visit', () => {
  it('opens contact-info overlay URL, not plain profile URL', () => {
    const state = buildState({ urls: ['alice'] });
    const { newState, actions } = R.plan(state, { type: 'TICK', now: NOW + 1000 }, deps);
    const update = findAction(actions, 'UPDATE_TAB');
    expect(update).toBeDefined();
    expect(update.url).toBe('https://www.linkedin.com/in/alice/overlay/contact-info/');
    expect(newState.queue.items[0].status).toBe('running');
  });

  it('schedules safety-net tick past CAPTURE_TIMEOUT', () => {
    const state = buildState({ urls: ['alice'] });
    const { actions } = R.plan(state, { type: 'TICK', now: NOW + 1000 }, deps);
    const sched = findAction(actions, 'SCHEDULE_TICK');
    expect(sched.delayMs).toBeGreaterThan(R.CAPTURE_TIMEOUT_MS);
  });

  it('does not double-start when a visit is already running', () => {
    let state = buildState({ urls: ['a', 'b'] });
    // First tick: starts item 0
    state = R.plan(state, { type: 'TICK', now: NOW }, deps).newState;
    // Second tick BEFORE CAPTURE_DONE: should NOT UPDATE_TAB again
    const { actions } = R.plan(state, { type: 'TICK', now: NOW + 5000 }, deps);
    expect(findAction(actions, 'UPDATE_TAB')).toBeUndefined();
    // Should log waiting + schedule another check
    expect(findAction(actions, 'SCHEDULE_TICK')).toBeDefined();
  });

  it('times out a hung visit past CAPTURE_TIMEOUT_MS', () => {
    let state = buildState({ urls: ['a', 'b'] });
    state = R.plan(state, { type: 'TICK', now: NOW }, deps).newState;
    // Simulate a very late tick — CAPTURE_TIMEOUT_MS + 1s past start
    const { newState } = R.plan(state, { type: 'TICK', now: NOW + R.CAPTURE_TIMEOUT_MS + 1000 }, deps);
    expect(newState.queue.items[0].status).toBe('failed');
    expect(newState.queue.items[0].error).toBe('timeout');
  });
});

describe('plan — CAPTURE_DONE flow', () => {
  it('marks visited, persists, schedules next tick', () => {
    let state = buildState({ urls: ['a', 'b'] });
    state = R.plan(state, { type: 'TICK', now: NOW }, deps).newState;
    const done = R.plan(state, { type: 'CAPTURE_DONE', now: NOW + 30_000 }, deps);
    expect(done.newState.queue.items[0].status).toBe('visited');
    expect(findAction(done.actions, 'PERSIST')).toBeDefined();
    expect(findAction(done.actions, 'SCHEDULE_TICK')).toBeDefined();
    expect(findAction(done.actions, 'CLOSE_TAB')).toBeUndefined(); // more items pending
  });

  it('when last item completes → CLOSE_TAB + ARCHIVE + NOTIFY_USER', () => {
    let state = buildState({ urls: ['a'] });
    state = R.plan(state, { type: 'TICK', now: NOW }, deps).newState;
    const done = R.plan(state, { type: 'CAPTURE_DONE', now: NOW + 30_000 }, deps);
    expect(done.newState.queue.status).toBe('completed');
    expect(findAction(done.actions, 'CLOSE_TAB')).toBeDefined();
    expect(findAction(done.actions, 'ARCHIVE')).toBeDefined();
    expect(findAction(done.actions, 'NOTIFY_USER')).toBeDefined();
  });

  it('after batchSize visits → takes batch break', () => {
    // batchSize=3, do 3 CAPTURE_DONEs, verify third schedules a >10min delay
    let state = buildState({ urls: ['a', 'b', 'c', 'd'], settings: { ...BASE_SETTINGS, batchSize: 3 } });
    for (let i = 0; i < 2; i++) {
      state = R.plan(state, { type: 'TICK', now: NOW + i * 60_000 }, deps).newState;
      state = R.plan(state, { type: 'CAPTURE_DONE', now: NOW + i * 60_000 + 30_000 }, deps).newState;
    }
    // 3rd visit
    state = R.plan(state, { type: 'TICK', now: NOW + 3 * 60_000 }, deps).newState;
    const done = R.plan(state, { type: 'CAPTURE_DONE', now: NOW + 3 * 60_000 + 30_000 }, deps);
    const sched = findAction(done.actions, 'SCHEDULE_TICK');
    // Batch break delay is at least 10 min
    expect(sched.delayMs).toBeGreaterThan(10 * 60_000);
    // Batch break stamp recorded
    expect(done.newState.queue.stats.visitsSinceBreak).toBe(0);
  });

  it('CAPTURE_DONE with mismatched URL is silently dropped (late signal guard)', () => {
    let state = buildState({ urls: ['a', 'b'] });
    state = R.plan(state, { type: 'TICK', now: NOW }, deps).newState;
    const running = state.queue.items[0];
    // Simulate a stale CAPTURE_DONE from a previous item that arrives late
    const late = R.plan(state, {
      type: 'CAPTURE_DONE', now: NOW + 30_000,
      url: 'https://www.linkedin.com/in/someone-else/',
    }, deps);
    // Running item NOT marked visited
    expect(late.newState.queue.items[0].status).toBe('running');
    expect(running.status).toBe('running');
  });

  it('CAPTURE_DONE with matching URL marks item visited', () => {
    let state = buildState({ urls: ['a', 'b'] });
    state = R.plan(state, { type: 'TICK', now: NOW }, deps).newState;
    const runningUrl = state.queue.items[0].url;
    const done = R.plan(state, {
      type: 'CAPTURE_DONE', now: NOW + 30_000, url: runningUrl,
    }, deps);
    expect(done.newState.queue.items[0].status).toBe('visited');
  });

  it('late CAPTURE_DONE when queue paused is ignored', () => {
    let state = buildState({ urls: ['a'] });
    state = R.plan(state, { type: 'TICK', now: NOW }, deps).newState;
    state = R.plan(state, { type: 'PAUSE', now: NOW + 100 }, deps).newState;
    const late = R.plan(state, { type: 'CAPTURE_DONE', now: NOW + 5000 }, deps);
    expect(late.newState.queue.status).toBe('paused');
    // Item stays running because we're paused
    expect(late.newState.queue.items[0].status).toBe('running');
  });
});

describe('plan — CAPTURE_FAILED flow', () => {
  it('marks failed and continues to next item', () => {
    let state = buildState({ urls: ['a', 'b'] });
    state = R.plan(state, { type: 'TICK', now: NOW }, deps).newState;
    const failed = R.plan(state, {
      type: 'CAPTURE_FAILED', now: NOW + 5000, reason: 'modal-not-found',
    }, deps);
    expect(failed.newState.queue.items[0].status).toBe('failed');
    expect(failed.newState.queue.items[0].error).toBe('modal-not-found');
    expect(findAction(failed.actions, 'SCHEDULE_TICK').delayMs).toBe(10_000);
  });

  it('failed as last item completes the queue', () => {
    let state = buildState({ urls: ['a'] });
    state = R.plan(state, { type: 'TICK', now: NOW }, deps).newState;
    const failed = R.plan(state, {
      type: 'CAPTURE_FAILED', now: NOW + 5000, reason: 'timeout',
    }, deps);
    expect(failed.newState.queue.status).toBe('completed');
    expect(findAction(failed.actions, 'CLOSE_TAB')).toBeDefined();
  });
});

describe('plan — PAUSE / RESUME / CANCEL controls', () => {
  it('PAUSE closes tab + persists, sets queue paused', () => {
    const state = buildState();
    const p = R.plan(state, { type: 'PAUSE' }, deps);
    expect(p.newState.queue.status).toBe('paused');
    expect(findAction(p.actions, 'CLOSE_TAB')).toBeDefined();
    expect(findAction(p.actions, 'PERSIST')).toBeDefined();
  });

  it('RESUME schedules a tick, flips back to running', () => {
    let state = buildState();
    state = R.plan(state, { type: 'PAUSE' }, deps).newState;
    const r = R.plan(state, { type: 'RESUME' }, deps);
    expect(r.newState.queue.status).toBe('running');
    expect(findAction(r.actions, 'SCHEDULE_TICK')).toBeDefined();
  });

  it('CANCEL closes tab, archives, marks remaining as skipped', () => {
    const state = buildState({ urls: ['a', 'b'] });
    const c = R.plan(state, { type: 'CANCEL', now: NOW + 1000 }, deps);
    expect(c.newState.queue.status).toBe('completed');
    expect(c.newState.queue.items[0].skipReason).toBe('canceled');
    expect(findAction(c.actions, 'ARCHIVE')).toBeDefined();
    expect(findAction(c.actions, 'CLOSE_TAB')).toBeDefined();
  });

  it('PAUSE on already-paused queue is a no-op (no CLOSE_TAB / PERSIST)', () => {
    let state = buildState();
    state = R.plan(state, { type: 'PAUSE' }, deps).newState;
    const p2 = R.plan(state, { type: 'PAUSE' }, deps);
    expect(p2.newState.queue.status).toBe('paused');
    // Doesn't repeat CLOSE_TAB
    expect(findAction(p2.actions, 'CLOSE_TAB')).toBeUndefined();
  });
});

describe('plan — HEALTH_ALARM', () => {
  it('pauses queue, notifies user, closes tab', () => {
    const state = buildState();
    const h = R.plan(state, {
      type: 'HEALTH_ALARM', signal: '/checkpoint/challenge',
    }, deps);
    expect(h.newState.queue.status).toBe('paused');
    expect(findAction(h.actions, 'CLOSE_TAB')).toBeDefined();
    expect(findAction(h.actions, 'NOTIFY_USER')).toBeDefined();
    expect(findAction(h.actions, 'NOTIFY_USER').body).toMatch(/checkpoint/);
    // Long sleep before retry
    expect(findAction(h.actions, 'SCHEDULE_TICK').delayMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  it('HEALTH_ALARM on paused queue is no-op', () => {
    let state = buildState();
    state = R.plan(state, { type: 'PAUSE' }, deps).newState;
    const h = R.plan(state, { type: 'HEALTH_ALARM', signal: 'x' }, deps);
    expect(findAction(h.actions, 'NOTIFY_USER')).toBeUndefined();
  });
});

describe('plan — IDLE_DETECTED', () => {
  it('defers next tick by IDLE_PAUSE_MS, keeps queue running', () => {
    const state = buildState();
    const i = R.plan(state, { type: 'IDLE_DETECTED', now: NOW }, deps);
    expect(i.newState.queue.status).toBe('running');
    const sched = findAction(i.actions, 'SCHEDULE_TICK');
    expect(sched.delayMs).toBe(R.IDLE_PAUSE_MS);
  });
});

describe('plan — window boundary', () => {
  it('outside window → schedules tick until window reopens, no UPDATE_TAB', () => {
    const settings = { ...BASE_SETTINGS, windowStart: '09:00', windowEnd: '21:00' };
    const state = buildState({ settings });
    const threeAm = Date.UTC(2026, 6, 2, 3, 0, 0);
    const { actions } = R.plan(state, { type: 'TICK', now: threeAm }, deps);
    expect(findAction(actions, 'UPDATE_TAB')).toBeUndefined();
    const sched = findAction(actions, 'SCHEDULE_TICK');
    // Should sleep ~6h until 09:00
    expect(sched.delayMs).toBeGreaterThan(5 * 60 * 60 * 1000);
    expect(sched.delayMs).toBeLessThan(7 * 60 * 60 * 1000);
  });
});

describe('plan — daily cap boundary', () => {
  it('cap reached → schedules 1h retry, no UPDATE_TAB', () => {
    const state = buildState({ settings: { ...BASE_SETTINGS, dailyCap: 2 }, urls: ['a', 'b', 'c'] });
    // Manually inflate today's count
    state.queue.stats.dailyVisitedByDate = { '2026-07-02': 2 };
    const { actions } = R.plan(state, { type: 'TICK', now: NOW }, deps);
    expect(findAction(actions, 'UPDATE_TAB')).toBeUndefined();
    expect(findAction(actions, 'SCHEDULE_TICK').delayMs).toBe(60 * 60 * 1000);
  });
});

describe('plan — deterministic replay', () => {
  it('same seed + same event sequence → identical actions', () => {
    const s1 = buildState({ urls: ['a', 'b', 'c'], seed: 999 });
    const s2 = buildState({ urls: ['a', 'b', 'c'], seed: 999 });
    const events = [
      { type: 'TICK', now: NOW },
      { type: 'CAPTURE_DONE', now: NOW + 30_000 },
      { type: 'TICK', now: NOW + 90_000 },
      { type: 'CAPTURE_DONE', now: NOW + 120_000 },
    ];
    let ns1 = s1, ns2 = s2;
    const acts1 = [], acts2 = [];
    for (const ev of events) {
      const r1 = R.plan(ns1, ev, deps); ns1 = r1.newState; acts1.push(r1.actions);
      const r2 = R.plan(ns2, ev, deps); ns2 = r2.newState; acts2.push(r2.actions);
    }
    expect(acts1).toEqual(acts2);
    expect(ns1.queue.items).toEqual(ns2.queue.items);
  });
});
