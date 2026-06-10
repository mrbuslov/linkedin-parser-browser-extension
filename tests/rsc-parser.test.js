// RSC payload parser tests. The fixtures here are minimal synthetic snippets
// modeled exactly on what LinkedIn's Next.js streaming format actually ships
// for a profile view (Михаил Курилович's real top-card payload was used as
// the structural reference). We don't ship full real payloads because they
// are ~1.5 MB each and most of the content is rendering tree noise.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractRSCText,
  extractRSCTextCached,
  resetRSCCache,
  findNetworkDistance,
  findProfileBasics,
  findActionTypes,
  detectStatusFromRSC,
  unescapeJsString,
} from '../linkedin-tracker/core/rsc-parser.js';

// Build a <script> tag that mimics Next.js streaming:
//   self.__next_f.push([1, "<escaped JSON-Flight chunk>"])
function pushChunk(rawJsonFragment) {
  // Escape backslashes and quotes the way real LinkedIn output does
  const escaped = rawJsonFragment
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `self.__next_f.push([1, "${escaped}"])`;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('unescapeJsString', () => {
  it('decodes the four most common escapes', () => {
    expect(unescapeJsString('Hi \\"world\\"')).toBe('Hi "world"');
    expect(unescapeJsString('a\\\\b')).toBe('a\\b');
    expect(unescapeJsString('line\\nnext')).toBe('line\nnext');
    expect(unescapeJsString('\\u0041')).toBe('A');
  });
});

describe('extractRSCText', () => {
  it('concatenates payloads from multiple __next_f.push() chunks', () => {
    document.body.innerHTML = `
      <script>${pushChunk('{"firstName":"Михаил",')}</script>
      <script>${pushChunk('"lastName":"Курилович"}')}</script>
    `;
    const out = extractRSCText(document);
    expect(out).toContain('"firstName":"Михаил"');
    expect(out).toContain('"lastName":"Курилович"');
  });

  it('ignores unrelated scripts', () => {
    document.body.innerHTML = `
      <script>console.log("hi");</script>
      <script>${pushChunk('"firstName":"X"')}</script>
    `;
    expect(extractRSCText(document)).toBe('"firstName":"X"');
  });

  it('returns an empty string when no RSC scripts are present', () => {
    document.body.innerHTML = '<script>foo()</script>';
    expect(extractRSCText(document)).toBe('');
  });
});

describe('findNetworkDistance — the canonical degree-of-connection signal', () => {
  it('extracts distance=1 from the vieweeMemberUrn block (target profile)', () => {
    const payload = '"vieweeMemberUrn":"urn:li:member:738795938","viewerPrivacySetting":"F","networkDistance":1';
    expect(findNetworkDistance(payload)).toBe(1);
  });

  it('extracts distance=2 for non-connection profiles', () => {
    const payload = '"vieweeMemberUrn":"urn:li:member:1","viewerPrivacySetting":"F","networkDistance":2';
    expect(findNetworkDistance(payload)).toBe(2);
  });

  it('extracts distance=3 for distant profiles', () => {
    const payload = '"vieweeMemberUrn":"urn:li:member:2","viewerPrivacySetting":"F","networkDistance":3';
    expect(findNetworkDistance(payload)).toBe(3);
  });

  it('falls back to a loose match if no vieweeMemberUrn context exists', () => {
    expect(findNetworkDistance('{"networkDistance":1}')).toBe(1);
  });

  it('returns null when no networkDistance is present in the payload', () => {
    expect(findNetworkDistance('"otherField":1')).toBeNull();
    expect(findNetworkDistance('')).toBeNull();
  });

  it('finds distance even when LinkedIn reorders fields between anchor and distance', () => {
    // Anchor-based parser must not depend on field ordering. The old hardcoded
    // pattern required `vieweeMemberUrn → viewerPrivacySetting → networkDistance`
    // in EXACT order; this fixture deliberately swaps and adds extra fields
    // in between, exactly like LinkedIn might without notice. Regression case
    // for "Zhenia Mohyla wrongly stays declined" — a 1st-degree contact
    // misread as not_connected because the strict regex missed her distance.
    const payload = '"vieweeMemberUrn":"urn:li:member:111",'
      + '"extraField":"abc","anotherField":42,'
      + '"viewerPrivacySetting":"F","yetAnother":"x",'
      + '"networkDistance":1,"someTrailing":"z"';
    expect(findNetworkDistance(payload)).toBe(1);
  });

  it('ignores mutual-connection distance when target profile is 1st degree (anchor wins)', () => {
    // Real-world bug case: the target is 1st degree but the payload also
    // contains a mutuals sidebar with their own networkDistance values (2/3).
    // Anchor on vieweeMemberUrn must lock onto the target's distance, NOT
    // pick up some random mutual's distance from later in the payload.
    const payload = '"vieweeMemberUrn":"urn:li:member:111","networkDistance":1,'
      + '...someother...'
      + '"mutualConnection":{"networkDistance":2,"name":"Mutual A"},'
      + '"mutualConnection":{"networkDistance":3,"name":"Mutual B"}';
    expect(findNetworkDistance(payload)).toBe(1);
  });

  it('handles vieweeMemberUrn appearing before unrelated networkDistance occurrences', () => {
    // The anchor is FIRST, the target's distance appears nearby (within
    // window), then unrelated entries follow further down. Anchor-window
    // logic should still pick the right one.
    const payload = '"vieweeMemberUrn":"urn:li:member:111","networkDistance":1,'
      + 'a'.repeat(50000) + '"networkDistance":99';
    expect(findNetworkDistance(payload)).toBe(1);
  });
});

describe('findProfileBasics', () => {
  it('extracts firstName, lastName, vanityName, memberId together', () => {
    const payload = [
      '"firstName":"Михаил","lastName":"Курилович"',
      '"vanityName":"mikhail-kurilovich"}',
      '"memberUrn":{"memberId":"738795938"}',
    ].join(',');
    expect(findProfileBasics(payload)).toEqual({
      firstName: 'Михаил',
      lastName: 'Курилович',
      vanityName: 'mikhail-kurilovich',
      memberId: '738795938',
    });
  });

  it('falls back to vieweeMemberUrn for memberId when no flat memberUrn object', () => {
    const payload = '"firstName":"Anna","lastName":"Test","vieweeMemberUrn":"urn:li:member:42"';
    const r = findProfileBasics(payload);
    expect(r.memberId).toBe('42');
  });

  it('returns null when nothing recognizable is present', () => {
    expect(findProfileBasics('"unrelated":"data"')).toBeNull();
  });
});

describe('findActionTypes — what primary actions LinkedIn renders for this profile', () => {
  it('captures CONNECT, FOLLOW, WITHDRAW_INVITATION etc.', () => {
    const payload = '"actionTypeToLegacyControlName":{"CONNECT":"people_connect","FOLLOW":"pf_follow"}';
    const types = findActionTypes(payload);
    expect(types.has('CONNECT')).toBe(true);
    expect(types.has('FOLLOW')).toBe(true);
  });

  it('returns an empty Set when no actions are described', () => {
    expect(findActionTypes('').size).toBe(0);
  });
});

describe('detectStatusFromRSC — end-to-end status decision', () => {
  it('returns "connected" for networkDistance=1', () => {
    const payload = '"vieweeMemberUrn":"urn:li:member:1","viewerPrivacySetting":"F","networkDistance":1';
    expect(detectStatusFromRSC(payload)).toBe('connected');
  });

  it('returns "not_connected" for networkDistance>=2', () => {
    expect(detectStatusFromRSC('"vieweeMemberUrn":"urn:li:member:1","viewerPrivacySetting":"F","networkDistance":2'))
      .toBe('not_connected');
    expect(detectStatusFromRSC('"vieweeMemberUrn":"urn:li:member:1","viewerPrivacySetting":"F","networkDistance":3'))
      .toBe('not_connected');
  });

  it('returns "pending" when a Withdraw action is being rendered (Mira "Follow→Unfollow" canonical fix)', () => {
    // Regression for the Follow→Unfollow false-positive: only WITHDRAW_INVITATION
    // (an outstanding invite) means "pending", and it's present in the SSR
    // payload regardless of how LinkedIn paints the button.
    const payload = '"actionTypeToLegacyControlName":{"WITHDRAW_INVITATION":"x"}, "networkDistance":2';
    expect(detectStatusFromRSC(payload)).toBe('pending');
  });

  it('returns null when no relevant signals are found', () => {
    expect(detectStatusFromRSC('"foo":"bar"')).toBeNull();
  });
});

// Injection via innerHTML rather than createElement+append: the former skips
// jsdom's "evaluate inline script" path (per the HTML spec), so our fake
// `self.__next_f.push(...)` snippet never actually runs — which is what we
// want, because there is no `self.__next_f` array in this test environment.
function setScript(content) {
  document.body.innerHTML = `<script>${content}</script>`;
}

describe('extractRSCTextCached', () => {
  beforeEach(() => {
    resetRSCCache();
    document.body.innerHTML = '';
  });

  it('returns the same parsed payload on repeated calls (cache hit)', () => {
    setScript(pushChunk('"networkDistance":1'));
    const first = extractRSCTextCached(document);
    // Replace the script with a different one. The cached call must NOT
    // pick this up — the cache is keyed off URL, which hasn't changed.
    setScript(pushChunk('"networkDistance":3'));
    const second = extractRSCTextCached(document);
    expect(second).toBe(first);
    expect(second).toContain('"networkDistance":1');
    expect(second).not.toContain('"networkDistance":3');
  });

  it('re-reads from the DOM when the URL changes (SPA navigation)', () => {
    setScript(pushChunk('"networkDistance":2'));
    extractRSCTextCached(document);
    // Simulate SPA navigation: URL changes AND LinkedIn appends a new chunk.
    window.history.pushState({}, '', '/in/different-profile/');
    setScript(pushChunk('"networkDistance":1'));
    const after = extractRSCTextCached(document);
    expect(after).toContain('"networkDistance":1');
  });

  it('resetRSCCache forces re-read on next call', () => {
    setScript(pushChunk('"networkDistance":2'));
    extractRSCTextCached(document);
    setScript(pushChunk('"networkDistance":1'));
    resetRSCCache();
    const after = extractRSCTextCached(document);
    expect(after).toContain('"networkDistance":1');
  });
});
