// Pure logic tests for the 1.3.3 simplified bulk visit queue.
// State machine + URL list parsing + humanized timing distributions.
// The side-effectful driver lives in profile.js (self-navigation);
// this module has NO side effects and is unit-testable in isolation.

import { describe, it, expect } from 'vitest';
const {
  parseUrlList,
  createQueue,
  isActive,
  currentTargetUrl,
  advance,
  cancelQueue,
  isExpectedUrl,
  logNormalDwellMs,
  exponentialPauseMs,
} = require('../linkedin-tracker/core/visit-queue-simple.js');

const NOW = 1_720_000_000_000;

// Deterministic PRNG so distribution tests don't flake. Same seed +
// same call sequence → identical output.
function seededRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4_294_967_296;
  };
}

// ---------- parseUrlList ----------

describe('parseUrlList — accepts newlines and commas', () => {
  it('parses newline-separated URLs', () => {
    const r = parseUrlList('https://www.linkedin.com/in/alice/\nhttps://www.linkedin.com/in/bob/');
    expect(r.valid).toEqual([
      'https://www.linkedin.com/in/alice/',
      'https://www.linkedin.com/in/bob/',
    ]);
  });

  it('parses comma-separated URLs', () => {
    const r = parseUrlList('https://www.linkedin.com/in/alice/, https://www.linkedin.com/in/bob/');
    expect(r.valid).toEqual([
      'https://www.linkedin.com/in/alice/',
      'https://www.linkedin.com/in/bob/',
    ]);
  });

  it('accepts mixed newlines + commas', () => {
    const r = parseUrlList('https://www.linkedin.com/in/alice/, https://www.linkedin.com/in/bob/\nhttps://www.linkedin.com/in/carol/');
    expect(r.valid).toHaveLength(3);
  });

  it('normalizes to canonical /in/<slug>/ form (trailing slash + www)', () => {
    const r = parseUrlList([
      'https://linkedin.com/in/alice',           // no www, no slash
      'https://uk.linkedin.com/in/bob/',         // locale subdomain
      'https://www.linkedin.com/in/carol/',      // canonical already
    ].join('\n'));
    expect(r.valid).toEqual([
      'https://www.linkedin.com/in/alice/',
      'https://www.linkedin.com/in/bob/',
      'https://www.linkedin.com/in/carol/',
    ]);
  });

  it('handles URN-format URLs same as vanity', () => {
    const r = parseUrlList('https://www.linkedin.com/in/ACoAAAAKdt4BJsIJ1JWspUDO30kiqpShpM9-GCI/');
    expect(r.valid).toEqual(['https://www.linkedin.com/in/ACoAAAAKdt4BJsIJ1JWspUDO30kiqpShpM9-GCI/']);
  });

  it('rejects non-profile LinkedIn URLs (feed, search, company)', () => {
    const r = parseUrlList([
      'https://www.linkedin.com/feed/',
      'https://www.linkedin.com/search/results/people/',
      'https://www.linkedin.com/company/acme/',
      'https://www.linkedin.com/in/alice/',
    ].join('\n'));
    expect(r.valid).toEqual(['https://www.linkedin.com/in/alice/']);
    expect(r.invalid).toHaveLength(3);
  });

  it('rejects non-linkedin URLs entirely', () => {
    const r = parseUrlList('https://google.com/\nhttps://twitter.com/alice');
    expect(r.valid).toEqual([]);
    expect(r.invalid).toHaveLength(2);
  });

  it('dedupes exact repeats (case-preserving canonical match)', () => {
    const r = parseUrlList([
      'https://www.linkedin.com/in/alice/',
      'https://www.linkedin.com/in/alice',    // no trailing slash — same URL
      'https://www.linkedin.com/in/alice/',
    ].join('\n'));
    expect(r.valid).toEqual(['https://www.linkedin.com/in/alice/']);
    expect(r.duplicates).toBe(2);
  });

  it('tolerates trailing punctuation from copy-paste', () => {
    const r = parseUrlList('https://www.linkedin.com/in/alice/, https://www.linkedin.com/in/bob/;');
    expect(r.valid).toContain('https://www.linkedin.com/in/bob/');
  });

  it('handles empty/whitespace/null input', () => {
    expect(parseUrlList('').valid).toEqual([]);
    expect(parseUrlList('   \n  \n').valid).toEqual([]);
    expect(parseUrlList(null).valid).toEqual([]);
    expect(parseUrlList(undefined).valid).toEqual([]);
  });

  it('accepts bare linkedin.com/in/<slug> without protocol (1.3.3 report)', () => {
    // Real user paste that failed: `linkedin.com/in/daniella-falkman-twedmark,`.
    // Previously rejected because regex required ^https?:// anchor. Now
    // the parser finds `linkedin.com/in/<slug>` anywhere in the line.
    const r = parseUrlList('linkedin.com/in/daniella-falkman-twedmark,\nlinkedin.com/in/joe');
    expect(r.valid).toEqual([
      'https://www.linkedin.com/in/daniella-falkman-twedmark/',
      'https://www.linkedin.com/in/joe/',
    ]);
    expect(r.invalid).toEqual([]);
  });

  it('accepts www.linkedin.com/in/<slug> without protocol', () => {
    expect(parseUrlList('www.linkedin.com/in/alice').valid).toEqual([
      'https://www.linkedin.com/in/alice/',
    ]);
  });

  it('extracts URL embedded inside surrounding text', () => {
    // Paste from a Slack message where someone wrote "check him out linkedin.com/in/joe".
    expect(parseUrlList('check him out linkedin.com/in/joe').valid).toEqual([
      'https://www.linkedin.com/in/joe/',
    ]);
    // Paste with parentheses.
    expect(parseUrlList('Joe Dougherty (linkedin.com/in/joe)').valid).toEqual([
      'https://www.linkedin.com/in/joe/',
    ]);
    // Paste with angle brackets (email-style).
    expect(parseUrlList('<linkedin.com/in/joe>').valid).toEqual([
      'https://www.linkedin.com/in/joe/',
    ]);
  });

  it('rejects lines that lack the linkedin.com/in/ substring entirely', () => {
    const r = parseUrlList([
      'linkedin.com/company/acme',
      'linkedin.com/feed/',
      'linkedin.com/jobs/',
      'https://twitter.com/joe',
      'just some prose',
    ].join('\n'));
    expect(r.valid).toEqual([]);
    expect(r.invalid).toHaveLength(5);
  });

  it('handles tab-separated and semicolon-separated URLs', () => {
    expect(parseUrlList('linkedin.com/in/alice\tlinkedin.com/in/bob').valid).toEqual([
      'https://www.linkedin.com/in/alice/',
      'https://www.linkedin.com/in/bob/',
    ]);
    expect(parseUrlList('linkedin.com/in/alice; linkedin.com/in/bob').valid).toEqual([
      'https://www.linkedin.com/in/alice/',
      'https://www.linkedin.com/in/bob/',
    ]);
  });

  it('handles hyphenated slug with trailing comma (1.3.3 exact case)', () => {
    // Exact input from the user's 1.3.3 report — should extract cleanly.
    const r = parseUrlList('linkedin.com/in/daniella-falkman-twedmark,');
    expect(r.valid).toEqual(['https://www.linkedin.com/in/daniella-falkman-twedmark/']);
    expect(r.invalid).toEqual([]);
  });

  it('does NOT include overlay/contact-info sub-paths — collapses to canonical', () => {
    // /in/alice/overlay/contact-info/ collapses to /in/alice/ so a queue
    // of profile links pasted from various contexts doesn't dupe when
    // one is bare + one has a sub-path.
    const r = parseUrlList([
      'https://www.linkedin.com/in/alice/',
      'https://www.linkedin.com/in/alice/overlay/contact-info/',
    ].join('\n'));
    expect(r.valid).toEqual(['https://www.linkedin.com/in/alice/']);
    expect(r.duplicates).toBe(1);
  });
});

// ---------- createQueue / isActive / currentTargetUrl ----------

describe('createQueue', () => {
  it('returns a fresh queue with currentIndex=0 and cancelRequested=false', () => {
    const q = createQueue(['a', 'b', 'c'], NOW, 42);
    expect(q.currentIndex).toBe(0);
    expect(q.urls).toEqual(['a', 'b', 'c']);
    expect(q.capturedCount).toBe(0);
    expect(q.startedAt).toBe(NOW);
    expect(q.lastAdvancedAt).toBe(NOW);
    expect(q.cancelRequested).toBe(false);
    expect(q.seed).toBe(42);
  });

  it('returns null on empty URL list (no queue to run)', () => {
    expect(createQueue([], NOW, 1)).toBeNull();
  });

  it('returns null on non-array URLs (defensive)', () => {
    expect(createQueue(null, NOW, 1)).toBeNull();
    expect(createQueue(undefined, NOW, 1)).toBeNull();
    expect(createQueue('not-an-array', NOW, 1)).toBeNull();
  });

  it('throws on invalid `now` — never silently use Date.now() default', () => {
    expect(() => createQueue(['a'], 'not-a-number', 1)).toThrow(TypeError);
    expect(() => createQueue(['a'], NaN, 1)).toThrow(TypeError);
    expect(() => createQueue(['a'], undefined, 1)).toThrow(TypeError);
  });

  it('does not share the input array (defensive copy)', () => {
    const arr = ['a', 'b'];
    const q = createQueue(arr, NOW, 1);
    arr.push('c');
    expect(q.urls).toEqual(['a', 'b']);
  });
});

describe('isActive', () => {
  it('true for a fresh queue with URLs', () => {
    expect(isActive(createQueue(['a'], NOW, 1))).toBe(true);
  });

  it('false when queue is null', () => {
    expect(isActive(null)).toBe(false);
    expect(isActive(undefined)).toBe(false);
  });

  it('false when cancelRequested', () => {
    const q = createQueue(['a'], NOW, 1);
    q.cancelRequested = true;
    expect(isActive(q)).toBe(false);
  });

  it('false when currentIndex is past the last URL', () => {
    const q = createQueue(['a'], NOW, 1);
    q.currentIndex = 1;
    expect(isActive(q)).toBe(false);
  });
});

describe('currentTargetUrl', () => {
  it('returns urls[currentIndex]', () => {
    const q = createQueue(['a', 'b', 'c'], NOW, 1);
    expect(currentTargetUrl(q)).toBe('a');
    q.currentIndex = 1;
    expect(currentTargetUrl(q)).toBe('b');
  });

  it('returns null on inactive queue', () => {
    expect(currentTargetUrl(null)).toBeNull();
    const done = createQueue(['a'], NOW, 1);
    done.currentIndex = 1;
    expect(currentTargetUrl(done)).toBeNull();
  });
});

// ---------- advance ----------

describe('advance', () => {
  it('moves to the next URL, increments capturedCount, stamps lastAdvancedAt', () => {
    const q = createQueue(['a', 'b', 'c'], NOW, 1);
    const r = advance(q, NOW + 60_000);
    expect(r.done).toBe(false);
    expect(r.nextUrl).toBe('b');
    expect(r.state.currentIndex).toBe(1);
    expect(r.state.capturedCount).toBe(1);
    expect(r.state.lastAdvancedAt).toBe(NOW + 60_000);
    // Original state MUST NOT be mutated (functional / immutable style).
    expect(q.currentIndex).toBe(0);
    expect(q.capturedCount).toBe(0);
  });

  it('returns done=true when we hit the last URL', () => {
    const q = createQueue(['a', 'b'], NOW, 1);
    q.currentIndex = 1;  // on last URL
    const r = advance(q, NOW);
    expect(r.done).toBe(true);
    expect(r.state).toBeNull();
    expect(r.nextUrl).toBeNull();
  });

  it('returns done=true when cancelRequested', () => {
    const q = createQueue(['a', 'b', 'c'], NOW, 1);
    q.cancelRequested = true;
    const r = advance(q, NOW);
    expect(r.done).toBe(true);
    expect(r.state).toBeNull();
  });

  it('returns done=true on null state (defensive)', () => {
    expect(advance(null, NOW).done).toBe(true);
  });
});

// ---------- cancelQueue ----------

describe('cancelQueue', () => {
  it('sets cancelRequested=true without touching other fields', () => {
    const q = createQueue(['a', 'b'], NOW, 1);
    q.currentIndex = 1;
    q.capturedCount = 1;
    const cancelled = cancelQueue(q);
    expect(cancelled.cancelRequested).toBe(true);
    expect(cancelled.currentIndex).toBe(1);
    expect(cancelled.capturedCount).toBe(1);
    expect(cancelled.urls).toEqual(['a', 'b']);
    // Original NOT mutated.
    expect(q.cancelRequested).toBe(false);
  });

  it('null-safe', () => {
    expect(cancelQueue(null)).toBeNull();
  });
});

// ---------- isExpectedUrl ----------

describe('isExpectedUrl', () => {
  it('true when current URL matches queue target', () => {
    const q = createQueue(['https://www.linkedin.com/in/alice/'], NOW, 1);
    expect(isExpectedUrl(q, 'https://www.linkedin.com/in/alice/')).toBe(true);
  });

  it('true when trailing slash differs (lenient)', () => {
    const q = createQueue(['https://www.linkedin.com/in/alice/'], NOW, 1);
    expect(isExpectedUrl(q, 'https://www.linkedin.com/in/alice')).toBe(true);
  });

  it('false when different profile', () => {
    const q = createQueue(['https://www.linkedin.com/in/alice/'], NOW, 1);
    expect(isExpectedUrl(q, 'https://www.linkedin.com/in/bob/')).toBe(false);
  });

  it('false on inactive queue (no navigation happens)', () => {
    expect(isExpectedUrl(null, 'https://www.linkedin.com/in/alice/')).toBe(false);
    const cancelled = createQueue(['x'], NOW, 1);
    cancelled.cancelRequested = true;
    expect(isExpectedUrl(cancelled, 'x')).toBe(false);
  });

  // Regression — the 1.3.3 "Christine ™" incident. Pasted URLs contain raw
  // non-ASCII (™, é, cyrillic, ...); browser navigates to the
  // percent-encoded form; location.href returns the encoded string. Naive
  // string compare left queue "paused" for 4h+ on one profile.
  it('true when target has raw ™ and current has %E2%84%A2 (browser-encoded)', () => {
    const q = createQueue(
      ['https://www.linkedin.com/in/christine-scott-chi™-spanish-46136243/'],
      NOW,
      1,
    );
    expect(
      isExpectedUrl(q, 'https://www.linkedin.com/in/christine-scott-chi%E2%84%A2-spanish-46136243/'),
    ).toBe(true);
  });

  it('true when target has cyrillic and current is percent-encoded', () => {
    const q = createQueue(['https://www.linkedin.com/in/дмитрий-буслов/'], NOW, 1);
    expect(
      isExpectedUrl(q, 'https://www.linkedin.com/in/%D0%B4%D0%BC%D0%B8%D1%82%D1%80%D0%B8%D0%B9-%D0%B1%D1%83%D1%81%D0%BB%D0%BE%D0%B2/'),
    ).toBe(true);
  });

  it('true when target has diacritics (é) and current is percent-encoded', () => {
    const q = createQueue(['https://www.linkedin.com/in/andré-doe/'], NOW, 1);
    expect(isExpectedUrl(q, 'https://www.linkedin.com/in/andr%C3%A9-doe/')).toBe(true);
  });

  it('true when both sides raw (no encoding involved)', () => {
    const q = createQueue(['https://www.linkedin.com/in/christine-™/'], NOW, 1);
    expect(isExpectedUrl(q, 'https://www.linkedin.com/in/christine-™/')).toBe(true);
  });

  it('encoding-fix does NOT make different profiles look equal', () => {
    const q = createQueue(['https://www.linkedin.com/in/alice-™/'], NOW, 1);
    expect(isExpectedUrl(q, 'https://www.linkedin.com/in/bob-%E2%84%A2/')).toBe(false);
  });
});

// ---------- Humanized timing distributions ----------

describe('logNormalDwellMs — reading time distribution', () => {
  it('respects [min, max] clamp on every draw', () => {
    const rand = seededRand(1);
    for (let i = 0; i < 500; i++) {
      const ms = logNormalDwellMs(rand, 45_000, 0.5, 15_000, 240_000);
      expect(ms).toBeGreaterThanOrEqual(15_000);
      expect(ms).toBeLessThanOrEqual(240_000);
    }
  });

  it('median-ish: >50% of draws land within [median/2, median*2]', () => {
    const rand = seededRand(7);
    const median = 45_000;
    let inBand = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const ms = logNormalDwellMs(rand, median, 0.5, 1000, 5 * 60_000);
      if (ms >= median / 2 && ms <= median * 2) inBand++;
    }
    expect(inBand / N).toBeGreaterThan(0.55);
  });

  it('deterministic under a fixed seed (reproducibility)', () => {
    const a = seededRand(42);
    const b = seededRand(42);
    for (let i = 0; i < 20; i++) {
      expect(logNormalDwellMs(a, 30_000, 0.6, 5_000, 5 * 60_000))
        .toBe(logNormalDwellMs(b, 30_000, 0.6, 5_000, 5 * 60_000));
    }
  });
});

describe('exponentialPauseMs — between-visit pause distribution', () => {
  it('respects [min, max] clamp on every draw', () => {
    const rand = seededRand(9);
    for (let i = 0; i < 500; i++) {
      const ms = exponentialPauseMs(rand, 60_000, 20_000, 5 * 60_000);
      expect(ms).toBeGreaterThanOrEqual(20_000);
      expect(ms).toBeLessThanOrEqual(5 * 60_000);
    }
  });

  it('mean is roughly in the middle of the sample (order-of-magnitude check)', () => {
    // Exponential with mean 60s, clamped [20s, 300s]. The sample mean
    // is dragged around by the clamp but should stay in the same
    // ballpark as the target mean. We just check it's within [30, 120].
    const rand = seededRand(11);
    let total = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) total += exponentialPauseMs(rand, 60_000, 20_000, 300_000);
    const mean = total / N;
    expect(mean).toBeGreaterThan(30_000);
    expect(mean).toBeLessThan(120_000);
  });

  it('deterministic under a fixed seed', () => {
    const a = seededRand(123);
    const b = seededRand(123);
    for (let i = 0; i < 20; i++) {
      expect(exponentialPauseMs(a, 90_000, 30_000, 3 * 60_000))
        .toBe(exponentialPauseMs(b, 90_000, 30_000, 3 * 60_000));
    }
  });
});
