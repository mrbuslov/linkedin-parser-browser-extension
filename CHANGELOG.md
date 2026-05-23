# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

In development for the next release. See [plan.md](plan.md) for the prioritized roadmap.

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
