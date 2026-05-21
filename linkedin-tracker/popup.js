const SENT_URL = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';
const DAY_MS = 86400000;
const AGE_YELLOW_DAYS = 7;
const AGE_RED_DAYS = 14;

const $ = (id) => document.getElementById(id);
const ageDays = (ts) => Math.floor((Date.now() - ts) / DAY_MS);
const ageClassFromDays = (d) => d >= AGE_RED_DAYS ? 'age-red' : d >= AGE_YELLOW_DAYS ? 'age-yellow' : '';

let searchQuery = '';

function matchesSearch(item) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return (item.name || '').toLowerCase().includes(q)
    || (item.headline || '').toLowerCase().includes(q);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function statusBadge(verified) {
  if (verified === 'accepted') return el('span', { className: 'status-badge accepted' }, ['✓ accepted']);
  if (verified === 'declined') return el('span', { className: 'status-badge declined' }, ['✗ declined']);
  return el('span', { className: 'status-badge unverified' }, ['?']);
}

function renderPending(items) {
  const list = $('pending-list');
  list.innerHTML = '';
  const filtered = items.filter(matchesSearch);
  $('pending-empty').hidden = items.length > 0;
  $('pending-summary').textContent = items.length === 0
    ? ''
    : searchQuery
      ? `${filtered.length} of ${items.length} match`
      : `${items.length} pending · sorted oldest first`;

  const sorted = filtered.slice().sort((a, b) => a.firstSeenAt - b.firstSeenAt);

  for (const item of sorted) {
    const days = ageDays(item.firstSeenAt);
    list.append(el('li', { className: `row ${ageClassFromDays(days)}` }, [
      item.avatar ? el('img', { className: 'avatar', src: item.avatar, alt: '' }) : null,
      el('div', { className: 'row-body' }, [
        el('div', { className: 'name-row' }, [
          el('a', { className: 'name', href: item.profileUrl, target: '_blank' }, [item.name]),
        ]),
        item.headline ? el('div', { className: 'headline' }, [item.headline]) : null,
        el('div', { className: 'meta' }, [
          el('span', {}, [`Pending ${days}d`]),
          item.sentDateRelative ? el('span', {}, [item.sentDateRelative]) : null,
        ]),
      ]),
    ]));
  }
}

function isMarked(item) {
  // welcomeMessageSent kept for backwards-compat with older storage entries
  return Boolean(item.marked || item.welcomeMessageSent);
}

function renderAcceptedRow(item, { primaryAction, primaryLabel }) {
  const sinceAccepted = ageDays(item.acceptedAt);
  const isDeclined = item.verified === 'declined';

  const openBtn = el('button', {}, ['Open profile']);
  openBtn.addEventListener('click', () => chrome.tabs.create({ url: item.profileUrl }));

  const actions = [openBtn];
  if (!isDeclined) {
    const actionBtn = el('button', { className: 'primary' }, [primaryLabel]);
    actionBtn.addEventListener('click', () => primaryAction(item.profileUrl));
    actions.push(actionBtn);
  }

  const rowClasses = ['row', ageClassFromDays(sinceAccepted)];
  if (isDeclined) rowClasses.push('declined');

  return el('li', { className: rowClasses.filter(Boolean).join(' ') }, [
    item.avatar ? el('img', { className: 'avatar', src: item.avatar, alt: '' }) : null,
    el('div', { className: 'row-body' }, [
      el('div', { className: 'name-row' }, [
        el('a', { className: 'name', href: item.profileUrl, target: '_blank' }, [item.name]),
        statusBadge(item.verified),
      ]),
      item.headline ? el('div', { className: 'headline' }, [item.headline]) : null,
      item.location ? el('div', { className: 'location' }, [item.location]) : null,
      el('div', { className: 'meta' }, [
        el('span', {}, [`Accepted ${sinceAccepted}d ago`]),
        el('span', {}, [`was pending ${item.daysPending}d`]),
      ]),
      el('div', { className: 'row-actions' }, actions),
    ]),
  ]);
}

function renderAccepted(items) {
  const list = $('accepted-list');
  list.innerHTML = '';

  const unmarked = items.filter((x) => !isMarked(x));
  const visible = unmarked.filter(matchesSearch);
  $('accepted-empty').hidden = unmarked.length > 0;
  $('accepted-summary-text').textContent = unmarked.length === 0
    ? ''
    : searchQuery
      ? `${visible.length} of ${unmarked.length} match`
      : `${unmarked.length} to handle`;
  $('mark-all').hidden = unmarked.filter((x) => x.verified !== 'declined').length === 0;

  const sorted = visible.slice().sort((a, b) => b.acceptedAt - a.acceptedAt);
  for (const item of sorted) {
    list.append(renderAcceptedRow(item, {
      primaryAction: (url) => setMarked(url, true),
      primaryLabel: 'Mark',
    }));
  }
}

function renderMarked(items) {
  const list = $('marked-list');
  list.innerHTML = '';

  const all = items.filter(isMarked);
  const visible = all.filter(matchesSearch);
  $('marked-empty').hidden = all.length > 0;
  $('marked-summary').textContent = all.length === 0
    ? ''
    : searchQuery
      ? `${visible.length} of ${all.length} match`
      : `${all.length} marked`;

  const sorted = visible.slice().sort((a, b) => (b.markedAt || b.acceptedAt) - (a.markedAt || a.acceptedAt));
  for (const item of sorted) {
    list.append(renderAcceptedRow(item, {
      primaryAction: (url) => setMarked(url, false),
      primaryLabel: 'Unmark',
    }));
  }
}

async function loadData() {
  const { sentInvitations = {}, accepted = {}, scanHistory = [] } =
    await dbGet(['sentInvitations', 'accepted', 'scanHistory']);

  renderPending(Object.values(sentInvitations));
  renderAccepted(Object.values(accepted));
  renderMarked(Object.values(accepted));

  const lastScan = scanHistory[scanHistory.length - 1];
  const stats = `pending: ${Object.keys(sentInvitations).length} · accepted: ${Object.keys(accepted).length} · scans: ${scanHistory.length}`;
  $('stats-line').textContent = lastScan
    ? `${stats} · last scan ${new Date(lastScan.timestamp).toLocaleString()}`
    : stats;
}

async function setMarked(profileUrl, value) {
  const { accepted = {} } = await dbGet('accepted');
  if (!accepted[profileUrl]) return;
  accepted[profileUrl].marked = value;
  accepted[profileUrl].markedAt = value ? Date.now() : null;
  if (!value) accepted[profileUrl].welcomeMessageSent = false;
  await dbSet({ accepted });
}

async function markAllAccepted() {
  const { accepted = {} } = await dbGet('accepted');
  const now = Date.now();
  let changed = 0;
  for (const item of Object.values(accepted)) {
    if (isMarked(item)) continue;
    if (item.verified === 'declined') continue;
    item.marked = true;
    item.markedAt = now;
    changed++;
  }
  if (changed === 0) return;
  await dbSet({ accepted });
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportCsv() {
  const { sentInvitations = {}, accepted = {} } = await dbGet(['sentInvitations', 'accepted']);
  const rows = [['status', 'verified', 'name', 'profileUrl', 'headline', 'firstSeenAt', 'acceptedAt', 'daysPending', 'welcomeSent']];
  for (const x of Object.values(sentInvitations)) {
    rows.push(['pending', '', x.name, x.profileUrl, x.headline, new Date(x.firstSeenAt).toISOString(), '', '', '']);
  }
  for (const x of Object.values(accepted)) {
    rows.push(['accepted', x.verified || '', x.name, x.profileUrl, x.headline,
      new Date(x.firstSeenAt).toISOString(), new Date(x.acceptedAt).toISOString(),
      x.daysPending, x.welcomeMessageSent]);
  }
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `linkedin-tracker-${new Date().toISOString().slice(0, 10)}.csv`);
}

async function exportJson() {
  const data = await dbGet(null);
  const payload = { exportedAt: new Date().toISOString(), version: 1, data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `linkedin-tracker-${new Date().toISOString().slice(0, 10)}.json`);
}

async function importJson(file) {
  const status = $('import-status');
  status.classList.remove('error');
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const data = parsed?.data;
    if (!data || typeof data !== 'object') throw new Error('Missing `data` object — not a valid backup');
    await dbClear();
    await dbSet(data);
    status.textContent = `Imported ${Object.keys(data).length} keys.`;
    loadData();
  } catch (e) {
    status.classList.add('error');
    status.textContent = `Import failed: ${e.message}`;
  }
}

function switchTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('active', panel.id === `${name}-panel`);
  }
}

async function updateScanButton() {
  const btn = $('open-sent');
  const { scanInProgress } = await dbGet('scanInProgress');

  btn.classList.remove('scanning', 'mode-scan', 'mode-goto');
  btn.disabled = false;

  if (scanInProgress) {
    btn.classList.add('scanning', 'mode-scan');
    btn.textContent = 'Stop';
    btn.title = 'Click to cancel the scan';
    btn.dataset.mode = 'stop';
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onSentPage = tab?.url?.startsWith(SENT_URL);
  if (onSentPage) {
    btn.classList.add('mode-scan');
    btn.textContent = 'Scan';
    btn.title = 'Start a scan of this page';
    btn.dataset.mode = 'scan';
  } else {
    btn.classList.add('mode-goto');
    btn.textContent = 'Go to Sent page';
    btn.title = 'Open the sent invitations page on LinkedIn';
    btn.dataset.mode = 'goto';
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'DB_CHANGED') return;
  const keys = msg.keys || [];
  const all = keys.includes('*');
  if (all || keys.includes('scanInProgress')) updateScanButton();
  if (all || keys.includes('sentInvitations') || keys.includes('accepted')) loadData();
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

$('open-sent').addEventListener('click', async () => {
  const mode = $('open-sent').dataset.mode;
  if (mode === 'goto') {
    chrome.tabs.create({ url: SENT_URL });
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith(SENT_URL)) {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SCAN' });
  }
});

$('empty-open-sent').addEventListener('click', () => chrome.tabs.create({ url: SENT_URL }));
$('mark-all').addEventListener('click', markAllAccepted);
$('search').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  loadData();
});
$('export-csv').addEventListener('click', exportCsv);
$('export-json').addEventListener('click', exportJson);
$('import-json').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) importJson(file);
});

loadData();
updateScanButton();
