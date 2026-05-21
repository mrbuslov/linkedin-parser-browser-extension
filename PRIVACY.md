# Privacy Policy — LinkedIn Parser: Invites & Contacts

_Last updated: 2026-05-21_

This Chrome extension is built around a simple promise: **your data never leaves your browser**.

## What the extension does

The extension reads two kinds of pages on linkedin.com that you open yourself:

1. **The sent invitations page** (`linkedin.com/mynetwork/invitation-manager/sent/`) — to track which connection requests you've sent and which have been accepted or declined.
2. **Profile pages** (`linkedin.com/in/...`) — to capture metadata about people you visit (name, headline, location, profile photo URL, connection status).

The extension activates **only on pages you navigate to yourself**. It never opens LinkedIn pages in the background, never clicks any UI, and never calls LinkedIn's internal APIs.

## What is stored

The extension stores the following data in **IndexedDB on your own device only**:

- Sent invitations: profile URL, name, headline, "sent X days ago" string, avatar URL, timestamps
- Accepted connections: same fields plus when they accepted, connection status (✓ accepted / ✗ declined)
- Contacts visited: same fields plus location and country (parsed from the profile page)
- Scan history: timestamps and counts (for stats)
- Local settings: scan-in-progress flag, marked/unmarked flags

## What is NOT stored or collected

- **No passwords**, no LinkedIn cookies, no authentication tokens — the extension never touches your LinkedIn session
- **No analytics, no telemetry** — there are zero outbound network requests from the extension to any external server
- **No third-party services** — no Google Analytics, no Sentry, no crash reporting, nothing
- **No advertising IDs, no fingerprinting, no tracking**

## Where the data goes

Nowhere. There is no backend. The extension does not connect to any server controlled by the developer or by any third party. All data lives in `IndexedDB` on your local machine. If you uninstall the extension or clear Chrome's site data, the data is gone.

## Your control over the data

- **View it** anytime in Chrome DevTools → Application → IndexedDB → `linkedin-tracker`
- **Export it** as JSON from the Settings tab inside the extension popup
- **Import it** back from a JSON backup on the same or another device
- **Delete it** by uninstalling the extension or by clearing site data for the extension

## Permissions

- `host_permissions: https://www.linkedin.com/*` — required to read the sent invitations page and profile pages you visit
- `notifications` — to show local desktop notifications when someone new accepts your invite. No remote notification service is used.

That is the full permission set. The extension does not request `tabs`, `storage`, `cookies`, `webRequest`, or any other broad-scope permissions.

## Changes to this policy

If this policy ever changes, the new version will be published in this same file with an updated date. There are no email lists or accounts to notify you, by design.

## Affiliation

This extension is an independent third-party tool and is **not affiliated with, endorsed by, or sponsored by LinkedIn Corporation**. LinkedIn is a trademark of LinkedIn Corporation.

## Contact

Issues and questions: open an issue in the GitHub repository for this extension.
