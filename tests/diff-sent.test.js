import { describe, it, expect } from 'vitest';
import { diffSentInvitations } from '../linkedin-tracker/core/diff-sent.js';

const NOW = 1716624000000;
const DAY = 86400000;

function card(url, overrides = {}) {
  return {
    profileUrl: url,
    name: url.split('/in/')[1].replace(/\/$/, ''),
    headline: 'Headline',
    sentDateRelative: '2 days ago',
    avatar: '',
    ...overrides,
  };
}

// Build a v2-shaped `stored` from a per-URL record dict.
function storedV2(entries) {
  return { schemaVersion: 2, contacts: entries || {} };
}

describe('diffSentInvitations — fresh state', () => {
  it('adds every snapshot card as new status=pending', () => {
    const snapshot = [
      card('https://www.linkedin.com/in/a/'),
      card('https://www.linkedin.com/in/b/'),
    ];
    const r = diffSentInvitations(snapshot, storedV2(), NOW);
    expect(Object.keys(r.contacts)).toHaveLength(2);
    expect(r.contacts['https://www.linkedin.com/in/a/'].status).toBe('pending');
    expect(r.newlyPending).toHaveLength(2);
    expect(r.newlyAccepted).toHaveLength(0);
    expect(r.partial).toBe(false);
  });

  it('writes firstSeenAt and lastSeenAt = now on new pending records', () => {
    const r = diffSentInvitations([card('https://www.linkedin.com/in/a/')], storedV2(), NOW);
    const entry = r.contacts['https://www.linkedin.com/in/a/'];
    expect(entry.firstSeenAt).toBe(NOW);
    expect(entry.lastSeenAt).toBe(NOW);
  });
});

describe('diffSentInvitations — pending → accepted (missing from snapshot)', () => {
  const aUrl = 'https://www.linkedin.com/in/a/';
  const bUrl = 'https://www.linkedin.com/in/b/';

  it('flips a missing pending person to status=accepted, preserves firstSeenAt', () => {
    const stored = storedV2({
      [aUrl]: { profileUrl: aUrl, name: 'A', status: 'pending', firstSeenAt: NOW - 5 * DAY },
      [bUrl]: { profileUrl: bUrl, name: 'B', status: 'pending', firstSeenAt: NOW - 5 * DAY },
    });
    // b is missing in this scan → moved to accepted
    const r = diffSentInvitations([card(aUrl)], stored, NOW);
    expect(r.contacts[bUrl].status).toBe('accepted');
    expect(r.contacts[bUrl].acceptedAt).toBe(NOW);
    expect(r.contacts[bUrl].daysPending).toBe(5);
    expect(r.newlyAccepted).toHaveLength(1);
  });

  it('keeps a present person as status=pending, bumps lastSeenAt', () => {
    const stored = storedV2({
      [aUrl]: {
        profileUrl: aUrl, name: 'A', status: 'pending',
        firstSeenAt: NOW - 5 * DAY, lastSeenAt: NOW - 5 * DAY,
      },
    });
    const r = diffSentInvitations([card(aUrl)], stored, NOW);
    expect(r.contacts[aUrl].status).toBe('pending');
    expect(r.contacts[aUrl].lastSeenAt).toBe(NOW);
  });
});

describe('diffSentInvitations — sanity check (partial scan)', () => {
  it('skips missing→accepted when snapshot < 50% of previous pending count', () => {
    const prev = {};
    for (let i = 0; i < 20; i++) {
      const u = `https://www.linkedin.com/in/p${i}/`;
      prev[u] = { profileUrl: u, name: `P${i}`, status: 'pending', firstSeenAt: NOW - 3 * DAY };
    }
    // Snapshot sees only 5 — clearly a partial scroll, not 15 acceptances
    const snapshot = Object.values(prev).slice(0, 5).map((p) => card(p.profileUrl));
    const r = diffSentInvitations(snapshot, storedV2(prev), NOW);
    expect(r.partial).toBe(true);
    expect(r.newlyAccepted).toHaveLength(0);
    // The 20 pending records must remain as-is (all still status=pending)
    const stillPending = Object.values(r.contacts).filter((c) => c.status === 'pending');
    expect(stillPending).toHaveLength(20);
  });

  it('does NOT trip sanity check when only a few previous entries exist', () => {
    const prev = {};
    for (let i = 0; i < 4; i++) {
      const u = `https://www.linkedin.com/in/q${i}/`;
      prev[u] = { profileUrl: u, name: `Q${i}`, status: 'pending', firstSeenAt: NOW - 3 * DAY };
    }
    // SANITY_MIN_PREV is 5, so with prev=4 the sanity check is bypassed entirely
    const r = diffSentInvitations([], storedV2(prev), NOW);
    expect(r.partial).toBe(false);
    expect(r.newlyAccepted).toHaveLength(4);
  });

  it('sanity check ignores non-pending contacts when counting previous', () => {
    // If storage has 20 accepted + 3 pending, and snapshot is empty, that's
    // 3 → 0 transition — small numbers, sanity check doesn't fire.
    const prev = {};
    for (let i = 0; i < 20; i++) {
      const u = `https://www.linkedin.com/in/acc${i}/`;
      prev[u] = { profileUrl: u, status: 'accepted', acceptedAt: NOW - 30 * DAY };
    }
    for (let i = 0; i < 3; i++) {
      const u = `https://www.linkedin.com/in/pend${i}/`;
      prev[u] = { profileUrl: u, status: 'pending', firstSeenAt: NOW - 2 * DAY };
    }
    const r = diffSentInvitations([], storedV2(prev), NOW);
    expect(r.partial).toBe(false);
    expect(r.newlyAccepted).toHaveLength(3);
  });
});

describe('diffSentInvitations — withdrawn flag (P0.2)', () => {
  const url = 'https://www.linkedin.com/in/with/';

  it('recently withdrawn entries land as status=declined, not accepted', () => {
    const stored = storedV2({
      [url]: {
        profileUrl: url, name: 'W', status: 'pending', firstSeenAt: NOW - 10 * DAY,
        withdrawnAt: NOW - 1 * DAY,
      },
    });
    const r = diffSentInvitations([], stored, NOW);
    expect(r.contacts[url].status).toBe('declined');
    expect(r.contacts[url].declinedAt).toBe(NOW - 1 * DAY);
    expect(r.newlyAccepted).toHaveLength(0);
  });

  it('falls back to accepted classification once withdrawnAt is older than 7 days', () => {
    const stored = storedV2({
      [url]: {
        profileUrl: url, name: 'W', status: 'pending', firstSeenAt: NOW - 30 * DAY,
        withdrawnAt: NOW - 14 * DAY,
      },
    });
    const r = diffSentInvitations([], stored, NOW);
    expect(r.contacts[url].status).toBe('accepted');
  });
});

describe('diffSentInvitations — scanHistory', () => {
  it('appends a scanHistory entry with timestamp + counts', () => {
    const r = diffSentInvitations([card('https://www.linkedin.com/in/a/')], storedV2(), NOW);
    expect(r.scanHistory).toHaveLength(1);
    expect(r.scanHistory[0]).toMatchObject({
      timestamp: NOW, pendingCount: 1, newAccepted: 0,
    });
  });

  it('caps history at 100 entries (FIFO)', () => {
    const old = Array.from({ length: 100 }, (_, i) => ({
      timestamp: NOW - (100 - i) * DAY, pendingCount: i, newAccepted: 0,
    }));
    const r = diffSentInvitations([], { schemaVersion: 2, contacts: {}, scanHistory: old }, NOW);
    expect(r.scanHistory).toHaveLength(100);
    expect(r.scanHistory[r.scanHistory.length - 1].timestamp).toBe(NOW);
    expect(r.scanHistory[0].timestamp).toBe(NOW - 99 * DAY);
  });
});

describe('diffSentInvitations — re-invite of a declined person', () => {
  const url = 'https://www.linkedin.com/in/reinvite/';

  it('seeing a previously-declined entry on /sent/ flips it back to pending, clears declinedAt', () => {
    const stored = storedV2({
      [url]: {
        profileUrl: url, name: 'R', status: 'declined',
        firstSeenAt: NOW - 60 * DAY, declinedAt: NOW - 20 * DAY,
      },
    });
    const r = diffSentInvitations([card(url)], stored, NOW);
    expect(r.contacts[url].status).toBe('pending');
    expect(r.contacts[url].declinedAt).toBeNull();
  });
});
