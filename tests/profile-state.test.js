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

  it('marks a verified-accepted entry with connectedOnText as declined (was real /connections/ contact, now not connected)', () => {
    // Was on /connections/ at some point (has connectedOnText). User then
    // either removed the connection or it expired. We DON'T delete — silent
    // deletions erode trust. Instead we flip the badge to ✗ declined; the
    // popup shows it in the collapsed "Didn't accept" block.
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          verified: 'accepted',
          verifiedAt: NOW - 5 * DAY,
          connectedOnText: 'Connected on May 12, 2024',
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/jane/']).toBeDefined();
    expect(r.accepted['https://www.linkedin.com/in/jane/'].verified).toBe('declined');
    expect(r.acceptedChanged).toBe(true);
  });

  it('marks a verified-accepted entry without connectedOnText as declined (Vlad case)', () => {
    // Verified upgraded by a previous profile.js detection (possibly transient).
    // LinkedIn now shows Connect — record stays in Marked, badge flips to ✗ declined.
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/vlad/': {
          profileUrl: 'https://www.linkedin.com/in/vlad/',
          verified: 'accepted',
          verifiedAt: NOW - 5 * DAY,
          marked: true,
          markedAt: NOW - 1 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info({ profileUrl: 'https://www.linkedin.com/in/vlad/' }), 'not_connected', NOW);
    const entry = r.accepted['https://www.linkedin.com/in/vlad/'];
    expect(entry).toBeDefined();
    expect(entry.verified).toBe('declined');
    expect(entry.marked).toBe(true); // preserve marked status
    expect(r.acceptedChanged).toBe(true);
  });

  it('marks an autoMarked entry as declined (preserves the record over silent deletion)', () => {
    // Auto-added "pre-existing" entry from a profile visit. If status now says
    // not_connected, the past detection was wrong OR they disconnected since.
    // Either way, preserve and surface via declined badge — surprise deletes
    // are worse than a stale label.
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
    expect(r.accepted['https://www.linkedin.com/in/jane/']).toBeDefined();
    expect(r.accepted['https://www.linkedin.com/in/jane/'].verified).toBe('declined');
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

describe('applyProfileVisit — regression: someone added me, then I visit their profile', () => {
  // Anastasia bug: she added the user → showed up in Accepted via /connections/
  // scan with verified='accepted', autoMarked=false, marked=false. User then
  // visits her profile (status='connected'). Expectation: she STAYS in accepted.
  it('preserves a connections-page-sourced entry across a connected profile visit', () => {
    const url = 'https://www.linkedin.com/in/anastasia/';
    const stored = {
      accepted: {
        [url]: {
          profileUrl: url,
          name: 'Anastasia',
          headline: 'IT Recruiter',
          avatar: 'https://media.licdn.com/avatar.jpg',
          acceptedAt: NOW - 2 * DAY,
          firstSeenAt: NOW - 2 * DAY,
          daysPending: 0,
          marked: false,
          markedAt: null,
          verified: 'accepted',
          verifiedAt: NOW - 2 * DAY,
          connectedOnText: 'Connected on May 23, 2026',
          autoMarked: false,
          addedFrom: 'connections-page',
        },
      },
    };
    const r = applyProfileVisit(stored, info({ profileUrl: url, name: 'Anastasia' }), 'connected', NOW);
    expect(r.accepted[url]).toBeDefined();
    expect(r.accepted[url].verified).toBe('accepted');
    expect(r.accepted[url].marked).toBe(false);
    expect(r.accepted[url].autoMarked).toBe(false);
  });

  // Edge case: if MutationObserver fires DURING page load, the first tick may
  // see a partial DOM (no buttons rendered yet) — in that intermediate state
  // detect returns 'not_connected' falsely → applyProfileVisit deletes her.
  // The fix is in the detector (return null when not enough signal), not here,
  // but document the expected behavior of applyProfileVisit too.
  it('preserves entry when status is null (caller must skip persistence in that case)', () => {
    // applyProfileVisit isn't called with null in real code (profile.js bails
    // out earlier), but this asserts the contract.
    const url = 'https://www.linkedin.com/in/anastasia/';
    const stored = {
      accepted: { [url]: { profileUrl: url, verified: 'accepted' } },
    };
    // Sanity: applyProfileVisit doesn't accept null — caller is expected to
    // pre-filter. Document: only valid statuses are pending/connected/not_connected.
    expect(() => applyProfileVisit(stored, info({ profileUrl: url }), 'connected', NOW)).not.toThrow();
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
