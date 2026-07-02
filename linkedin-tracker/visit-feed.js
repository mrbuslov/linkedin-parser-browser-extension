// Runs on /feed/ pages. Two jobs:
//   1) During a running bulk-visit queue's feed break — perform a
//      light humanized scroll so the feed session looks like real
//      browsing (a couple of impressions on visible posts).
//   2) Inject the same floating Cancel widget the visit tabs get, so
//      the user can stop the queue from any LinkedIn tab, not just
//      the popup.
//
// Dormant otherwise — normal /feed/ browsing by the user is untouched.

(async function visitFeedMain() {
  const { visitQueue } = await dbGet('visitQueue');
  if (!visitQueue || visitQueue.status !== 'running') return;

  // Inject the floating widget (idempotent — guards against re-run on
  // SPA navigation)
  injectVisitWidget(visitQueue);

  // Do a light scroll — 2-3 slow scrollBy calls to look like scanning
  // the feed.
  const rand = LITHumanizer.mulberry32(
    (visitQueue.seed >>> 0) ^ (visitQueue.stats.visitsSinceFeed * 0xB7E15163),
  );
  const steps = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < steps; i++) {
    await sleep(3000 + Math.round(rand() * 4000)); // 3-7s pause
    if (!(await isQueueStillRunning())) return;
    window.scrollBy({ top: 300 + Math.round(rand() * 400), behavior: 'auto' });
  }
})();

function injectVisitWidget(visitQueue) {
  if (document.getElementById('lit-visit-widget')) return;
  const widget = document.createElement('div');
  widget.id = 'lit-visit-widget';
  widget.style.cssText = [
    'position:fixed', 'top:80px', 'right:16px', 'z-index:2147483647',
    'background:#0a66c2', 'color:#fff', 'font-family:-apple-system,sans-serif',
    'font-size:13px', 'padding:10px 12px', 'border-radius:8px',
    'box-shadow:0 4px 12px rgba(0,0,0,0.2)', 'min-width:220px',
    'display:flex', 'flex-direction:column', 'gap:8px',
  ].join(';');

  const visited = visitQueue.items.filter((i) => i.status === 'visited').length;
  const total = visitQueue.items.length;
  const remaining = total - visited;

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700;font-size:12px';
  title.textContent = `🤖 Bulk visit running`;
  widget.appendChild(title);

  const progress = document.createElement('div');
  progress.style.cssText = 'font-size:11px;opacity:0.9';
  progress.textContent = `Progress: ${visited} / ${total} · ${remaining} left`;
  widget.appendChild(progress);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px';

  const pauseBtn = document.createElement('button');
  pauseBtn.textContent = 'Pause';
  pauseBtn.style.cssText = _widgetBtnStyle('#fff', '#0a66c2');
  pauseBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'VISIT_QUEUE_PAUSE' }).catch(() => {});
    widget.remove();
  });
  btnRow.appendChild(pauseBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel queue';
  cancelBtn.style.cssText = _widgetBtnStyle('#d02b1e', '#fff');
  cancelBtn.addEventListener('click', () => {
    if (!confirm('Cancel the queue? Remaining items will be marked as skipped.')) return;
    chrome.runtime.sendMessage({ type: 'VISIT_QUEUE_CANCEL' }).catch(() => {});
    widget.remove();
  });
  btnRow.appendChild(cancelBtn);

  widget.appendChild(btnRow);
  document.body.appendChild(widget);
}

function _widgetBtnStyle(bg, fg) {
  return [
    `background:${bg}`, `color:${fg}`, 'border:none', 'border-radius:5px',
    'padding:6px 10px', 'cursor:pointer', 'font-size:11px', 'font-weight:600',
    'flex:1',
  ].join(';');
}

async function isQueueStillRunning() {
  const { visitQueue } = await dbGet('visitQueue');
  return visitQueue && visitQueue.status === 'running';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
