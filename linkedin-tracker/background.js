// Service worker. Receives SCAN_DONE messages from content.js, updates the
// toolbar badge (= pending count of accepted that still need a welcome), and
// pops a desktop notification when new connects come in.

async function refreshBadge() {
  const { accepted = {} } = await chrome.storage.local.get('accepted');
  const unmarked = Object.values(accepted)
    .filter((x) => !x.marked && !x.welcomeMessageSent && x.verified !== 'declined')
    .length;
  await chrome.action.setBadgeText({ text: unmarked > 0 ? String(unmarked) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#0a66c2' });
}

function notifyNewlyAccepted(newlyAccepted) {
  if (!newlyAccepted || newlyAccepted.length === 0) return;
  const first = newlyAccepted[0];
  const title = newlyAccepted.length === 1
    ? `${first.name} accepted your invite`
    : `${newlyAccepted.length} new connections accepted`;
  const message = newlyAccepted.length === 1
    ? 'Time to write a welcome message.'
    : `Including ${first.name}${newlyAccepted.length > 1 ? ` and ${newlyAccepted.length - 1} more` : ''}.`;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
    priority: 1,
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'SCAN_DONE') {
    notifyNewlyAccepted(msg.newlyAccepted);
    refreshBadge();
  }
  if (msg?.type === 'REFRESH_BADGE') {
    refreshBadge();
  }
});

chrome.runtime.onInstalled.addListener(() => refreshBadge());
chrome.runtime.onStartup.addListener(() => refreshBadge());
