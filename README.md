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
   - To scan barcodes into Squarespace from Admin → 🏷️ Barcodes, make it **Products: Read/Write** instead.
   - To count **website sales** in the header, Admin and Insights ([Online sales](#online-sales-the-website)), give it **Orders: Read** as well.
   - To **print website orders** and tick off Store Pickups ([Website orders](#website-orders-printing-and-store-pickup)), make it **Orders: Read and Write**, plus **Transactions: Read** for the card type on the printout.
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
2. Click **⚙︎ Settings** (it asks for the Admin password, the `ADMIN_PIN` env var on Netlify) and fill in:
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
  touched until a store is chosen. The store's tag (e.g. **SM**) then shows on the **Invoices ▾**
  button; open that menu and tap the store to switch (the sale in progress is cleared, since a
  basket belongs to one store).
- **Scan** — the barcode box is always focused; a keyboard-wedge scanner types the code
  and hits Enter automatically. Scan again to add another; quantities merge.
  The whole product list is kept on the device, so a scan never waits on the internet.
  A barcode matches however the scanner sends it: with or without the leading 0 that some
  scanners add or drop (EAN-13 vs UPC-A), the same way big-store tills match on the 14-digit GTIN.
  A scan still lands in the basket after tapping a button (Card, a discount…) or while the
  cursor is in a box like the customer's name: the till recognises the scanner's speed and
  takes the code out of that box. A barcode the device doesn't know yet (just added in
  Squarespace, or labelled on another till) is looked up once (**Looking up…**) and added if
  it's there. The list also refreshes itself every 10 minutes while the till is idle.
- **Search on a phone or tablet opens the camera.** Point it at the product's barcode and the
  item goes straight into the sale, as if it had been scanned. **🔍 Search by name** in the camera
  screen opens the usual typed search. On a computer (PC or Mac) Search is always the typed search
  and the camera never opens.
- Adjust **quantity** with − / +, or type it. **✕** removes a line.
- Pick **Cash** or **Card**. Cash shows the **5¢-rounded** total, quick-tender buttons,
  and **change**. Card is charged exact. **Split** takes part by card and the rest in cash:
  type the card amount and the cash part (5¢-rounded) shows with its change. Takings count each
  part under Cash and Card.
- Choose **Served by**. For sales **$1,000+** the app requires a customer name/ABN (ATO rule).
- **Charge $… & print** → the 80 mm **TAX INVOICE** prints and a new sale starts. Or
  **Charge $…, no print** to record the sale without printing (still numbered & logged).
  A **Pick up later** order always prints — the button is hidden, since the customer needs the
  receipt's pick-up barcode to collect it.
- **Invoices ▾ → Previous invoices** (header) → search and view any past sale **for this store**, on any date;
  open one to **reprint** it.
- **Refund some of a sale** — open the invoice → **Refund items…**, choose how many of each line
  come back, cash or card, and who did it → **Refund & print**. It prints a **REFUND —
  ADJUSTMENT NOTE** numbered `CR-<invoice>`, takes the amount off **today's** takings (any
  discount on the sale comes off in proportion), and puts the stock back. Each line can only be
  refunded up to what was sold. **Exchange** = refund the item, then ring up the replacement.
  **Void whole sale** still cancels the lot (only while nothing on it has been refunded).
- **Admin ▾ → Takings** (header, or click the Today tally) → this store's **total earnings** with a
  cash/card/GST breakdown and a date picker; **Print takings summary** for an end-of-day docket.
- **Admin ▾ → Admin dashboard** (header) → **both stores, any date range** — see [section 6](#6-two-stores-one-record).
- **Pick up later** — tap **Order → Pick up later / Pre order** (the switch beside *Take now*) before finalising. The receipt then prints a
  **pick-up barcode** (Code 128) with its own unique code, e.g. `PUMGB4K2X17Q`. See
  [Pick up later](#pick-up-later) below.
- **⟲ Reprint** opens today's invoices at this store — from every device, newest first — and each
  row has its own **⟲ Reprint** button. Tap the one you want and it prints exactly as it was saved:
  same invoice number, time and lines. It never reprints "whatever came last".
- Admin → **Export range CSV** gives your accountant a file covering both stores; Settings →
  **Export this device's CSV** dumps just the local copy (the last 14 days rung up here, plus
  anything not on the site yet).

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

> **Re-run the installer now if receipts show a 1970 date.** Older copies of the bridge
> misread the sale time the till sends (an ISO string such as `2026-10-03T02:50:00.000Z`)
> and printed `01/01/1970` on the invoice line. Fixed in `escpos-bridge.pl`; the deployed
> copy only picks it up when you re-run whichever installer you used.
> Test: `perl receipt-bridge/t/receipt-ts.t`.

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

### Pick up later

Every *Pick up later* sale gets a **pick-up code**: `PU` + the time in base 36 + two random
characters. It's printed under the totals as a **Code 128 barcode** (with the code in text
underneath), and stays with the sale forever. It's separate from the invoice number on purpose:
a number can still change after printing (a clash is renamed `…-2`), the code never does.

- **Order number on top.** Every pick-up also gets an **order number**, printed as the docket's
  first line in big type: `SMP0001`, `SMP0002`… at South Melbourne, `RXP0001`… at Roxy. Write it
  on the bag so the items are easy to find. Each store has its own sequence on the site, shared by
  every till. One rung up offline carries the device id (`SMP0012-K7Q`), like an offline invoice number.
- **Two receipts.** A new pick-up prints **twice**, one for the customer and one to keep with the
  items, each **cut on its own**. With the receipt bridge they go as two print jobs. With the print
  dialog each copy is its own page, so set the printer driver to cut after every page. A reprint
  is one copy.
- **Pick-up date.** Choosing *Pick up later* shows a **Pick-up date**, set to **today**. Move it
  to a later day for a **pre-order**. The receipt prints *Pick up from <date>*, and the Pick ups
  list shows it in orange until the day comes (*Ready* after that).
- **Scanned too early?** If the barcode is scanned before the pick-up date, a message says
  *Not ready yet. Pick-up for this order is on <date>.* Ticking ✓ early asks before handing it over.
- **🛍 Pick ups** (header) lists this store's orders **waiting to be picked up** — from any day —
  with the customer's name and phone, invoice number, number of items and price. The red badge
  is how many are waiting. Search by name, phone, invoice # or item.
- **Scan the barcode** on a customer's receipt — into the normal scan box, or the Pick ups search
  box — and the tab opens with that order **highlighted**. A code from the other store says which
  store it's at; one already collected says when.
- **Tap the ✓** when the customer has collected it. It moves to **Picked up — last 7 days**
  (with who ticked it and when) on every till. Tap the ✓ again to undo.
- **Tap a row** to open its invoice (reprint, void). The invoice also shows *Waiting* or
  *✓ Picked up*. Voiding a pick-up takes it off the list.
- Pick-up orders rung up before this existed are found automatically (last 45 days) the first
  time Pick ups is opened, and given a code, so reprinting one adds the barcode.
- The receipt bridge prints the barcode itself (`GS k`), so **re-run the receipt printer
  installer** once after updating. An older bridge still prints the docket, just without the
  barcode, and the till says so.

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
   - **Device tag** — not needed: every device at a store shares one invoice count (see
     [Invoice numbers](#invoice-numbers)). If set, it's added to that device's numbers (`INV-SM2-0007`).
4. Takings then reads **✓ From the site — every device at this store**. If a device is offline,
   its sales still complete and print, and are sent up automatically once it's back online.

### Invoice numbers

Each store counts its own sequence, tagged so the two can never collide:
`INV-SM-0001`, `INV-SM-0002`… at South Melbourne, `INV-RX-0001`… at Roxy.
Set the prefix and each store's next number in **Settings → Tax & printing**.

The count lives **on the site**, not in each browser: every device at a store takes its next
number from the same sequence (`POST /api/sales?counter=next`), so a number is only ever used
once, and reprinting an invoice from any device prints the same number. The site also refuses to
let a second sale overwrite one that already holds a number — it files it as `…-2` and the till
renames its own copy to match. If the site can't be reached, the sale still goes through and is
numbered from the device's own count with a short device code on the end (`INV-SM-0042-K7Q`), so
it can't clash with a number another till gets.

### The Admin tab

**Admin ▾ → Admin dashboard** in the header (also reachable from the opening screen, before picking a store):

- **All stores**, or one store on its own.
- **Today / This week / Last 7 days / This month / Last 30 days / This year**, or any From–To you type.
- Total takings, cash, card, **online** and GST for the period, then a **per-store split** and a
  **day-by-day table** — click any row to open that day's invoices for that store.
- **Export range CSV** — every sale in the period, with a **Store** column, straight from the
  site. This is the file for your accountant. Website orders are in it too, as store **Online**.

### Online sales (the website)

Orders from the Squarespace website are counted next to the tills', read through `/api/online`
with the same `SQUARESPACE_API_KEY` (it needs **Orders: Read**, section 2):

- **Takings** (the day docket) is the store's own sales only (cash and card), so it matches the
  drawer and the EFTPOS. Website orders aren't in it.
- The header's **All stores** figure (admin) includes today's website orders; **This store**
  doesn't.
- **Admin** has an **Online** store button, an **Online** card and column, and an Online row in
  the per-store and day-by-day tables. **All stores** includes online; picking one store doesn't.
- **Insights** counts each order's products in revenue, profit, brands, top products and the by-store
  chart (as **Online**), costed from the same cost prices as the tills. Shipping isn't product
  revenue, so it's left out there. An **Online products** card lists every product found in the
  website orders for the period (qty, orders, revenue, last sold), and a grey chip says how many
  orders were left out and why (cancelled, test, in-store, nothing paid).
- **Pickup or delivery**, taken from what the order itself says, never guessed: an order whose
  checkout shipping option says *pick up* (e.g. **Store Pickup**) counts as pickup; an order with a
  **tracking number** counts as delivery; anything else is *not picked up or sent yet*. Admin's
  Online card shows the split (e.g. *3 Store Pickup · 2 Delivery*), and the
  sales CSV's Order column gives each web order's option name or tracking number.

What counts: paid web orders, less anything refunded. Test orders, cancelled orders and unpaid ones
are left out, as are Squarespace POS sales, which are in-store. A refund or cancellation made in
Squarespace later shows up within a minute. Orders are filed under the Melbourne day they were placed.

The site keeps a copy of the orders (Netlify Blobs) and asks Squarespace for changes at most once a
minute. The very first time, it lists every order Squarespace has (paid and pending alike; `ONLINE_SINCE` env var
sets the earliest day kept), which can take a few goes; Takings/Admin say *Still reading older online orders* until it's done. If the
key lacks Orders permission, they say so and show the tills' figures alone.

### Website orders: printing and Store Pickup

Tick **Settings → Website orders → Print website orders on this till** on **one** till (the one
whose store holds the pickups). Every new paid Squarespace order then prints there by itself, on
the receipt printer, within about a minute:

- **Store Pickup** (the order's checkout shipping option says *pick up*): prints **twice**, one for
  the bag and one for the customer, with the **Squarespace order number** big on top (e.g. **#1001**)
  and a **pick-up barcode**. It also goes on that store's **🛍 Pick ups** list, the same as a till
  pick-up: scan the barcode (or search the name, phone or #1001), the order comes up, tick ✓, and the
  order is marked **fulfilled in Squarespace**, and Squarespace emails the customer its usual
  *order fulfilled* email. Set the Netlify env var `SQ_PICKUP_NOTIFY=0` to stop the email. Unticking
  puts it back on the list, but Squarespace can't un-fulfil an order.
- **Delivery** (any other shipping option): prints **once**, with the ship-to address. Nothing goes
  on the Pick ups list.

The printout says **WEBSITE ORDER** (Squarespace emails the customer their own invoice) and has
the customer's name, phone, email and address (the ship-to address for a delivery), the shipping
option, any promo code, anything typed into the checkout form (e.g. a gift note), the products, the
shipping, GST, total and how it was paid (e.g. *PAID ONLINE - Visa (Stripe)*; just *PAID ONLINE*
if the key hasn't got **Transactions: Read**). All of it is copied from the order as Squarespace
has it.

**Nothing gets lost.** `/api/web-orders` keeps a print queue, and an order only leaves it once a
till has printed it. With no wifi, the till closed or the receipt printer off, orders wait and print
as soon as it's all back. While the printer can't be reached the header shows **🖨 N website orders
to print**; tap it to print them through the print dialog instead. If two tills have the box ticked,
each order still prints once (the first till to take it prints it, and a pickup goes on *that*
store's list).

**Kept in step with Squarespace.** An order cancelled or fully refunded in Squarespace leaves the
queue and the Pick ups list. One marked fulfilled in Squarespace is ticked off the list (*by
Squarespace*). Website orders are never counted in a store's takings: they're already in **Online**.

Only orders placed after the first time a till asks are printed (30 minutes back), so switching it on
doesn't print the whole history. `WEB_PRINT_SINCE` (an ISO time) starts it from somewhere else.

The receipt bridge needs **re-installing once** (run *Install Receipt Printer* again) to print the
full docket. An older bridge still prints the order, with the details squeezed onto the customer line.

**🏷️ Barcodes → 📷 Scan into Squarespace** — a product added in Squarespace gets a made-up SKU
starting with **SQ** until its barcode goes in. This lists every Squarespace product with the SQ
ones on top (newest first). Tap one on a phone, point the camera at the box's barcode, and **Save**:
the barcode becomes the variant's **SKU** and, for a real shop barcode (EAN/UPC with a valid check
digit), its **GTIN** too, and you're back at the list to pick the next one. The till you used scans
it at once; the others after their next ⟳ Sync. You can also type the code or use a Bluetooth/USB
scanner in the box. Needs the Squarespace key to have **Products: Read/Write** (section 2) and the
site on https (Netlify is). On an iPhone the barcode reader loads from jsDelivr the first time.

**🏷️ Barcodes → Make our own barcode** — for one-off things with no barcode (a single card, a second-hand item).
Type the name, sell price, cost price and stock, pick a label size (50 × 25, 62 × 29 or 40 × 30 mm
rolls, or an A4 sheet of 21 stickers such as Avery L7160) and hit **Make barcode & print**. For a
single card in a toploader use **50 × 25 mm** on the **back** of the toploader — it fits inside the
edges and leaves the front of the card clear. The
site gives it a 12-digit barcode starting with **2** (the range kept for in-store codes, so it
can't clash with a maker's barcode) and the labels print as Code 128. Every till scans it after its
next ⟳ Sync, and its stock counts down on each sale (back up on a void/refund). The list underneath
reprints labels, edits price/cost/stock (to restock) or deletes one. These products live **only on
the website** (`/api/labels`) — not in Squarespace and not on the Google Sheet's Products tab. Their
cost price is kept with the website's typed costs, so Insights counts their profit.

Admin is **password-protected**, so a customer at the counter can't tap it and read the day's
takings. The password is the Netlify environment variable **`ADMIN_PIN`** (Site configuration →
Environment variables, then redeploy). It is **not** in `index.html`: the till sends what's typed
to `/api/admin`, which checks it on the server. Without `ADMIN_PIN` set, nobody can log in.

To change the password, change `ADMIN_PIN` on Netlify and redeploy (and the `ADMIN_PIN` line in
the Google Sheet script). Devices still holding the old one are logged out the next time they
open the till online.

### Renaming a store, or per-store details on the docket

**Settings → Stores** holds each location's **name** (what the opening screen and the docket
show) plus an optional **address** and **phone** — blank falls back to the business details, so
each store's tax invoices can print its own address. Renaming is safe: sales are filed under a
fixed internal id, so history follows the rename.

> Sales rung up **before** the store selector existed have no store on them. They belong to
> **South Melbourne**, so that's where they're filed: the site moves any old *Unassigned* sales
> across the first time their day is read (Takings, Invoices, Admin or the sheet script), and a
> sale that still arrives with no store is filed under South Melbourne too.

### Weekly backup to Google Drive (Sundays)
A separate spreadsheet, **Till Backup**, in your Google Drive holds a full copy of the till. Its
own script (`google-sheet/backup.gs`) rewrites it every **Sunday night** with everything the
site holds: every sale and refund (both stores, since `BACKUP_FROM`), each item sold, expenses,
money added, website cost prices, the box → pack list and a copy of the main sheet's Products
tab. Paste the script into Till Backup → **Extensions → Apps Script**, type in `ADMIN_PIN`, and
run **setup()** once. **🧾 Backup → Back up now** runs it any time; the **About** tab shows
when it last ran.

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

**Money Added.** The **💰 Money Added** button in the header is open to everyone (no login).
Pick the date and store, tap **$2 / $4 / $10 / $20 / $50** (they add up) or type any amount
under **Other**, then press **Done** or **Enter**. Entries are saved on the site
(`/api/money-added`) and the same hourly script writes each day's total into the sheet's
**Money Added** column (same 14-day look-back as expenses). Paste the updated script into
Apps Script again.

**Cost prices & profit.** The same script also keeps two extra tabs in that sheet —
they're created and styled for you (blue header, filter buttons, frozen header):

- **Products** — every product with barcode, name, brand, sell price and live stock. It checks
  Squarespace **every 5 minutes** (`PRODUCTS_EVERY_MINUTES`), **every time you open the sheet**,
  and on **🧾 Till → Refresh products now**. A product you've just added on Squarespace appears
  at the **top** with its **Cost** cell in **red** — type the cost and it turns yellow. Only
  Name, Price and Stock are ever rewritten, so what you type in **Cost** and **Brand** is never
  touched, even mid-refresh. Margin $, Margin % (green / orange / red), stock value and the
  **Added** date fill in by formula the moment you type.
- **Profit** — one row per trading day, **newest at the top**: takings, cost of goods sold, gross
  profit, margin % and how many items sold had **no cost entered yet** (red when > 0, meaning
  profit reads high). A green **Summary** box on the right shows today, this week, this month,
  last 30 days, this year and all time. **Website (Squarespace) orders are counted here too**
  (`INCLUDE_ONLINE`), shipping left out, the same as Admin → Insights. They're read with the
  Admin password, so `ADMIN_PIN` must be filled in at the top of the script; if the site can't
  give the online orders, the Profit tab is left as it was (see Apps Script → Executions). The
  daily **Games** column stays store-only.
- **Japanese products** get their cost from a different formula (`JAPAN_SETS` in the script; the
  working is in `google-sheet/japanese-costs.xlsx`). One **pack** = box price ÷ packs in the box,
  **+ 5% commission + 1.75% card-processing fee**, then **+ $0.50 delivery**. A whole **box** =
  packs in the box × the pack cost (e.g. a 20-pack box costs 20 × the pack). The 1.75% is what the
  invoices' "Additional fees" line works out to (6.75% of the goods in total). Names must say
  Japan / Japanese / JP / JPN to match. Check the packs-per-box column against your real boxes.
- **Footy items** (`footyCostFor` in the script) use the prices on the supplier invoices / price list
  (GST included, like the Cost column). **Footy Stars, Luminous and NRL League Heroes get no $0.50
  delivery** (free shipping). **Team Coach adds $0.10 per pack** ($3.75 → $3.85 a pack, $138.60 a
  display box, $1,663.20 a case; collector albums $8.80). Footy Stars: $134.25 a box ($1,611 a case of
  12), $34.99 a blaster, vinyl album $24.00, binder album $11.89; Luminous album $22.00; NRL League
  Heroes box $107.64 ($2.99 a pack). Footy Stars packs-per-box is assumed 36 — check it.
- **Tax Invoice 388075** (Magic Marvel Super Heroes displays, poker chips, One-Touch X holders, One Piece DP-12 / OP-17 / Dash Packs): invoice unit price (ex GST) + **$0.32** each — the $8.00 delivery split over the 25 units ordered (Dash Packs were free, so they cost just the $0.32).
- **Brand** column on Products — guessed from the name: card games (Pokémon Japanese vs English
  kept separate, One Piece, Yu-Gi-Oh!, MTG, Lorcana…) and sport (AFL, NRL, Rugby, NFL, Soccer,
  Basketball, F1, Cricket, Tennis, Baseball, Wrestling & UFC), plus Harry Potter; else *Other*.
  Type over any guess and it sticks. Products left on *Other* (or blank) get re-guessed each
  refresh, so new rules reach them. Add your own rules in `BRAND_RULES` (the script and
  `index.html` both have the list).
- The year tabs (**2025**, **2026**…) are left exactly as they were — the script only fills the
  Games / Expenses / Money Added cells, as before.

The graphs are **no longer in the sheet** — the new script deletes the old charts, the brand and
month tables and the *Sales lines* tab. They live on the website instead: **Admin → 📊 Insights**.

**Admin → 📊 Insights.** Revenue & profit over time (by hour for one day, by day, or by month for
This year), revenue by brand, profit by brand with margin, a by-store split, and the top 10
products by profit / revenue / qty — for the same store and period buttons as Takings (Today,
This week, Last 7 days, This month, Last 30 days, This year, All time, or any From–To). To work out profit
it needs the cost prices, so the sheet script sends the Products tab's costs and brands to the
site (`/api/costs`) after every refresh and straight away when you edit a Cost or Brand cell.
Items with no cost are left out of profit, and the page says how many there are.

**Games takings from before the till.** The daily **Games** column of the Google Sheet (the 2025 and
2026 tabs, 1 Oct 2025 → 19 Sep 2026) is built into the site as a one-off copy — it never syncs — so
Insights reaches back before the till. The till rang up some of those days itself (sales made on the
device before the site kept them were uploaded when it went live). The switch-over is fixed at
**4 Sep 2026** (`TILL_FROM`) — the first day from which South Melbourne's till matches the sheet's
Games figure every day (the till was in use from 8 Aug, but a few days up to 3 Sep differ, and the
sheet is always right). Before it the sheet is used and those till sales are left out; from it
only the till counts — so every month matches the sheet and nothing is counted twice. Sheet days
have no items, so each counts as one South Melbourne lump under **Games (before the till)**, with
the cost estimated at **50%** (`HIST_COST` in `index.html`). A red chip names that day — accurate profit margins were only tracked from then (the Margin card says “estimated before” it). They show
in Insights only — not in Takings, the invoice list or the CSV export, which have no cash/card split
for them. **All time** picks the whole period from the sheet's first day.

**Items sold with no cost.** When anything sold in the chosen store and period has **no cost
price** (so it's left out of profit), Insights shows a yellow **“N items sold with no cost yet”**
button. Press it to list them, each with its name and a box to type the cost straight in — it saves
as you press Enter or move off the box; **Done** closes the list and updates the profit figures.
No button means nothing is missing a cost.
- **Products** are listed once each, with qty sold, sales and when last sold. A cost typed here is
  used for profit straight away, and the sheet script copies it into the **Products** tab's Cost
  column on its next refresh (every 5 minutes) — from then on the sheet holds it, so change it there.
- **Miscellaneous** (“+ Misc $”) lines have no barcode, so each one sold is listed on its own by the
  **date and time it was sold** (plus the invoice number and who served). Its cost stays on the site;
  Insights and the sheet's Profit tab both count it.
- Tick **Show ones already costed here** to see (and fix) costs typed in this list.

> Cost prices are now on the site, readable with the Admin password. Set **`ADMIN_PIN`** on
> Netlify (the same value as `ADMIN_PIN` in the sheet script) so `/api/costs`
> refuses anyone without it. The till never shows cost prices at the counter or on a receipt.

After pasting the updated script into Apps Script, run **setup** once — it adds the 5-minute,
on-open and on-edit triggers.

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
  picked and an offline fallback invoice counter stay per-device (localStorage), as does a copy of
  the sales this device rang up — that copy is what it falls back on when the site is
  unreachable, and the queue it re-sends from.
- **The local copy is kept small.** Once a sale is on the site, its local copy is dropped after
  **14 days** (`LOCAL_KEEP_DAYS` in `index.html`); it stays on the site. A sale is never dropped
  while it still needs this device: not sent yet, its Squarespace stock not adjusted (or, for a
  void/refund, not put back) yet, a pick-up not collected yet, or a 🎓 Training sale. If the
  browser's storage ever fills up, the till prunes harder (a week, then everything already on
  the site) and tries again, so finishing a sale is never blocked. Once a sale has gone from here,
  voiding or refunding it from this device needs the **Admin** login (the same as a sale rung up on
  another till), and offline the Invoices list only shows what's still held here.
- The till needs the internet for **live** totals. Offline it still scans, prints and numbers
  sales, shows *"this device only"* on the tally, and sends everything up on reconnect.

## Files
| File | What it is |
|------|-----------|
| `index.html` | The till app — the only file you actually run. |
| `netlify/functions/catalog.js` | Netlify catalogue proxy (holds the Squarespace key). |
| `netlify/functions/sales.mjs` | The sales record both stores read and write (`/api/sales`, Netlify Blobs), plus the Pick up later list. |
| `netlify/functions/inventory.mjs` | Netlify stock write-back (decrements Squarespace on each sale). |
| `netlify/functions/labels.mjs` | One-off products given a barcode in Admin → 🏷️ Barcodes (`/api/labels`). |
| `netlify/functions/sq-barcodes.mjs` | Lists Squarespace products and writes a scanned barcode to a variant's SKU and GTIN (`/api/sq-barcodes`). |
| `netlify/functions/online.mjs` | Website orders from Squarespace, for Takings and Insights (`/api/online`). |
| `netlify/functions/web-orders.mjs` | Website orders to print, and Store Pickups onto the Pick ups list (`/api/web-orders`). |
| `netlify/lib/pickups.mjs` | Where pick-ups are kept and how one is ticked, shared by `sales.mjs` and `web-orders.mjs`. |
| `netlify/lib/squarespace.mjs` | Fulfilling an order and reading how it was paid, from Squarespace. |
| `netlify/functions/costs.mjs` | Cost prices & brands sent from the Google Sheet, for Admin → Insights (`/api/costs`). |
| `netlify.toml` + `package.json` | Netlify routing + the `@netlify/blobs` dependency. |
| `worker.js` | Cloudflare Worker catalogue proxy (alt to Netlify). |
| `api/catalog.js` | Vercel catalogue proxy (alt to Netlify). |
| `README.md` | This guide. |

---

## Admin login & sales totals

- **Admin ▾ → 🔒 Login** (header) asks for the Admin password once; the device then stays logged in
  until **Log out**. Logged in, the header shows **This store** (today) and **All stores** (today)
  totals plus cash/card. Logged out, those figures are blacked out and Takings/Admin/⚙︎ Settings ask for
  the password.
- If the site rejects the device's **sales token** (so no password can be checked), ⚙︎ Settings opens
  anyway so the token can be fixed; log in after saving.
- The password is the Netlify env var **ADMIN_PIN** — the site checks it, so it isn't in the page.
  The server also refuses box-list edits, expenses and cost prices without it.
- **⚠ N unsent** appears in the header only while sales rung up on this device haven't reached the
  site (no wifi). They send themselves when the connection is back; tap it to try straight away.
  It disappears once everything is sent.
- **Offline reload.** The page keeps a copy of itself on the device (`sw.js`), so the till still
  opens with no internet; sales made then queue up under **⚠ N unsent**.

## Open box (box → single packs)

**📦 Open box** (till screen, anyone can use it). Adding or removing boxes needs the Admin login. Each row links a sealed box barcode to its single pack barcode and the number of
packs inside. **Open 1** sends one Squarespace adjustment: box −1 and pack +N together (all or nothing).
The list is stored on the site (`/api/boxes`, Netlify Blobs), so every till shares it. Until the first edit
it starts from a built-in list of the boxes in the product feed (see `netlify/functions/boxes.mjs`).

## 🎓 Training mode

The opening screen has a small dashed **🎓 Training** tile in the bottom-right corner. It opens the
exact same till — scanning, discounts, cash/card/split, pick-ups, voids, refunds, reprints — so new
staff can practise, but **nothing they do is real**:

- Sales stay on that device only (a separate practice log) and are **never sent to the site**, so
  they don't show in Takings, Admin, Insights, the Google Sheet or either store's invoice list.
- **Squarespace stock is never changed**, and the on-screen stock counts don't drop either.
- Invoice numbers come from their own local run (`INV-TR-0001`, …), so the real stores' numbering
  doesn't move.
- Money Added and Expenses don't save, and Open box is switched off.
- Every docket prints **TRAINING — NOT A REAL SALE** at the top, and the header shows an orange
  **TRAINING** flag the whole time.

To finish, tap **Invoices ▾ → ⇄ switch** and pick a real store. To wipe the practice sales, open
Settings while in Training and use **Clear this device's log** (that clears the practice log only).
