// Tests for pure helper functions extracted from popup.js. The full popup
// requires chrome.* APIs we'd have to mock for true integration tests; for
// now we cover the pure decision logic which is where the bugs would hide.

import { describe, it, expect } from 'vitest';
import { shouldShowDeclinedWarning, cleanHeadline, fixSwappedNameHeadline, parseMutualsCount } from '../linkedin-tracker/core/popup-logic.js';

describe('shouldShowDeclinedWarning', () => {
  it('shows when there are declined entries and /connections/ was never scanned', () => {
    expect(shouldShowDeclinedWarning(3, undefined)).toBe(true);
    expect(shouldShowDeclinedWarning(3, null)).toBe(true);
    expect(shouldShowDeclinedWarning(3, {})).toBe(true);
    expect(shouldShowDeclinedWarning(1, { lastScannedAt: null })).toBe(true);
  });

  it('hides after at least one /connections/ scan completed', () => {
    expect(shouldShowDeclinedWarning(3, { lastScannedAt: Date.now() })).toBe(false);
    expect(shouldShowDeclinedWarning(3, { lastScannedAt: 1 })).toBe(false);
  });

  it('hides when there are no declined entries (no point nagging the user)', () => {
    expect(shouldShowDeclinedWarning(0, undefined)).toBe(false);
    expect(shouldShowDeclinedWarning(0, { lastScannedAt: Date.now() })).toBe(false);
  });

  it('treats negative counts as zero (defensive)', () => {
    expect(shouldShowDeclinedWarning(-1, undefined)).toBe(false);
  });
});

describe('cleanHeadline — defensive name-glued-to-headline cleanup', () => {
  it('strips name prefix and a trailing separator', () => {
    // Real bug case: an SR text node had "Daniil StankevichFullstack developer | …"
    // stored as headline. cleanHeadline removes the name prefix at render time.
    expect(cleanHeadline('Daniil StankevichFullstack developer | React/Angular/NestJS', 'Daniil Stankevich'))
      .toBe('Fullstack developer | React/Angular/NestJS');
    expect(cleanHeadline('elizaveta sigarevait recruiter | sourcer', 'elizaveta sigareva'))
      .toBe('it recruiter | sourcer');
    expect(cleanHeadline('Nikolay Shadrintg: t.me/ShadrinNikolay / Frontend Developer', 'Nikolay Shadrin'))
      .toBe('tg: t.me/ShadrinNikolay / Frontend Developer');
    expect(cleanHeadline('Mark NeramikLead Automation Engineer (SDET)', 'Mark Neramik'))
      .toBe('Lead Automation Engineer (SDET)');
  });

  it('case-insensitive name match', () => {
    expect(cleanHeadline('JANE DOEEngineer at Acme', 'Jane Doe')).toBe('Engineer at Acme');
  });

  it('strips a separator (·, |, —, -) between name and headline if present', () => {
    expect(cleanHeadline('Jane Doe · Engineer at Acme', 'Jane Doe')).toBe('Engineer at Acme');
    expect(cleanHeadline('Jane Doe — Engineer at Acme', 'Jane Doe')).toBe('Engineer at Acme');
    expect(cleanHeadline('Jane Doe | Engineer at Acme', 'Jane Doe')).toBe('Engineer at Acme');
  });

  it('idempotent: clean headline passes through unchanged', () => {
    expect(cleanHeadline('Engineer at Acme', 'Jane Doe')).toBe('Engineer at Acme');
    expect(cleanHeadline('Fullstack developer | React', 'Daniil Stankevich'))
      .toBe('Fullstack developer | React');
  });

  it('handles empty/missing inputs without crashing', () => {
    expect(cleanHeadline('', 'Jane Doe')).toBe('');
    expect(cleanHeadline('Some headline', '')).toBe('Some headline');
    expect(cleanHeadline(undefined, 'Jane Doe')).toBe('');
    expect(cleanHeadline('Some headline', undefined)).toBe('Some headline');
  });

  it('does NOT mangle headlines that genuinely start with the same words as a different name', () => {
    // Edge case: headline could literally start with words that happen to
    // match the name. We accept this tradeoff — the headline collision is
    // rarer than the SR-node-glue case the cleanup targets.
    expect(cleanHeadline('Jane Doe Industries CEO', 'Jane Doe')).toBe('Industries CEO');
  });
});

describe('fixSwappedNameHeadline — undoes name/headline swap in legacy records', () => {
  it("corrects the real Daniil Stankevich record from the user's storage dump", () => {
    const r = fixSwappedNameHeadline({
      name: 'Daniil StankevichFullstack developer | React/Angular/NestJS',
      headline: 'Daniil Stankevich',
    });
    expect(r.name).toBe('Daniil Stankevich');
    expect(r.headline).toBe('Fullstack developer | React/Angular/NestJS');
  });

  it('corrects Daniil Lysenko (real record from dump)', () => {
    const r = fixSwappedNameHeadline({
      name: 'Daniil LysenkoLead Brand Designer / Art Director',
      headline: 'Daniil Lysenko',
    });
    expect(r.name).toBe('Daniil Lysenko');
    expect(r.headline).toBe('Lead Brand Designer / Art Director');
  });

  it('idempotent on already-clean records', () => {
    const r = fixSwappedNameHeadline({
      name: 'Jane Doe',
      headline: 'Engineer at Acme',
    });
    expect(r.name).toBe('Jane Doe');
    expect(r.headline).toBe('Engineer at Acme');
  });

  it('does NOT swap when name and headline are equal length (ambiguous)', () => {
    // If they were swapped, name would be LONGER than headline (it contains
    // both). Equal length means we can't tell which is which → leave alone.
    const r = fixSwappedNameHeadline({
      name: 'Jane Smith',
      headline: 'Jane Smith',
    });
    expect(r.name).toBe('Jane Smith');
    expect(r.headline).toBe('Jane Smith');
  });

  it('passes through when headline is empty (nothing to swap with)', () => {
    const r = fixSwappedNameHeadline({ name: 'Jane Doe', headline: '' });
    expect(r.name).toBe('Jane Doe');
    expect(r.headline).toBe('');
  });

  it('passes through when name is empty (defensive)', () => {
    const r = fixSwappedNameHeadline({ name: '', headline: 'something' });
    expect(r.name).toBe('');
    expect(r.headline).toBe('something');
  });

  it('passes through on null/undefined record (defensive)', () => {
    expect(fixSwappedNameHeadline(null)).toEqual({ name: '', headline: '' });
    expect(fixSwappedNameHeadline(undefined)).toEqual({ name: '', headline: '' });
  });

  it('handles case-insensitive prefix match', () => {
    const r = fixSwappedNameHeadline({
      name: 'JANE DOEengineer at Acme',
      headline: 'Jane Doe',
    });
    expect(r.name).toBe('Jane Doe');
    expect(r.headline).toBe('engineer at Acme');
  });
});

describe('parseMutualsCount — extract count from anchor text', () => {
  it('"X, Y and N other mutual connections" → N + 2 (names visible)', () => {
    expect(parseMutualsCount('Anton, Mikhail and 79 other mutual connections')).toBe(81);
  });

  it('single visible name + "and N other"', () => {
    expect(parseMutualsCount('Mykhailo and 12 other mutual connections')).toBe(13);
  });

  it('no visible names, "and N other"', () => {
    expect(parseMutualsCount('and 12 other mutual connections')).toBe(12);
  });

  it('"N mutual connections" (single number form)', () => {
    expect(parseMutualsCount('5 mutual connections')).toBe(5);
    expect(parseMutualsCount('1 mutual connection')).toBe(1);
  });

  it('returns null when no count is parseable', () => {
    expect(parseMutualsCount('See all mutuals')).toBeNull();
    expect(parseMutualsCount('')).toBeNull();
    expect(parseMutualsCount(null)).toBeNull();
    expect(parseMutualsCount(undefined)).toBeNull();
  });

  it('locale-stable on whitespace normalization (multi-space, tabs)', () => {
    expect(parseMutualsCount('Anton,  Mikhail  and  79  other  mutual  connections')).toBe(81);
  });
});
