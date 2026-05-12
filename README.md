# LinkedIn Connection Tracker

Read-only Chrome extension (Manifest V3) that tracks sent LinkedIn invitations. When someone disappears from the `/sent/` page they accepted (or you withdrew, or they declined), so the extension diffs every visit and surfaces newly-accepted connections to write a welcome message to.

See [linkedin-tracker-extension-spec.md](linkedin-tracker-extension-spec.md) for the full design and rationale.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the [linkedin-tracker/](linkedin-tracker/) folder
4. Pin the extension to the toolbar for easier access

## Usage

1. Go to https://www.linkedin.com/mynetwork/invitation-manager/sent/
2. The extension auto-scrolls to load the full list, then parses every card silently
3. Click the toolbar icon to see Pending and Accepted tabs
4. Badge number = accepted connections still waiting for a welcome message
5. Click **CSV** in the popup to export all data

## Files

- [linkedin-tracker/manifest.json](linkedin-tracker/manifest.json) — MV3 manifest, minimal permissions (`storage`, `notifications`)
- [linkedin-tracker/content.js](linkedin-tracker/content.js) — DOM parser, auto-scroll, diff against previous snapshot
- [linkedin-tracker/background.js](linkedin-tracker/background.js) — service worker for badge + desktop notifications
- [linkedin-tracker/popup.html](linkedin-tracker/popup.html), [popup.js](linkedin-tracker/popup.js), [popup.css](linkedin-tracker/popup.css) — UI
- [linkedin-tracker/icons/](linkedin-tracker/icons/) — toolbar + notification icons (regenerate with `.venv/bin/python scripts/make_icons.py`)

## Notes

- The extension never clicks anything on LinkedIn UI and never opens LinkedIn in the background. It only reads the DOM on the page you opened yourself.
- DOM selectors are defensive (data-view-name attribute first, then structural fallback via `/in/` links). If LinkedIn rebrands and the parse breaks, check the DevTools console for `[LI Tracker] parsed N cards` — if N is 0, selectors need updating in [content.js](linkedin-tracker/content.js).
- All data is stored locally in `chrome.storage.local`. Nothing leaves your browser.

## Roadmap

MVP shipped. Next up per spec: welcome templates with `{firstName}` substitution, reminders via `chrome.alarms`, notes & tags per invite, target list.
