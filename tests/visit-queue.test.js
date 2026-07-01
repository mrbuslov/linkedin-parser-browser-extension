import { describe, it, expect } from 'vitest';
const Q = require('../linkedin-tracker/core/visit-queue.js');
const H = require('../linkedin-tracker/core/humanizer.js');

const NOW = Date.UTC(2026, 6, 2, 12, 0, 0); // 2026-07-02 12:00 UTC
const DAY = 86_400_000;

const DEFAULT_SETTINGS = {
  windowStart: '00:00',       // tests use 00:00-23:59 by default so no window gating
  windowEnd:   '23:59',
  tzOffsetMin: 0,
  dailyCap: 30,
  skipRecentDays: 30,
  skipFirstDegree: true,
  batchSize: 5,
  betweenMeanSec: 90,
  warmupDays: 0,              // disable warmup by default
};

describe('canonicalizeProfileUrl', () => {
  it('canonicalizes http/https, www prefix, trailing slash, trailing junk', () => {
    expect(Q.canonicalizeProfileUrl('https://www.linkedin.com/in/alice/'))
      .toBe('https://www.linkedin.com/in/alice/');
    expect(Q.canonicalizeProfileUrl('http://linkedin.com/in/alice'))
      .toBe('https://www.linkedin.com/in/alice/');
    expect(Q.canonicalizeProfileUrl('  https://www.linkedin.com/in/alice/details/ '))
      .toBe('https://www.linkedin.com/in/alice/');
    expect(Q.canonicalizeProfileUrl('https://www.linkedin.com/in/alice?trk=foo'))
      .toBe('https://www.linkedin.com/in/alice/');
  });

  it('preserves non-ASCII vanities', () => {
    expect(Q.canonicalizeProfileUrl('https://www.linkedin.com/in/дмитрий-буслов'))
      .toBe('https://www.linkedin.com/in/дмитрий-буслов/');
  });

  it('rejects non-profile URLs', () => {
    expect(Q.canonicalizeProfileUrl('https://www.linkedin.com/company/foo/')).toBeNull();
    expect(Q.canonicalizeProfileUrl('https://www.linkedin.com/feed/')).toBeNull();
    expect(Q.canonicalizeProfileUrl('https://google.com/in/alice/')).toBeNull();
    expect(Q.canonicalizeProfileUrl('')).toBeNull();
    expect(Q.canonicalizeProfileUrl(null)).toBeNull();
    expect(Q.canonicalizeProfileUrl(undefined)).toBeNull();
  });
});

describe('parseUrlBlob', () => {
  it('one URL per line', () => {
    const blob = 'https://linkedin.com/in/a\nhttps://linkedin.com/in/b\nhttps://linkedin.com/in/c';
    const r = Q.parseUrlBlob(blob);
    expect(r.urls).toEqual([
      'https://www.linkedin.com/in/a/',
      'https://www.linkedin.com/in/b/',
      'https://www.linkedin.com/in/c/',
    ]);
    expect(r.invalid).toEqual([]);
  });

  it('comma-separated on one line', () => {
    const blob = 'https://linkedin.com/in/a, https://linkedin.com/in/b, https://linkedin.com/in/c';
    const r = Q.parseUrlBlob(blob);
    expect(r.urls).toHaveLength(3);
  });

  it('mixed newlines and commas', () => {
    const blob = 'https://linkedin.com/in/a,https://linkedin.com/in/b\nhttps://linkedin.com/in/c';
    const r = Q.parseUrlBlob(blob);
    expect(r.urls).toHaveLength(3);
  });

  it('deduplicates within the blob', () => {
    const blob = 'https://linkedin.com/in/a\nhttps://www.linkedin.com/in/a\nhttps://linkedin.com/in/a/';
    const r = Q.parseUrlBlob(blob);
    expect(r.urls).toHaveLength(1);
  });

  it('collects invalid entries — no silent drop', () => {
    const blob = 'https://linkedin.com/in/a\ngarbage\nhttps://google.com';
    const r = Q.parseUrlBlob(blob);
    expect(r.urls).toEqual(['https://www.linkedin.com/in/a/']);
    expect(r.invalid).toEqual(['garbage', 'https://google.com']);
  });

  it('throws on non-string input', () => {
    expect(() => Q.parseUrlBlob(null)).toThrow(/string/);
  });
});

describe('evaluatePreSkip', () => {
  const url = 'https://www.linkedin.com/in/a/';
  it('skip if already 1st degree and toggle enabled', () => {
    const contacts = { [url]: { status: 'accepted' } };
    expect(Q.evaluatePreSkip({ url, contacts, settings: DEFAULT_SETTINGS, now: NOW }))
      .toBe(Q.SKIP_REASON.ALREADY_FIRST_DEGREE);
  });

  it('do NOT skip 1st degree when toggle disabled', () => {
    const contacts = { [url]: { status: 'accepted' } };
    const settings = { ...DEFAULT_SETTINGS, skipFirstDegree: false };
    expect(Q.evaluatePreSkip({ url, contacts, settings, now: NOW })).toBeNull();
  });

  it('skip if visitedAt is within skipRecentDays', () => {
    const contacts = { [url]: { status: 'visited', visitedAt: NOW - 10 * DAY } };
    expect(Q.evaluatePreSkip({ url, contacts, settings: DEFAULT_SETTINGS, now: NOW }))
      .toBe(Q.SKIP_REASON.RECENT_VISIT);
  });

  it('do NOT skip stale visits', () => {
    const contacts = { [url]: { status: 'visited', visitedAt: NOW - 40 * DAY } };
    expect(Q.evaluatePreSkip({ url, contacts, settings: DEFAULT_SETTINGS, now: NOW }))
      .toBeNull();
  });

  it('null when no existing record', () => {
    expect(Q.evaluatePreSkip({ url, contacts: {}, settings: DEFAULT_SETTINGS, now: NOW })).toBeNull();
  });

  it('pending record does NOT get skipped by 1st-degree filter', () => {
    const contacts = { [url]: { status: 'pending' } };
    expect(Q.evaluatePreSkip({ url, contacts, settings: DEFAULT_SETTINGS, now: NOW }))
      .toBeNull();
  });
});

describe('buildQueue', () => {
  it('builds a fresh queue with per-item pre-skip evaluated', () => {
    const rawInput = [
      'https://linkedin.com/in/alice',
      'https://linkedin.com/in/bob',
      'https://linkedin.com/in/carol',
    ].join('\n');
    const contacts = {
      'https://www.linkedin.com/in/alice/':  { status: 'accepted' },
      'https://www.linkedin.com/in/carol/':  { status: 'visited', visitedAt: NOW - 5 * DAY },
    };
    const queue = Q.buildQueue({
      rawInput, contacts, settings: DEFAULT_SETTINGS, now: NOW, seed: 42,
    });
    expect(queue.status).toBe('idle');
    expect(queue.seed).toBe(42);
    expect(queue.items).toHaveLength(3);
    expect(queue.items[0]).toMatchObject({ status: 'skipped', skipReason: 'already-1st-degree' });
    expect(queue.items[1]).toMatchObject({ status: 'queued' });
    expect(queue.items[2]).toMatchObject({ status: 'skipped', skipReason: 'recent-visit' });
  });

  it('stores warmupUntil when settings.warmupDays > 0', () => {
    const q = Q.buildQueue({
      rawInput: 'https://linkedin.com/in/a',
      contacts: {},
      settings: { ...DEFAULT_SETTINGS, warmupDays: 7 },
      now: NOW,
      seed: 1,
    });
    expect(q.settings.warmupUntil).toBe(NOW + 7 * DAY);
  });

  it('warmupUntil is null when warmupDays=0', () => {
    const q = Q.buildQueue({
      rawInput: 'https://linkedin.com/in/a',
      contacts: {},
      settings: DEFAULT_SETTINGS,
      now: NOW,
      seed: 1,
    });
    expect(q.settings.warmupUntil).toBeNull();
  });

  it('collects invalidInput', () => {
    const q = Q.buildQueue({
      rawInput: 'https://linkedin.com/in/a\nbogus',
      contacts: {},
      settings: DEFAULT_SETTINGS,
      now: NOW,
      seed: 1,
    });
    expect(q.invalidInput).toEqual(['bogus']);
  });

  it('throws when exceeding MAX_QUEUE_SIZE', () => {
    const rawInput = Array.from({ length: Q.MAX_QUEUE_SIZE + 1 },
      (_, i) => `https://linkedin.com/in/user${i}`).join('\n');
    expect(() => Q.buildQueue({
      rawInput, contacts: {}, settings: DEFAULT_SETTINGS, now: NOW, seed: 1,
    })).toThrow(/exceeds max queue size/);
  });
});

describe('nextRunnable', () => {
  function q(items, overrides = {}) {
    return {
      status: 'running',
      settings: DEFAULT_SETTINGS,
      stats: { dailyVisitedByDate: {}, visitsSinceBreak: 0, visitsSinceFeed: 0 },
      items,
      ...overrides,
    };
  }

  it('returns first queued index', () => {
    const queue = q([
      { status: 'skipped' },
      { status: 'visited' },
      { status: 'queued', url: 'a' },
      { status: 'queued', url: 'b' },
    ]);
    expect(Q.nextRunnable({ queue, now: NOW, humanizer: H })).toBe(2);
  });

  it('returns -1 when queue is paused', () => {
    const queue = q([{ status: 'queued' }], { status: 'paused' });
    expect(Q.nextRunnable({ queue, now: NOW, humanizer: H })).toBe(-1);
  });

  it('returns -1 when outside time window', () => {
    const queue = q([{ status: 'queued' }], {
      settings: { ...DEFAULT_SETTINGS, windowStart: '09:00', windowEnd: '18:00' },
    });
    const threeAM = Date.UTC(2026, 6, 2, 3, 0, 0);
    expect(Q.nextRunnable({ queue, now: threeAM, humanizer: H })).toBe(-1);
  });

  it('returns -1 when daily cap reached', () => {
    const queue = q([{ status: 'queued' }], {
      stats: {
        dailyVisitedByDate: { '2026-07-02': 30 },
        visitsSinceBreak: 5, visitsSinceFeed: 3,
      },
    });
    expect(Q.nextRunnable({ queue, now: NOW, humanizer: H })).toBe(-1);
  });

  it('returns -1 when nothing queued', () => {
    const queue = q([{ status: 'visited' }, { status: 'skipped' }]);
    expect(Q.nextRunnable({ queue, now: NOW, humanizer: H })).toBe(-1);
  });
});

describe('effectiveDailyCap with warmup', () => {
  it('caps at 30% during warmup', () => {
    const queue = {
      settings: { ...DEFAULT_SETTINGS, dailyCap: 30, warmupUntil: NOW + 3 * DAY },
    };
    expect(Q.effectiveDailyCap(queue, NOW, H)).toBe(9); // 30 * 0.3 = 9
  });
  it('full cap after warmup expires', () => {
    const queue = {
      settings: { ...DEFAULT_SETTINGS, dailyCap: 30, warmupUntil: NOW - DAY },
    };
    expect(Q.effectiveDailyCap(queue, NOW, H)).toBe(30);
  });
  it('minimum 1 even if configured cap is very low with warmup', () => {
    const queue = {
      settings: { ...DEFAULT_SETTINGS, dailyCap: 1, warmupUntil: NOW + DAY },
    };
    expect(Q.effectiveDailyCap(queue, NOW, H)).toBeGreaterThanOrEqual(1);
  });
});

describe('state transitions', () => {
  const items = [
    { url: 'a', status: 'queued', queuedAt: NOW, skipReason: null, error: null, startedAt: null, finishedAt: null },
    { url: 'b', status: 'queued', queuedAt: NOW, skipReason: null, error: null, startedAt: null, finishedAt: null },
  ];
  function fresh() {
    return {
      status: 'running',
      settings: DEFAULT_SETTINGS,
      stats: { dailyVisitedByDate: {}, visitsSinceBreak: 0, visitsSinceFeed: 0, lastBatchEndAt: null, lastFeedBreakAt: null },
      items: items.map((i) => ({ ...i })),
    };
  }

  it('markRunning stamps startedAt', () => {
    const next = Q.markRunning(fresh(), 0, NOW + 1000);
    expect(next.items[0].status).toBe('running');
    expect(next.items[0].startedAt).toBe(NOW + 1000);
    // Immutability check
    expect(fresh().items[0].status).toBe('queued');
  });

  it('markVisited increments daily counter and visits-since counters', () => {
    let q = fresh();
    q = Q.markVisited(q, 0, NOW);
    expect(q.items[0].status).toBe('visited');
    expect(q.stats.dailyVisitedByDate['2026-07-02']).toBe(1);
    expect(q.stats.visitsSinceBreak).toBe(1);
    expect(q.stats.visitsSinceFeed).toBe(1);
  });

  it('markVisited flips queue to completed when all items terminal', () => {
    let q = fresh();
    q = Q.markVisited(q, 0, NOW);
    expect(q.status).toBe('running');
    q = Q.markVisited(q, 1, NOW);
    expect(q.status).toBe('completed');
  });

  it('markFailed stamps error', () => {
    const q = Q.markFailed(fresh(), 0, NOW, 'timeout');
    expect(q.items[0].status).toBe('failed');
    expect(q.items[0].error).toBe('timeout');
  });

  it('recordBatchBreak resets visitsSinceBreak, stamps lastBatchEndAt', () => {
    let q = fresh();
    q = Q.markVisited(q, 0, NOW);
    q = Q.recordBatchBreak(q, NOW + 1000);
    expect(q.stats.visitsSinceBreak).toBe(0);
    expect(q.stats.lastBatchEndAt).toBe(NOW + 1000);
    expect(q.stats.visitsSinceFeed).toBe(1); // untouched
  });

  it('recordFeedBreak resets visitsSinceFeed, stamps lastFeedBreakAt', () => {
    let q = fresh();
    q = Q.markVisited(q, 0, NOW);
    q = Q.recordFeedBreak(q, NOW + 500);
    expect(q.stats.visitsSinceFeed).toBe(0);
    expect(q.stats.lastFeedBreakAt).toBe(NOW + 500);
    expect(q.stats.visitsSinceBreak).toBe(1); // untouched
  });

  it('start requires idle or paused status', () => {
    const q = { status: 'running', items: [], stats: {} };
    expect(() => Q.start(q)).toThrow(/cannot start/);
  });

  it('pause requires running status', () => {
    const q = { status: 'idle', items: [], stats: {} };
    expect(() => Q.pause(q)).toThrow(/cannot pause/);
  });

  it('cancel marks all queued/running as skipped, sets completed', () => {
    let q = fresh();
    q = Q.markRunning(q, 0, NOW);
    q = Q.cancel(q, NOW + 1000);
    expect(q.status).toBe('completed');
    expect(q.items[0].status).toBe('skipped');
    expect(q.items[0].skipReason).toBe('canceled');
    expect(q.items[1].status).toBe('skipped');
    expect(q.items[1].skipReason).toBe('canceled');
  });
});

describe('archiveToHistory', () => {
  it('prepends completed queue summary, caps at HISTORY_CAP', () => {
    const completed = {
      createdAt: NOW - 3600_000,
      items: [
        { status: 'visited' }, { status: 'visited' }, { status: 'visited' },
        { status: 'skipped', skipReason: 'recent-visit' },
        { status: 'failed', error: 'timeout' },
      ],
    };
    const history = Q.archiveToHistory([], completed, NOW);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
      createdAt: NOW - 3600_000,
      completedAt: NOW,
      itemCount: 5,
      visitedCount: 3,
      skippedCount: 1,
      failedCount: 1,
    });
  });

  it('caps history at HISTORY_CAP entries', () => {
    let history = [];
    for (let i = 0; i < Q.HISTORY_CAP + 5; i++) {
      history = Q.archiveToHistory(history, { createdAt: i, items: [] }, i + 1);
    }
    expect(history).toHaveLength(Q.HISTORY_CAP);
    // Most recent first
    expect(history[0].createdAt).toBe(Q.HISTORY_CAP + 4);
  });
});

describe('todayVisited across timezone boundary', () => {
  it('counts by local date, not UTC', () => {
    // 23:30 UTC in tz +180 (Kyiv summer) = 02:30 local next day
    const queue = {
      settings: { ...DEFAULT_SETTINGS, tzOffsetMin: 180 },
      stats: { dailyVisitedByDate: { '2026-07-03': 5 } },
    };
    const utcLate = Date.UTC(2026, 6, 2, 23, 30, 0);
    expect(Q.todayVisited(queue, utcLate)).toBe(5);
  });
});

describe('dryRunPreview', () => {
  it('reports willVisit, alreadySkipped by reason, days', () => {
    const q = Q.buildQueue({
      rawInput: [
        'https://linkedin.com/in/a',
        'https://linkedin.com/in/b',
        'https://linkedin.com/in/c',
        'https://linkedin.com/in/d',
      ].join('\n'),
      contacts: {
        'https://www.linkedin.com/in/a/': { status: 'accepted' },
        'https://www.linkedin.com/in/b/': { status: 'visited', visitedAt: NOW - 5 * DAY },
      },
      settings: DEFAULT_SETTINGS, now: NOW, seed: 1,
    });
    const preview = Q.dryRunPreview({ queue: q, now: NOW, humanizer: H });
    expect(preview.totalItems).toBe(4);
    expect(preview.willVisit).toBe(2);
    expect(preview.alreadySkipped).toEqual({
      'already-1st-degree': 1,
      'recent-visit': 1,
    });
    expect(preview.daysNeeded).toBeGreaterThanOrEqual(1);
    expect(preview.perDayCap).toBe(30);
    expect(preview.warmupActive).toBe(false);
  });

  it('reports warmupActive=true when warmup ongoing', () => {
    const q = Q.buildQueue({
      rawInput: 'https://linkedin.com/in/a',
      contacts: {},
      settings: { ...DEFAULT_SETTINGS, warmupDays: 7 },
      now: NOW, seed: 1,
    });
    const preview = Q.dryRunPreview({ queue: q, now: NOW, humanizer: H });
    expect(preview.warmupActive).toBe(true);
    expect(preview.perDayCap).toBe(9); // 30 * 0.3
  });
});
