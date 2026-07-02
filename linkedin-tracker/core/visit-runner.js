// Visit Runner — pure event planner.
//
// The service-worker glue (in visit-runner-sw.js, written separately)
// is a tiny controller that:
//   1) Listens for events (chrome.alarms tick, tab onUpdated, popup
//      button presses, content-script CAPTURE_DONE messages)
//   2) For each event: calls `plan(state, event, deps)` to get the
//      NEW state + a list of ACTIONS to perform
//   3) Applies each action to the real chrome API (open tab, update
//      tab, close tab, schedule alarm, persist storage, notify)
//
// The plan() function is 100% pure. All chrome API side effects are
// expressed as declarative actions. This split is deliberate:
//   - We can test the ENTIRE runner logic here with zero mocks
//   - The SW glue is a trivial switch on action.type — trivial to review
//   - Deterministic replay from a seed + event log = exact reproducer
//     for post-mortem debugging of a queue that misbehaved
//
// The `deps` argument bundles:
//   - humanizer (LITHumanizer)
//   - visitQueue (LITVisitQueue)
//
// Wrapped in IIFE — see visit-queue.js header for the rationale.

(function () {

const EVENT = Object.freeze({
  TICK:           'TICK',
  CAPTURE_DONE:   'CAPTURE_DONE',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  PAUSE:          'PAUSE',
  RESUME:         'RESUME',
  CANCEL:         'CANCEL',
  HEALTH_ALARM:   'HEALTH_ALARM',
  IDLE_DETECTED:  'IDLE_DETECTED',
});

const ACTION = Object.freeze({
  OPEN_TAB:       'OPEN_TAB',
  UPDATE_TAB:     'UPDATE_TAB',
  CLOSE_TAB:      'CLOSE_TAB',
  SCHEDULE_TICK:  'SCHEDULE_TICK',
  PERSIST:        'PERSIST',
  NOTIFY_USER:    'NOTIFY_USER',
  ARCHIVE:        'ARCHIVE',
  LOG:            'LOG',
});

const CAPTURE_TIMEOUT_MS = 45_000; // fallback if content script never signals
const IDLE_PAUSE_MS = 5 * 60 * 1000; // 5 min after user activity detected
const HEALTH_PAUSE_MS = 60 * 60 * 1000; // 1h forced pause on checkpoint

// deriveRand — spawn a per-event PRNG from the queue seed + a counter
// so successive events produce fresh randomness while remaining
// deterministic given (seed, eventCount).
function deriveRand(seed, offset, humanizer) {
  return humanizer.mulberry32((seed >>> 0) ^ (offset * 0x9E3779B9));
}

// Guard: apply pause/cancel unconditionally. Everything else routes
// through per-status handlers below.
function _handleControl(state, event, deps) {
  if (event.type === EVENT.PAUSE && state.queue.status === 'running') {
    return {
      newState: { ...state, queue: { ...state.queue, status: 'paused' } },
      actions: [
        { type: ACTION.CLOSE_TAB },
        { type: ACTION.PERSIST },
        { type: ACTION.LOG, message: 'queue paused' },
      ],
    };
  }
  if (event.type === EVENT.RESUME && state.queue.status === 'paused') {
    return {
      newState: { ...state, queue: { ...state.queue, status: 'running' } },
      actions: [
        { type: ACTION.SCHEDULE_TICK, delayMs: 1000 },
        { type: ACTION.PERSIST },
        { type: ACTION.LOG, message: 'queue resumed' },
      ],
    };
  }
  if (event.type === EVENT.CANCEL) {
    const canceled = deps.visitQueue.cancel(state.queue, event.now);
    return {
      newState: { ...state, queue: canceled },
      actions: [
        { type: ACTION.CLOSE_TAB },
        { type: ACTION.ARCHIVE, queue: canceled },
        { type: ACTION.PERSIST },
        { type: ACTION.LOG, message: 'queue canceled by user' },
      ],
    };
  }
  return null; // no control-event match; caller runs main logic
}

function _handleHealth(state, event) {
  if (event.type !== EVENT.HEALTH_ALARM) return null;
  if (state.queue.status !== 'running') return null;
  const paused = { ...state.queue, status: 'paused' };
  return {
    newState: { ...state, queue: paused },
    actions: [
      { type: ACTION.CLOSE_TAB },
      { type: ACTION.NOTIFY_USER,
        title: 'LinkedIn requested verification',
        body: `Detected ${event.signal}. Queue paused. Open LinkedIn manually, complete the check, then resume from popup.` },
      { type: ACTION.SCHEDULE_TICK, delayMs: HEALTH_PAUSE_MS },
      { type: ACTION.PERSIST },
      { type: ACTION.LOG, message: `health-signal pause: ${event.signal}` },
    ],
  };
}

function _handleIdle(state, event) {
  if (event.type !== EVENT.IDLE_DETECTED) return null;
  if (state.queue.status !== 'running') return null;
  // Not a full pause — just delay next tick. Preserves queue running
  // status so it auto-resumes.
  return {
    newState: state,
    actions: [
      { type: ACTION.SCHEDULE_TICK, delayMs: IDLE_PAUSE_MS },
      { type: ACTION.LOG, message: 'user activity detected; delaying next visit 5 min' },
    ],
  };
}

// Handle CAPTURE_DONE: the content-script signaled "profile parsed +
// modal parsed + dwell finished". Mark visited, decide what's next.
function _handleCaptureDone(state, event, deps) {
  const { humanizer, visitQueue } = deps;
  if (state.queue.status !== 'running') {
    // Late signal from a paused/canceled queue — ignore.
    return { newState: state, actions: [{ type: ACTION.LOG, message: 'CAPTURE_DONE ignored (queue not running)' }] };
  }
  const runningIdx = state.queue.items.findIndex((i) => i.status === 'running');
  if (runningIdx === -1) {
    return { newState: state, actions: [{ type: ACTION.LOG, message: 'CAPTURE_DONE with no running item' }] };
  }
  // Late-signal guard: if a URL was included and it doesn't match the
  // currently running item, silently drop it — a previous visit's
  // content script fired after we already advanced.
  if (event.url && event.url !== state.queue.items[runningIdx].url) {
    return {
      newState: state,
      actions: [{ type: ACTION.LOG, message: `CAPTURE_DONE URL mismatch (got ${event.url}, running ${state.queue.items[runningIdx].url}); ignored` }],
    };
  }
  let q = visitQueue.markVisited(state.queue, runningIdx, event.now);
  const actions = [{ type: ACTION.PERSIST }];

  if (q.status === 'completed') {
    actions.push({ type: ACTION.CLOSE_TAB });
    actions.push({ type: ACTION.ARCHIVE, queue: q });
    actions.push({ type: ACTION.NOTIFY_USER,
      title: 'Bulk visit queue completed',
      body: `${q.items.filter((i) => i.status === 'visited').length} profiles visited, `
          + `${q.items.filter((i) => i.status === 'skipped').length} skipped.` });
    return { newState: { ...state, queue: q }, actions };
  }

  // Decide next scheduling: batch break, feed break, or normal pause
  const rand = deriveRand(q.seed, q.stats.visitsSinceBreak + q.stats.visitsSinceFeed, humanizer);
  let nextDelayMs;
  let reason = 'between';
  if (humanizer.shouldBreak({
    visitsSinceBreak: q.stats.visitsSinceBreak, batchSize: q.settings.batchSize,
  })) {
    nextDelayMs = humanizer.batchBreak({ rand });
    q = visitQueue.recordBatchBreak(q, event.now + nextDelayMs);
    reason = 'batch-break';
  } else if (humanizer.shouldFeedBreak({
    visitsSinceFeed: q.stats.visitsSinceFeed, rand,
  })) {
    // Real feed break: navigate visit tab to /feed/ so it briefly
    // shows in the browser history — a genuine social signal LinkedIn's
    // ML model expects on a normal-activity account.
    nextDelayMs = 30_000 + Math.round(rand() * 20_000); // 30-50s dwell on feed
    q = visitQueue.recordFeedBreak(q, event.now + nextDelayMs);
    reason = 'feed-break';
    actions.push({ type: ACTION.UPDATE_TAB, url: 'https://www.linkedin.com/feed/', itemIndex: -1 });
  } else {
    nextDelayMs = humanizer.betweenVisits({
      meanSec: q.settings.betweenMeanSec, minSec: 30, maxSec: 300, rand,
    });
  }
  actions.push({ type: ACTION.SCHEDULE_TICK, delayMs: nextDelayMs });
  actions.push({ type: ACTION.LOG, message: `visit ${runningIdx} done; next in ${Math.round(nextDelayMs / 1000)}s (${reason})` });
  return { newState: { ...state, queue: q }, actions };
}

function _handleCaptureFailed(state, event, deps) {
  const { visitQueue } = deps;
  if (state.queue.status !== 'running') {
    return { newState: state, actions: [] };
  }
  const runningIdx = state.queue.items.findIndex((i) => i.status === 'running');
  if (runningIdx === -1) return { newState: state, actions: [] };
  const q = visitQueue.markFailed(state.queue, runningIdx, event.now, event.reason || 'unknown');
  const actions = [
    { type: ACTION.PERSIST },
    { type: ACTION.LOG, message: `visit ${runningIdx} failed: ${event.reason}` },
  ];
  if (q.status === 'completed') {
    actions.push({ type: ACTION.CLOSE_TAB });
    actions.push({ type: ACTION.ARCHIVE, queue: q });
  } else {
    // Short pause then try next
    actions.push({ type: ACTION.SCHEDULE_TICK, delayMs: 10_000 });
  }
  return { newState: { ...state, queue: q }, actions };
}

// Handle TICK: decide whether to start next visit or wait.
function _handleTick(state, event, deps) {
  const { humanizer, visitQueue } = deps;
  if (state.queue.status !== 'running') {
    return { newState: state, actions: [] };
  }
  // A visit currently in-flight? If so, check for timeout.
  const runningIdx = state.queue.items.findIndex((i) => i.status === 'running');
  if (runningIdx !== -1) {
    const running = state.queue.items[runningIdx];
    if (running.startedAt && event.now - running.startedAt > CAPTURE_TIMEOUT_MS) {
      // Timeout — treat as failed, don't block queue forever
      return _handleCaptureFailed(state, { type: EVENT.CAPTURE_FAILED, now: event.now, reason: 'timeout' }, deps);
    }
    return {
      newState: state,
      actions: [{ type: ACTION.SCHEDULE_TICK, delayMs: 5000 },
                { type: ACTION.LOG, message: `awaiting CAPTURE_DONE for item ${runningIdx}` }],
    };
  }

  const idx = visitQueue.nextRunnable({ queue: state.queue, now: event.now, humanizer });
  if (idx === -1) {
    // Nothing runnable now — figure out WHY and schedule wake-up
    const outsideWindow = !humanizer.isWithinWindow({
      now: event.now,
      windowStart: state.queue.settings.windowStart,
      windowEnd:   state.queue.settings.windowEnd,
      tzOffsetMin: state.queue.settings.tzOffsetMin,
    });
    if (outsideWindow) {
      const wait = humanizer.msUntilWindow({
        now: event.now,
        windowStart: state.queue.settings.windowStart,
        windowEnd:   state.queue.settings.windowEnd,
        tzOffsetMin: state.queue.settings.tzOffsetMin,
      });
      return {
        newState: state,
        actions: [
          { type: ACTION.SCHEDULE_TICK, delayMs: wait },
          { type: ACTION.LOG, message: `outside window; sleeping ${Math.round(wait / 60_000)}min until reopens` },
        ],
      };
    }
    const capHit = visitQueue.todayVisited(state.queue, event.now)
                 >= visitQueue.effectiveDailyCap(state.queue, event.now, humanizer);
    if (capHit) {
      // Sleep 1h and re-check (simple approach; runner can be smarter)
      return {
        newState: state,
        actions: [
          { type: ACTION.SCHEDULE_TICK, delayMs: 60 * 60 * 1000 },
          { type: ACTION.LOG, message: 'daily cap reached; sleeping 1h' },
        ],
      };
    }
    // Nothing queued left — queue should already be completed
    return { newState: state, actions: [{ type: ACTION.LOG, message: 'nothing runnable and not completed — unusual' }] };
  }

  // Start next visit
  const item = state.queue.items[idx];
  const overlayUrl = item.url + 'overlay/contact-info/';
  const nextQueue = visitQueue.markRunning(state.queue, idx, event.now);
  return {
    newState: { ...state, queue: nextQueue },
    actions: [
      { type: ACTION.UPDATE_TAB, url: overlayUrl, itemIndex: idx },
      { type: ACTION.SCHEDULE_TICK, delayMs: CAPTURE_TIMEOUT_MS + 5000 }, // safety net
      { type: ACTION.PERSIST },
      { type: ACTION.LOG, message: `starting visit ${idx}: ${item.url}` },
    ],
  };
}

// Master planner. Returns { newState, actions }.
function plan(state, event, deps) {
  if (!state || !state.queue) {
    throw new Error('plan: state must include queue');
  }
  if (!deps || !deps.humanizer || !deps.visitQueue) {
    throw new Error('plan: deps must include humanizer + visitQueue');
  }
  const control = _handleControl(state, event, deps);
  if (control) return control;
  const health = _handleHealth(state, event);
  if (health) return health;
  const idle = _handleIdle(state, event);
  if (idle) return idle;
  switch (event.type) {
    case EVENT.CAPTURE_DONE:   return _handleCaptureDone(state, event, deps);
    case EVENT.CAPTURE_FAILED: return _handleCaptureFailed(state, event, deps);
    case EVENT.TICK:           return _handleTick(state, event, deps);
    default: return { newState: state, actions: [{ type: ACTION.LOG, message: `plan: unknown event ${event.type}` }] };
  }
}

const LITVisitRunner = {
  EVENT,
  ACTION,
  CAPTURE_TIMEOUT_MS,
  IDLE_PAUSE_MS,
  HEALTH_PAUSE_MS,
  plan,
  deriveRand,
};
if (typeof globalThis !== 'undefined') globalThis.LITVisitRunner = LITVisitRunner;
if (typeof module !== 'undefined' && module.exports) module.exports = LITVisitRunner;

})();
