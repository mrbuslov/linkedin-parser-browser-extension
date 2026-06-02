// Tests for pure helper functions extracted from popup.js. The full popup
// requires chrome.* APIs we'd have to mock for true integration tests; for
// now we cover the pure decision logic which is where the bugs would hide.

import { describe, it, expect } from 'vitest';
import { shouldShowDeclinedWarning } from '../linkedin-tracker/core/popup-logic.js';

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
