import { describe, it, expect, beforeEach } from 'vitest';
import { detectConnectionStatus } from '../linkedin-tracker/core/detect.js';

// Build a minimal profile-page DOM. Each fixture function returns the `root`
// element that detectConnectionStatus expects (the LinkedIn <main>).
function makeRoot(innerHtml) {
  document.body.innerHTML = `<main>${innerHtml}</main>`;
  return document.querySelector('main');
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('detectConnectionStatus', () => {
  it('returns null when there is no heading on the page', () => {
    const root = makeRoot('<div>not loaded yet</div>');
    expect(detectConnectionStatus(root)).toBeNull();
  });

  it('returns null when root itself is null', () => {
    expect(detectConnectionStatus(null)).toBeNull();
  });

  it('returns "connected" for a 1st-degree profile (Message link only)', () => {
    const root = makeRoot(`
      <h1>Alice Doe</h1>
      <a href="/messaging/compose/?recipient=alice">Message</a>
      <button>More</button>
    `);
    expect(detectConnectionStatus(root)).toBe('connected');
  });

  it('returns "not_connected" for a 2nd-degree profile with Connect button', () => {
    const root = makeRoot(`
      <h1>Bob Smith</h1>
      <button>Connect</button>
      <a href="/messaging/compose/?recipient=bob">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('not_connected');
  });

  it('returns "pending" when Pending button is present', () => {
    const root = makeRoot(`
      <h1>Carol</h1>
      <a aria-label="Pending, click to withdraw invitation sent to Carol">Pending</a>
      <a href="/messaging/compose/?recipient=carol">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('pending');
  });

  it('returns "pending" even when Pending button contains hidden screen-reader text (the Anna Sukhotska bug)', () => {
    // LinkedIn sometimes wraps Pending in an <a> whose textContent includes the
    // hidden aria-style description, making the trimmed text "Pending\nClick to
    // withdraw invitation sent to Anna Sukhotska" rather than bare "Pending".
    const root = makeRoot(`
      <h2>Anna Sukhotska</h2>
      <a aria-label="Pending, click to withdraw invitation sent to Anna Sukhotska">
        <span aria-hidden="true">Pending</span>
        <span class="visually-hidden">Click to withdraw invitation sent to Anna Sukhotska</span>
      </a>
      <a href="/messaging/compose/?recipient=anna">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('pending');
  });

  it('returns "pending" for Russian "Очікує" / "Ожидает" Pending button', () => {
    const rootRu = makeRoot(`
      <h1>Иван Иванов</h1>
      <a aria-label="Ожидает, нажмите чтобы отозвать приглашение">Ожидает</a>
      <a href="/messaging/compose/">Сообщение</a>
    `);
    expect(detectConnectionStatus(rootRu)).toBe('pending');
  });

  it('returns "pending" for Ukrainian Pending', () => {
    const root = makeRoot(`
      <h2>Ганна Сухоцька</h2>
      <a aria-label="Очікує, натисніть, щоб скасувати запрошення">Очікує на розгляд</a>
      <a href="/messaging/compose/">Повідомлення</a>
    `);
    expect(detectConnectionStatus(root)).toBe('pending');
  });

  it('returns "not_connected" for a 3rd-degree profile with Follow + Message (no Connect, no Pending)', () => {
    const root = makeRoot(`
      <h1>Distant Person</h1>
      <button>Follow</button>
      <a href="/messaging/compose/?recipient=foo">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('not_connected');
  });

  it('treats /preload/custom-invite/ link as a not_connected signal even without text buttons', () => {
    const root = makeRoot(`
      <h1>Stranger</h1>
      <a href="/preload/custom-invite/?profile=stranger">…</a>
      <a href="/messaging/compose/">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('not_connected');
  });

  it('accepts h2 instead of h1 (LinkedIn moved name from h1 to h2 in some layouts)', () => {
    const root = makeRoot(`
      <h2>H2 Name</h2>
      <a href="/messaging/compose/">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('connected');
  });

  it('ignores Pending mentions in long <div> paragraphs (only buttons/anchors are matched)', () => {
    // Defense in depth: even without a length cap, the selector restricts to
    // button/a/[role="button"] — bare <div>s with "pending" prose don't match.
    const root = makeRoot(`
      <h1>Some Person</h1>
      <button>Connect</button>
      <a href="/messaging/compose/">Message</a>
      <div>Pending invitations are shown elsewhere. Lots of explanatory paragraph text here that mentions pending more than once to make sure we don't accidentally trigger on long passages.</div>
    `);
    expect(detectConnectionStatus(root)).toBe('not_connected');
  });

  it('does not false-positive on a long button label that happens to contain "Follow"', () => {
    // After length-cap removal we rely purely on prefix matching. A button
    // text that starts with "Follow" still triggers hasFollow — but a button
    // text that just MENTIONS follow somewhere in the middle should not.
    const root = makeRoot(`
      <h1>Real Connection</h1>
      <button>Click to learn how to follow this user later</button>
      <a href="/messaging/compose/">Message</a>
    `);
    // The button text starts with "Click" → does NOT match Follow prefix.
    expect(detectConnectionStatus(root)).toBe('connected');
  });

  it('ignores hidden Pending buttons (display:none)', () => {
    const root = makeRoot(`
      <h1>Visible Connection</h1>
      <a style="display:none" aria-label="Pending, click to withdraw">Pending</a>
      <a href="/messaging/compose/">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('connected');
  });

  it('prioritizes Pending over Connect when both are present', () => {
    // Edge case where LinkedIn might render both during transition. Pending
    // should win since it's the more specific signal about user action.
    const root = makeRoot(`
      <h1>Transitional State</h1>
      <button>Connect</button>
      <a aria-label="Pending, click to withdraw invitation">Pending</a>
      <a href="/messaging/compose/">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('pending');
  });
});
