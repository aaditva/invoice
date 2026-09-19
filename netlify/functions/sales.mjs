/* ------------------------------------------------------------------ *
 *  Netlify Function — shared sales log (the till's "website memory")
 * ------------------------------------------------------------------ *
 *  Every finalised sale is POSTed here and stored in Netlify Blobs, so the
 *  record lives on the site rather than in one browser's localStorage. Any
 *  till — or the Admin tab — can then read back a store's sales for today or
 *  any earlier day, from any device.
 *
 *  Routes (all on /api/sales):
 *    POST /api/sales                     body = the sale object
 *      Upsert by invoice number. Re-POSTing the same invoice overwrites it,
 *      which is how a void/refund propagates.
 *
 *    GET  /api/sales?day=YYYY-MM-DD[&store=ID]
 *      → { day, store, sales:[...] }     one day, one store or all stores
 *
 *    GET  /api/sales?from=YYYY-MM-DD&to=YYYY-MM-DD[&store=ID][&include=sales]
 *      → { from, to, stores, days:[{day,store,...agg}], byStore, totals }
 *      Per-day/per-store takings for the Admin tab. include=sales also
 *      returns the raw sales (used by Admin → Export CSV).
 *
 *  Env vars (Site configuration → Environment variables):
 *    SALES_TOKEN    optional shared secret. If set, every request must send a
 *                   matching x-sales-token header. The same token the till's
 *                   Settings → Shared log token holds.
 *    ALLOW_ORIGIN   optional, locks CORS to your site URL (default *).
 *
 *  Storage layout — two kinds of blob:
 *    sale/<day>/<store>/<invoiceNo>   the sale itself. SOURCE OF TRUTH.
 *                                     One blob per sale, so two tills writing
 *                                     at once can never clobber each other.
 *    index/<day>/<store>              { sales:[...], etags:{} } — a read cache
 *                                     so a day costs 2 requests instead of one
 *                                     per sale. Rebuilt automatically from the
 *                                     sale blobs whenever it looks out of date,
 *                                     so a lost index write never hides a sale.
 * ------------------------------------------------------------------ */

import { getStore } from '@netlify/blobs';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STORE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const UNASSIGNED = 'unassigned';       // sales that arrived without a store (pre-store-selector tills)
const MAX_RANGE_DAYS = 62;             // keeps an Admin range inside the function timeout
const CONCURRENCY = 10;                // parallel blob reads
const INDEX_V = 1;

// Local bookkeeping the till uses to track its own offline queue. It means
// nothing once the sale is on the server, so it doesn't get stored.
const LOCAL_ONLY = ['synced', 'stockAdjusted', 'restocked', 'stockItems'];

export default async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': process.env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-sales-token',
    'Cache-Control': 'no-store',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  const want = process.env.SALES_TOKEN;
  if (want && !sameToken(req.headers.get('x-sales-token') || '', want)) {
    return json({ error: 'Bad or missing x-sales-token.' }, 401, headers);
  }

  try {
    if (req.method === 'POST') return await handlePost(req, headers);
    if (req.method === 'GET') return await handleGet(req, headers);
    return json({ error: 'Method not allowed.' }, 405, headers);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500, headers);
  }
};

export const config = { path: '/api/sales' };

/* ---------------- write ---------------- */

async function handlePost(req, headers) {
  let sale;
  try { sale = await req.json(); } catch (e) { return json({ error: 'Body must be JSON.' }, 400, headers); }
  if (!sale || typeof sale !== 'object' || Array.isArray(sale)) {
    return json({ error: 'Body must be a sale object.' }, 400, headers);
  }

  const no = String(sale.no == null ? '' : sale.no).trim();
  if (!no) return json({ error: 'Sale is missing an invoice number (no).' }, 400, headers);

  const day = String(sale.day == null ? '' : sale.day).trim();
  if (!DAY_RE.test(day)) return json({ error: 'Sale needs day = YYYY-MM-DD.' }, 400, headers);

  const store = slugStore(sale.store);
  const clean = { ...sale, no, day, store };
  for (const k of LOCAL_ONLY) delete clean[k];

  const st = blobs();
  // Sale blob first: once this lands the sale is recorded, whatever happens to the index.
  const res = await st.setJSON(saleKey(day, store, no), clean);
  const etag = (res && res.etag) || null;
  await mergeIntoIndex(st, day, store, clean, etag);

  return json({ ok: true, store, day, no }, 200, headers);
}

// Add (or replace) one sale in the day's index. A concurrent write at the same
// store can lose this update; readDay() notices and rebuilds, so it stays correct.
async function mergeIntoIndex(st, day, store, sale, etag) {
  const key = indexKey(day, store);
  const idx = await readIndex(st, key);
  const i = idx.sales.findIndex(s => String(s.no) === String(sale.no));
  if (i >= 0) idx.sales[i] = sale; else idx.sales.push(sale);
  idx.sales.sort(byTs);
  if (etag) idx.etags[sale.no] = etag; else delete idx.etags[sale.no];
  try {
    await st.setJSON(key, { v: INDEX_V, day, store, sales: idx.sales, etags: idx.etags });
  } catch (e) { /* cache only — readDay() rebuilds it from the sale blobs */ }
}

/* ---------------- read ---------------- */

async function handleGet(req, headers) {
  const q = new URL(req.url).searchParams;

  const storeParam = (q.get('store') || '').trim();
  let store = null;
  if (storeParam && storeParam !== 'all') {
    store = slugStore(storeParam);
    if (!STORE_RE.test(store)) return json({ error: 'Bad store id.' }, 400, headers);
  }

  const from = (q.get('from') || '').trim();
  const to = (q.get('to') || '').trim();

  // Range → per-day/per-store takings (Admin tab).
  if (from || to) {
    const a = from || to, b = to || from;
    if (!DAY_RE.test(a) || !DAY_RE.test(b)) return json({ error: 'from/to must be YYYY-MM-DD.' }, 400, headers);
    // Count first, so an over-long range can say how long it actually was.
    const span = Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
    if (!isFinite(span) || span < 1) return json({ error: 'from is after to.' }, 400, headers);
    if (span > MAX_RANGE_DAYS) {
      return json({ error: 'That range is ' + span + ' days; the most this can read at once is ' + MAX_RANGE_DAYS + '.' }, 400, headers);
    }
    const days = dayRange(a, b);
    if (!days.length) return json({ error: 'from is after to.' }, 400, headers);

    const perDay = await mapLimit(days, CONCURRENCY, d => readDay(d, store));
    const rows = [];
    const all = [];
    const byStore = {};
    days.forEach((d, i) => {
      const group = new Map();
      for (const s of perDay[i]) {
        const id = slugStore(s.store);
        if (!group.has(id)) group.set(id, []);
        group.get(id).push(s);
        all.push(s);
      }
      for (const [id, list] of group) {
        rows.push({ day: d, store: id, ...aggregate(list) });
        byStore[id] = addAgg(byStore[id], aggregate(list));
      }
    });
    rows.sort((x, y) => x.day.localeCompare(y.day) || x.store.localeCompare(y.store));

    const out = {
      from: days[0], to: days[days.length - 1],
      stores: Object.keys(byStore).sort(),
      days: rows, byStore, totals: aggregate(all),
    };
    if (q.get('include') === 'sales') out.sales = all.sort(byTs);
    return json(out, 200, headers);
  }

  // Single day (the till's own Today / Invoices / Takings views).
  const day = (q.get('day') || '').trim() || utcToday();
  if (!DAY_RE.test(day)) return json({ error: 'day must be YYYY-MM-DD.' }, 400, headers);
  const sales = await readDay(day, store);
  return json({ day, store: store || 'all', sales: sales.sort(byTs) }, 200, headers);
}

// Every sale for one day, for one store or all of them. Reads the per-day index
// and repairs it from the sale blobs when the two disagree, so a sale can never
// be missing from a total just because an index write was lost or raced.
async function readDay(day, storeFilter) {
  const st = blobs();
  const prefix = 'sale/' + day + '/' + (storeFilter ? storeFilter + '/' : '');

  let listed;
  try { listed = await st.list({ prefix }); } catch (e) { return []; }
  const blobList = (listed && listed.blobs) || [];
  if (!blobList.length) return [];

  // key = sale/<day>/<store>/<encoded invoice no>
  const byStore = new Map();
  for (const b of blobList) {
    const parts = String(b.key).split('/');
    if (parts.length < 4) continue;
    const store = parts[2];
    const no = safeDecode(parts.slice(3).join('/'));
    if (!store || !no) continue;
    if (!byStore.has(store)) byStore.set(store, new Map());
    byStore.get(store).set(no, { key: b.key, etag: b.etag || null });
  }

  const out = [];
  for (const [store, wanted] of byStore) {
    const idx = await readIndex(st, indexKey(day, store));
    const have = new Map(idx.sales.map(s => [String(s.no), s]));

    // Refetch anything the index has never seen, or whose blob has changed
    // since it was indexed (a void re-POST whose index update went missing).
    const stale = [];
    for (const [no, info] of wanted) {
      const known = idx.etags[no];
      if (!have.has(no)) stale.push(no);
      else if (known && info.etag && known !== info.etag) stale.push(no);
    }

    if (stale.length) {
      const fetched = await mapLimit(stale, CONCURRENCY, no => getJSON(st, wanted.get(no).key));
      stale.forEach((no, i) => {
        const s = fetched[i];
        if (s && s.no) {
          have.set(String(s.no), s);
          const e = wanted.get(no).etag;
          if (e) idx.etags[no] = e;
        }
      });
      // Drop index entries whose sale blob is gone, then write the repair back.
      const rebuilt = [...have.values()].filter(s => wanted.has(String(s.no))).sort(byTs);
      const etags = {};
      for (const s of rebuilt) { if (idx.etags[s.no]) etags[s.no] = idx.etags[s.no]; }
      try {
        await st.setJSON(indexKey(day, store), { v: INDEX_V, day, store, sales: rebuilt, etags });
      } catch (e) { /* best effort — the data we're returning is already correct */ }
      out.push(...rebuilt);
    } else {
      out.push(...idx.sales.filter(s => wanted.has(String(s.no))));
    }
  }
  return out;
}

async function readIndex(st, key) {
  const v = await getJSON(st, key);
  const sales = v && Array.isArray(v.sales) ? v.sales : (Array.isArray(v) ? v : []);
  const etags = v && v.etags && typeof v.etags === 'object' ? { ...v.etags } : {};
  return { sales, etags };
}

/* ---------------- totals ----------------
   Mirrors aggregate() in index.html — voided sales don't count, cash is the
   5c-rounded amount actually taken, card is the exact total. Keep the two in
   step: the till aggregates single days itself and trusts these for a range. */

function aggregate(sales) {
  const live = (sales || []).filter(s => s && !s.voided);
  let cash = 0, card = 0, gst = 0, sub = 0;
  for (const s of live) {
    const total = num(s.total);
    if (s.method === 'cash') cash += (s.paid != null ? num(s.paid) : total);
    else card += total;
    gst += num(s.gst);
    sub += num(s.sub);
  }
  cash = r2(cash); card = r2(card);
  return { count: live.length, cash, card, gst: r2(gst), sub: r2(sub), total: r2(cash + card) };
}

function addAgg(a, b) {
  if (!a) return { ...b };
  return {
    count: a.count + b.count, cash: r2(a.cash + b.cash), card: r2(a.card + b.card),
    gst: r2(a.gst + b.gst), sub: r2(a.sub + b.sub), total: r2(a.total + b.total),
  };
}

/* ---------------- plumbing ---------------- */

function blobs() {
  // Strong consistency: a till must read back the sale it just wrote.
  return getStore({ name: 'sales', consistency: 'strong' });
}

function saleKey(day, store, no) { return 'sale/' + day + '/' + store + '/' + encodeURIComponent(no); }
function indexKey(day, store) { return 'index/' + day + '/' + store; }

async function getJSON(st, key) {
  try { return await st.get(key, { type: 'json' }); } catch (e) { return null; }
}

function slugStore(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s && STORE_RE.test(s) ? s : UNASSIGNED;
}

function dayRange(from, to) {
  const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b) || b < a) return [];
  const out = [];
  // The caller checks the span first; this cap is only a guard against looping away.
  for (let t = a; t <= b && out.length < 400; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function utcToday() { return new Date().toISOString().slice(0, 10); }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  });
  await Promise.all(workers);
  return out;
}

function byTs(a, b) { return String(a && a.ts).localeCompare(String(b && b.ts)); }
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

// Length-independent compare, so a wrong token can't be probed byte by byte.
function sameToken(got, want) {
  const a = String(got), b = String(want);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  }
  return diff === 0;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
