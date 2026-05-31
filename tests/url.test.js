import { describe, it, expect } from 'vitest';
import { normalizeProfileUrl, isEmailKey, extractEmail } from '../linkedin-tracker/core/url.js';

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
