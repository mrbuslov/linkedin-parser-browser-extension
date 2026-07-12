import { describe, it, expect } from 'vitest';
import { normalizeProfileUrl, isEmailKey, extractEmail, decodeLinkedInRedirect, isProfilePath, extractURNFromConnectionOf, extractUrnFromProfileUrl, isPeopleSearchPath } from '../linkedin-tracker/core/url.js';

describe('normalizeProfileUrl', () => {
  it('keeps a canonical /in/name/ URL untouched', () => {
    expect(normalizeProfileUrl('https://www.linkedin.com/in/john-doe/'))
      .toBe('https://www.linkedin.com/in/john-doe/');
  });

  it('appends trailing slash if missing', () => {
    expect(normalizeProfileUrl('https://www.linkedin.com/in/john-doe'))
      .toBe('https://www.linkedin.com/in/john-doe/');
  });

  it('strips query string and hash', () => {
    expect(normalizeProfileUrl('https://www.linkedin.com/in/john-doe/?utm_source=share#about'))
      .toBe('https://www.linkedin.com/in/john-doe/');
  });

  it('strips duplicate trailing slashes', () => {
    expect(normalizeProfileUrl('https://www.linkedin.com/in/john-doe///'))
      .toBe('https://www.linkedin.com/in/john-doe/');
  });

  it('resolves a relative href against the LinkedIn origin', () => {
    expect(normalizeProfileUrl('/in/jane/')).toBe('https://www.linkedin.com/in/jane/');
  });

  it('preserves unicode profile slugs', () => {
    expect(normalizeProfileUrl('https://www.linkedin.com/in/дмитрий-буслов/'))
      .toMatch(/\/in\/[^/]+\/$/);
  });

  it('normalizes mailto: URLs (email-based /sent/ invites)', () => {
    expect(normalizeProfileUrl('mailto:Foo@Example.COM'))
      .toBe('mailto:foo@example.com');
    expect(normalizeProfileUrl('mailto:scavaca@dmrs.min-saude.pt'))
      .toBe('mailto:scavaca@dmrs.min-saude.pt');
  });

  it('collapses /in/<vanity>/overlay/contact-info/ to the canonical /in/<vanity>/', () => {
    // Real bug: opening the Contact info modal changed location.href to add
    // /overlay/contact-info/, the tick recorded under that key, and the
    // user got two `accepted` records for the same person.
    expect(normalizeProfileUrl('https://www.linkedin.com/in/zhenyamogila/overlay/contact-info/'))
      .toBe('https://www.linkedin.com/in/zhenyamogila/');
  });

  it('collapses any /in/<vanity>/<subpath>... to the canonical /in/<vanity>/', () => {
    expect(normalizeProfileUrl('https://www.linkedin.com/in/jane/detail/contact-info/'))
      .toBe('https://www.linkedin.com/in/jane/');
    expect(normalizeProfileUrl('https://www.linkedin.com/in/jane/recent-activity/all/'))
      .toBe('https://www.linkedin.com/in/jane/');
  });
});

describe('isProfilePath — SPA-navigation gate', () => {
  it('accepts canonical /in/<vanity>/', () => {
    expect(isProfilePath('/in/jane/')).toBe(true);
    expect(isProfilePath('/in/jane')).toBe(true);
  });
  it('accepts /in/<vanity>/overlay/... (contact-info, etc)', () => {
    expect(isProfilePath('/in/jane/overlay/contact-info/')).toBe(true);
  });
  it('rejects /search/ and other non-profile paths', () => {
    // Regression for the real bug: SPA navigation away from /in/* kept the
    // content script running, and a profile entry got written under a
    // /search/results/people/ key.
    expect(isProfilePath('/search/results/people/')).toBe(false);
    expect(isProfilePath('/feed/')).toBe(false);
    expect(isProfilePath('/jobs/')).toBe(false);
    expect(isProfilePath('/mynetwork/')).toBe(false);
  });
  it('rejects empty / undefined', () => {
    expect(isProfilePath('')).toBe(false);
    expect(isProfilePath(null)).toBe(false);
    expect(isProfilePath(undefined)).toBe(false);
  });
});

describe('isEmailKey', () => {
  it('returns true for mailto: identifiers', () => {
    expect(isEmailKey('mailto:foo@bar.com')).toBe(true);
  });
  it('returns false for regular profile URLs', () => {
    expect(isEmailKey('https://www.linkedin.com/in/jane/')).toBe(false);
  });
});

describe('extractEmail', () => {
  it('finds the first email in mixed text', () => {
    expect(extractEmail('Sent to scavaca@dmrs.min-saude.pt 2 weeks ago'))
      .toBe('scavaca@dmrs.min-saude.pt');
  });
  it('lowercases the result', () => {
    expect(extractEmail('Foo@EXAMPLE.com')).toBe('foo@example.com');
  });
  it('returns null when no email is present', () => {
    expect(extractEmail('Just regular text here')).toBeNull();
  });
});

describe('decodeLinkedInRedirect', () => {
  it('strips the safety/go wrapper and returns the embedded url', () => {
    const href = 'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Ft%2Eme%2F%2Ba89_MGzNllpmZmUy&urlhash=2Sd1&isSdui=true';
    expect(decodeLinkedInRedirect(href)).toBe('https://t.me/+a89_MGzNllpmZmUy');
  });
  it('returns plain external URLs unchanged', () => {
    expect(decodeLinkedInRedirect('https://example.com/foo'))
      .toBe('https://example.com/foo');
  });
  it('returns the input unchanged when safety-go is present but url= is missing', () => {
    expect(decodeLinkedInRedirect('https://www.linkedin.com/safety/go/?urlhash=abc'))
      .toBe('https://www.linkedin.com/safety/go/?urlhash=abc');
  });
  it('passes through empty/falsy input', () => {
    expect(decodeLinkedInRedirect('')).toBe('');
    expect(decodeLinkedInRedirect(null)).toBe(null);
  });
});

describe('extractURNFromConnectionOf', () => {
  it('extracts the URN from URL-encoded connectionOf', () => {
    const url = 'https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&network=%5B%22F%22%5D&connectionOf=%5B%22ACoAAAD3TQABqRHgsCZ_Ma8zqRLdxpuuiwR_xs4%22%5D';
    expect(extractURNFromConnectionOf(url)).toBe('ACoAAAD3TQABqRHgsCZ_Ma8zqRLdxpuuiwR_xs4');
  });

  it('extracts the URN from already-decoded connectionOf', () => {
    const url = 'https://www.linkedin.com/search/results/people/?connectionOf=["ACoAABcH_0ABWVl3iTrm-mzehDjBO0NoAq_ZLtE"]';
    expect(extractURNFromConnectionOf(url)).toBe('ACoAABcH_0ABWVl3iTrm-mzehDjBO0NoAq_ZLtE');
  });

  it('returns null when connectionOf is missing', () => {
    expect(extractURNFromConnectionOf('https://www.linkedin.com/search/results/people/?network=%5B%22F%22%5D')).toBeNull();
  });

  it('returns null when connectionOf value is not the expected ACoA URN shape', () => {
    expect(extractURNFromConnectionOf('https://www.linkedin.com/search/results/people/?connectionOf=invalid')).toBeNull();
    expect(extractURNFromConnectionOf('https://www.linkedin.com/search/results/people/?connectionOf=%5B%22XYZ%22%5D')).toBeNull();
  });

  it('returns null for empty/falsy input', () => {
    expect(extractURNFromConnectionOf('')).toBeNull();
    expect(extractURNFromConnectionOf(null)).toBeNull();
  });
});

describe('extractUrnFromProfileUrl', () => {
  it('extracts URN from an /in/ACoA.../ URL (LinkedIn URN-format profile URL)', () => {
    expect(extractUrnFromProfileUrl('https://www.linkedin.com/in/ACoAAAAKdt4BJsIJ1JWspUDO30kiqpShpM9-GCI/'))
      .toBe('ACoAAAAKdt4BJsIJ1JWspUDO30kiqpShpM9-GCI');
    expect(extractUrnFromProfileUrl('https://www.linkedin.com/in/ACoAAAAjktYBfN_UNHAUsz2SoXjGbdK1foTREnE/'))
      .toBe('ACoAAAAjktYBfN_UNHAUsz2SoXjGbdK1foTREnE');
    expect(extractUrnFromProfileUrl('https://www.linkedin.com/in/ACoAAAhdDz4BVo1GEpOKgey4ACpSOiG6DcVSAl0/'))
      .toBe('ACoAAAhdDz4BVo1GEpOKgey4ACpSOiG6DcVSAl0');
  });

  it('works without a trailing slash', () => {
    expect(extractUrnFromProfileUrl('https://www.linkedin.com/in/ACoAAAAKdt4BJsIJ1JWspUDO30kiqpShpM9-GCI'))
      .toBe('ACoAAAAKdt4BJsIJ1JWspUDO30kiqpShpM9-GCI');
  });

  it('returns null for vanity-format URLs (no URN in path)', () => {
    expect(extractUrnFromProfileUrl('https://www.linkedin.com/in/joedougherty/')).toBeNull();
    expect(extractUrnFromProfileUrl('https://www.linkedin.com/in/wendypease/')).toBeNull();
    expect(extractUrnFromProfileUrl('https://www.linkedin.com/in/john-doe/')).toBeNull();
  });

  it('returns null for URLs that just happen to contain "ACoA" outside the path segment', () => {
    // Query params, hash fragments, or vanity slugs that CONTAIN ACoA but
    // don't START with it → no match (regex anchors to segment start).
    expect(extractUrnFromProfileUrl('https://www.linkedin.com/in/notACoAperson/')).toBeNull();
    expect(extractUrnFromProfileUrl('https://www.linkedin.com/in/john-doe/?ref=ACoAxyz')).toBeNull();
  });

  it('returns null for non-profile paths (search, feed, mailto)', () => {
    expect(extractUrnFromProfileUrl('https://www.linkedin.com/search/results/people/?connectionOf=ACoAxyz')).toBeNull();
    expect(extractUrnFromProfileUrl('https://www.linkedin.com/feed/')).toBeNull();
    expect(extractUrnFromProfileUrl('mailto:foo@bar.com')).toBeNull();
    expect(extractUrnFromProfileUrl('MAILTO:foo@bar.com')).toBeNull();
  });

  it('returns null for empty/malformed input', () => {
    expect(extractUrnFromProfileUrl('')).toBeNull();
    expect(extractUrnFromProfileUrl(null)).toBeNull();
    expect(extractUrnFromProfileUrl(undefined)).toBeNull();
    expect(extractUrnFromProfileUrl(123)).toBeNull();
  });

  it('tolerates overlay sub-paths — /in/ACoA.../overlay/... resolves to same URN', () => {
    // Callers should ideally normalize first, but the extractor is robust
    // to unnormalized input — anchor is the FIRST /in/<segment>/ token.
    expect(extractUrnFromProfileUrl('https://www.linkedin.com/in/ACoAAAAKdt4BJsIJ1JWspUDO30kiqpShpM9-GCI/overlay/contact-info/'))
      .toBe('ACoAAAAKdt4BJsIJ1JWspUDO30kiqpShpM9-GCI');
    expect(extractUrnFromProfileUrl('https://www.linkedin.com/in/ACoAAAAKdt4BJsIJ1JWspUDO30kiqpShpM9-GCI/details/experience/'))
      .toBe('ACoAAAAKdt4BJsIJ1JWspUDO30kiqpShpM9-GCI');
  });
});

describe('isPeopleSearchPath', () => {
  it('matches /search/results/people/ and /search/results/people', () => {
    expect(isPeopleSearchPath('/search/results/people/')).toBe(true);
    expect(isPeopleSearchPath('/search/results/people')).toBe(true);
  });
  it('rejects other paths', () => {
    expect(isPeopleSearchPath('/in/jane/')).toBe(false);
    expect(isPeopleSearchPath('/search/results/companies/')).toBe(false);
    expect(isPeopleSearchPath('/feed/')).toBe(false);
    expect(isPeopleSearchPath('')).toBe(false);
  });
});
