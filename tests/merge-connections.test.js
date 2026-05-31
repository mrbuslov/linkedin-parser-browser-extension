import { describe, it, expect } from 'vitest';
import { mergeConnections } from '../linkedin-tracker/core/merge-connections.js';

const NOW = 1716624000000;
const DAY = 86400000;

function item(url, overrides = {}) {
  return {
    profileUrl: url,
    name: url.split('/in/')[1].replace(/\/$/, ''),
    headline: 'Headline',
    avatar: '',
    connectedAt: NOW - 30 * DAY,
    dateText: 'Connected on Apr 25, 2024',
    ...overrides,
  };
}

describe('mergeConnections', () => {
  it('adds every connection to accepted with verified=accepted', () => {
    const r = mergeConnections([item('https://www.linkedin.com/in/a/')], {}, NOW);
    const a = r.accepted['https://www.linkedin.com/in/a/'];
    expect(a.verified).toBe('accepted');
    expect(a.verifiedAt).toBe(NOW);
    expect(a.acceptedAt).toBe(NOW - 30 * DAY);
    expect(a.addedFrom).toBe('connections-page');
    expect(r.touched).toBe(1);
  });

  it('removes promoted profiles from sentInvitations', () => {
    const url = 'https://www.linkedin.com/in/a/';
    const stored = {
      sentInvitations: { [url]: { profileUrl: url, firstSeenAt: NOW - 30 * DAY } },
    };
    const r = mergeConnections([item(url)], stored, NOW);
    expect(r.sentInvitations[url]).toBeUndefined();
    expect(r.accepted[url]).toBeDefined();
  });

  it('uses LinkedIn-provided connectedAt over our previous guess', () => {
    const url = 'https://www.linkedin.com/in/a/';
    const stored = {
      accepted: {
        [url]: {
          profileUrl: url, name: 'A',
          acceptedAt: NOW - 10 * DAY, // our /sent/ guess
          firstSeenAt: NOW - 20 * DAY,
        },
      },
    };
    const r = mergeConnections([item(url, { connectedAt: NOW - 50 * DAY })], stored, NOW);
    expect(r.accepted[url].acceptedAt).toBe(NOW - 50 * DAY);
  });

  it('REGRESSION (Dmitry "560 to handle" bug): auto-marks pre-existing connections never tracked via /sent/', () => {
    // User scans /connections/ for the first time. Their 600 legacy connections
    // all land in accepted — but those are pre-existing contacts, not people
    // who just accepted a recent invite. Don't pollute the "to handle" count;
    // mark them so they go straight to the Marked tab.
    const url = 'https://www.linkedin.com/in/old-friend/';
    const r = mergeConnections([item(url)], {}, NOW);
    expect(r.accepted[url].marked).toBe(true);
    expect(r.accepted[url].markedAt).toBe(NOW);
    expect(r.accepted[url].autoMarked).toBe(true);
  });

  it('does NOT auto-mark a connection that was newly accepted from sentInvitations', () => {
    // User sent invite → person accepted → /sent/ diff moved them to accepted
    // with marked=false. /connections/ scan re-confirms them. They SHOULD stay
    // unmarked — they're someone the user is actively handling.
    const url = 'https://www.linkedin.com/in/just-accepted/';
    const stored = {
      sentInvitations: { [url]: { profileUrl: url, firstSeenAt: NOW - 7 * DAY } },
    };
    const r = mergeConnections([item(url)], stored, NOW);
    expect(r.accepted[url].marked).toBe(false);
    expect(r.accepted[url].autoMarked).toBe(false);
    expect(r.sentInvitations[url]).toBeUndefined();
  });

  it('preserves marked status set by the user', () => {
    const url = 'https://www.linkedin.com/in/a/';
    const stored = {
      accepted: { [url]: { profileUrl: url, marked: true, markedAt: NOW - 1 * DAY } },
    };
    const r = mergeConnections([item(url)], stored, NOW);
    expect(r.accepted[url].marked).toBe(true);
    expect(r.accepted[url].markedAt).toBe(NOW - 1 * DAY);
  });

  it('skips snapshot entries without profileUrl', () => {
    const r = mergeConnections([{ name: 'no-url' }], {}, NOW);
    expect(r.accepted).toEqual({});
    expect(r.touched).toBe(0);
  });

  it('computes daysPending from firstSeenAt and connectedAt', () => {
    const url = 'https://www.linkedin.com/in/a/';
    const stored = {
      accepted: {
        [url]: { profileUrl: url, firstSeenAt: NOW - 100 * DAY },
      },
    };
    const r = mergeConnections([item(url, { connectedAt: NOW - 90 * DAY })], stored, NOW);
    expect(r.accepted[url].daysPending).toBe(10);
  });
});
