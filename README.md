# Store Till & Tax Invoice

A barcode-scanning point-of-sale + **ATO tax-invoice** printer for a single Australian
retail store. Reads your products live from your **Squarespace** store catalogue,
tallies a basket as you scan, calculates GST (10% inclusive), takes **cash or card**,
records **who served**, and prints to an **80 mm thermal receipt printer**.

- **No build step.** `index.html` is the whole app. Runs on any browser/tablet/PC.
- **Works offline** after the first catalogue sync (the product list is cached).
- Your **secret API key never touches the browser** — a tiny read-only proxy holds it.

---

## How it fits together

```
Squarespace store  ──►  proxy (worker.js / api/catalog.js)  ──►  index.html (the till)
  (your products)        holds the secret API key, read-only        scans, totals, prints
```

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

- **Scan** — the barcode box is always focused; a keyboard-wedge scanner types the code
  and hits Enter automatically. Scan again to add another; quantities merge.
- Adjust **quantity** with − / +, or type it. **✕** removes a line.
- Pick **Cash** or **Card**. Cash shows the **5¢-rounded** total, quick-tender buttons,
  and **change**. Card is charged exact.
- Choose **Served by**. For sales **$1,000+** the app requires a customer name/ABN (ATO rule).
- **Finalise & Print** → the 80 mm **TAX INVOICE** prints and a new sale starts. Or
  **Finalise — no print** to record the sale without printing (still numbered & logged).
- **Invoices** (header) → search and view every past sale; open one to **reprint** it.
- **Takings** (header, or click the Today tally) → the day's **total earnings** with a
  cash/card/GST breakdown and a date picker; **Print takings summary** for an end-of-day docket.
- **Reprint last** re-prints the most recent invoice (paper jams / cancelled print).
- Settings → **Export sales CSV** gives your accountant an end-of-day/-month file.

### Printer setup
Use your browser's print dialog once to select the thermal printer and set margins to
**None**. Chrome/Edge remember it. The receipt is sized from **Settings → Receipt paper**
(80 mm / 58 mm / A4).

---

## 6. Combine both tills (one live day total) — optional but recommended for 2 devices

Without this, each device keeps its **own** sales log, so "Takings" only shows that device.
Turn on the shared log and **both tills feed one combined day total** that either device can see live.

1. It deploys automatically with the Netlify setup above — the shared log is the
   `netlify/functions/sales.mjs` function (served at `/api/sales`). It stores sales in
   **Netlify Blobs** (no database to set up).
2. Site → **Environment variables:** add `SALES_TOKEN` = any long random string (your password
   for the shared log).
3. On **each** device, open **⚙︎ Settings → Shared log** and set:
   - **Shared log URL** = `https://<your-site>.netlify.app/api/sales`
   - **Shared log token** = the same `SALES_TOKEN` value
   - **Device tag** = a different letter/number per till (e.g. `1` on one, `2` on the other)
     so invoice numbers never clash (`INV-1-0007` vs `INV-2-0007`).
4. Now **Takings** and **Invoices** show **✓ Combined — both tills**. If a device is offline,
   its sales still complete and print, and sync automatically once it's back online.

## Where to run the till
- **Recommended:** deploy to **Netlify** (Option A) — the till, the catalogue proxy and the
  shared log all live on one public site; open it in Chrome/Edge on each of your 2 devices.
- **Simplest offline:** keep `index.html` on the counter PC/tablet and open it directly
  (no shared log — single device only).

## Notes & limits
- This till **reads** your catalogue and prints invoices; it does **not** write sales
  back into Squarespace or adjust its stock (by design — chosen setup).
- GST is treated as **inclusive** (price ÷ 11). Change the rate in Settings if needed.
- Settings, catalogue cache and the invoice counter are per-device (localStorage). With the
  **shared log** on, the *sales record* is centralised in Netlify Blobs; without it, each
  device keeps its own — **Export sales CSV** backs up the local copy either way.

## Files
| File | What it is |
|------|-----------|
| `index.html` | The till app — the only file you actually run. |
| `netlify/functions/catalog.js` | Netlify catalogue proxy (holds the Squarespace key). |
| `netlify/functions/sales.mjs` | Netlify shared sales log (combines both tills). |
| `netlify.toml` + `package.json` | Netlify routing + the `@netlify/blobs` dependency. |
| `worker.js` | Cloudflare Worker catalogue proxy (alt to Netlify). |
| `api/catalog.js` | Vercel catalogue proxy (alt to Netlify). |
| `README.md` | This guide. |
