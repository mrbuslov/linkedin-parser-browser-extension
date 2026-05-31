// Pure merge for the /mynetwork/invite-connect/connections/ scan. The scanner
// gives us name + profileUrl + headline + avatar + LinkedIn-provided
// `connectedAt` for every visible card. We treat that date as canonical
// (overrides our /sent/-based guesses) and clear any stale autoMarked flag.

const DAY_MS = 86400000;

function mergeConnections(snapshot, stored, now) {
  const accepted = { ...(stored.accepted || {}) };
  const sentInvitations = { ...(stored.sentInvitations || {}) };
  let touched = 0;

  for (const item of snapshot) {
    if (!item || !item.profileUrl) continue;

    const existing = accepted[item.profileUrl];
    const wasInSent = !!sentInvitations[item.profileUrl];

    // LinkedIn confirms they're connected → remove from sentInvitations.
    if (wasInSent) {
      delete sentInvitations[item.profileUrl];
    }

    // "Pre-existing discovery": we've never tracked this person before (not
    // in accepted, not in sentInvitations) and we just discovered them via
    // the canonical /connections/ scan. They're a legacy connection — not
    // someone the user just sent an invite to and is waiting to handle.
    // Auto-mark so they don't pollute the "N to handle" count in Accepted.
    //
    // Subsequent rescans preserve marked state via `existing?.marked ?? ...`,
    // so a user who manually unmarked an auto-marked entry stays unmarked.
    const isPreExistingDiscovery = !existing && !wasInSent;

    const linkedinAcceptedAt = item.connectedAt || existing?.acceptedAt || now;
    const firstSeenAt = existing?.firstSeenAt || linkedinAcceptedAt;

    accepted[item.profileUrl] = {
      ...(existing || {}),
      profileUrl: item.profileUrl,
      name: item.name || existing?.name || '',
      headline: item.headline || existing?.headline || '',
      avatar: item.avatar || existing?.avatar || '',
      acceptedAt: linkedinAcceptedAt,
      firstSeenAt,
      daysPending: Math.floor((linkedinAcceptedAt - firstSeenAt) / DAY_MS),
      marked: existing?.marked ?? isPreExistingDiscovery,
      markedAt: existing?.markedAt ?? (isPreExistingDiscovery ? now : null),
      verified: 'accepted',
      verifiedAt: now,
      connectedOnText: item.dateText || existing?.connectedOnText || '',
      autoMarked: existing?.autoMarked ?? isPreExistingDiscovery,
      addedFrom: existing?.addedFrom || 'connections-page',
    };
    touched++;
  }

  return { accepted, sentInvitations, touched };
}

const LITMergeConnections = { mergeConnections, DAY_MS };
if (typeof globalThis !== 'undefined') globalThis.LITMergeConnections = LITMergeConnections;
if (typeof module !== 'undefined' && module.exports) module.exports = LITMergeConnections;
