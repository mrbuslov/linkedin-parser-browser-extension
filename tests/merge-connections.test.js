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

  it('clears any stale autoMarked flag once LinkedIn confirms via connections page', () => {
    const url = 'https://www.linkedin.com/in/a/';
    const stored = {
      accepted: { [url]: { profileUrl: url, autoMarked: true, marked: true } },
    };
    const r = mergeConnections([item(url)], stored, NOW);
    expect(r.accepted[url].autoMarked).toBe(false);
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
