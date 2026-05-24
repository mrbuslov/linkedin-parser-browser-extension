# LinkedIn Parser: Invites & Contacts

A Chrome extension that helps you keep track of your LinkedIn networking.

It tells you **who accepted your invites**, **who hasn't replied yet**, and quietly **builds a database of every contact you visit** — all stored on your own computer, nothing sent to any server.

## Install

### Option 1 — Chrome Web Store (easy)

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/linkedin-parser-invites-c/jmfogopmjhijliikailejnmajckoeklo)

Click **Add to Chrome** and that's it. Pin the icon to your toolbar so you can find it quickly.

### Option 2 — From source (for developers)

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Turn on **Developer mode** (toggle in the top-right)
4. Click **Load unpacked** and select the `linkedin-tracker/` folder
5. Pin the extension to your toolbar

## How to use it

### 1. Track your sent invites

Open LinkedIn → click the toolbar icon → **Go to Sent page**.

You'll land on `linkedin.com/mynetwork/invitation-manager/sent/`. Click the orange **Scan** button.

The extension will scroll the page for you and capture everyone you've invited. They show up in the **Pending** tab in the popup.

> Keep the LinkedIn tab visible during the scan. Chrome pauses background tabs and the scan will stall otherwise.

### 2. See who accepted

Open the popup → **Accepted** tab → click **Go to Connections page** → click **Scan**.

The extension pulls your full connections list with the real "Connected on" date from LinkedIn. People who accepted your invites move from Pending to Accepted automatically.

### 3. Follow up with new connections

The popup shows a badge with how many people are waiting for a welcome message.

For each one:
- Click their name to open their profile in the same tab
- Write your welcome message manually
- Come back to the popup → click **Mark** to move them out of the "to handle" list

### 4. Auto-capture everyone you browse

Just browse LinkedIn normally. Every profile page you open gets saved into your local database — name, headline, country, photo, current company, last-seen status. No clicks needed.

This is your private LinkedIn CRM that grows by itself.

### 5. Search and filter

Use the search field in the popup header to find people by name or headline. Works across Pending, Accepted, and Marked tabs.

### 6. Back up your data

**Settings** tab → **Download JSON**. Save the file somewhere safe.

To restore on a new device: install the extension → Settings → **Import JSON…** → pick the file.

You can also export to CSV if you want to analyze in Excel/Google Sheets.

## Privacy

- All data lives in your browser's IndexedDB on your own machine
- Nothing is sent to any server, ever
- No analytics, no telemetry, no accounts
- See [PRIVACY.md](PRIVACY.md) for the full policy

## Something broke?

LinkedIn changes its page structure from time to time and the extension parser might miss things.

If the popup shows a red error line under the summary (like _"Last scan failed: …"_), open an issue with the message: **Settings → Contact support / Report issue**.

## Contributing

The code is open under [MIT License](LICENSE). PRs welcome — see [plan.md](plan.md) for the roadmap.

## Tech notes for the curious

- Manifest V3, vanilla JS, no frameworks
- Three content scripts: `/sent/`, `/in/*` profile pages, `/mynetwork/invite-connect/connections/`
- IndexedDB-backed storage with effectively unlimited space (handles 100k+ contacts)
- Read-only — never clicks LinkedIn buttons, never opens pages in background, never calls LinkedIn's internal APIs. Safe against the kind of detection that bans automation tools.
