import { describe, it, expect } from 'vitest';
import { applyProfileVisit } from '../linkedin-tracker/core/profile-state.js';

const NOW = 1716624000000; // 2024-05-25T08:00:00Z, fixed for determinism
const DAY = 86400000;

function info(overrides = {}) {
  return {
    profileUrl: 'https://www.linkedin.com/in/jane/',
    name: 'Jane Doe',
    headline: 'Engineer',
    avatar: 'https://media.licdn.com/profile-displayphoto/jane.jpg',
    location: 'Berlin, Germany',
    country: 'Germany',
    ...overrides,
  };
}

describe('applyProfileVisit — contacts (always touched)', () => {
  it('creates a contacts entry on first visit', () => {
    const r = applyProfileVisit({}, info(), 'connected', NOW);
    expect(r.contacts['https://www.linkedin.com/in/jane/']).toMatchObject({
      name: 'Jane Doe',
      headline: 'Engineer',
      country: 'Germany',
      connected: true,
      visitedAt: NOW,
      firstSeenAt: NOW,
    });
  });

  it('preserves firstSeenAt across subsequent visits', () => {
    const stored = {
      contacts: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          firstSeenAt: NOW - 10 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    expect(r.contacts['https://www.linkedin.com/in/jane/'].firstSeenAt).toBe(NOW - 10 * DAY);
    expect(r.contacts['https://www.linkedin.com/in/jane/'].visitedAt).toBe(NOW);
  });

  it('sets connected=false in contacts when status is not_connected', () => {
    const r = applyProfileVisit({}, info(), 'not_connected', NOW);
    expect(r.contacts['https://www.linkedin.com/in/jane/'].connected).toBe(false);
  });
});

describe('applyProfileVisit — status:pending', () => {
  it('adds to sentInvitations when not in any bucket', () => {
    const r = applyProfileVisit({}, info(), 'pending', NOW);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/']).toMatchObject({
      profileUrl: 'https://www.linkedin.com/in/jane/',
      name: 'Jane Doe',
      addedFrom: 'profile',
      firstSeenAt: NOW,
    });
    expect(r.accepted).toEqual({});
    expect(r.sentChanged).toBe(true);
  });

  it('updates existing sentInvitations entry (lastSeenAt bumped)', () => {
    const stored = {
      sentInvitations: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          name: 'Old Name',
          firstSeenAt: NOW - 5 * DAY,
          lastSeenAt: NOW - 5 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'pending', NOW);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/'].lastSeenAt).toBe(NOW);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/'].firstSeenAt).toBe(NOW - 5 * DAY);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/'].name).toBe('Jane Doe');
  });

  it('drops a stale accepted entry when status flips to pending (re-invite case)', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          verified: 'declined',
          acceptedAt: NOW - 30 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'pending', NOW);
    expect(r.accepted['https://www.linkedin.com/in/jane/']).toBeUndefined();
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/']).toBeDefined();
    expect(r.acceptedChanged).toBe(true);
    expect(r.sentChanged).toBe(true);
  });
});

describe('applyProfileVisit — status:connected', () => {
  it('auto-marks a brand-new connection as pre-existing contact', () => {
    const r = applyProfileVisit({}, info(), 'connected', NOW);
    const a = r.accepted['https://www.linkedin.com/in/jane/'];
    expect(a).toMatchObject({
      verified: 'accepted',
      autoMarked: true,
      marked: true,
      acceptedAt: NOW,
      daysPending: 0,
    });
  });

  it('promotes pending → accepted preserving firstSeenAt for daysPending calculation', () => {
    const stored = {
      sentInvitations: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          name: 'Jane Doe',
          firstSeenAt: NOW - 5 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/']).toBeUndefined();
    const a = r.accepted['https://www.linkedin.com/in/jane/'];
    expect(a.daysPending).toBe(5);
    expect(a.acceptedAt).toBe(NOW);
    expect(a.verified).toBe('accepted');
    expect(a.autoMarked).toBeUndefined();
  });

  it('upgrades verified:null → verified:accepted on an existing accepted entry', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          verified: null,
          acceptedAt: NOW - 2 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/jane/'].verified).toBe('accepted');
    expect(r.acceptedChanged).toBe(true);
  });

  it('upgrades verified:declined → verified:accepted (user changed mind)', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          verified: 'declined',
          acceptedAt: NOW - 10 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/jane/'].verified).toBe('accepted');
  });
});

describe('applyProfileVisit — status:not_connected', () => {
  it('no-op when profile never tracked', () => {
    const r = applyProfileVisit({}, info(), 'not_connected', NOW);
    expect(r.accepted).toEqual({});
    expect(r.sentInvitations).toEqual({});
    expect(r.acceptedChanged).toBe(false);
    expect(r.sentChanged).toBe(false);
  });

  it('removes from sentInvitations (user withdrew on the profile page)', () => {
    const stored = {
      sentInvitations: {
        'https://www.linkedin.com/in/jane/': { profileUrl: 'https://www.linkedin.com/in/jane/' },
      },
    };
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/']).toBeUndefined();
    expect(r.sentChanged).toBe(true);
  });

  it('DELETES (not declines) a confirmed-accepted entry when no longer connected (user removed connection)', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          verified: 'accepted',
          verifiedAt: NOW - 5 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/jane/']).toBeUndefined();
    expect(r.acceptedChanged).toBe(true);
  });

  it('DELETES an autoMarked entry that was never a real connection', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          autoMarked: true,
          verified: 'accepted',
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/jane/']).toBeUndefined();
  });

  it('marks verified:declined when entry was tracked via /sent/ but never confirmed', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          verified: null,
          acceptedAt: NOW - 7 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/jane/'].verified).toBe('declined');
    expect(r.acceptedChanged).toBe(true);
  });

  it('no-op when entry already verified:declined', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          verified: 'declined',
          verifiedAt: NOW - 1 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    expect(r.acceptedChanged).toBe(false);
  });
});

describe('applyProfileVisit — invariants', () => {
  it('"one bucket at a time" — pending visit clears accepted, never both', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': { profileUrl: 'https://www.linkedin.com/in/jane/' },
      },
    };
    const r = applyProfileVisit(stored, info(), 'pending', NOW);
    const inAccepted = !!r.accepted['https://www.linkedin.com/in/jane/'];
    const inSent = !!r.sentInvitations['https://www.linkedin.com/in/jane/'];
    expect(inAccepted && inSent).toBe(false);
    expect(inSent).toBe(true);
  });

  it('"one bucket at a time" — connected visit clears sentInvitations', () => {
    const stored = {
      sentInvitations: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          firstSeenAt: NOW - 3 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/']).toBeUndefined();
    expect(r.accepted['https://www.linkedin.com/in/jane/']).toBeDefined();
  });
});
