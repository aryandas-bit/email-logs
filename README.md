# Team Email Log Sheet

Auto-logs Resolved / On Hold tickets from Yellow.ai and shows a real-time team leaderboard at [email-logs.vercel.app](https://email-logs.vercel.app).

---

## How it works

1. Each agent installs the Chrome extension on their browser
2. When they resolve or put a ticket on hold in Yellow.ai, it's automatically logged
3. The entry instantly appears on the shared team dashboard — no manual input needed

---

## Installing the Chrome Extension

> Do this once on each team member's laptop.

**Step 1 — Get the extension folder**

Download or copy the `yl-logger-extension` folder to your computer.

**Step 2 — Open Chrome Extensions**

Go to this URL in Chrome:
```
chrome://extensions
```

**Step 3 — Enable Developer Mode**

Toggle **Developer mode** on (top-right corner of the page).

**Step 4 — Load the extension**

Click **Load unpacked** → select the `yl-logger-extension` folder → click **Open**.

The extension is now installed. You'll see **Yellow.ai Email Logger** appear in the list.

**Step 5 — Verify it's working**

1. Open [cloud.yellow.ai](https://cloud.yellow.ai) and go to any ticket
2. Resolve or put a ticket on hold
3. A small toast notification will appear in the bottom-right corner confirming it was logged
4. Open [email-logs.vercel.app](https://email-logs.vercel.app) — your entry appears instantly

---

## Updating the extension

If the extension files are updated, reload it:

1. Go to `chrome://extensions`
2. Find **Yellow.ai Email Logger**
3. Click the **refresh** icon

---

## Dashboard

Live at **[email-logs.vercel.app](https://email-logs.vercel.app)**

- Entries grouped by hour (e.g. 12–1 AM, 1–2 AM)
- Each hour shows resolved/on hold counts + date/time range
- Click **Open report** to see the ranked agent list for that hour
- Summary cards at the top show team-wide totals
- **Export CSV** downloads the full log

---

## Tech stack

- Chrome Extension (Manifest V3) — intercepts Yellow.ai network calls
- Firebase Realtime Database — shared storage with instant push
- Vercel — hosts the dashboard (static HTML)
