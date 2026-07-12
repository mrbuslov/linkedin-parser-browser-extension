// Tests for pure helper functions extracted from popup.js. The full popup
// requires chrome.* APIs we'd have to mock for true integration tests; for
// now we cover the pure decision logic which is where the bugs would hide.

import { describe, it, expect } from 'vitest';
import {
  shouldShowDeclinedWarning,
  cleanHeadline,
  fixSwappedNameHeadline,
  parseMutualsCount,
  extractHeadlineFromScope,
  demoteToDeclined,
  demoteToVisited,
  shouldShowScanGap,
  formatEta,
} from '../linkedin-tracker/core/popup-logic.js';

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

describe('extractHeadlineFromScope — deterministic skip rules', () => {
  function setup(html) {
    document.body.innerHTML = `<div id="scope">${html}</div>`;
    const scope = document.getElementById('scope');
    const heading = scope.querySelector('h1, h2');
    return { scope, heading };
  }

  it('returns first text-only node after the heading', () => {
    const { scope, heading } = setup(`
      <h1>Jane Doe</h1>
      <p>Senior Engineer at Acme</p>
    `);
    expect(extractHeadlineFromScope(scope, heading, 'Jane Doe'))
      .toBe('Senior Engineer at Acme');
  });

  it('skips the degree-badge text "· 1st" / "· 2nd" / "· 3rd"', () => {
    const { scope, heading } = setup(`
      <h1>Jane Doe</h1>
      <p>· 1st</p>
      <p>Senior Engineer at Acme</p>
    `);
    expect(extractHeadlineFromScope(scope, heading, 'Jane Doe'))
      .toBe('Senior Engineer at Acme');
  });

  it('skips video.js placeholder text (vjs-* class ancestor) — Clare Suttie regression', () => {
    // LinkedIn renders profile-cover videos with video.js. The loading
    // spinner contains a <span class="vjs-control-text">Video Player is
    // loading.</span> which our scan would otherwise grab as the headline.
    const { scope, heading } = setup(`
      <h1>Clare Suttie</h1>
      <div class="vjs-loading-spinner vjs-hidden">
        <span class="vjs-control-text">Video Player is loading.</span>
      </div>
      <p>Founder at SuttieCo</p>
    `);
    expect(extractHeadlineFromScope(scope, heading, 'Clare Suttie'))
      .toBe('Founder at SuttieCo');
  });

  it('skips name-only text (no headline match yields empty string)', () => {
    const { scope, heading } = setup(`
      <h1>Jane Doe</h1>
      <p>Jane Doe</p>
    `);
    expect(extractHeadlineFromScope(scope, heading, 'Jane Doe')).toBe('');
  });

  it('strips a "name + glued headline" SR-only node into a clean headline', () => {
    const { scope, heading } = setup(`
      <h1>Daniil Stankevich</h1>
      <span>Daniil StankevichFullstack developer | React/Angular/NestJS</span>
    `);
    expect(extractHeadlineFromScope(scope, heading, 'Daniil Stankevich'))
      .toBe('Fullstack developer | React/Angular/NestJS');
  });

  it('returns "" when scope has no usable text-only nodes after heading', () => {
    const { scope, heading } = setup(`<h1>Jane Doe</h1>`);
    expect(extractHeadlineFromScope(scope, heading, 'Jane Doe')).toBe('');
  });

  it('returns "" defensively when scope or name is missing', () => {
    expect(extractHeadlineFromScope(null, null, 'X')).toBe('');
    expect(extractHeadlineFromScope(document.body, null, '')).toBe('');
  });
});

describe('extractHeadlineFromScope — real LinkedIn HTML fixture', () => {
  it('Clare Suttie fixture: video.js placeholder is NOT picked up as headline', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(
      path.resolve(__dirname, 'fixtures/clare-suttie-headline.html'),
      'utf8'
    );
    document.body.innerHTML = html;
    // The fixture contains the cover-video element + a heading-like marker.
    // We mimic the production scope (the top-card SECTION) by using the
    // outermost wrapper we saved.
    const scope = document.body.firstElementChild || document.body;
    const heading = scope.querySelector('h1, h2') || scope;
    const headline = extractHeadlineFromScope(scope, heading, 'Clare Suttie');
    // The single hard requirement: the video.js placeholder must NOT be
    // returned. (Whatever real headline the fixture surfaces is profile-
    // specific and may shift across LinkedIn rebuilds; the regression is
    // strictly "video.js text excluded".)
    expect(headline).not.toContain('Video Player is loading');
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

describe('demoteToDeclined — user marks pending as no-longer-active', () => {
  const NOW = 1_800_000_000_000;

  it('flips status to declined and stamps declinedAt+withdrawnAt', () => {
    const rec = {
      profileUrl: 'https://www.linkedin.com/in/alice/',
      status: 'pending',
      name: 'Alice',
      firstSeenAt: NOW - 30 * 86400000,
    };
    const out = demoteToDeclined(rec, NOW);
    expect(out.status).toBe('declined');
    expect(out.declinedAt).toBe(NOW);
    expect(out.withdrawnAt).toBe(NOW);
  });

  it('preserves an EARLIER withdrawnAt (do not overwrite a real click stamp)', () => {
    const earlier = 1_700_000_000_000;
    const rec = { status: 'pending', withdrawnAt: earlier };
    const out = demoteToDeclined(rec, NOW);
    expect(out.withdrawnAt).toBe(earlier);
    expect(out.declinedAt).toBe(NOW);
  });

  it('preserves all other fields — nothing is destructively rewritten', () => {
    const rec = {
      profileUrl: 'https://www.linkedin.com/in/alice/',
      status: 'pending',
      name: 'Alice',
      headline: 'Engineer at Acme',
      firstSeenAt: 1_000,
      sentDateRelative: '3 weeks ago',
      notes: 'friend of Bob',
      tags: ['warm'],
      favorite: true,
      mutualsCount: 5,
    };
    const out = demoteToDeclined(rec, NOW);
    expect(out.name).toBe('Alice');
    expect(out.headline).toBe('Engineer at Acme');
    expect(out.firstSeenAt).toBe(1_000);
    expect(out.sentDateRelative).toBe('3 weeks ago');
    expect(out.notes).toBe('friend of Bob');
    expect(out.tags).toEqual(['warm']);
    expect(out.favorite).toBe(true);
    expect(out.mutualsCount).toBe(5);
  });

  it('is defensively no-op on null/undefined record', () => {
    expect(demoteToDeclined(null, NOW)).toBeNull();
    expect(demoteToDeclined(undefined, NOW)).toBeUndefined();
  });
});

describe('demoteToVisited — user marks accepted as not-in-network', () => {
  const NOW = 1_800_000_000_000;

  it('flips status to visited and clears the anti-downgrade guards', () => {
    // Guard chain lives in profile-state.js statusFromVisit():
    //   if (prev.connectedOnText || prev.firstConnectedAt) → keep accepted
    // Failing to clear these fields would silently undo the user's
    // manual override the next time they visit the profile page.
    const rec = {
      status: 'accepted',
      acceptedAt: 1_000,
      verifiedAt: 2_000,
      firstConnectedAt: 500,
      connectedOnText: 'Connected on Jan 5, 2024',
      connectedOnDate: '2024-01-05',
    };
    const out = demoteToVisited(rec, NOW);
    expect(out.status).toBe('visited');
    expect(out.acceptedAt).toBeNull();
    expect(out.verifiedAt).toBeNull();
    expect(out.firstConnectedAt).toBeNull();
    expect(out.connectedOnText).toBe('');
    expect(out.connectedOnDate).toBe('');
    expect(out.visitedAt).toBe(NOW);
  });

  it('preserves user-authored + historical fields', () => {
    // daysPending is historical fact — how long the invite was pending
    // BEFORE it was (wrongly?) marked accepted. Keep it as a data point.
    const rec = {
      status: 'accepted',
      name: 'Alice',
      headline: 'Engineer at Acme',
      daysPending: 12,
      notes: 'met at conf',
      tags: ['warm'],
      favorite: true,
      firstSeenAt: 1_000,
    };
    const out = demoteToVisited(rec, NOW);
    expect(out.name).toBe('Alice');
    expect(out.headline).toBe('Engineer at Acme');
    expect(out.daysPending).toBe(12);
    expect(out.notes).toBe('met at conf');
    expect(out.tags).toEqual(['warm']);
    expect(out.favorite).toBe(true);
    expect(out.firstSeenAt).toBe(1_000);
  });

  it('is defensively no-op on null/undefined record', () => {
    expect(demoteToVisited(null, NOW)).toBeNull();
    expect(demoteToVisited(undefined, NOW)).toBeUndefined();
  });

  it('subsequent profile-page visit CANNOT silently re-elevate to accepted', () => {
    // Integration guard: after demoteToVisited, statusFromVisit for a
    // 'not_connected' observation must return 'visited' (or 'declined'),
    // NOT 'accepted' (which would happen if any guard field survived).
    const { statusFromVisit } = require('../linkedin-tracker/core/profile-state.js');
    const rec = {
      status: 'accepted',
      firstConnectedAt: 500,
      connectedOnText: 'Connected on Jan 5, 2024',
    };
    const demoted = demoteToVisited(rec, NOW);
    // Now simulate a fresh profile-page visit where LinkedIn shows the
    // Connect button (they're not connected). If either guard field
    // survived demote, statusFromVisit would re-elevate to accepted.
    const nextStatus = statusFromVisit('not_connected', demoted);
    expect(nextStatus).toBe('visited');
  });
});

describe('shouldShowScanGap — contextual info banner in Pending tab', () => {
  it('shows when store has many pending but last scan captured few', () => {
    // The bug motivation: user cleaned 157 out of 158 pending on LinkedIn
    // UI, next scan captured just 1, partial-scan guard preserved 157
    // stale records. Banner explains WHY and teaches the − button.
    expect(shouldShowScanGap(158, 1)).toBe(true);
    expect(shouldShowScanGap(50, 20)).toBe(true);  // 20 < 25
    expect(shouldShowScanGap(20, 9)).toBe(true);   // 9 < 10
  });

  it('does NOT show when scan captured >=50% of stored pending', () => {
    expect(shouldShowScanGap(20, 10)).toBe(false); // exactly 50%
    expect(shouldShowScanGap(50, 30)).toBe(false);
    expect(shouldShowScanGap(158, 158)).toBe(false);
    expect(shouldShowScanGap(158, 80)).toBe(false); // above threshold
  });

  it('does NOT show for tiny stores (<=5 pending) — avoids nag on brand-new users', () => {
    // Mirrors SANITY_MIN_PREV in diff-sent.js. Prevents "you have 3
    // pending, scan captured 0" pop-up which is likely a first-time
    // setup, not a stale-record situation.
    expect(shouldShowScanGap(5, 0)).toBe(false);
    expect(shouldShowScanGap(3, 0)).toBe(false);
    expect(shouldShowScanGap(1, 0)).toBe(false);
  });

  it('does NOT show when we have no scan info yet (first popup open)', () => {
    // lastCount=null means the scan never ran. The gap only makes sense
    // AFTER at least one scan established the "captured N" baseline.
    expect(shouldShowScanGap(158, null)).toBe(false);
    expect(shouldShowScanGap(158, undefined)).toBe(false);
  });

  it('boundary: exactly at the partial threshold does NOT show', () => {
    // shouldShow requires strict < half. Exact half is fine (guard
    // wouldn't have fired either).
    expect(shouldShowScanGap(10, 5)).toBe(false);
  });
});

describe('formatEta — human-readable time-remaining for the Bulk Visit panel', () => {
  it('< 30s collapses to "<1 min" (rounds to 0)', () => {
    expect(formatEta(0)).toBe('<1 min');
    expect(formatEta(-1)).toBe('<1 min');
    expect(formatEta(NaN)).toBe('<1 min');
    expect(formatEta(Infinity)).toBe('<1 min');
    // 29s → 0.48min → rounds to 0 → "<1 min"
    expect(formatEta(29_000)).toBe('<1 min');
  });

  it('minute-precision under 1 hour', () => {
    expect(formatEta(60_000)).toBe('~1 min');
    expect(formatEta(5 * 60_000)).toBe('~5 min');
    expect(formatEta(45 * 60_000)).toBe('~45 min');
    expect(formatEta(59 * 60_000)).toBe('~59 min');
  });

  it('h/min format for 1h+', () => {
    expect(formatEta(60 * 60_000)).toBe('~1h');
    expect(formatEta(75 * 60_000)).toBe('~1h 15min');
    expect(formatEta(2 * 60 * 60_000)).toBe('~2h');
    expect(formatEta(2 * 60 * 60_000 + 30 * 60_000)).toBe('~2h 30min');
  });

  it('realistic bulk-queue ETAs (32.5s per profile — avg of 25-40s uniform)', () => {
    // 10-URL run: 10 * 32.5s = 325s = 5.4min → ~5 min
    expect(formatEta(10 * 32_500)).toBe('~5 min');
    // 100-URL run: 3250s = 54min
    expect(formatEta(100 * 32_500)).toBe('~54 min');
    // 525-URL run (user's real case): 17062.5s = 284.4min = 4h 44min
    expect(formatEta(525 * 32_500)).toBe('~4h 44min');
  });

  it('rounds sub-minute deltas gracefully', () => {
    // 90s → 1.5min → rounds to 2min
    expect(formatEta(90_000)).toBe('~2 min');
    // 29s → rounds down to 0 → "<1 min"
    expect(formatEta(29_000)).toBe('<1 min');
  });
});
