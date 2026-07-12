const SENT_URL = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';
const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
const SUPPORT_URL = 'https://github.com/mrbuslov/linkedin-parser-browser-extension/issues/new';
const DAY_MS = 86400000;
const AGE_YELLOW_DAYS = 7;
const AGE_RED_DAYS = 14;

function relativeTime(ts) {
  if (!ts) return null;
  const diffMs = Date.now() - ts;
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function renderScanInfo(container, state) {
  container.innerHTML = '';
  if (!state || !state.lastScannedAt) {
    container.append(el('span', { className: 'scan-info-text muted' }, ['Never scanned']));
    return;
  }
  const when = relativeTime(state.lastScannedAt);
  if (state.lastError) {
    container.append(
      el('span', { className: 'scan-info-text error' }, [`Last scan ${when} failed: ${state.lastError}`])
    );
  } else {
    const count = state.lastCount != null ? ` · ${state.lastCount} captured` : '';
    container.append(
      el('span', { className: 'scan-info-text muted' }, [`Last scan ${when}${count}`])
    );
  }
}

const $ = (id) => document.getElementById(id);
const ageDays = (ts) => Math.floor((Date.now() - ts) / DAY_MS);
const ageClassFromDays = (d) => d >= AGE_RED_DAYS ? 'age-red' : d >= AGE_YELLOW_DAYS ? 'age-yellow' : '';

let searchQuery = '';

// Defensive view-side correction for legacy records where `name` and
// `headline` got swapped (an old extractor stored an accessibility text
// node like "Daniil StankevichFullstack developer | …" as the name, and
// the real name as headline). fixSwappedNameHeadline detects and undoes
// this — and we run it on every row before rendering so all tabs
// (Pending / Accepted / Marked / Declined block) get the correction.
function viewItem(item) {
  const fixed = LITPopupLogic.fixSwappedNameHeadline(item);
  return { ...item, name: fixed.name, headline: fixed.headline };
}

function matchesSearch(item) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return (item.name || '').toLowerCase().includes(q)
    || (item.headline || '').toLowerCase().includes(q)
    || (item.email || '').toLowerCase().includes(q)
    || (item.phone || '').toLowerCase().includes(q)
    || (item.website || '').toLowerCase().includes(q)
    || (item.address || '').toLowerCase().includes(q);
}

// One-shot toast at the bottom of the popup. Used for "Copied!" feedback after
// the user clicks a contact-copy icon. Kept inline (no library) — we only need
// a single transient line of text.
let toastTimer = null;
function showToast(text) {
  let node = document.getElementById('toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast';
    node.className = 'toast';
    document.body.append(node);
  }
  node.textContent = text;
  node.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 1200);
}

async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied`);
  } catch {
    showToast('Copy failed');
  }
}

function contactButton(emoji, value, label) {
  if (!value) return null;
  const btn = el('button', {
    className: 'contact-copy',
    type: 'button',
    title: `Copy ${label}: ${value}`,
  }, [emoji]);
  btn.setAttribute('aria-label', `Copy ${label}`);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    copyToClipboard(value, label);
  });
  return btn;
}

function contactButtons(item) {
  const buttons = [
    contactButton('📧', item.email, 'email'),
    contactButton('📞', item.phone, 'phone'),
    contactButton('🌐', item.website, 'website'),
  ].filter(Boolean);
  if (buttons.length === 0) return null;
  return el('span', { className: 'contact-copies' }, buttons);
}

// "🤝 N" chip — opens LinkedIn's connection-of search in a new tab.
// Color logic: solid blue when the list of mutuals has NOT been captured
// (CTA — click to navigate, the search-mutuals content script will save
// the list when LinkedIn renders it); white/outlined when we've already
// captured the list locally.
function mutualsChip(item) {
  if (!item.mutualsUrl) return null;
  const labelText = item.mutualsCount != null ? `🤝 ${item.mutualsCount}` : '🤝';
  const collected = Array.isArray(item.mutualsCollected) && item.mutualsCollected.length > 0;
  const a = el('a', {
    className: collected ? 'mutuals-chip collected' : 'mutuals-chip',
    href: item.mutualsUrl,
    target: '_blank',
    rel: 'noopener noreferrer',
  }, [labelText]);
  a.title = collected
    ? `${item.mutualsCollected.length} mutual(s) saved locally${item.mutualsText ? ' — ' + item.mutualsText : ''}`
    : (item.mutualsText
        ? `${item.mutualsText} — click to capture the list locally`
        : 'Open the LinkedIn search to capture mutuals locally');
  return a;
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

// Profile link that navigates the current active tab instead of opening a new one.
// Cmd/Ctrl-click still opens in a new tab (browser-native, via the href fallback).
// For email-keyed entries (mailto:foo@bar) we render a non-navigating span — no
// /in/ profile exists to open, and we don't want to fire the user's email client.
function profileLink(url, text) {
  if (typeof url === 'string' && url.startsWith('mailto:')) {
    return el('span', { className: 'name email' }, [text]);
  }
  const a = el('a', { className: 'name', href: url }, [text]);
  a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.button === 1) return; // let browser handle new-tab
    e.preventDefault();
    chrome.tabs.update({ url });
    window.close();
  });
  return a;
}

function statusBadge(verified) {
  if (verified === 'accepted') {
    const b = el('span', { className: 'status-badge accepted' }, ['✓']);
    b.title = 'accepted';
    return b;
  }
  if (verified === 'declined') {
    const b = el('span', { className: 'status-badge declined' }, ['✗']);
    b.title = 'declined';
    return b;
  }
  const b = el('span', { className: 'status-badge unverified' }, ['?']);
  b.title = 'unverified';
  return b;
}

function renderPending(rawItems, sentScanState) {
  const items = rawItems.map(viewItem);
  const list = $('pending-list');
  list.innerHTML = '';
  const filtered = items.filter(matchesSearch);
  $('pending-empty').hidden = items.length > 0;
  $('pending-summary').textContent = items.length === 0
    ? ''
    : searchQuery
      ? `${filtered.length} of ${items.length} match`
      : `${items.length} pending · sorted newest first`;

  renderPendingScanGap(items.length, sentScanState);

  // Newest first: invitations sent recently appear at the top. Old
  // long-pending ones drift to the bottom (and the row's age class still
  // visually flags them, regardless of position).
  const sorted = filtered.slice().sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  for (const item of sorted) list.append(renderPendingRow(item));
}

// Contextual "your store has N pending, last scan captured only M" banner.
// Fires the same threshold as diff-sent.js's partial-scan guard so the
// user sees it exactly when the guard held back a would-be missing→accepted
// diff. Educational — teaches the − button as the manual reconcile path.
function renderPendingScanGap(pendingCount, sentScanState) {
  const banner = $('pending-gap-banner');
  if (!banner) return;
  const lastCount = sentScanState && sentScanState.lastScannedAt ? sentScanState.lastCount : null;
  const show = LITPopupLogic.shouldShowScanGap(pendingCount, lastCount);
  banner.hidden = !show;
  if (show) {
    $('pending-gap-title').textContent =
      `Last scan captured ${lastCount} invitation${lastCount === 1 ? '' : 's'} on LinkedIn, but ${pendingCount} still stored here.`;
  }
}

function isMarked(item) {
  // welcomeMessageSent kept for backwards-compat with older storage entries
  return Boolean(item.marked || item.welcomeMessageSent);
}

function renderAcceptedRow(item, { primaryAction, primaryLabel }) {
  const sinceAccepted = ageDays(item.acceptedAt);
  const isDeclined = item.status === 'declined';

  const actions = [];
  if (!isDeclined) {
    const actionBtn = el('button', { className: 'primary' }, [primaryLabel]);
    actionBtn.addEventListener('click', () => primaryAction(item.profileUrl));
    actions.push(actionBtn);
  }
  // Minus button — only on rows where LinkedIn currently claims 'accepted'
  // AND the user hasn't already marked them as handled. Semantically it's
  // "this isn't actually in my network" — moves to Viewed. Not shown on
  // 'declined' (already-off-network) or on Marked rows (user's own state).
  if (item.status === 'accepted' && !isMarked(item)) {
    actions.push(demoteButton(item, 'visited'));
  }
  actions.push(deleteButton(item));

  const rowClasses = ['row', ageClassFromDays(sinceAccepted)];
  if (isDeclined) rowClasses.push('declined');

  const nameNode = item.profileUrl && item.profileUrl.startsWith('mailto:')
    ? el('span', { className: 'name email' }, [item.name])
    : el('a', { className: 'name', href: item.profileUrl, target: '_blank' }, [item.name]);

  return el('li', { className: rowClasses.filter(Boolean).join(' ') }, [
    item.avatar ? el('img', { className: 'avatar', src: item.avatar, alt: '' }) : null,
    el('div', { className: 'row-body' }, [
      el('div', { className: 'name-row' }, [
        nameNode,
        favoriteButton(item),
        infoButton(item),
        statusBadge(item.status),
        contactButtons(item),
        mutualsChip(item),
      ]),
      (() => { const h = LITPopupLogic.cleanHeadline(item.headline, item.name); return h ? el('div', { className: 'headline' }, [h]) : null; })(),
      item.location ? el('div', { className: 'location' }, [item.location]) : null,
      el('div', { className: 'meta' }, [
        el('span', {}, [`Accepted ${sinceAccepted}d ago`]),
        el('span', {}, [`was pending ${item.daysPending}d`]),
      ]),
      actions.length > 0 ? el('div', { className: 'row-actions' }, actions) : null,
    ]),
  ]);
}

function renderDeclinedWarning(declinedCount, connectionsScanState) {
  const banner = $('declined-warning');
  if (!banner) return;
  banner.hidden = !LITPopupLogic.shouldShowDeclinedWarning(declinedCount, connectionsScanState);
}

function renderAccepted(rawItems, connectionsScanState) {
  const items = rawItems.map(viewItem);
  const list = $('accepted-list');
  const declinedList = $('declined-list');
  const declinedBlock = $('declined-block');
  list.innerHTML = '';
  declinedList.innerHTML = '';

  const unmarked = items.filter((x) => !isMarked(x));
  const active = unmarked.filter((x) => x.status !== 'declined');
  const declined = unmarked.filter((x) => x.status === 'declined');
  const visible = active.filter(matchesSearch);
  const declinedVisible = declined.filter(matchesSearch);

  $('accepted-empty').hidden = unmarked.length > 0;
  $('accepted-summary-text').textContent = active.length === 0
    ? ''
    : searchQuery
      ? `${visible.length} of ${active.length} match`
      : `${active.length} to handle`;
  $('mark-all').hidden = active.length === 0;

  const sorted = visible.slice().sort((a, b) => b.acceptedAt - a.acceptedAt);
  for (const item of sorted) {
    list.append(renderAcceptedRow(item, {
      primaryAction: (url) => setMarked(url, true),
      primaryLabel: 'Mark',
    }));
  }

  declinedBlock.hidden = declined.length === 0;
  $('declined-summary').textContent = declined.length === 0
    ? "Didn't accept"
    : searchQuery
      ? `Didn't accept (${declinedVisible.length} of ${declined.length})`
      : `Didn't accept (${declined.length})`;
  const declinedSorted = declinedVisible.slice().sort((a, b) => b.acceptedAt - a.acceptedAt);
  for (const item of declinedSorted) {
    declinedList.append(renderAcceptedRow(item, {
      primaryAction: (url) => setMarked(url, true),
      primaryLabel: 'Mark',
    }));
  }

  renderDeclinedWarning(declined.length, connectionsScanState);
}

function renderMarked(rawItems) {
  const items = rawItems.map(viewItem);
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

// Favorites tab: aggregates `favorite: true` records from all three stores,
// v2: everything lives in one `contacts` dict; favorites is a filter on
// `favorite === true`. Rendering choice per row: 'pending' status → Pending
// row shape (age color + sentDateRelative); 'accepted'/'declined' → Accepted
// row shape (Mark button); anything else → contacts-only row shape.
// Viewed tab — profiles with status='visited' (opened but never invited /
// connected). Sorted by most recent visit. Reuses the contacts-only
// row renderer since these entries look the same shape.
function renderViewed(contacts) {
  const list = $('viewed-list');
  list.innerHTML = '';

  const viewed = Object.values(contacts)
    .filter((r) => r.status === 'visited')
    .map(viewItem);
  const visible = viewed.filter(matchesSearch);
  $('viewed-empty').hidden = viewed.length > 0;
  $('viewed-summary').textContent = viewed.length === 0
    ? ''
    : searchQuery
      ? `${visible.length} of ${viewed.length} match`
      : `${viewed.length} viewed`;

  const sorted = visible.slice()
    .sort((a, b) => (b.visitedAt || b.firstSeenAt || 0) - (a.visitedAt || a.firstSeenAt || 0));
  for (const item of sorted) {
    list.append(renderContactOnlyRow(item));
  }
}

function renderFavorites(contacts) {
  const list = $('favorites-list');
  list.innerHTML = '';

  const favs = Object.values(contacts).filter((r) => r.favorite).map(viewItem);
  const visible = favs.filter(matchesSearch);
  $('favorites-empty').hidden = favs.length > 0;
  $('favorites-summary').textContent = favs.length === 0
    ? ''
    : searchQuery
      ? `${visible.length} of ${favs.length} match`
      : `${favs.length} favorited`;

  const sorted = visible.slice().sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0));
  for (const item of sorted) {
    if (item.status === 'accepted' || item.status === 'declined') {
      list.append(renderAcceptedRow(item, {
        primaryAction: (url) => setMarked(url, !isMarked(item)),
        primaryLabel: isMarked(item) ? 'Unmark' : 'Mark',
      }));
    } else if (item.status === 'pending') {
      list.append(renderPendingRow(item));
    } else {
      list.append(renderContactOnlyRow(item));
    }
  }
}

// Pull the per-row render out of renderPending() so the Favorites tab can
// reuse it without re-running the whole search/sort/summary pipeline.
function renderPendingRow(item) {
  const days = ageDays(item.firstSeenAt);
  return el('li', { className: `row ${ageClassFromDays(days)}` }, [
    item.avatar ? el('img', { className: 'avatar', src: item.avatar, alt: '' }) : null,
    el('div', { className: 'row-body' }, [
      el('div', { className: 'name-row' }, [
        profileLink(item.profileUrl, item.name),
        favoriteButton(item),
        infoButton(item),
        contactButtons(item),
        mutualsChip(item),
      ]),
      (() => { const h = LITPopupLogic.cleanHeadline(item.headline, item.name); return h ? el('div', { className: 'headline' }, [h]) : null; })(),
      el('div', { className: 'meta' }, [
        el('span', {}, [`Pending ${days}d`]),
        item.sentDateRelative ? el('span', {}, [item.sentDateRelative]) : null,
      ]),
      el('div', { className: 'row-actions' }, [
        demoteButton(item, 'declined'),
        deleteButton(item),
      ]),
    ]),
  ]);
}

// Contacts-only row (favorited person who never appeared in pending/accepted
// — e.g. a 3rd-degree profile the user visited). Minimal but functional.
function renderContactOnlyRow(item) {
  return el('li', { className: 'row' }, [
    item.avatar ? el('img', { className: 'avatar', src: item.avatar, alt: '' }) : null,
    el('div', { className: 'row-body' }, [
      el('div', { className: 'name-row' }, [
        profileLink(item.profileUrl, item.name),
        favoriteButton(item),
        infoButton(item),
        contactButtons(item),
        mutualsChip(item),
      ]),
      (() => { const h = LITPopupLogic.cleanHeadline(item.headline, item.name); return h ? el('div', { className: 'headline' }, [h]) : null; })(),
      item.location ? el('div', { className: 'location' }, [item.location]) : null,
      el('div', { className: 'row-actions' }, [deleteButton(item)]),
    ]),
  ]);
}

// One-shot v1 → v2 schema migration. Runs on every popup load; idempotent
// (LITSchema.isV2 short-circuits when schemaVersion=2 already). The
// service worker also runs this on startup — this is belt-and-suspenders.
async function ensureSchemaV2() {
  const stored = await dbGet(null);
  if (LITSchema.isV2(stored)) return;
  const migrated = LITSchema.migrateToV2(stored);
  migrated._backup_v1._migratedAt = Date.now();
  await dbSet(migrated);
  await dbDelete(LITSchema.LEGACY_STORE_KEYS);
  console.log('[LI Tracker] popup migrated storage to v2.');
}

// One-shot URN-based cross-URL dedup. Runs on every popup load; idempotent
// (backfillUrnIds skips records that already have urnId; dedupeByUrnId
// finds no dups once run). Motivated by real 2026-07-12 report where the
// user had Joe Dougherty as TWO records — accepted at /joedougherty/ and
// visited at /ACoAAAAKdt4BJsIJ1JWspUDO30kiqpShpM9-GCI/ — because the URN
// URL was a valid alternate path LinkedIn served, and pre-1.3.3 dedup
// only matched by memberId (which was empty for both records).
async function migrateUrnDedup() {
  const { contacts = {} } = await dbGet('contacts');
  const result = LITSchema.runUrnDedupMigration(contacts);
  if (result.backfilled === 0 && result.deduped === 0 && result.repaired === 0) return;
  await dbSet({ contacts });
  console.log(`[LI Tracker] URN-dedup migration: backfilled ${result.backfilled} urnIds, merged ${result.deduped} duplicates, repaired ${result.repaired} profileUrl mismatches.`);
}

// One-shot migration: walk every record and undo any name/headline swap.
// Idempotent: no write when nothing to fix.
async function migrateSwappedNames() {
  const { contacts = {} } = await dbGet('contacts');
  let changed = false;
  for (const rec of Object.values(contacts)) {
    const fixed = LITPopupLogic.fixSwappedNameHeadline(rec);
    if (fixed.name !== rec.name || fixed.headline !== rec.headline) {
      rec.name = fixed.name;
      rec.headline = fixed.headline;
      changed = true;
    }
  }
  if (changed) {
    await dbSet({ contacts });
    console.log('[LI Tracker] migration cleaned name/headline swap in contacts.');
  }
}

async function loadData() {
  await ensureSchemaV2();
  await migrateSwappedNames();
  await migrateUrnDedup();

  const { contacts = {}, scanHistory = [], scanState = {} } =
    await dbGet(['contacts', 'scanHistory', 'scanState']);

  const pending  = Object.values(contacts).filter((r) => r.status === 'pending');
  const accepted = Object.values(contacts).filter((r) => r.status === 'accepted' || r.status === 'declined');

  renderPending(pending, scanState.sent);
  renderAccepted(accepted, scanState.connections);
  renderMarked(accepted);
  renderFavorites(contacts);
  renderViewed(contacts);
  renderScanInfo($('pending-scan-info'), scanState.sent);
  renderScanInfo($('accepted-scan-info'), scanState.connections);

  const lastScan = scanHistory[scanHistory.length - 1];
  const stats = `pending: ${pending.length} · accepted: ${accepted.filter((r) => r.status === 'accepted').length} · scans: ${scanHistory.length}`;
  $('stats-line').textContent = lastScan
    ? `${stats} · last scan ${new Date(lastScan.timestamp).toLocaleString()}`
    : stats;
}

async function setMarked(profileUrl, value) {
  const { contacts = {} } = await dbGet('contacts');
  if (!contacts[profileUrl]) return;
  contacts[profileUrl].marked = value;
  contacts[profileUrl].markedAt = value ? Date.now() : null;
  if (!value) contacts[profileUrl].welcomeMessageSent = false;
  await dbSet({ contacts });
}

// Permanently remove an entry by its profileUrl. One dict, one delete.
async function deleteEntry(profileUrl, displayName) {
  const ok = window.confirm(
    `Delete "${displayName || profileUrl}" from the tracker?\n\n`
    + 'Removes this entry from Pending / Accepted / Marked / Favorites. '
    + 'Cannot be undone. If LinkedIn still has the actual connection, a '
    + 'future /connections/ scan will re-add them.'
  );
  if (!ok) return;
  const { contacts = {} } = await dbGet('contacts');
  if (!contacts[profileUrl]) return;
  delete contacts[profileUrl];
  await dbSet({ contacts });
  showToast('Deleted');
}

function deleteButton(item) {
  const btn = el('button', { className: 'danger', type: 'button' }, ['Delete']);
  btn.addEventListener('click', () => deleteEntry(item.profileUrl, item.name));
  return btn;
}

// Manual demote: user says "this record shouldn't be in Pending / Accepted".
// Kept as ONE helper for both flows because the click-path is identical —
// only the target status and tooltip change. Mutation itself is pure
// (delegated to LITPopupLogic.demoteTo{Declined,Visited}) so behaviour is
// unit-testable without dragging in the DB layer.
async function demoteEntry(profileUrl, targetStatus) {
  const { contacts = {} } = await dbGet('contacts');
  const rec = contacts[profileUrl];
  if (!rec) return;
  const now = Date.now();
  contacts[profileUrl] = targetStatus === 'declined'
    ? LITPopupLogic.demoteToDeclined(rec, now)
    : LITPopupLogic.demoteToVisited(rec, now);
  await dbSet({ contacts });
  showToast(targetStatus === 'declined' ? 'Marked declined' : 'Marked as visited');
}

// − button. Used on Pending rows (target='declined') and on Accepted rows
// (target='visited'). Kept visually distinct from the Delete button — no
// data is lost, only status changes.
function demoteButton(item, targetStatus) {
  const tooltip = targetStatus === 'declined'
    ? 'Mark as declined — use if you already removed this invitation on LinkedIn'
    : 'Not actually in my network — move to Viewed';
  const btn = el('button', {
    className: 'demote-btn',
    type: 'button',
    title: tooltip,
  }, ['−']);
  btn.setAttribute('aria-label', tooltip);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    demoteEntry(item.profileUrl, targetStatus);
  });
  return btn;
}

function infoButton(item) {
  const btn = el('button', {
    className: 'info-btn',
    type: 'button',
    title: 'Show full info',
  }, ['ⓘ']);
  btn.setAttribute('aria-label', 'Show full info');
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openDetailView(item.profileUrl);
  });
  return btn;
}

// Star toggle. Filled ★ = favorited, outline ☆ = not. Click toggles the
// `favorite` boolean on whichever store(s) hold this profileUrl (a person
// can live in sentInvitations OR accepted, plus contacts in parallel — we
// flip ALL of them so reads are consistent regardless of which store the
// renderer pulled from).
function favoriteButton(item) {
  const fav = !!item.favorite;
  const btn = el('button', {
    className: fav ? 'fav-btn favorited' : 'fav-btn',
    type: 'button',
    title: fav ? 'Remove from favorites' : 'Add to favorites',
  }, [fav ? '★' : '☆']);
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-pressed', String(fav));
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFavorite(item.profileUrl);
  });
  return btn;
}

async function toggleFavorite(profileUrl) {
  const { contacts = {} } = await dbGet('contacts');
  const rec = contacts[profileUrl];
  if (!rec) return;
  const next = !rec.favorite;
  rec.favorite = next;
  rec.favoritedAt = next ? Date.now() : null;
  await dbSet({ contacts });
  // The list-panel re-render is triggered by the DB_CHANGED broadcast
  // (loadData reads fresh contacts). Detail panel is rendered once on
  // open() and won't pick up the new favorite state unless we refresh
  // it explicitly here.
  await refreshDetailView();
}

// ---------- Detail view ----------
//
// Click ⓘ on any row → the list panel hides, a full-width detail panel
// renders every stored field for that profile. Back button returns to the
// previously-active tab. Implemented as a separate <section id="detail-panel">
// — same `.panel` slot system the tabs use, plus a `showing-detail` body
// class that hides the tab switcher while a detail is open.

let detailReturnTab = 'pending';
let currentDetailUrl = null;

async function openDetailView(profileUrl) {
  detailReturnTab = activeTabName();
  currentDetailUrl = profileUrl;
  const { contacts = {} } = await dbGet('contacts');
  const item = contacts[profileUrl];
  if (!item) return;
  renderDetail(item);
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.remove('active');
    if (panel.id !== 'detail-panel') panel.hidden = true;
  }
  const detail = $('detail-panel');
  detail.hidden = false;
  detail.classList.add('active');
  document.body.classList.add('showing-detail');
}

function closeDetailView() {
  currentDetailUrl = null;
  document.body.classList.remove('showing-detail');
  const detail = $('detail-panel');
  detail.hidden = true;
  detail.classList.remove('active');
  for (const panel of document.querySelectorAll('.panel')) {
    if (panel.id === 'detail-panel') continue;
    panel.hidden = false;
  }
  switchTab(detailReturnTab);
}

// Re-fetch the current detail-view record from storage and re-render. Used
// after in-place mutations (e.g. favorite toggle) so the panel reflects
// fresh field values without closing/reopening. No-op when detail view is
// not currently showing.
async function refreshDetailView() {
  if (!currentDetailUrl) return;
  const { contacts = {} } = await dbGet('contacts');
  const item = contacts[currentDetailUrl];
  if (!item) return;
  renderDetail(item);
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const day = 86400000;
  if (diff < day) return 'today';
  const days = Math.floor(diff / day);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function field(label, value, opts = {}) {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
  const valNode = typeof value === 'string' || typeof value === 'number'
    ? el('span', { className: 'field-value' + (opts.mono ? ' mono' : '') }, [String(value)])
    : value;
  const children = [el('div', { className: 'field-label' }, [label]), valNode];
  if (opts.copy && typeof value === 'string') {
    const btn = el('button', { className: 'copy-link', type: 'button' }, ['Copy']);
    btn.addEventListener('click', () => copyToClipboard(value, label));
    children.push(btn);
  }
  return el('div', { className: 'detail-field' }, children);
}

function renderDetail(item) {
  const fixed = LITPopupLogic.fixSwappedNameHeadline(item);
  const name = fixed.name;
  const headline = LITPopupLogic.cleanHeadline(fixed.headline, name);
  const panel = $('detail-panel');
  panel.innerHTML = '';

  const header = el('div', { className: 'detail-header' }, [
    (() => {
      const back = el('button', { className: 'detail-back', type: 'button', title: 'Back' }, ['←']);
      back.setAttribute('aria-label', 'Back');
      back.addEventListener('click', closeDetailView);
      return back;
    })(),
    el('div', { className: 'detail-title-wrap' }, [
      item.avatar ? el('img', { className: 'detail-avatar', src: item.avatar, alt: '' }) : null,
      el('div', { className: 'detail-title-text' }, [
        el('div', { className: 'detail-name' }, [
          name || '(no name)',
          favoriteButton(item),
        ]),
        item.status ? statusBadge(item.status) : null,
      ]),
    ]),
  ]);
  panel.append(header);

  // ABOUT section
  const about = el('div', { className: 'detail-section' }, [
    el('h4', {}, ['About']),
    field('Headline', headline),
    field('Location', item.location),
    field('Country', item.country),
  ].filter(Boolean));
  if (about.querySelectorAll('.detail-field').length > 0) panel.append(about);

  // CONTACT section
  const contactRows = [
    field('Email', item.email, { copy: true, mono: true }),
    field('Phone', item.phone ? `${item.phone}${item.phoneLabel ? ' (' + item.phoneLabel + ')' : ''}` : '', { copy: !!item.phone, mono: true }),
    field('Website', item.website ? `${item.website}${item.websiteLabel ? ' (' + item.websiteLabel + ')' : ''}` : '', { copy: !!item.website, mono: true }),
    field('Address', item.address),
    field('Birthday', item.birthday),
    field('Connected since', item.connectedSinceText),
  ].filter(Boolean);
  if (contactRows.length > 0) {
    panel.append(el('div', { className: 'detail-section' }, [
      el('h4', {}, ['Contact info']),
      ...contactRows,
    ]));
  } else {
    panel.append(el('div', { className: 'detail-section muted' }, [
      el('h4', {}, ['Contact info']),
      el('p', { className: 'hint' }, ['Open the LinkedIn "Contact info" overlay on this profile to capture email/phone/website here.']),
    ]));
  }

  // MUTUALS section
  if (item.mutualsUrl || (item.mutualsCollected && item.mutualsCollected.length)) {
    const collected = Array.isArray(item.mutualsCollected) ? item.mutualsCollected : [];
    const sec = el('div', { className: 'detail-section' }, [
      el('h4', {}, [`Mutual connections${item.mutualsCount != null ? ` (${item.mutualsCount})` : ''}`]),
      item.mutualsText ? el('p', { className: 'hint' }, [item.mutualsText]) : null,
      item.mutualsUrl ? (() => {
        const a = el('a', { href: item.mutualsUrl, target: '_blank', className: 'text-action' }, ['Open on LinkedIn →']);
        return a;
      })() : null,
      collected.length > 0
        ? el('div', { className: 'mutuals-collected-meta' }, [`${collected.length} saved locally · captured ${relTime(item.mutualsCollectedAt)}`])
        : null,
      collected.length > 0 ? el('ul', { className: 'mutuals-collected-list' }, collected.map((m) => {
        const link = el('a', { href: m.profileUrl, target: '_blank', className: 'mutual-row' }, [
          m.avatar ? el('img', { className: 'mutual-avatar', src: m.avatar, alt: '' }) : null,
          el('span', { className: 'mutual-name' }, [m.name]),
        ]);
        return el('li', {}, [link]);
      })) : null,
    ].filter(Boolean));
    panel.append(sec);
  }

  // ACTIVITY section — only if we have any captured posts
  const recent = Array.isArray(item.recentActivity) ? item.recentActivity : [];
  if (recent.length > 0 || item.lastActivityAt || item.lastPostAt) {
    const activitySection = el('div', { className: 'detail-section' }, [
      el('h4', {}, ['Recent activity']),
      item.lastActivityAt ? field('Last activity', `${fmtDate(item.lastActivityAt)} · ${relTime(item.lastActivityAt)}`) : null,
      item.lastPostAt     ? field('Last own post', `${fmtDate(item.lastPostAt)} · ${relTime(item.lastPostAt)}`) : null,
      recent.length > 0 ? el('ul', { className: 'activity-list' }, recent.map((c) => {
        const snippet = (c.text || '').slice(0, 280) + ((c.text || '').length > 280 ? '…' : '');
        const typeLabel = c.type === 'post' ? 'post' : c.type === 'share' ? 'share' : c.type;
        const meta = el('div', { className: 'activity-meta' }, [
          el('span', { className: `activity-type activity-type-${c.type}` }, [typeLabel]),
          el('span', { className: 'activity-time' }, [c.postedAtText || '']),
          c.author ? el('span', { className: 'activity-author' }, [`· ${c.author}`]) : null,
        ].filter(Boolean));
        const link = el('a', { href: c.url, target: '_blank', className: 'activity-link' }, ['Open ↗']);
        return el('li', { className: 'activity-row' }, [
          meta,
          snippet ? el('p', { className: 'activity-text' }, [snippet]) : null,
          link,
        ].filter(Boolean));
      })) : null,
    ].filter(Boolean));
    panel.append(activitySection);
  }

  // CONNECTION section (status + dates)
  panel.append(el('div', { className: 'detail-section' }, [
    el('h4', {}, ['Connection']),
    field('Status', item.status),
    field('Accepted at', item.acceptedAt ? `${fmtDate(item.acceptedAt)} · ${relTime(item.acceptedAt)}` : null),
    field('Days pending before accept', item.daysPending != null ? item.daysPending : null),
    field('First seen', item.firstSeenAt ? `${fmtDate(item.firstSeenAt)} · ${relTime(item.firstSeenAt)}` : null),
    field('Last visited', item.visitedAt ? `${fmtDate(item.visitedAt)} · ${relTime(item.visitedAt)}` : null),
    field('Marked at', item.markedAt ? `${fmtDate(item.markedAt)} · ${relTime(item.markedAt)}` : null),
  ].filter(Boolean)));

  // TECHNICAL section
  panel.append(el('div', { className: 'detail-section' }, [
    el('h4', {}, ['Technical']),
    field('Profile URL', item.profileUrl, { copy: true, mono: true }),
    field('Member ID', item.memberId, { mono: true }),
    field('Vanity name', item.vanityName, { mono: true }),
    field('Connected on (LinkedIn)', item.connectedOnText),
    field('Captured contact info', item.contactsCapturedAt ? `${fmtDate(item.contactsCapturedAt)} · ${relTime(item.contactsCapturedAt)}` : null),
  ].filter(Boolean)));

  // ACTIONS section
  const openLi = el('a', { href: item.profileUrl, target: '_blank', className: 'cta' }, ['Open LinkedIn profile']);
  const del = el('button', { className: 'danger', type: 'button' }, ['Delete this entry']);
  del.addEventListener('click', async () => {
    await deleteEntry(item.profileUrl, name);
    closeDetailView();
  });
  panel.append(el('div', { className: 'detail-section detail-actions' }, [
    openLi,
    del,
  ]));
}

async function markAllAccepted() {
  const { contacts = {} } = await dbGet('contacts');
  const now = Date.now();
  let changed = 0;
  for (const item of Object.values(contacts)) {
    if (item.status !== 'accepted') continue;
    if (isMarked(item)) continue;
    item.marked = true;
    item.markedAt = now;
    changed++;
  }
  if (changed === 0) return;
  await dbSet({ contacts });
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
  const { contacts = {} } = await dbGet('contacts');
  const rows = [[
    'status', 'name', 'profileUrl', 'headline',
    'location', 'country',
    'firstSeenAt', 'acceptedAt', 'declinedAt', 'daysPending', 'welcomeSent',
    'marked', 'favorite',
    'email', 'phone', 'phoneLabel', 'website', 'address', 'birthday',
    'lastActivityAt', 'lastPostAt',
  ]];
  const iso = (ts) => (ts ? new Date(ts).toISOString() : '');
  for (const r of Object.values(contacts)) {
    rows.push([
      r.status || '', r.name || '', r.profileUrl || '', r.headline || '',
      r.location || '', r.country || '',
      iso(r.firstSeenAt), iso(r.acceptedAt), iso(r.declinedAt), r.daysPending || 0, r.welcomeMessageSent || false,
      r.marked || false, r.favorite || false,
      r.email || '', r.phone || '', r.phoneLabel || '',
      r.website || '', r.address || '', r.birthday || '',
      r.lastActivityAt || '', r.lastPostAt || '',
    ]);
  }
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `linkedin-tracker-${new Date().toISOString().slice(0, 10)}.csv`);
}

async function exportJson() {
  const data = await dbGet(null);
  // Payload version 2: unified `contacts` store shape. Importers ≥1.3.0
  // handle both v1 (three-store) and v2 payloads via the migration path.
  const payload = { exportedAt: new Date().toISOString(), version: 2, data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `linkedin-tracker-${new Date().toISOString().slice(0, 10)}.json`);
}

// Download only the CURRENT tab's list as JSON. Matches what the user
// actually sees on screen — one contacts dict, filtered by status.
async function exportCurrentTab() {
  const tab = activeTabName();
  const { contacts = {} } = await dbGet('contacts');
  const all = Object.values(contacts);

  let items;
  switch (tab) {
    case 'pending':
      items = all.filter((r) => r.status === 'pending');
      break;
    case 'accepted':
      // Accepted tab renders items that are NOT marked, both active + declined.
      items = all.filter((r) => (r.status === 'accepted' || r.status === 'declined') && !isMarked(r));
      break;
    case 'marked':
      items = all.filter((r) => isMarked(r));
      break;
    case 'favorites':
      items = all.filter((r) => r.favorite);
      break;
    default:
      // Settings has no list. Give the user something graceful rather
      // than a zero-byte file: full backup, same as the Settings button.
      return exportJson();
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    version: 2,
    tab,
    count: items.length,
    items,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `linkedin-tracker-${tab}-${date}.json`);
}

async function importJson(file) {
  const status = $('import-status');
  status.classList.remove('error');
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const data = parsed?.data;
    if (!data || typeof data !== 'object') throw new Error('Missing `data` object — not a valid backup');
    // Backup version detection: v1 payload wrappers carry legacy
    // sentInvitations/accepted keys in `data` — migrate them to v2
    // before writing so imports from any old backup land cleanly.
    const isLegacy = LITSchema.isLegacyPayload(parsed);
    const finalData = isLegacy ? LITSchema.migrateToV2(data) : data;
    if (isLegacy) finalData._backup_v1._migratedAt = Date.now();
    await dbClear();
    await dbSet(finalData);
    const contactCount = Object.keys(finalData.contacts || {}).length;
    status.textContent = isLegacy
      ? `Imported ${contactCount} contacts (auto-migrated from legacy v1 backup).`
      : `Imported ${contactCount} contacts.`;
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
  // The per-tab Download button only makes sense on list tabs. Settings
  // and Bulk have no per-tab list to export — Settings has its own
  // full-backup button; Bulk is a control panel, not a list view.
  const btn = $('tab-download');
  if (btn) btn.hidden = name === 'settings' || name === 'bulk';
}

// Maps each popup tab to the LinkedIn page it scans. Marked and Settings have
// no scan target — for those tabs the button is hidden.
const TAB_SCAN_TARGETS = {
  pending:  { url: SENT_URL,        source: 'sent',        gotoLabel: 'Go to Sent page' },
  accepted: { url: CONNECTIONS_URL, source: 'connections', gotoLabel: 'Go to Connections page' },
};

function activeTabName() {
  return document.querySelector('.tab.active')?.dataset.tab || 'pending';
}

async function updateScanButton() {
  const btn = $('open-sent');
  const hint = $('scan-hint');
  const target = TAB_SCAN_TARGETS[activeTabName()];

  btn.classList.remove('scanning', 'mode-scan', 'mode-goto');
  btn.disabled = false;

  if (!target) {
    // Marked / Settings — no scan applies, hide the button entirely
    btn.hidden = true;
    hint.hidden = true;
    return;
  }
  btn.hidden = false;

  const { scanInProgress } = await dbGet('scanInProgress');
  const isScanningThisSource = scanInProgress === target.source;
  hint.hidden = !isScanningThisSource;

  btn.dataset.target = target.url;
  btn.dataset.source = target.source;

  if (isScanningThisSource) {
    btn.classList.add('scanning', 'mode-scan');
    btn.textContent = 'Stop';
    btn.title = 'Click to cancel the scan';
    btn.dataset.mode = 'stop';
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onTargetPage = tab?.url?.startsWith(target.url);
  document.body.classList.toggle('is-on-sent', onTargetPage && target.source === 'sent');

  if (onTargetPage) {
    btn.classList.add('mode-scan');
    btn.textContent = 'Scan';
    btn.title = 'Start a scan of this page';
    btn.dataset.mode = 'scan';
  } else {
    btn.classList.add('mode-goto');
    btn.textContent = target.gotoLabel;
    btn.title = `Open ${target.gotoLabel.replace(/^Go to /, '')} on LinkedIn`;
    btn.dataset.mode = 'goto';
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'DB_CHANGED') return;
  const keys = msg.keys || [];
  const all = keys.includes('*');
  if (all || keys.includes('scanInProgress')) updateScanButton();
  if (all || keys.includes('contacts') || keys.includes('scanState')) loadData();
  if (all || keys.includes('visitQueueSimple')) renderBulkPanel();
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    switchTab(tab.dataset.tab);
    updateScanButton();
  });
});

$('open-sent').addEventListener('click', async () => {
  const btn = $('open-sent');
  const targetUrl = btn.dataset.target;
  if (!targetUrl) return;
  if (btn.dataset.mode === 'goto') {
    chrome.tabs.create({ url: targetUrl });
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith(targetUrl)) {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SCAN' });
  }
});

$('empty-open-sent').addEventListener('click', () => chrome.tabs.create({ url: SENT_URL }));
$('declined-warning-scan').addEventListener('click', () => chrome.tabs.create({ url: CONNECTIONS_URL }));
$('mark-all').addEventListener('click', markAllAccepted);
$('open-support').addEventListener('click', () => chrome.tabs.create({ url: SUPPORT_URL }));

const CONTACT_DETAIL_FIELDS = [
  'email', 'phone', 'phoneLabel',
  'website', 'websiteLabel', 'extraWebsites',
  'address', 'birthday', 'connectedSinceText',
  'contactsCapturedAt',
];

function stripContactFields(record) {
  let touched = false;
  for (const f of CONTACT_DETAIL_FIELDS) {
    if (record[f] !== undefined) { delete record[f]; touched = true; }
  }
  return touched;
}

async function forgetAllContactDetails() {
  const status = $('forget-status');
  status.classList.remove('error');
  const ok = window.confirm(
    'Wipe captured email/phone/website/address/birthday from every saved contact?\n\n'
    + 'Names, headlines, profile URLs and accepted/marked status are NOT affected. This cannot be undone.'
  );
  if (!ok) return;
  const { contacts = {} } = await dbGet('contacts');
  let touched = 0;
  for (const r of Object.values(contacts)) if (stripContactFields(r)) touched++;
  if (touched === 0) {
    status.textContent = 'No contact details were stored.';
    return;
  }
  await dbSet({ contacts });
  status.textContent = `Cleared contact details from ${touched} record(s).`;
  loadData();
}

$('forget-contacts').addEventListener('click', forgetAllContactDetails);
$('search').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  loadData();
});
$('export-csv').addEventListener('click', exportCsv);
$('export-json').addEventListener('click', exportJson);
$('tab-download').addEventListener('click', exportCurrentTab);
$('import-json').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) importJson(file);
});

loadData();
updateScanButton();

// ---------- Simplified Bulk Visit Queue (1.3.3) ----------
//
// Preview → Start → progress → Cancel. State machine lives in
// core/visit-queue-simple.js; storage key is `visitQueueSimple`. The
// driver is profile.js — it reads the queue at end of every capture
// tick and self-navigates window.location. Popup is view + control only.

function renderBulkPreview() {
  const textarea = $('bulk-textarea');
  const preview  = $('bulk-preview');
  const startBtn = $('bulk-start-btn');
  const hint     = $('bulk-hint');
  const result   = LITVisitQueueSimple.parseUrlList(textarea.value);
  preview.innerHTML = '';
  hint.hidden = true;
  if (result.valid.length === 0 && result.invalid.length === 0 && result.duplicates === 0) {
    startBtn.disabled = true;
    return;
  }
  const bits = [];
  if (result.valid.length)     bits.push(`${result.valid.length} valid`);
  if (result.invalid.length)   bits.push(`${result.invalid.length} rejected (not a profile URL)`);
  if (result.duplicates)       bits.push(`${result.duplicates} duplicate${result.duplicates === 1 ? '' : 's'} dropped`);
  preview.textContent = bits.join(' · ');
  startBtn.disabled = result.valid.length === 0;
  startBtn._parsedUrls = result.valid;
}

async function startBulkQueue() {
  const startBtn = $('bulk-start-btn');
  const urls = startBtn._parsedUrls;
  if (!Array.isArray(urls) || urls.length === 0) return;

  // Check that the user's current active tab is on LinkedIn — the queue
  // drives THAT tab via profile.js self-navigation. No new tab is opened.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onLinkedIn = tab?.url?.startsWith('https://www.linkedin.com/');
  if (!tab || !onLinkedIn) {
    const hint = $('bulk-hint');
    hint.hidden = false;
    hint.textContent = 'Open a LinkedIn tab first — the queue drives your current active tab.';
    return;
  }

  const queue = LITVisitQueueSimple.createQueue(urls, Date.now(), Math.floor(Math.random() * 1e9));
  await dbSet({ visitQueueSimple: queue });
  // Navigate the LinkedIn tab to the first URL — profile.js takes over
  // from there. Popup can be closed after this point.
  chrome.tabs.update(tab.id, { url: queue.urls[0] });
  await renderBulkPanel();
}

async function cancelBulkQueue() {
  const { visitQueueSimple: state } = await dbGet('visitQueueSimple');
  if (!state) return;
  await dbSet({ visitQueueSimple: LITVisitQueueSimple.cancelQueue(state) });
  // The queue driver in profile.js polls the cancel flag every ~1s and
  // clears the storage entry on next check. Popup's DB_CHANGED listener
  // will re-render when that happens.
}

async function renderBulkPanel() {
  const idle    = $('bulk-idle');
  const running = $('bulk-running');
  const list    = $('bulk-list');
  const title   = $('bulk-progress-title');
  const sub     = $('bulk-progress-sub');
  const { visitQueueSimple: state } = await dbGet('visitQueueSimple');
  const active = LITVisitQueueSimple.isActive(state);
  idle.hidden = active;
  running.hidden = !active;
  if (!active) return;
  const total = state.urls.length;
  const done  = state.capturedCount;
  const idx   = state.currentIndex;
  // ETA — remaining URLs * average per-URL time. Matches the actual
  // distribution params used by profile.js:runQueueTickIfApplicable
  // (log-normal dwell median 45s, exponential pause mean 60s → ~105s
  // per profile on average). Coarse estimate; real runs vary widely
  // because both distributions have fat right tails.
  const remaining = total - idx;
  const etaMs = remaining * 105_000;
  title.textContent = `${idx + 1} of ${total} · ${done} captured · ${LITPopupLogic.formatEta(etaMs)} remaining`;
  const started = new Date(state.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  sub.textContent = `Started ${started} · currently on ${state.urls[idx].replace(/^https?:\/\/(?:www\.)?linkedin\.com/, '')}`;
  list.innerHTML = '';
  for (let i = 0; i < state.urls.length; i++) {
    const status = i < idx ? 'done' : i === idx ? 'running' : 'queued';
    const icon   = status === 'done' ? '✓' : status === 'running' ? '●' : '○';
    const li = el('li', { className: `bulk-list-item bulk-${status}` }, [
      el('span', { className: 'bulk-list-icon' }, [icon]),
      el('span', { className: 'bulk-list-url' }, [state.urls[i].replace(/^https?:\/\/(?:www\.)?linkedin\.com/, '')]),
    ]);
    list.append(li);
  }
}

$('bulk-textarea').addEventListener('input', renderBulkPreview);
$('bulk-clear-btn').addEventListener('click', () => {
  $('bulk-textarea').value = '';
  renderBulkPreview();
});
$('bulk-start-btn').addEventListener('click', startBulkQueue);
$('bulk-cancel-btn').addEventListener('click', cancelBulkQueue);

// Initial render (queue may already be running from a previous popup session
// — the driver in profile.js keeps going even when the popup is closed).
// Live updates come via the DB_CHANGED broadcast above.
renderBulkPanel();
