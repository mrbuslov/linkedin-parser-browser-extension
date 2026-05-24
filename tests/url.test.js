import { describe, it, expect } from 'vitest';
import { normalizeProfileUrl } from '../linkedin-tracker/core/url.js';

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
});
