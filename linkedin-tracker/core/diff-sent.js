// Pure diff for the /sent/ scan. Takes a snapshot (current list of pending
// cards on the page), the previously stored state, and a clock value; returns
// the new state plus what changed. No DOM, no IDB, no chrome.runtime — fully
// testable in Node.
//
// Sanity check: if we used to track many invites and this scan saw far fewer,
// it's almost certainly a partial scroll, not 100+ people accepting at once.
// Skip the "missing = accepted" move in that case to avoid false positives.

const DAY_MS = 86400000;
const SANITY_SHRINK_RATIO = 0.5;
const SANITY_MIN_PREV = 5;

function diffSentInvitations(snapshot, stored, now) {
  const pending = { ...(stored.sentInvitations || {}) };
  const accepted = { ...(stored.accepted || {}) };
  const history = (stored.scanHistory || []).slice();
  const newlyAccepted = [];
  const newlyPending = [];

  const currentUrls = new Set(snapshot.map((x) => x.profileUrl));
  const prevCount = Object.keys(pending).length;
  const partial = prevCount > SANITY_MIN_PREV && snapshot.length < prevCount * SANITY_SHRINK_RATIO;

  if (!partial) {
    for (const [url, item] of Object.entries(pending)) {
      if (currentUrls.has(url)) continue;
      // Respect withdrawn flag set by the click listener (P0.2). If user
      // explicitly withdrew the invite on /sent/, the card vanishes from the
      // page just like accepted ones — without this flag we'd misclassify.
      if (item.withdrawnAt && (now - item.withdrawnAt) < 7 * DAY_MS) {
        // Leave the entry as-is — caller can surface it from a `withdrawn` view
        // if desired, but it should NOT become "accepted". Delete from pending
        // so it stops cluttering that view.
        delete pending[url];
        continue;
      }
      const entry = {
        ...item,
        acceptedAt: now,
        daysPending: Math.floor((now - item.firstSeenAt) / DAY_MS),
        marked: false,
        markedAt: null,
        verified: null,
      };
      accepted[url] = entry;
      newlyAccepted.push(entry);
      delete pending[url];
    }
  }

  for (const item of snapshot) {
    const existing = pending[item.profileUrl];
    if (existing) {
      existing.lastSeenAt = now;
      existing.sentDateRelative = item.sentDateRelative || existing.sentDateRelative;
      existing.name = item.name || existing.name;
      existing.headline = item.headline || existing.headline;
      existing.avatar = item.avatar || existing.avatar;
    } else {
      pending[item.profileUrl] = {
        ...item,
        firstSeenAt: now,
        lastSeenAt: now,
        notes: '',
        tags: [],
      };
      newlyPending.push(pending[item.profileUrl]);
    }
  }

  const newHistory = [
    ...history,
    { timestamp: now, pendingCount: snapshot.length, newAccepted: newlyAccepted.length },
  ].slice(-100);

  return {
    sentInvitations: pending,
    accepted,
    scanHistory: newHistory,
    newlyAccepted,
    newlyPending,
    pendingCount: snapshot.length,
    partial,
  };
}

const LITDiffSent = { diffSentInvitations, DAY_MS, SANITY_SHRINK_RATIO };
if (typeof globalThis !== 'undefined') globalThis.LITDiffSent = LITDiffSent;
if (typeof module !== 'undefined' && module.exports) module.exports = LITDiffSent;
