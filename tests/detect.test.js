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

  // RSC + DOM combined-mode tests. These cover the real-world reasoning
  // described in core/detect.js — RSC is the ground truth for "are they
  // 1st degree", DOM polling catches real-time actions.

  function withRSCDistance(distance, innerHTML) {
    const payload = `"vieweeMemberUrn":"urn:li:member:1","viewerPrivacySetting":"F","networkDistance":${distance}`;
    const escaped = payload.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    document.body.innerHTML = `
      <script>self.__next_f.push([1, "${escaped}"])</script>
      <main>${innerHTML}</main>
    `;
    return document.querySelector('main');
  }

  it('returns "connected" when RSC says distance=1 regardless of which buttons are visible', () => {
    // Mira's "Follow→Unfollow" canonical regression. Even if DOM shows a
    // Following button (which OLD code might misinterpret), RSC ground truth
    // wins: distance=1 means they're a real connection.
    const root = withRSCDistance(1, `
      <h2>Real Connection</h2>
      <a href="/messaging/compose/">Message</a>
      <button>More</button>
    `);
    expect(detectConnectionStatus(root)).toBe('connected');
  });

  it('returns "not_connected" when RSC says distance=2 even if DOM looks "connected-ish"', () => {
    // Follow on a 2nd-degree contact: DOM has Following + Message, no Connect.
    // Without RSC, our detector previously thought this was 'connected'.
    // With RSC, distance=2 trumps the ambiguous DOM signal.
    const root = withRSCDistance(2, `
      <h2>Just Following</h2>
      <button>Following</button>
      <a href="/messaging/compose/">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('not_connected');
  });

  it('DOM Pending button trumps RSC (user just clicked Connect; RSC is now stale)', () => {
    // RSC snapshot was rendered when distance=2 and CONNECT was offered. User
    // then clicked Connect. DOM swapped Connect → Pending. Our detector
    // must return 'pending' — DOM is fresher than RSC for this event.
    const root = withRSCDistance(2, `
      <h2>Just Invited</h2>
      <a aria-label="Pending, click to withdraw invitation">Pending</a>
      <a href="/messaging/compose/">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('pending');
  });

  it('falls back to DOM-only logic when no RSC payload is present (SPA navigation)', () => {
    document.body.innerHTML = `
      <main>
        <h2>SPA-Navigated Profile</h2>
        <a href="/messaging/compose/">Message</a>
      </main>
    `;
    const root = document.querySelector('main');
    expect(detectConnectionStatus(root)).toBe('connected');
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

  // aria-label-degree tests. This is the new top-priority degree signal.
  // It's the canonical fix for "Zhenia Mohyla wrongly declined" — her profile
  // ships no RSC payload (Premium account) but has `aria-label="Zhenia Mohyla
  // Premium Profile 1st"` on the top-card. The detector must pick that up
  // and return 'connected' regardless of the Follow button being rendered.

  it('Zhenia regression: aria-label "Name Premium Profile 1st" wins over Follow button + Message', () => {
    // EXACT real-world DOM shape: Premium profile, Follow visible (Creator
    // mode), Message visible, NO RSC. Without aria-degree this falls to
    // hasFollow → not_connected → declined badge stays.
    const root = makeRoot(`
      <a aria-label="Zhenia Mohyla Premium Profile 1st" href="/in/zhenia/">
        <h1>Zhenia Mohyla</h1>
      </a>
      <button>Follow</button>
      <a href="/messaging/compose/?recipient=zhenia">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('connected');
  });

  it('returns connected for "Name 1st" aria-label (no Premium tag)', () => {
    const root = makeRoot(`
      <a aria-label="John Smith 1st"><h1>John Smith</h1></a>
      <a href="/messaging/compose/">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('connected');
  });

  it('returns not_connected for "2nd" aria-label degree', () => {
    const root = makeRoot(`
      <a aria-label="Some Name 2nd"><h1>Some Name</h1></a>
      <button>Connect</button>
    `);
    expect(detectConnectionStatus(root)).toBe('not_connected');
  });

  it('returns not_connected for "3rd" aria-label degree', () => {
    const root = makeRoot(`
      <a aria-label="Distant Person 3rd"><h1>Distant Person</h1></a>
      <button>Follow</button>
    `);
    expect(detectConnectionStatus(root)).toBe('not_connected');
  });

  it('does NOT false-match "1st" embedded in arbitrary mid-text aria-label', () => {
    // The regex requires the degree token at the END of the aria-label
    // (with trailing whitespace allowed). "Wins 1st place trophy" must NOT
    // be read as a degree signal.
    const root = makeRoot(`
      <a aria-label="Wins 1st place trophy"><h1>Trophy Holder</h1></a>
      <button>Connect</button>
      <a href="/messaging/compose/">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('not_connected');
  });

  it('Pending DOM button wins over aria-degree 2nd (user just sent invite)', () => {
    // The page's aria says 2nd degree; user clicked Connect; the button
    // flipped to Pending. We want the freshly-updated DOM signal to win
    // because aria-degree won't update until reload.
    const root = makeRoot(`
      <a aria-label="Foo Bar 2nd"><h1>Foo Bar</h1></a>
      <a aria-label="Pending, click to withdraw">Pending</a>
      <a href="/messaging/compose/">Message</a>
    `);
    expect(detectConnectionStatus(root)).toBe('pending');
  });

  it('Kimberly Martinez regression: sidebar Pending buttons do NOT leak into detection (scope to top-card)', () => {
    // The top-card sits inside a <section>. Sidebars with OTHER people's
    // action buttons live OUTSIDE the section, still inside <main>. The
    // detector now scopes its button scan to the top-card section, so
    // sidebar buttons are invisible to it by construction. Previously a
    // sidebar Pending button caused a real 1st-degree contact to be
    // classified as pending → stored in sentInvitations.
    const root = makeRoot(`
      <section>
        <a aria-label="Kimberly Martinez Premium Profile 1st">
          <h1>Kimberly Martinez</h1>
        </a>
        <a href="/messaging/compose/">Message</a>
        <button>More</button>
      </section>
      <aside>
        <button>Connect</button>
        <button>Connect</button>
        <a aria-label="Pending, click to withdraw invitation sent to Anton">Pending</a>
        <button>Follow</button>
        <button>Follow</button>
      </aside>
    `);
    expect(detectConnectionStatus(root)).toBe('connected');
  });

  it('scope ignores sidebar Connect for a 1st-degree without explicit Message in top-card', () => {
    // The top-card has aria-degree=1 and Message — detector returns 'connected'.
    // Sidebar Connect buttons (for OTHER people) must not flip it to 'not_connected'.
    const root = makeRoot(`
      <section>
        <a aria-label="Some Person 1st"><h1>Some Person</h1></a>
        <a href="/messaging/compose/">Message</a>
      </section>
      <aside>
        <button>Connect</button>
        <button>Follow</button>
        <a href="/preload/custom-invite/?profile=other">…</a>
      </aside>
    `);
    expect(detectConnectionStatus(root)).toBe('connected');
  });

  it('scope ignores sidebar Follow for a 2nd-degree (real "Connect" still detected in top-card)', () => {
    const root = makeRoot(`
      <section>
        <a aria-label="Some Person 2nd"><h1>Some Person</h1></a>
        <button>Connect</button>
        <a href="/messaging/compose/">Message</a>
      </section>
      <aside>
        <button>Follow</button>
        <button>Following</button>
      </aside>
    `);
    expect(detectConnectionStatus(root)).toBe('not_connected');
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
