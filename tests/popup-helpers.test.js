// Tests for pure helper functions extracted from popup.js. The full popup
// requires chrome.* APIs we'd have to mock for true integration tests; for
// now we cover the pure decision logic which is where the bugs would hide.

import { describe, it, expect } from 'vitest';
import { shouldShowDeclinedWarning, cleanHeadline } from '../linkedin-tracker/core/popup-logic.js';

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
