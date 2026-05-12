const SENT_URL = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';
const DAY_MS = 86400000;
const AGE_YELLOW_DAYS = 7;
const AGE_RED_DAYS = 14;

const $ = (id) => document.getElementById(id);

function ageDays(timestamp) {
  return Math.floor((Date.now() - timestamp) / DAY_MS);
}

function ageClassFromDays(days) {
  if (days >= AGE_RED_DAYS) return 'age-red';
  if (days >= AGE_YELLOW_DAYS) return 'age-yellow';
  return '';
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

function renderPending(items) {
  const list = $('pending-list');
  list.innerHTML = '';
  $('pending-empty').hidden = items.length > 0;
  $('pending-summary').textContent = items.length === 0
    ? ''
    : `${items.length} pending · sorted oldest first`;

  const sorted = items.slice().sort((a, b) => a.firstSeenAt - b.firstSeenAt);

  for (const item of sorted) {
    const days = ageDays(item.firstSeenAt);
    const row = el('li', { className: `row ${ageClassFromDays(days)}` }, [
      el('a', { className: 'name', href: item.profileUrl, target: '_blank' }, [item.name]),
      item.headline ? el('div', { className: 'headline' }, [item.headline]) : null,
      el('div', { className: 'meta' }, [
        `Pending ${days}d`,
        item.sentDateRelative || '',
      ]),
    ]);
    list.append(row);
  }
}

function renderAccepted(items, onMarkWelcome) {
  const list = $('accepted-list');
  list.innerHTML = '';
  const waiting = items.filter((x) => !x.welcomeMessageSent);
  $('accepted-empty').hidden = waiting.length > 0;
  $('accepted-summary').textContent = waiting.length === 0
    ? ''
    : `${waiting.length} waiting for welcome message`;

  const sorted = waiting.slice().sort((a, b) => b.acceptedAt - a.acceptedAt);

  for (const item of sorted) {
    const sinceAccepted = ageDays(item.acceptedAt);
    const markBtn = el('button', { className: 'primary' }, ['Mark welcome sent']);
    markBtn.addEventListener('click', () => onMarkWelcome(item.profileUrl));

    const openBtn = el('button', {}, ['Open profile']);
    openBtn.addEventListener('click', () => chrome.tabs.create({ url: item.profileUrl }));

    const row = el('li', { className: `row ${ageClassFromDays(sinceAccepted)}` }, [
      el('a', { className: 'name', href: item.profileUrl, target: '_blank' }, [item.name]),
      item.headline ? el('div', { className: 'headline' }, [item.headline]) : null,
      el('div', { className: 'meta' }, [
        `Accepted ${sinceAccepted}d ago`,
        `was pending ${item.daysPending}d`,
      ]),
      el('div', { className: 'row-actions' }, [openBtn, markBtn]),
    ]);
    list.append(row);
  }
}

async function loadData() {
  const { sentInvitations = {}, accepted = {} } = await chrome.storage.local.get(['sentInvitations', 'accepted']);
  renderPending(Object.values(sentInvitations));
  renderAccepted(Object.values(accepted), markWelcomeSent);
}

async function markWelcomeSent(profileUrl) {
  const { accepted = {} } = await chrome.storage.local.get('accepted');
  if (!accepted[profileUrl]) return;
  accepted[profileUrl].welcomeMessageSent = true;
  accepted[profileUrl].welcomeMessageSentAt = Date.now();
  await chrome.storage.local.set({ accepted });
  chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
  loadData();
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function exportCsv() {
  const { sentInvitations = {}, accepted = {} } = await chrome.storage.local.get(['sentInvitations', 'accepted']);
  const rows = [['status', 'name', 'profileUrl', 'headline', 'firstSeenAt', 'acceptedAt', 'daysPending', 'welcomeSent']];
  for (const x of Object.values(sentInvitations)) {
    rows.push(['pending', x.name, x.profileUrl, x.headline, new Date(x.firstSeenAt).toISOString(), '', '', '']);
  }
  for (const x of Object.values(accepted)) {
    rows.push(['accepted', x.name, x.profileUrl, x.headline, new Date(x.firstSeenAt).toISOString(), new Date(x.acceptedAt).toISOString(), x.daysPending, x.welcomeMessageSent]);
  }
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `linkedin-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function switchTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('active', panel.id === `${name}-panel`);
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

$('open-sent').addEventListener('click', () => chrome.tabs.create({ url: SENT_URL }));
$('export-csv').addEventListener('click', exportCsv);

loadData();
