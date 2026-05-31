# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

In development for the next release. See [plan.md](plan.md) for the prioritized roadmap.

## [1.1.2] — 2026-05-25

Bugfix release driven by external user feedback (thanks Mira).

### Fixed
- profile.js: a real 1st-degree connection no longer gets wrongly flipped to
  ✗ DECLINED in the popup just because a profile-page visit briefly saw a
  Follow/Connect button mid-render. Entries whose `verified='accepted'` was
  written by the canonical /connections/ scan (i.e. carry a `connectedOnText`
  field) are now off-limits to profile.js downgrades — only a fresh
  /connections/ scan can revise them.
- content.js: /sent/ invitations sent to an email address (no /in/ link
  because the recipient has no LinkedIn profile yet, or LinkedIn's
  "you-must-know-them" wall hid the link) are now captured. They appear in
  the Pending tab keyed by `mailto:<email>`, with the email rendered as a
  non-clickable monospace span (no profile to open, no email client to fire).

## [1.1.1] — 2026-05-25

Reliability patch for profile-visit status detection. Two real-user bugs fixed
plus a behavioral simplification.

### Fixed
- profile.js: 1st-degree contacts no longer get nuked on profile visit because
  of a transient mid-page-load false positive. Destructive status changes are
  now confirmed via a 1.5-second stability re-check before being committed.
- profile-state.js: visiting a profile that LinkedIn now shows as `not_connected`
  (Connect button visible) no longer silently deletes the entry. The badge
  flips to ✗ declined and the record is preserved in the "Didn't accept"
  collapsible block at the bottom of the Accepted tab.

### Changed
- not_connected handling unified: regardless of how the entry got `verified='accepted'`
  (via /connections/ scan or a previous profile.js detection), the entry is now
  preserved and marked declined rather than auto-deleted. Surprise removals
  erode trust in the data more than a stale label does. User can clean up
  manually if desired.

## [1.1.0] — 2026-05-25

Stability release. Several real-user bug reports fixed plus the long-awaited
canonical connections-page parser. Internals refactored for testability: pure
logic now lives in `linkedin-tracker/core/` and is covered by 66 Vitest unit tests
that run in CI on every push and pull request.

### Added
- Parser for `linkedin.com/mynetwork/invite-connect/connections/` — the canonical
  list of accepted connections. Each entry includes LinkedIn's own "Connected on"
  date which we use as the source of truth for `acceptedAt`. Multi-locale date
  parser (English native, Russian/Ukrainian/German via regex fallback).
- "Scan connections" button in the Accepted tab — opens the connections page if
  not already there, triggers a scan if already there.
- Per-tab last-scanned indicator under each summary row showing relative time
  and either count of items captured or the failure reason in red.
- "Contact support / Report issue" button in Settings → opens GitHub Issues.
- `scanState` storage key tracking per-source scan metadata (`sent`, `connections`).
- Declined entries collapsed into a `<details>` block at the bottom of the
  Accepted tab — they no longer clutter the main "to handle" count.
- Withdraw click listener on /sent/: explicitly withdrawn invites are stamped
  with `withdrawnAt` and excluded from the missing→accepted diff for 7 days.
- Vitest test suite (66 tests) covering the date parser, status detector,
  profile state transitions, /sent/ diff, and /connections/ merge.
- GitHub Actions CI: ESLint + tests run on every push and PR; tagged releases
  produce a CWS-ready zip artifact.

### Fixed
- profile.js: "phantom-accepted" — visiting a 2nd/3rd-degree profile no longer
  adds them to Accepted just because LinkedIn renders a `/messaging/` link
  (used for InMail). Now requires absence of Follow/Connect/Pending buttons +
  presence of Message link.
- profile.js: Pending button (an `<a>`, not `<button>`) now detected.
- profile.js: Pending detection no longer breaks on non-English UIs ("Очікує на
  розгляд") or buttons with embedded screen-reader text. Uses Unicode-friendly
  prefix matching instead of ASCII `\b` boundaries.
- profile.js: enforces "one bucket at a time" invariant — sending Connect after
  withdrawing no longer leaves a stale accepted entry visible alongside Pending.
- profile.js: removing a real connection drops the entry from Accepted instead
  of mis-labelling it as Declined.
- profile.js: clicking Connect from a profile page now adds the person to
  Pending in real time via an always-on MutationObserver.
- parseConnectedDate: rejects dates without an explicit 4-digit 20xx year
  (previously `Date.parse("May 24")` would silently fall back to year 2001).
- popup: "N to handle" count in the Accepted tab no longer includes declined
  entries.

### Changed
- Profile-name links in the popup now navigate the current active tab via
  `chrome.tabs.update` instead of opening a new tab. Cmd/Ctrl-click preserves
  new-tab behavior.
- "Open profile" button removed from Accepted/Marked rows (name is already a link).
- Project structure: pure logic extracted to `linkedin-tracker/core/`, content
  scripts now consume it via the manifest's `js:` array. No bundler — each
  core file is dual-mode (classic script + CJS module).

## [1.0.0] — 2026-05-21

First public release on the Chrome Web Store.

### Added
- Parser for `linkedin.com/mynetwork/invitation-manager/sent/` that captures
  every sent invitation (name, headline, profile URL, avatar, "sent X ago")
- Diff algorithm: anyone who disappears from /sent/ between scans is moved to
  Accepted as a likely-accepted connection
- Age-based color coding for pending invites (yellow at 7 days, red at 14)
- Profile-page content script that auto-captures every `/in/...` profile the
  user visits (name, headline, location, country, photo URL, connection status)
- Cross-language connection-status detection via `/messaging/` link presence
  (works regardless of LinkedIn UI language)
- Auto-archive of pre-existing connections discovered through profile visits
  (they land directly in Marked rather than Accepted)
- Popup with four tabs: Pending, Accepted, Marked, Settings
- Status badges per accepted entry: ✓ accepted, ✗ declined, ? unverified
- Mark / Mark all / Unmark actions for moving entries between Accepted and Marked
- Search field that filters all lists by name or headline
- JSON export/import for full local backup and device migration
- CSV export for external analysis
- Custom tooltip explaining the unverified ? status
- Desktop notifications for newly accepted connections after a scan
- Scan progress UI with cancellable Stop button and animated spinner
- In-popup hint advising users to keep the LinkedIn tab visible during scans
  (Chrome throttles background tabs and pauses lazy-loads)
- Single header action button with three modes: Go to Sent page / Scan / Stop

### Changed
- Storage backend: IndexedDB instead of `chrome.storage.local`. Removes the
  10 MB ceiling; effectively unlimited on user's device (gigabytes available).
  All reads/writes proxied through the service worker so content scripts
  (linkedin.com origin) and the popup (extension origin) share one store.
- Popup layout: full-height flex layout eliminates the previous scroll-within-scroll

### Removed
- `storage` permission (no longer needed after IDB migration)
