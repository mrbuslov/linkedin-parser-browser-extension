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

describe('diffSentInvitations — fresh state', () => {
  it('adds every snapshot card as new pending', () => {
    const snapshot = [
      card('https://www.linkedin.com/in/a/'),
      card('https://www.linkedin.com/in/b/'),
    ];
    const r = diffSentInvitations(snapshot, {}, NOW);
    expect(Object.keys(r.sentInvitations)).toHaveLength(2);
    expect(r.newlyPending).toHaveLength(2);
    expect(r.newlyAccepted).toHaveLength(0);
    expect(r.partial).toBe(false);
  });

  it('writes firstSeenAt and lastSeenAt = now', () => {
    const r = diffSentInvitations([card('https://www.linkedin.com/in/a/')], {}, NOW);
    const entry = r.sentInvitations['https://www.linkedin.com/in/a/'];
    expect(entry.firstSeenAt).toBe(NOW);
    expect(entry.lastSeenAt).toBe(NOW);
  });
});

describe('diffSentInvitations — missing → accepted', () => {
  const aUrl = 'https://www.linkedin.com/in/a/';
  const bUrl = 'https://www.linkedin.com/in/b/';

  it('moves a missing person from pending to accepted', () => {
    const stored = {
      sentInvitations: {
        [aUrl]: { profileUrl: aUrl, name: 'A', firstSeenAt: NOW - 5 * DAY },
        [bUrl]: { profileUrl: bUrl, name: 'B', firstSeenAt: NOW - 5 * DAY },
      },
    };
    // b is missing in this scan → moved to accepted
    const r = diffSentInvitations([card(aUrl)], stored, NOW);
    expect(r.sentInvitations[bUrl]).toBeUndefined();
    expect(r.accepted[bUrl]).toMatchObject({ acceptedAt: NOW, daysPending: 5 });
    expect(r.newlyAccepted).toHaveLength(1);
  });

  it('keeps a present person in pending', () => {
    const stored = {
      sentInvitations: {
        [aUrl]: {
          profileUrl: aUrl, name: 'A',
          firstSeenAt: NOW - 5 * DAY, lastSeenAt: NOW - 5 * DAY,
        },
      },
    };
    const r = diffSentInvitations([card(aUrl)], stored, NOW);
    expect(r.sentInvitations[aUrl].lastSeenAt).toBe(NOW);
    expect(r.accepted[aUrl]).toBeUndefined();
  });
});

describe('diffSentInvitations — sanity check (partial scan)', () => {
  it('skips missing→accepted when snapshot < 50% of previous pending count', () => {
    const prev = {};
    for (let i = 0; i < 20; i++) {
      const u = `https://www.linkedin.com/in/p${i}/`;
      prev[u] = { profileUrl: u, name: `P${i}`, firstSeenAt: NOW - 3 * DAY };
    }
    // snapshot only sees 5 — clearly a partial scroll, not 15 acceptances
    const snapshot = Object.values(prev).slice(0, 5).map((p) => card(p.profileUrl));
    const r = diffSentInvitations(snapshot, { sentInvitations: prev }, NOW);
    expect(r.partial).toBe(true);
    expect(r.newlyAccepted).toHaveLength(0);
    // The 15 missing ones must still be in pending
    expect(Object.keys(r.sentInvitations)).toHaveLength(20);
  });

  it('does NOT trip sanity check when only a few previous entries exist', () => {
    const prev = {};
    for (let i = 0; i < 4; i++) {
      const u = `https://www.linkedin.com/in/q${i}/`;
      prev[u] = { profileUrl: u, name: `Q${i}`, firstSeenAt: NOW - 3 * DAY };
    }
    // SANITY_MIN_PREV is 5, so with prev=4 the sanity check is bypassed entirely
    const r = diffSentInvitations([], { sentInvitations: prev }, NOW);
    expect(r.partial).toBe(false);
    expect(r.newlyAccepted).toHaveLength(4);
  });
});

describe('diffSentInvitations — withdrawn flag (P0.2)', () => {
  const url = 'https://www.linkedin.com/in/with/';

  it('does NOT move recently withdrawn entries to accepted', () => {
    const stored = {
      sentInvitations: {
        [url]: {
          profileUrl: url, name: 'W', firstSeenAt: NOW - 10 * DAY,
          withdrawnAt: NOW - 1 * DAY,
        },
      },
    };
    const r = diffSentInvitations([], stored, NOW);
    expect(r.accepted[url]).toBeUndefined();
    expect(r.sentInvitations[url]).toBeUndefined();
    expect(r.newlyAccepted).toHaveLength(0);
  });

  it('falls back to accepted classification once withdrawnAt is older than 7 days', () => {
    const stored = {
      sentInvitations: {
        [url]: {
          profileUrl: url, name: 'W', firstSeenAt: NOW - 30 * DAY,
          withdrawnAt: NOW - 14 * DAY,
        },
      },
    };
    const r = diffSentInvitations([], stored, NOW);
    expect(r.accepted[url]).toBeDefined();
  });
});

describe('diffSentInvitations — scanHistory', () => {
  it('appends a scanHistory entry with timestamp + counts', () => {
    const r = diffSentInvitations([card('https://www.linkedin.com/in/a/')], {}, NOW);
    expect(r.scanHistory).toHaveLength(1);
    expect(r.scanHistory[0]).toMatchObject({
      timestamp: NOW, pendingCount: 1, newAccepted: 0,
    });
  });

  it('caps history at 100 entries (FIFO)', () => {
    const old = Array.from({ length: 100 }, (_, i) => ({
      timestamp: NOW - (100 - i) * DAY, pendingCount: i, newAccepted: 0,
    }));
    const r = diffSentInvitations([], { scanHistory: old }, NOW);
    expect(r.scanHistory).toHaveLength(100);
    expect(r.scanHistory[r.scanHistory.length - 1].timestamp).toBe(NOW);
    // oldest entry should have been evicted
    expect(r.scanHistory[0].timestamp).toBe(NOW - 99 * DAY);
  });
});
