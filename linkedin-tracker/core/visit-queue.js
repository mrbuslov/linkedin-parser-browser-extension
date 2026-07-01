// Visit Queue state machine — pure logic.
//
// The runner (visit-runner.js in the service worker) uses these
// functions to decide "what happens next" without touching Chrome
// APIs. Everything is a pure transition: input state + event → new
// state. The runner then acts on the new state (open a tab, wait, etc).
//
// This split is deliberate. Chrome APIs are hard to test; state
// transitions are easy. We test the entire queue lifecycle here with
// zero mocks — feed inputs, assert outputs.
//
// The queue lives at storage key `visitQueue` (see schema plan). One
// queue is active at a time. Completed queues are archived to
// `visitQueueHistory[]` (capped at 10 entries).

const STATUS = Object.freeze({
  QUEUED:  'queued',
  RUNNING: 'running',
  VISITED: 'visited',
  SKIPPED: 'skipped',
  FAILED:  'failed',
});

const QUEUE_STATUS = Object.freeze({
  IDLE:      'idle',
  RUNNING:   'running',
  PAUSED:    'paused',
  COMPLETED: 'completed',
});

const SKIP_REASON = Object.freeze({
  ALREADY_FIRST_DEGREE: 'already-1st-degree',
  RECENT_VISIT:         'recent-visit',
  DUPLICATE_IN_QUEUE:   'duplicate-in-queue',
  INVALID_URL:          'invalid-url',
});

const DAY_MS = 86_400_000;
const WARMUP_DAYS = 7;
const HISTORY_CAP = 10;
const MAX_QUEUE_SIZE = 500; // hard cap: guardrail against pasting 10k URLs

// LinkedIn profile URL — canonicalized to https://www.linkedin.com/in/{vanity}/
// Only accepts the /in/ path. No overlays, no query, no fragment.
const PROFILE_URL_RE = /^https?:\/\/(?:www\.)?linkedin\.com\/in\/([^/?#\s]+)/i;

function canonicalizeProfileUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = PROFILE_URL_RE.exec(trimmed);
  if (!m) return null;
  return `https://www.linkedin.com/in/${m[1]}/`;
}

// Parse a textarea blob into unique canonical profile URLs.
// Accepts one URL per line AND comma-separated on the same line.
// Returns { urls: [...], invalid: [rawLine, ...] } — nothing is silently
// dropped.
function parseUrlBlob(blob) {
  if (typeof blob !== 'string') {
    throw new TypeError(`parseUrlBlob: expected string, got ${typeof blob}`);
  }
  const urls = [];
  const invalid = [];
  const seen = new Set();
  for (const rawLine of blob.split(/[\r\n]+/)) {
    for (const raw of rawLine.split(',')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const canon = canonicalizeProfileUrl(trimmed);
      if (!canon) {
        invalid.push(trimmed);
        continue;
      }
      if (seen.has(canon)) continue;
      seen.add(canon);
      urls.push(canon);
    }
  }
  return { urls, invalid };
}

// Decide whether an item should be pre-skipped BEFORE the queue starts
// running. Returns skipReason or null.
function evaluatePreSkip({ url, contacts, settings, now }) {
  const rec = contacts && contacts[url];
  if (!rec) return null;
  if (settings.skipFirstDegree && rec.status === 'accepted') {
    return SKIP_REASON.ALREADY_FIRST_DEGREE;
  }
  if (settings.skipRecentDays > 0 && rec.visitedAt) {
    const ageDays = (now - rec.visitedAt) / DAY_MS;
    if (ageDays < settings.skipRecentDays) return SKIP_REASON.RECENT_VISIT;
  }
  return null;
}

// Build a fresh queue from user input. Runs full pre-skip evaluation
// on every URL, producing items in { url, status, skipReason } shape.
// Enforces MAX_QUEUE_SIZE. Returns the full visitQueue object ready to
// persist.
function buildQueue({ rawInput, contacts, settings, now, seed }) {
  const { urls, invalid } = parseUrlBlob(rawInput);
  if (urls.length > MAX_QUEUE_SIZE) {
    throw new RangeError(
      `buildQueue: ${urls.length} URLs exceeds max queue size ${MAX_QUEUE_SIZE}. `
      + `Split into multiple runs.`,
    );
  }
  const items = urls.map((url) => {
    const skipReason = evaluatePreSkip({ url, contacts, settings, now });
    return {
      url,
      status: skipReason ? STATUS.SKIPPED : STATUS.QUEUED,
      skipReason: skipReason || null,
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      error: null,
    };
  });
  const warmupUntil = settings.warmupDays > 0
    ? now + settings.warmupDays * DAY_MS
    : null;
  return {
    status: QUEUE_STATUS.IDLE,
    createdAt: now,
    seed,
    settings: {
      windowStart:     settings.windowStart,
      windowEnd:       settings.windowEnd,
      tzOffsetMin:     settings.tzOffsetMin,
      dailyCap:        settings.dailyCap,
      skipRecentDays:  settings.skipRecentDays,
      skipFirstDegree: settings.skipFirstDegree,
      batchSize:       settings.batchSize,
      betweenMeanSec:  settings.betweenMeanSec,
      warmupUntil,
    },
    items,
    stats: {
      dailyVisitedByDate: {},
      lastFeedBreakAt: null,
      lastBatchEndAt: null,
      visitsSinceBreak: 0,
      visitsSinceFeed: 0,
    },
    invalidInput: invalid,
  };
}

// UTC date bucket for the daily cap. Uses tzOffsetMin so a visit at
// 23:59 local counts against the local day, not UTC.
function _dateKey(now, tzOffsetMin = 0) {
  const local = new Date(now + tzOffsetMin * 60_000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
}

// Today's visited count, respecting timezone offset.
function todayVisited(queue, now) {
  if (!queue || !queue.stats) return 0;
  const key = _dateKey(now, queue.settings.tzOffsetMin);
  return queue.stats.dailyVisitedByDate[key] || 0;
}

// Effective daily cap accounting for warmup factor.
function effectiveDailyCap(queue, now, humanizer) {
  const factor = humanizer.warmupFactor({
    now, warmupUntil: queue.settings.warmupUntil,
  });
  return Math.max(1, Math.round(queue.settings.dailyCap * factor));
}

// Pick the next item to run. Returns index into queue.items, or -1 if
// nothing is runnable (either everything visited/skipped/failed, or
// daily cap reached, or window closed, or paused).
//
// Does NOT mutate. Callers decide what to do with the return value.
function nextRunnable({ queue, now, humanizer }) {
  if (queue.status !== QUEUE_STATUS.RUNNING) return -1;
  if (!humanizer.isWithinWindow({
    now,
    windowStart: queue.settings.windowStart,
    windowEnd:   queue.settings.windowEnd,
    tzOffsetMin: queue.settings.tzOffsetMin,
  })) return -1;
  if (todayVisited(queue, now) >= effectiveDailyCap(queue, now, humanizer)) return -1;
  for (let i = 0; i < queue.items.length; i++) {
    if (queue.items[i].status === STATUS.QUEUED) return i;
  }
  return -1;
}

function allTerminal(queue) {
  return queue.items.every((it) => (
    it.status === STATUS.VISITED
    || it.status === STATUS.SKIPPED
    || it.status === STATUS.FAILED
  ));
}

// Transition: mark item as running.
function markRunning(queue, itemIndex, now) {
  const items = queue.items.slice();
  items[itemIndex] = { ...items[itemIndex], status: STATUS.RUNNING, startedAt: now };
  return { ...queue, items };
}

// Transition: mark item as visited. Updates daily counter + break/feed
// counters.
function markVisited(queue, itemIndex, now) {
  const items = queue.items.slice();
  items[itemIndex] = { ...items[itemIndex], status: STATUS.VISITED, finishedAt: now };
  const key = _dateKey(now, queue.settings.tzOffsetMin);
  const dailyVisitedByDate = {
    ...queue.stats.dailyVisitedByDate,
    [key]: (queue.stats.dailyVisitedByDate[key] || 0) + 1,
  };
  const stats = {
    ...queue.stats,
    dailyVisitedByDate,
    visitsSinceBreak: queue.stats.visitsSinceBreak + 1,
    visitsSinceFeed:  queue.stats.visitsSinceFeed  + 1,
  };
  const next = { ...queue, items, stats };
  if (allTerminal(next)) next.status = QUEUE_STATUS.COMPLETED;
  return next;
}

// Transition: mark item as failed with error string.
function markFailed(queue, itemIndex, now, error) {
  const items = queue.items.slice();
  items[itemIndex] = {
    ...items[itemIndex], status: STATUS.FAILED, finishedAt: now, error,
  };
  const next = { ...queue, items };
  if (allTerminal(next)) next.status = QUEUE_STATUS.COMPLETED;
  return next;
}

// Transition: batch break taken. Resets visitsSinceBreak.
function recordBatchBreak(queue, now) {
  return {
    ...queue,
    stats: {
      ...queue.stats,
      visitsSinceBreak: 0,
      lastBatchEndAt: now,
    },
  };
}

// Transition: feed break taken. Resets visitsSinceFeed.
function recordFeedBreak(queue, now) {
  return {
    ...queue,
    stats: {
      ...queue.stats,
      visitsSinceFeed: 0,
      lastFeedBreakAt: now,
    },
  };
}

function start(queue) {
  if (queue.status !== QUEUE_STATUS.IDLE && queue.status !== QUEUE_STATUS.PAUSED) {
    throw new Error(`start: cannot start queue in status ${queue.status}`);
  }
  return { ...queue, status: QUEUE_STATUS.RUNNING };
}

function pause(queue) {
  if (queue.status !== QUEUE_STATUS.RUNNING) {
    throw new Error(`pause: cannot pause queue in status ${queue.status}`);
  }
  return { ...queue, status: QUEUE_STATUS.PAUSED };
}

function cancel(queue, now) {
  // Cancel is a terminal action. Mark any queued/running items as
  // skipped with reason 'canceled', flip queue to completed.
  const items = queue.items.map((it) => {
    if (it.status === STATUS.QUEUED || it.status === STATUS.RUNNING) {
      return { ...it, status: STATUS.SKIPPED, skipReason: 'canceled', finishedAt: now };
    }
    return it;
  });
  return { ...queue, items, status: QUEUE_STATUS.COMPLETED };
}

// Archive a completed queue into visitQueueHistory[]. Keeps last
// HISTORY_CAP entries. Called by the runner when transitioning to
// completed.
function archiveToHistory(historyArr, completedQueue, now) {
  const summary = {
    createdAt:    completedQueue.createdAt,
    completedAt:  now,
    itemCount:    completedQueue.items.length,
    visitedCount: completedQueue.items.filter((i) => i.status === STATUS.VISITED).length,
    skippedCount: completedQueue.items.filter((i) => i.status === STATUS.SKIPPED).length,
    failedCount:  completedQueue.items.filter((i) => i.status === STATUS.FAILED).length,
  };
  const next = [summary, ...(historyArr || [])];
  return next.slice(0, HISTORY_CAP);
}

// Dry-run preview: what will happen if we start this queue.
// Returns { totalItems, willVisit, alreadySkipped: {reason:count},
// estimatedMinutes, breakdownByDate }.
function dryRunPreview({ queue, now, humanizer }) {
  const skipCounts = {};
  let willVisit = 0;
  for (const it of queue.items) {
    if (it.status === STATUS.SKIPPED) {
      skipCounts[it.skipReason] = (skipCounts[it.skipReason] || 0) + 1;
    } else if (it.status === STATUS.QUEUED) {
      willVisit++;
    }
  }
  // Rough time estimate: mean betweenVisits + mean readingTime, ×
  // willVisit, plus batchBreaks. Very approximate — real time depends
  // on RNG and window boundaries.
  const perVisitMs = (queue.settings.betweenMeanSec * 1000) + 60_000;
  const batches = Math.ceil(willVisit / queue.settings.batchSize);
  const breaks = Math.max(0, batches - 1);
  const breakMs = breaks * 25 * 60_000;
  const totalMs = willVisit * perVisitMs + breakMs;
  // Simulate day-by-day fill against effective daily cap.
  const perDayCap = effectiveDailyCap(queue, now, humanizer);
  const days = Math.ceil(willVisit / perDayCap);
  return {
    totalItems: queue.items.length,
    willVisit,
    alreadySkipped: skipCounts,
    estimatedMinutes: Math.round(totalMs / 60_000),
    daysNeeded: days,
    perDayCap,
    warmupActive: humanizer.warmupFactor({ now, warmupUntil: queue.settings.warmupUntil }) < 1.0,
  };
}

const LITVisitQueue = {
  STATUS,
  QUEUE_STATUS,
  SKIP_REASON,
  WARMUP_DAYS,
  HISTORY_CAP,
  MAX_QUEUE_SIZE,
  canonicalizeProfileUrl,
  parseUrlBlob,
  evaluatePreSkip,
  buildQueue,
  todayVisited,
  effectiveDailyCap,
  nextRunnable,
  allTerminal,
  markRunning,
  markVisited,
  markFailed,
  recordBatchBreak,
  recordFeedBreak,
  start,
  pause,
  cancel,
  archiveToHistory,
  dryRunPreview,
};
if (typeof globalThis !== 'undefined') globalThis.LITVisitQueue = LITVisitQueue;
if (typeof module !== 'undefined' && module.exports) module.exports = LITVisitQueue;
