# MC Check for Gmail & DAT (Highway)

Tags carriers with their Highway assessment in **Gmail** and on **DAT One** (Search Trucks).

Gmail: tags inbox rows with the Highway assessment of the carrier's MC#, shown next to the timestamp:
`PASS · MC 689501` (blue), `PARTIAL PASS` (green), `FAIL` (red), `Not on Highway` (amber), `No MC#`, `Checking…`.

DAT One: when you run a truck search, every posting's carrier is looked up right away (visible or
not), and a compact tag (`PASS` / `PARTIAL` / `FAIL` / `N/A`) appears at the right end of each row. New
trucks that show up later are tagged too. Hover a tag for the MC#; click it to open the carrier on Highway.

BulkPosting: the Inquiries tab shows each carrier's Highway result (Pass / Partial / Fail / Not on
Highway) on every inquiry and in the opened inquiry. The app finds the MC# in the full email; the
extension does the Highway lookup with the same queue and saved results. Works on localhost:5173
right away; for the live site, enter its address under **BulkPosting** in the extension settings
(Chrome asks once for permission on that site).

## Install (no publishing needed) — Chrome, Brave or Edge

The extension works the same in every Chromium browser. Each browser needs it loaded once, and
needs its own Highway and DAT logins (a login in Brave does not carry over to Chrome).

1. Open `chrome://extensions` in Chrome (`brave://extensions` in Brave, `edge://extensions` in Edge).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** → choose the `extension` folder.
4. In that same browser, log into https://highway.com and https://one.dat.com.
5. Open / reload Gmail, DAT One and BulkPosting.
6. Using BulkPosting on its live address (not localhost)? Click the extension icon → **BulkPosting**,
   enter the address and allow it when Chrome asks.

On DAT, the truck search always sets the load's equipment; if DAT's equipment list has nothing that
fits, it stops and says so instead of searching with the last search's equipment. Emails written in a
posting's comments are picked up too (the contact email comes first).

After changing any file: click the reload ↻ icon on the extension card, then reload Gmail / DAT One.

## How it works

- **Gmail** (`src/gmail.js`): for each inbox row, looks for the MC# in the subject and preview; if
  missing, reads the full conversation through Gmail's print view and takes the first MC# in the
  newest message (quoted replies removed; older messages only if the newest has none).
- **DAT One** (`src/dat-main.js`, `src/dat-extract.js`, `src/dat.js`): reads the carrier MC#s
  (`carrierMcNumber`) from the search responses DAT's page already receives (no extra requests, no
  clicking rows open), looks them all up, and matches each one to its row by company name (phone /
  email used when two carriers share a name).
- **Background** (`background.js`): one queue for all MC#s, duplicates merged, results remembered
  for 12h. Up to 3 Highway lookups run at once.
- **Highway workers** (`src/highway-worker.js`, `src/highway-parse.js`): a minimized browser window
  with up to 3 Highway tabs, signed in with your session. Each lookup opens
  `highway.com/broker/carriers/search-results?q=<MC>` and reads the **Assessment** badge of the row
  showing `MC <number>`. Don't close that window while working (it's recreated automatically if you do).

## Settings

Click the extension icon: MC#s to ignore (e.g. your own), how long to remember results, number of
Highway tabs.

## Troubleshooting

- **DAT search tags take a while** → a search can return 250+ carriers; new ones are checked 3 at a
  time (raise "Highway tabs" in settings to 5–6). Carriers checked before show instantly.
- **No tags on DAT** → open DevTools on DAT and look for `[MC Check]` messages; DAT may have renamed
  `carrierMcNumber` in its responses.
- **Tags never appear** → Gmail changed its layout; open DevTools on Gmail and look for `[MC Check]` messages.
- **Everything says `Error`** → open the minimized Highway window and check what the page shows.
  Inspect the extension's service worker (link on the extension card) for `[MC Check]` logs.
- **`Log in to Highway`** → click the tag, log in; waiting lookups continue by themselves.

## Tests

```
npm install
npm test
```
