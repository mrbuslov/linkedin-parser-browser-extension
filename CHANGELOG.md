# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

In development for the next release. See [plan.md](plan.md) for the prioritized roadmap.

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

### Fixed
- profile.js: "phantom-accepted" — visiting a 2nd/3rd-degree profile no longer
  adds them to Accepted just because LinkedIn renders a `/messaging/` link
  (used for InMail). Now requires absence of Follow/Connect/Pending buttons +
  presence of Message link.
- profile.js: Pending button (an `<a>`, not `<button>`) now detected.
- profile.js: enforces "one bucket at a time" invariant — sending Connect after
  withdrawing no longer leaves a stale accepted entry visible alongside Pending.
- profile.js: removing a real connection drops the entry from Accepted instead
  of mis-labelling it as Declined.
- profile.js: clicking Connect from a profile page now adds the person to
  Pending in real time via an always-on MutationObserver.

### Changed
- Profile-name links in the popup now navigate the current active tab via
  `chrome.tabs.update` instead of opening a new tab. Cmd/Ctrl-click preserves
  new-tab behavior.
- "Open profile" button removed from Accepted/Marked rows (name is already a link).

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
