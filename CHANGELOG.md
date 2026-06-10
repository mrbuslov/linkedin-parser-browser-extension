# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

In development for the next release. See [plan.md](plan.md) for the prioritized roadmap.

## [1.2.3] — 2026-06-11

Hardening release on top of 1.2.2. Real-world testing surfaced layout
overflow, duplicate records, headline/name corruption, and a parser
that broke when LinkedIn updated its Contact-info markup. Every fix is
grounded in actual user-reported data — no speculative changes.

### Added
- `core/contacts-modal.js` parser now anchors primarily on **SVG icon ids**
  (`envelope-medium`, `phone-handset-small`, `link-medium`, `calendar-medium`,
  `people-medium`, `house-medium`, `linkedin-bug-medium`). LinkedIn ships
  these from a shared icon library used across the entire UI — renaming one
  would break hundreds of pages, so they're effectively frozen. Label-text
  matching kept as fallback for the case where icons disappear. Regression
  fixture (Igor Alentyev's actual modal HTML, 15 KB) pinned in
  `tests/fixtures/igor-contacts-modal.html` and exercised by the test
  suite — multi-website extraction included.
- DOM **aria-label degree detector** as the new top-priority signal in
  the connection detector. LinkedIn renders the connection degree as
  `aria-label="<Name> [Premium Profile] <1st|2nd|3rd>"` for screen
  readers across every profile shape, including Premium profiles that
  ship NO RSC payload at all. Priority chain: DOM Pending → aria-label
  degree → RSC degree → DOM fallback.
- **Cross-URL dedup by `memberId`** (zero name-based fallback). When
  LinkedIn changes a profile's vanity slug, the new record's `memberId`
  from RSC matches an existing entry's `memberId`, and the records get
  merged into the current-URL key (contact info, marked status, earlier
  firstSeenAt/acceptedAt, `verified='accepted'` all carry over). Name
  matching was deliberately rejected because two real people can share
  a name and silently merging them corrupts data with no recovery.
  Records now persist `memberId` / `vanityName` on every visit.
- Per-row **Delete** button across all popup tabs (Pending, Accepted,
  Marked, Declined block). One click + confirm dialog → entry purged
  from `sentInvitations` / `accepted` / `contacts` in one transaction.
- Settings → Privacy → **Forget all contact details** button. Wipes
  email/phone/website/address/birthday/connectedSinceText from every
  record. Names, headlines, profile URLs, accepted/marked status are
  preserved.
- **`extractRSCTextCached`** in `core/rsc-parser.js` — URL-keyed cache
  for the parsed RSC payload. Previously re-parsed 1.5 MB of script
  bytes on every 250 ms poll tick. Cache invalidates on URL change so
  SPA navigation between profiles still picks up the new payload.
- Popup **on-page toast** for contact-info capture confirmation:
  white card with green check, field chips ("📧 email · 📞 phone · 🌐
  website · 📍 address · 🎂 birthday"), rendered via Popover API in the
  browser top layer so LinkedIn's `<dialog>`-based modal can't hide it.
- `LITPopupLogic.cleanHeadline` and `LITPopupLogic.fixSwappedNameHeadline`
  in `core/popup-logic.js` — defensive cleanup helpers run on every
  popup render plus a one-shot storage migration on popup load.

### Fixed
- **Contact-info parser broke on the new LinkedIn markup** (Igor Alentyev's
  profile, observed 2026-06-11): per-section `componentkey` attribute
  was dropped from contact rows. Parser now uses SVG icon ids first and
  label-text as fallback; both shapes parse correctly.
- **5 duplicate records of the same person** caused by three independent
  bugs: (1) `normalizeProfileUrl` didn't collapse `/in/<vanity>/overlay/…`
  sub-paths, so opening Contact info stored under a different key;
  (2) content script kept running after SPA navigation and wrote a
  `https://www.linkedin.com/search/results/people/` keyed entry;
  (3) cross-URL dedup didn't exist. All three closed: normalizer
  collapses any `/in/<vanity>/<sub-path>...` to canonical, profile.js
  tick gates writes via `isProfilePath(location.pathname)`, and dedup
  merges by `memberId`.
- **`name` and `headline` swapped in legacy records** ("Daniil
  StankevichFullstack developer | …" stored as `name`, "Daniil
  Stankevich" stored as `headline`). `fixSwappedNameHeadline` detects
  the signature (`name` starts with `headline` AND is longer), swaps
  them, and strips any leading separator. Runs both at render time
  (instant visual fix on all tabs) and as a one-shot storage migration
  on popup load (so CSV exports get the clean shape too).
- **Name glued to headline** in newly-extracted records (LinkedIn ships
  an accessibility text node that combines both). `stripNamePrefix` in
  `extractProfileInfo` strips the name at extract; `cleanHeadline` at
  render time cleans legacy data without requiring a re-visit.
- **"· 1st" badge text** was being captured as headline. Skip filter
  in `extractProfileInfo` matches the degree-badge pattern (EN/RU/UA).
- **Zhenia Mohyla "stuck declined" canonical fix**: detector gained the
  aria-label degree signal, RSC `findNetworkDistance` rewritten to be
  robust against LinkedIn reordering fields in the payload, and
  `applyContactInfo` now flows into `accepted[url]` regardless of the
  visit status branch (was only `connected`).
- **Popup layout horizontal/vertical overflow**: `flex-wrap: wrap` on
  `.row .name-row`, `min-width: 0` chain through `.row-body`/`.name-row`/
  `.name`, ellipsis on long names, hard 380×600 cap on html/body.
- **popup.js SyntaxError** ("Identifier 'cleanHeadline' has already been
  declared") — `popup-logic.js` declared it as `function`, `popup.js`
  re-declared via `const` in the same global scope. Removed the `const`,
  use the global directly.
- Toast restyled to **white LinkedIn-style** card with max z-index and
  Popover API so it sits in the browser top layer (`<dialog>`-based
  LinkedIn modals can't hide it).
- CSV export now includes `email`, `phone`, `phoneLabel`, `website`,
  `address`, `birthday` columns (joined from the contacts store).
- Popup search matches against email/phone/website/address.

### Internal
- `temp/` directory untracked from git (it was already in `.gitignore`
  but legacy fixture HTMLs were committed under it).
- `tests/fixtures/` is the new home for real-world HTML samples used in
  regression tests.

## [1.2.2] — 2026-06-11

Contact-info harvest. When the user opens the "Contact info" overlay on any
profile, the extension now reads the fields LinkedIn shows there (email,
phone, website, address, birthday, connected-since) and stores them on the
contact record. Nothing is ever sent off-device. The popup grows a small
copy button per captured field — one click puts the value on the clipboard.

### Added
- `core/contacts-modal.js` — parser keyed off the stable
  `data-sdui-screen="com.linkedin.sdui.flagshipnav.profile.ProfileContactDetailsOverlay"`
  attribute. Each section's two `<p>` tags (label + value) are mapped to a
  canonical field name. Localized labels handled for English / Russian /
  Ukrainian.
- `decodeLinkedInRedirect` in `core/url.js` — strips LinkedIn's
  `safety/go/?url=…` wrapper so the website we store is the actual
  destination URL, not the obfuscated redirect.
- `applyContactInfo` state helper — overwrite-on-visit semantics with a
  `contactsCapturedAt` timestamp. Fields absent from the latest modal
  snapshot are preserved (no destructive wipe if the user opens the modal
  on a profile where only Phone is visible).
- Popup: small copy buttons (📧 📞 🌐) appear next to a contact's name in
  the Accepted/Marked tabs when the corresponding field is stored. Click =
  one-shot toast "email copied" / "phone copied" / "website copied".
- Popup search now matches against email/phone/website/address too — typing
  "t.me" finds the contact whose website is t.me/…
- 25 new unit tests across `contacts-modal.test.js`, `url.test.js`, and the
  contact-info section of `profile-state.test.js`. 152 tests total.
- CSV export now includes email, phone, phoneLabel, website, address, birthday
  columns (joined from the contacts store by profileUrl).
- Settings → Privacy → "Forget all contact details" button that wipes the
  captured fields from every record (names, headlines, profile URLs and
  accepted/marked status are preserved). Requires explicit confirmation.
- `extractRSCTextCached` — URL-keyed cache for the parsed RSC payload. We
  used to re-parse 1.5 MB of script bytes every 250 ms poll tick; we now
  parse once per page load. Cache invalidates on URL change so SPA navigation
  between profiles still picks up the new payload. 3 new tests pin the
  cache-hit, URL-change-invalidate, and resetRSCCache behaviors.
- On-page toast on the profile when Contact info modal data is captured —
  "✓ Contact info saved — 📧 📞 🌐" (2.2 sec, bottom-right, dedup'd). User
  no longer has to open the popup to know whether the harvest worked.
- Contact-info fields now also flow into `sentInvitations[url]` when the
  profile is pending, so the Pending tab in the popup renders the same
  copy buttons (📧 📞 🌐) as Accepted/Marked. Symmetric across all three
  tabs now.

### Fixed
- **Zhenia Mohyla "stays declined after profile visit" root-cause fix**:
  detector gained a new top-priority signal — DOM `aria-label` degree. LinkedIn
  always renders `<element aria-label="<Name> [Premium Profile] <1st|2nd|3rd>">`
  on the top-card for screen-reader accessibility. Some profile variants
  (Premium accounts in particular) ship NO RSC payload at all — the previous
  detector then fell to DOM heuristics, where a Follow button (Creator mode)
  was mis-read as "not connected". With aria-degree the detector now
  authoritatively says "1st degree" from a signal LinkedIn cannot remove.
  Priority chain is now: DOM Pending → aria-label degree → RSC degree → DOM
  fallback. Six regression tests including the exact Zhenia DOM shape.
- **Cross-URL dedup** by memberId ONLY (no name fallback) when LinkedIn
  changes a profile's vanity slug. `applyProfileVisit` scans
  `contacts`/`accepted`/`sentInvitations` for a record with a matching
  `memberId` — LinkedIn's canonical numeric profile ID, read from RSC.
  When found, contact-info fields, marked status, earlier
  firstSeenAt/acceptedAt and any `verified='accepted'` carry over into
  the current-URL record and the old key is deleted. Records gain
  `memberId` / `vanityName` on every visit so future dedup is rock-solid.
  Name-based fallback was deliberately rejected: two real people can share
  a name, and a silent name-merge corrupts data with no recovery. If
  memberId is missing on either side, we don't auto-merge — user can
  clean up manually if it bothers them.
- On-page toast restyled to **white LinkedIn-style** card: green ✓ in a
  circle, dark title text, light chip pills for each captured field
  (📧 email · 📞 phone · 🌐 website · 📍 address · 🎂 birthday). Larger
  padding (18px 22px), softer dual-layer shadow, max-z-index so the toast
  is never hidden by LinkedIn's own modal backdrops.
- `applyContactInfo` now flows into `accepted[url]` regardless of the visit
  status branch — previously only the `connected` branch wrote contact-info
  fields onto the accepted record. As a result, a profile that was stuck
  declined got its contact-modal data written only into the `contacts`
  journal, and the popup row showed no copy buttons (because the popup
  reads from `accepted`, not `contacts`). Now buttons appear whenever the
  user opens the Contact info modal, no matter the verified status.
- `findNetworkDistance` rewritten to be robust against LinkedIn reordering
  fields in the RSC payload. The previous version matched a hardcoded
  field sequence (`vieweeMemberUrn → viewerPrivacySetting → networkDistance`)
  — if LinkedIn ever inserts an extra field or reorders, the strict regex
  silently fails and the loose fallback picks up some mutual-connection's
  distance instead, mislabelling a real 1st-degree contact as 2nd-degree.
  This is the root cause behind "Zhenia Mohyla stays wrongly declined even
  after profile re-visit". New logic: anchor on `vieweeMemberUrn`, then
  search a 4 KB window forward for the FIRST `networkDistance`. No coupling
  to neighboring field order. Three new regression tests cover reordering,
  mutuals-sidebar contamination, and trailing unrelated distances.

### Notes
- Profile pages where the user never opens "Contact info" yield no extra
  fields — we don't auto-open anything, no extra requests.
- LinkedIn's RSC payload does not contain the contact-info fields. They're
  only loaded into the DOM when the overlay opens, so DOM scraping is the
  right (and only) path here.

## [1.2.1] — 2026-06-10

Canonical-source switch for the profile detector. Profile-page status now
comes from LinkedIn's own SSR payload (Next.js RSC), not from inspecting
which buttons happen to be visible at the moment we read the DOM. The
entire class of "DOM mis-read" bugs goes away with one change.

### Added
- `core/rsc-parser.js` — reads LinkedIn's streaming Next.js payload from
  `<script>` tags (`self.__next_f.push([1, "…"])`). Extracts the canonical
  `networkDistance` (1/2/3 ⇒ connection degree), `firstName`, `lastName`,
  `vanityName`, `memberId`, plus the set of primary actions (CONNECT,
  FOLLOW, WITHDRAW_INVITATION). Content-script safe — no MAIN-world
  injection, no extra permissions.
- 18 unit tests covering RSC extraction, escape decoding, status mapping,
  and the regression case behind Mira's "Follow→Unfollow flips to Accepted".

### Fixed
- profile.js status detection: primary source is now `networkDistance` from
  the SSR payload. Clicking Follow on a non-connection no longer causes a
  false "accepted" state, because the canonical degree doesn't change with
  follow-status. DOM heuristics remain as a fallback for SPA navigations
  where the payload isn't reloaded.
- profile.js name extraction: prefers `firstName + lastName` from the SSR
  payload before falling back to the page heading. Eliminates the
  long-headline-stuck-to-name family of bugs at the source.

## [1.2.0] — 2026-06-02

Big stability release driven by extensive real-world testing with Mira and
other beta users. Many bugs that had been silently dropping data are fixed,
and there's a new onboarding nudge in the popup so users know to run the
/connections/ scan when needed.

### Added
- Yellow warning banner in the Accepted tab that appears when declined entries
  exist AND the /connections/ scan was never run. One-click "Open connections
  page" CTA. Disappears permanently after the first /connections/ scan.
- `core/popup-logic.js` with pure-function helpers for popup decisions.

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
- profile.js: replaced MutationObserver + debounce + stability-confirm logic
  with a simple 250ms polling loop. The latest DOM snapshot self-corrects on
  the next tick, so transient mid-render false positives disappear within a
  quarter-second. Net code reduction ~40 lines.
- connections.js: /connections/ scan no longer exits early when LinkedIn
  virtualizes its long list (top cards get removed from DOM as new ones load
  at bottom, keeping the visible count flat). We now parse cards on every
  tick and accumulate into a Map keyed by profileUrl, so total-seen growth
  is the real signal. Plus a hard `window.scrollTo(0, scrollHeight)` each
  tick to trigger LinkedIn's lazy-load handler reliably. Stable-rounds
  threshold bumped 4 → 6 (16-28s tolerance) for slow LinkedIn batches.
- connections.js: avatar URLs are now picked up correctly. Previously the
  parser would lock in `avatar=''` on the very first parse of a card (when
  LinkedIn hadn't lazy-loaded the `<img>` yet) and never re-attempt. Now
  cards are re-parsed every tick and non-empty fields are preferred.
- merge-connections.js: pre-existing connections discovered during the first
  /connections/ scan are now auto-marked (go straight to Marked tab) so they
  don't pollute the "to handle" count in Accepted. Newly accepted invites
  (those that were in sentInvitations before) stay unmarked — those are the
  ones the user actually needs to handle.
- content.js (Withdraw): clicking Withdraw on /sent/ now removes the entry
  from Pending immediately. Previously we just stamped `withdrawnAt` and
  the entry hung around in the popup until the next /sent/ scan.
- /connections/ card parser: cards whose `<a href="/in/...">` link wraps both
  the name AND a long headline (new LinkedIn UI) no longer get silently
  dropped. Name is now extracted from the first inner `<h1>/<h2>/<h3>/<p>`,
  not from the whole `link.textContent`. This was the root cause of Mira's
  "Luis/Ana/Bernardo stuck as ✗ DECLINED" — they never made it into the
  /connections/ scan snapshot, so the canonical "verified=accepted" override
  never applied to them.
- /connections/ scan now scrolls the actual scroll container (LinkedIn's
  `<main>` element) instead of the window. The newer LinkedIn UI uses an
  internal scroll layer with `scrollHeight` of ~40000 while the window
  itself doesn't scroll at all — earlier versions got stuck at ~280 cards
  out of 2000+. We now detect the right container per tick and force-scroll
  it to the bottom.
- All hardcoded upper text-length filters removed across content.js,
  connections.js, profile.js, and core/detect.js. Lower bounds (skip
  empty/single-char strings) retained as garbage filters. Long real-world
  content (headlines, locations, button labels) is now preserved verbatim.

### Tests
- 94 unit tests (was 82). New regression cases: long-headline /connections/
  card capture, "no upper length cap" semantics, detect.js defense against
  long button-text false positives, popup warning visibility rules.

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
