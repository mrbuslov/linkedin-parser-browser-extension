// Pure merge for the /mynetwork/invite-connect/connections/ scan (v2).
//
// The scanner gives us name + profileUrl + headline + avatar + LinkedIn-
// provided `connectedAt` for every visible card. That date is CANONICAL —
// it overrides our /sent/-based guesses and the resulting record is
// immune to future not_connected downgrades (via connectedOnText guard).
//
// Auto-mark policy removed in 1.2.5: brand-new discoveries from the
// connections scan are NOT auto-marked anymore. They land in Accepted
// (marked=false) so the user sees them; the "Mark all" button covers
// the pre-install backlog case.

const DAY_MS = 86400000;

const STATUS = {
  ACCEPTED: 'accepted',
};

function mergeConnections(snapshot, stored, now) {
  const contacts = { ...(stored.contacts || {}) };
  let touched = 0;

  for (const item of snapshot) {
    if (!item || !item.profileUrl) continue;

    const existing = contacts[item.profileUrl];
    const linkedinAcceptedAt = item.connectedAt || existing?.acceptedAt || now;
    const firstSeenAt = existing?.firstSeenAt || linkedinAcceptedAt;

    contacts[item.profileUrl] = {
      ...(existing || {}),
      profileUrl: item.profileUrl,
      name: item.name || existing?.name || '',
      headline: item.headline || existing?.headline || '',
      avatar: item.avatar || existing?.avatar || '',
      status: STATUS.ACCEPTED,
      acceptedAt: linkedinAcceptedAt,
      declinedAt: null,
      firstSeenAt,
      visitedAt: existing?.visitedAt || now,
      daysPending: Math.floor((linkedinAcceptedAt - firstSeenAt) / DAY_MS),
      marked: existing?.marked || false,
      markedAt: existing?.markedAt || null,
      favorite: existing?.favorite || false,
      favoritedAt: existing?.favoritedAt || null,
      verifiedAt: now,
      connectedOnText: item.dateText || existing?.connectedOnText || '',
      connectedOnDate: item.dateText ? (item.connectedAt || null) : (existing?.connectedOnDate || null),
      addedFrom: existing?.addedFrom || 'connections-page',
    };
    touched++;
  }

  return { contacts, touched };
}

const LITMergeConnections = { mergeConnections, DAY_MS };
if (typeof globalThis !== 'undefined') globalThis.LITMergeConnections = LITMergeConnections;
if (typeof module !== 'undefined' && module.exports) module.exports = LITMergeConnections;
