# Store Till & Tax Invoice

A barcode-scanning point-of-sale + **ATO tax-invoice** printer for two Australian
retail shopfronts — **South Melbourne** and **Roxy**. Tallies a basket as you scan, calculates
GST (10% inclusive), takes **cash or card**, records **who served**, and prints to an
**80 mm thermal receipt printer**.

- **No build step.** `index.html` is the whole app. Runs on any browser/tablet/PC.
- **Pick the store when you open it** — two boxes, one tap. Sales are filed per location.
- **Sales live on the site,** not in the browser, so any device can see either store's takings
  and invoices for today or any earlier day ([section 6](#6-two-stores-one-record)).
- **Works offline** after the first sync — it keeps scanning, printing and numbering, and sends
  the sales up when the connection is back.

---

## Getting your products in — pick ONE

### ⭐ Option A — Google Sheet (no server, recommended, ~5 min)
The simplest path — **no Netlify, no GitHub, no API key, nothing to deploy.**

1. Make a Google Sheet with three columns and a header row:

   | barcode | name | price |
   |---------|------|-------|
   | 9310072000012 | Full Cream Milk 2L | 3.90 |
   | 93123457 | Chocolate Bar 50g | 2.50 |

   - **barcode** = the number your scanner reads (EAN/UPC). **price** = shelf price, **GST included**.
2. **File → Share → Publish to web → Entire document → "Comma-separated values (.csv)" → Publish.**
   Copy the link it gives you (ends in `...pub?output=csv`).
3. In the till: **⚙︎ Settings → Products link** → paste that link → **Save** → **Sync catalog**.
4. To change a price or add a product, just **edit the Sheet**, then hit **Sync catalog** again.

That's it. Skip to [step 5 (Point the till / daily use)](#5-daily-use) below. Everything else in
this README (proxy, Netlify, API keys) is **only** for Option B.

### Option B — Live sync from Squarespace (advanced, needs a deployed proxy)
Pulls products straight from your Squarespace catalogue so you never re-type them. This needs a
small server-side proxy because the browser can't call Squarespace directly. Follow steps 1–4 below.

```
Squarespace store  ──►  proxy (Netlify / worker.js)  ──►  index.html (the till)
  (your products)       holds the secret API key           scans, totals, prints
```

> **Note:** Options A and B both feed the same "Products link" box in Settings — one is a Sheet
> link, the other a proxy URL. You only need one.

---

## 1. Put barcodes on your products (important, one-time)

Squarespace products **don't have a "barcode" field — they have a SKU.**
The till matches a scanned barcode against the **SKU**, so:

> In Squarespace, set each product/variant's **SKU** to its **scannable barcode number**
> (the EAN/UPC printed under the barcode).

Products with no SKU are skipped (nothing to scan).

---

## 2. Get a Squarespace API key

Requires a **Business** or **Commerce** Squarespace plan.

1. Squarespace → **Settings → Developer API Keys** (or *Advanced → Developer API Keys*).
2. **Generate Key** → give it a name → permission **Products: Read Only**.
   - To also use **live stock sync** ([section 7](#7-live-stock-sync-decrement-squarespace-on-each-sale)), give the *same* key **Inventory: Read/Write** as well.
3. Copy the key (you only see it once). Keep it secret — it is *not* pasted into the app.

---

## 3. Deploy the proxy (pick ONE)

> **Why a proxy at all?** You *can't* call Squarespace straight from the browser — it
> sends no CORS headers and requires a `User-Agent` header the browser forbids JS from
> setting. So the proxy is technically required, not just a security nicety. In all three
> options below the key lives in a server-side **environment variable and never reaches
> the browser**, even though the site itself is public.

### Option A — Netlify (recommended: hosts the till AND the proxy on one public site)

1. Push this folder to GitHub, then [netlify.com](https://netlify.com) → **Add new site → import** it.
   (`netlify.toml` already serves `index.html` and wires up `/api/catalog`.)
2. Site → **Site configuration → Environment variables:**
   - `SQUARESPACE_API_KEY` = *your key from step 2*
   - *(optional)* `ALLOW_ORIGIN` = your Netlify site URL.
3. Your till is at `https://<your-site>.netlify.app` and the proxy at
   `https://<your-site>.netlify.app/api/catalog` — with only 2 devices, this public site is fine.

### Option B — Cloudflare Worker (no command line, no GitHub)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create → Worker**.
2. Paste the contents of **`worker.js`** → **Deploy**.
3. Worker → **Settings → Variables and Secrets** → add a **Secret** `SQUARESPACE_API_KEY`
   (and optionally `ALLOW_ORIGIN`).
4. Copy the worker address, e.g. `https://store-catalog.yourname.workers.dev`.

### Option C — Vercel

1. Put this folder on GitHub, then [vercel.com](https://vercel.com) → **New Project → import** it.
2. **Settings → Environment Variables:** `SQUARESPACE_API_KEY` = your key.
3. Your endpoint is `https://<project>.vercel.app/api/catalog`.

**Test it:** open the proxy URL in a browser — you should see JSON like
`{"count":123,"items":[{"sku":"9310...","name":"...","price":3.9,...}]}`.

---

## 4. Point the till at the proxy

1. Open **`index.html`** (double-click it, or host it — see below).
2. Click **⚙︎ Settings** and fill in:
   - **Business name, ABN, address, phone** — printed on every tax invoice (ABN is legally required).
   - **Catalog proxy URL** — the address from step 3.
   - **Staff names** — one per line; these populate the "Served by" list.
   - **GST rate** (default 10), **Receipt paper** (80 mm), **Invoice prefix** & **next number**.
3. **Save**, then click **Sync catalog** in the header. You should see your product count.

> No proxy yet? In Settings use **Load demo products** or **Paste products (CSV)**
> (`sku,name,price`) to try the whole scan → pay → print flow immediately.

---

## 5. Daily use

- **Pick the store first.** The till opens on two boxes — **South Melbourne** and **Roxy**.
  Tap one and that's the location this till is ringing up for; the one you used last on this
  device is outlined, so it's a single tap each morning. Nothing behind the screen can be
  touched until a store is chosen. The header then shows the store next to the business name —
  click it to switch (the sale in progress is cleared, since a basket belongs to one store).
- **Scan** — the barcode box is always focused; a keyboard-wedge scanner types the code
  and hits Enter automatically. Scan again to add another; quantities merge.
- Adjust **quantity** with − / +, or type it. **✕** removes a line.
- Pick **Cash** or **Card**. Cash shows the **5¢-rounded** total, quick-tender buttons,
  and **change**. Card is charged exact.
- Choose **Served by**. For sales **$1,000+** the app requires a customer name/ABN (ATO rule).
- **Finalise & Print** → the 80 mm **TAX INVOICE** prints and a new sale starts. Or
  **Finalise — no print** to record the sale without printing (still numbered & logged).
- **Invoices** (header) → search and view any past sale **for this store**, on any date;
  open one to **reprint** it.
- **Takings** (header, or click the Today tally) → this store's **total earnings** with a
  cash/card/GST breakdown and a date picker; **Print takings summary** for an end-of-day docket.
- **Admin** (header) → **both stores, any date range** — see [section 6](#6-two-stores-one-record).
- **Reprint last** re-prints this store's most recent invoice (paper jams / cancelled print).
- Admin → **Export range CSV** gives your accountant a file covering both stores; Settings →
  **Export this device's CSV** dumps just the local copy.

Everything above reads the sales record **kept on the site**, not the browser — so the Today
tally, Invoices and Takings all include sales rung up on the *other* device at the same store,
and switching devices doesn't lose history. See [section 6](#6-two-stores-one-record).

### Receipt printer: the ESC/POS bridge

**The TM-T88V cannot be driven by the macOS print dialog.** It speaks ESC/POS.
Epson no longer ships a Mac driver for it, so macOS assigns `Epson 24-Pin Series`
— an ESC/P2 dot-matrix driver. The printer doesn't understand ESC/P2 and prints
the escape bytes as characters, which comes out as pages of binary junk.

The fix is `receipt-bridge/`: a small local helper that builds ESC/POS itself and
hands it to CUPS with `lp -o raw`, which bypasses every filter so no driver ever
touches the data.

**Setup — pick one:**

| Installer | Scope | Password | Starts |
|---|---|---|---|
| `Install For All Profiles.command` | **every account on the Mac** | admin password | at boot |
| `Install Receipt Printer.command` | just the account that runs it | none | at login |

Use the all-profiles one if more than one macOS account uses the till. It copies
the bridge to `/usr/local/share/receipt-bridge/` (other accounts can't read your
home folder) and installs a LaunchDaemon in `/Library/LaunchDaemons/`. It also
removes the single-user login item if one exists, so the two can't fight over
port 9100.

Re-run the installer after editing `escpos-bridge.pl` — the daemon runs the
deployed copy, not the one in this folder.

**Single-user setup:** double-click **`receipt-bridge/Install Receipt Printer.command`**.
No admin password, no driver install. It finds your Epson queue, prints a test
docket, asks you to confirm it's readable, then installs a login item so the
bridge starts automatically. To remove it, double-click
`Uninstall Receipt Printer.command`.

**Two requirements, or it silently falls back to the broken print dialog:**

- The bridge must be running — check `curl http://127.0.0.1:9100/health`.
- **The till must be served over `http://` or `https://`, not opened as a
  `file://` page.** Chrome forbids a `file://` page from reaching localhost, so
  the bridge is unreachable and you'll get binary output again. Use the Netlify
  URL, or serve the folder locally.

When thermal paper is selected and the bridge can't be reached, the till toasts
*"Receipt bridge not running"* rather than quietly printing garbage.

Logs: `~/Library/Logs/receipt-bridge.log`.

### Printer setup (A4 only)
Use your browser's print dialog once to select the thermal printer, then set:

- **Margins: None** — the page already carries its own 4 mm side gutter.
- **Scale: 100%** (not "Fit to page", which will shrink the receipt).
- **Headers and footers: off** — otherwise the browser stamps the URL and date on every docket.

Chrome/Edge remember these. The receipt is sized from **Settings → Receipt paper**
(80 mm / 58 mm / A4).

**How page height works.** Roll paper is continuous, so each job has to declare a page
exactly as tall as its own content. `applyPageSize()` measures the rendered receipt just
before printing and writes a literal rule such as `@page{ size:80mm 115mm; margin:0 }`.

Do **not** be tempted to write `@page{ size:80mm auto }` — mixing a length with `auto` is
invalid CSS, so the browser silently discards the whole `size` declaration and falls back
to the system default paper. On an A4 machine that lays every receipt out on a 210×297 mm
page: the text prints in a narrow strip and the printer feeds ~30 cm of blank roll after
each sale. `var()` inside `@page` fails the same way. Literal millimetres only.

---

## 6. Two stores, one record

Sales are kept **on the site**, not in the browser that rang them up. Each sale is stamped with
the store picked on the opening screen, so:

- either device can open **either store**, and sees that store's full history — today's and
  every earlier day — whoever rang it up;
- clearing a browser, swapping a tablet or selling from a phone loses nothing;
- **Admin** shows both stores side by side over any date range.

```
South Melbourne till ─┐
                      ├─►  /api/sales  ──►  Netlify Blobs  ──►  Today · Invoices · Takings · Admin
Roxy till ────────────┘   (one blob per sale)                    on any device, any store, any day
```

### Setup

1. It deploys automatically with the Netlify setup above — the sales log is the
   `netlify/functions/sales.mjs` function (served at `/api/sales`). It stores sales in
   **Netlify Blobs** (no database to set up).
2. Site → **Environment variables:** add `SALES_TOKEN` = any long random string.
   **Do set this** — without it, anyone who guesses the URL can read every sale, and the site
   is public.
3. On **each** device, **⚙︎ Settings → Sales memory**:
   - **Sales log URL** — leave as `/api/sales` (or the full
     `https://<your-site>.netlify.app/api/sales` on a till hosted elsewhere).
   - **Sales log token** = the same `SALES_TOKEN` value.
   - **Device tag** — only needed if **two tills share one store**; it keeps their numbers apart
     (`INV-SM-0007` vs `INV-SM2-0007`). The store already tags its own.
4. Takings then reads **✓ From the site — every device at this store**. If a device is offline,
   its sales still complete and print, and are sent up automatically once it's back online.

### Invoice numbers

Each store counts its own sequence, tagged so the two can never collide:
`INV-SM-0001`, `INV-SM-0002`… at South Melbourne, `INV-RX-0001`… at Roxy.
Set the prefix and each store's next number in **Settings → Tax & printing**.

### The Admin tab

**Admin** in the header (also reachable from the opening screen, before picking a store):

- **All stores**, or one store on its own.
- **Today / Last 7 days / This month / Last 30 days**, or any From–To you type (up to 62 days).
- Total takings, cash, card and GST for the period, then a **per-store split** and a
  **day-by-day table** — click any row to open that day's invoices for that store.
- **Export range CSV** — every sale in the period, with a **Store** column, straight from the
  site. This is the file for your accountant.

Admin is **password-protected**, asked for each time it opens, so a customer at the counter
can't tap it and read the day's takings. The password is set in code only — `ADMIN_PIN`
in `index.html` — and can't be changed from Settings. Set it to `''` to leave Admin open.

> This password sits in `index.html`, which a public site hands to anyone who asks for the
> page. It's a lock on the counter, not a secret — so don't reuse a password from anywhere
> else here. If you need Admin to be genuinely private, that means moving the check into
> `sales.mjs` behind `SALES_TOKEN` rather than doing it in the browser.

### Renaming a store, or per-store details on the docket

**Settings → Stores** holds each location's **name** (what the opening screen and the docket
show) plus an optional **address** and **phone** — blank falls back to the business details, so
each store's tax invoices can print its own address. Renaming is safe: sales are filed under a
fixed internal id, so history follows the rename.

> Sales rung up **before** the store selector existed have no store on them. They're pushed to
> the site as **Unassigned** and show up that way in Admin, rather than being counted under a
> store they might not belong to.

### Daily total into a Google Sheet (hourly)
`google-sheet/daily-total.gs` writes each day's total sales into the **Games** column of an
existing sheet (one tab per year, dates down column A). It runs every hour, so the figure is at most an hour behind.

1. Open the sheet → **Extensions → Apps Script**, replace `Code.gs` with the file's contents.
2. Fill in the settings at the top: your site URL, `SALES_TOKEN` (if you set one), the store
   (`all` or one store id). The tab (`{year}`), date column (`A`) and heading (`Games`) are preset.
3. Pick **setup** in the function list → **Run ▶** → allow access. Setup writes today's total
   straight away and creates the hourly trigger.

The script finds today's date in column A of that year's tab and writes the total in the
Games column on that row. If the date isn't in the sheet, the day is skipped. The total leaves out voided sales and matches
the Admin tab's figure.

**Expenses.** Once logged in as Admin, a **💸 Expenses** button appears in the header (and in
Admin). Pick the date and store, tap the notes and coins that went out — they add up — then
press **Done** or **Enter**. Each expense is saved on the site (`/api/expenses`). The same hourly
script writes each day's expenses total into the **Expenses** column, on the row for the date
the expense was for (it re-checks the last 14 days, so a late entry still lands on the right
row). Days with no till expenses are left alone, so figures typed in by hand stay. Add an `Expenses` heading in row 1 if the tab doesn't have one, and paste the updated
script into Apps Script again.

**Money Added.** A **💰 Money Added** button in the header is open to everyone (no login).
Pick the date and store, tap **$2 / $4 / $10 / $20 / $50** (they add up) or type any amount
under **Other**, then press **Done** or **Enter**. Entries are saved on the site
(`/api/money-added`) and the same hourly script writes each day's total into the sheet's
**Money Added** column (same 14-day look-back as expenses). Paste the updated script into
Apps Script again.

## 7. Live stock sync (decrement Squarespace on each sale) — optional

Turn this on and **every finalised sale lowers the matching Squarespace stock**, so the quantity
on remactables.com drops automatically. You keep entering/restocking inventory in Squarespace as
normal; the till just subtracts what you sell. Needs the **Squarespace (Option B)** product path —
it matches each sold line to a Squarespace **variant by barcode/SKU**.

```
Sale finalised ─► /api/inventory (holds the key) ─► Squarespace inventory  ─► website stock drops
                  decrementOperations[{variantId, qty}]   (Inventory: Read/Write)
```

1. It deploys automatically with the Netlify setup — it's the `netlify/functions/inventory.mjs`
   function (served at `/api/inventory`). No extra dependency.
2. Give your **`SQUARESPACE_API_KEY`** the **Inventory: Read/Write** permission (section 2). One key
   with *Products: Read* **and** *Inventory: Read/Write* covers both the catalogue and stock sync.
3. In Squarespace, make sure each sellable variant has **stock tracking on** (a *Limited* quantity,
   not *Unlimited*) — there has to be a number to subtract from.
4. On **each** till, **⚙︎ Settings → Live stock**: leave **Inventory update URL** as `/api/inventory`
   (or the full `https://<your-site>.netlify.app/api/inventory` on a till hosted elsewhere). It reuses
   the **Shared log token** from section 6 for auth. Blank = never touch stock.

**How it behaves**
- The till shows each item's **live stock** as you scan (`3 left`) and in Search/basket.
- Selling more than is in stock **warns but still lets the sale through** (the item's in your hand) —
  Squarespace stock can go negative, which flags what to reorder.
- **Offline-safe & exactly-once:** a sale made offline still completes and prints, then decrements
  when the connection returns. Each sale carries the invoice number as an **Idempotency-Key**, and the
  till only sends the decrement once per sale, so a resync can't double-subtract.
- After each sync the till snaps its counts to Squarespace's authoritative numbers.

> Google-Sheet-only products (no Squarespace variant) can't be decremented — stock sync needs the
> Squarespace catalogue path. If a scanned SKU isn't a Squarespace variant, that line is simply skipped.

## Where to run the till
- **Recommended:** deploy to **Netlify** (Option A) — the till, the catalogue proxy and the
  shared log all live on one public site; open it in Chrome/Edge on each of your 2 devices.
- **Simplest offline:** keep `index.html` on the counter PC/tablet and open it directly
  (no shared log — single device only).

## Notes & limits
- This till **reads** your catalogue and prints invoices. It does **not** write *sales* back
  into Squarespace, but it can optionally **adjust stock** on each sale ([section 7](#7-live-stock-sync-decrement-squarespace-on-each-sale)).
- GST is treated as **inclusive** (price ÷ 11). Change the rate in Settings if needed.
- **Sales live on the site** (Netlify Blobs), so any device can read any store's history —
  see [section 6](#6-two-stores-one-record). Settings, the catalogue cache, the store last
  picked and each store's invoice counter stay per-device (localStorage), as does a copy of
  the sales this device rang up — that copy is what it falls back on when the site is
  unreachable, and the queue it re-sends from.
- The till needs the internet for **live** totals. Offline it still scans, prints and numbers
  sales, shows *"this device only"* on the tally, and sends everything up on reconnect.

## Files
| File | What it is |
|------|-----------|
| `index.html` | The till app — the only file you actually run. |
| `netlify/functions/catalog.js` | Netlify catalogue proxy (holds the Squarespace key). |
| `netlify/functions/sales.mjs` | The sales record both stores read and write (`/api/sales`, Netlify Blobs). |
| `netlify/functions/inventory.mjs` | Netlify stock write-back (decrements Squarespace on each sale). |
| `netlify.toml` + `package.json` | Netlify routing + the `@netlify/blobs` dependency. |
| `worker.js` | Cloudflare Worker catalogue proxy (alt to Netlify). |
| `api/catalog.js` | Vercel catalogue proxy (alt to Netlify). |
| `README.md` | This guide. |

---

## Admin login & sales totals

- **🔒 Admin login** (header) asks for the Admin password once; the device then stays logged in
  until **Log out**. Logged in, the header shows **This store** (today) and **All stores** (today)
  totals plus cash/card. Logged out, those figures are blacked out and Takings/Admin ask for the password.
- The password is `ADMIN_PIN` in `index.html`. Optionally set the same value as the Netlify env var
  **ADMIN_PIN** so the server also refuses box-list edits without it.

## Open box (box → single packs)

**📦 Open box** (till screen, anyone can use it). Adding or removing boxes needs the Admin login. Each row links a sealed box barcode to its single pack barcode and the number of
packs inside. **Open 1** sends one Squarespace adjustment: box −1 and pack +N together (all or nothing).
The list is stored on the site (`/api/boxes`, Netlify Blobs), so every till shares it. Until the first edit
it starts from a built-in list of the boxes in the product feed (see `netlify/functions/boxes.mjs`).
