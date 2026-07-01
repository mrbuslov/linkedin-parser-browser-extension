// Pure diff for the /sent/ scan (v2 unified store).
//
// Input:
//   - snapshot: array of pending-card records currently visible on the page
//   - stored:   the whole IDB snapshot (v2 shape: { contacts, schemaVersion, ... })
//   - now:      Date.now()
// Output:
//   - contacts:    updated unified dict (status transitions applied)
//   - scanHistory: appended tick record (capped at 100)
//   - newlyAccepted: records that just flipped pending → accepted
//   - newlyPending:  records that just appeared in pending
//   - pendingCount: raw snapshot size
//   - partial:     true if the sanity check kicked in and we refused to
//                  move missing → accepted (partial scroll etc.)
//
// Sanity check: if we used to track many invites and this scan saw far
// fewer, it's almost certainly a partial scroll, not 100+ people accepting
// at once. Skip the "missing = accepted" move in that case.

const DAY_MS = 86400000;
const SANITY_SHRINK_RATIO = 0.5;
const SANITY_MIN_PREV = 5;

const STATUS = {
  PENDING:  'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  VISITED:  'visited',
};

function diffSentInvitations(snapshot, stored, now) {
  const contacts = { ...(stored.contacts || {}) };
  const history = (stored.scanHistory || []).slice();
  const newlyAccepted = [];
  const newlyPending = [];

  const currentUrls = new Set(snapshot.map((x) => x.profileUrl));

  // Count how many entries are currently PENDING in the unified store —
  // that's the "prev" count for the sanity check.
  const prevPending = Object.values(contacts).filter((r) => r.status === STATUS.PENDING);
  const prevCount = prevPending.length;
  const partial = prevCount > SANITY_MIN_PREV && snapshot.length < prevCount * SANITY_SHRINK_RATIO;

  if (!partial) {
    // Any URL that was pending in storage but is NOT in this snapshot has
    // either (a) been accepted (LinkedIn removed the card once the
    // connection was accepted) or (b) been withdrawn recently by the user.
    for (const item of prevPending) {
      const url = item.profileUrl;
      if (currentUrls.has(url)) continue;
      if (item.withdrawnAt && (now - item.withdrawnAt) < 7 * DAY_MS) {
        // Recent withdraw — the card disappeared from /sent/ because the
        // user clicked Withdraw, NOT because it was accepted. Move to
        // status='declined' so it doesn't clutter Pending but doesn't
        // wrongly claim they accepted.
        contacts[url] = {
          ...item,
          status: STATUS.DECLINED,
          declinedAt: item.withdrawnAt,
        };
        continue;
      }
      const entry = {
        ...item,
        status: STATUS.ACCEPTED,
        acceptedAt: now,
        verifiedAt: null, // not verified via /connections/ yet — just /sent/ disappearance
        daysPending: Math.floor((now - item.firstSeenAt) / DAY_MS),
      };
      contacts[url] = entry;
      newlyAccepted.push(entry);
    }
  }

  for (const item of snapshot) {
    const existing = contacts[item.profileUrl];
    if (existing) {
      // Refresh visible /sent/ fields; do NOT change status if it's already
      // pending — but if the record was in another status (visited, declined),
      // seeing it on /sent/ means there's a fresh outstanding invite.
      existing.status = STATUS.PENDING;
      existing.lastSeenAt = now;
      existing.sentDateRelative = item.sentDateRelative || existing.sentDateRelative;
      existing.name = item.name || existing.name;
      existing.headline = item.headline || existing.headline;
      existing.avatar = item.avatar || existing.avatar;
      // Clear declined markers when re-inviting
      if (existing.declinedAt) existing.declinedAt = null;
    } else {
      contacts[item.profileUrl] = {
        ...item,
        status: STATUS.PENDING,
        firstSeenAt: now,
        lastSeenAt: now,
        visitedAt: now,
        notes: '',
        tags: [],
        addedFrom: 'sent-page',
      };
      newlyPending.push(contacts[item.profileUrl]);
    }
  }

  const newHistory = [
    ...history,
    { timestamp: now, pendingCount: snapshot.length, newAccepted: newlyAccepted.length },
  ].slice(-100);

  return {
    contacts,
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
