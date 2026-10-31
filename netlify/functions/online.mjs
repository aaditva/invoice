/* ------------------------------------------------------------------ *
 *  Netlify Function — online (website) sales from Squarespace
 * ------------------------------------------------------------------ *
 *  Reads the Squarespace store's orders so Takings and Insights can count
 *  what was sold on the website next to what was rung up at the tills.
 *  The secret key stays server-side (env var); it never reaches the browser.
 *
 *  Route:
 *    GET /api/online?from=YYYY-MM-DD&to=YYYY-MM-DD      (day=… works as a one-day range)
 *      → { from, to, days:[{day, store:'online', count, cash, card, online, gst, sub, total, shipping,
 *                           pickup, delivery, unmarked}],
 *          totals:{…same…}, sales:[…], sync:{ complete, syncedTo, error? } }
 *      Each order comes back shaped like a till sale (store 'online',
 *      method 'online', items with sku/name/qty/price), so the till can add it
 *      to its totals and charts with the code it already has.
 *      sync.complete is false while the first read of older orders is still
 *      going: ask again and it carries on from where it stopped.
 *
 *  What counts: paid (or partly refunded) web orders. Test orders, cancelled
 *  orders, unpaid ones, and Squarespace POS sales (channel 'pos' — in-store,
 *  not online) are left out. total = what was charged less anything refunded,
 *  shipping included; `shipping` is reported separately so Insights can leave
 *  it out of product revenue.
 *
 *  How it reaches the customer (each sale's `delivery`), read straight off the order:
 *    'pickup'    the shipping option chosen at checkout (shippingLines[0].method) says
 *                pick up, e.g. "Store Pickup"
 *    'delivery'  the order has a tracking number (fulfillments[].trackingNumber)
 *    ''          neither yet (e.g. a delivery not sent yet); `shipMethod` still carries
 *                the option's name as written, if there is one
 *
 *  Env vars:
 *    SQUARESPACE_API_KEY  the same key as /api/catalog, with **Orders: Read** permission too
 *    ONLINE_SINCE         optional, first day to read orders from (default 2025-10-01)
 *    STORE_TZ             optional, the time zone whose days orders are filed under
 *                         (default Australia/Melbourne, the same days the tills use)
 *    ADMIN_PIN            if set, the request needs a matching x-admin-pin (Takings and
 *                         Insights are Admin-only, so revenue stays behind the password)
 *    SALES_TOKEN          optional; if set, the request needs a matching x-sales-token
 *    ALLOW_ORIGIN         optional, locks CORS to your site URL
 *
 *  Storage (Netlify Blobs, store "online"):
 *    month/<YYYY-MM>  { orders:{ <id>: order } } — every counted order created that month
 *    state            { since, syncedTo, windowDays, lockUntil } — how far the copy is
 *                     up to date. Each read first fetches orders modified since
 *                     syncedTo (at most once a minute), so a refund or a
 *                     cancellation made in Squarespace later replaces the old copy.
 * ------------------------------------------------------------------ */

import { getStore } from '@netlify/blobs';
import { corsHeaders, preflight, json, tokenOk, pinOk } from '../lib/http.mjs';

const SQ = 'https://api.squarespace.com/1.0/commerce/orders';
const UA = 'StoreTill/1.0 (+online-sales)';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_SINCE = '2025-10-01';      // the first day Insights' "All time" goes back to
const MIN_GAP_MS = 60 * 1000;            // ask Squarespace at most once a minute
const BUDGET_MS = 7000;                  // stop syncing in time to answer inside the function timeout
const OVERLAP_MS = 2 * 60 * 1000;        // re-read a little before syncedTo, in case of clock skew
const MAX_WINDOW_DAYS = 30;
const MAX_RANGE_DAYS = 400;
const GST_RATE = 10;                     // fallback only, when Squarespace reports no tax
const COUNTED = new Set(['PAID', 'REFUNDED', 'REFUND_PENDING', 'REFUND_FAILED']);   // money was taken
const STATE_VERSION = 2;                 // bump to read every order again when compact() keeps more
const PICKUP_RE = /pick\s*-?\s*up/i;

export default async (req) => {
  const headers = corsHeaders('GET');
  if (req.method === 'OPTIONS') return preflight(headers);
  if (!tokenOk(req)) return json({ error: 'Bad or missing x-sales-token.' }, 401, headers);
  if (!pinOk(req)) return json({ error: 'Admin login needed.' }, 401, headers);
  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405, headers);

  const q = new URL(req.url).searchParams;
  const a = (q.get('from') || q.get('day') || '').trim();
  const b = (q.get('to') || q.get('day') || a).trim();
  if (!DAY_RE.test(a) || !DAY_RE.test(b)) return json({ error: 'from/to must be YYYY-MM-DD.' }, 400, headers);
  if (a > b) return json({ error: 'from is after to.' }, 400, headers);
  const span = Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
  if (span > MAX_RANGE_DAYS) return json({ error: 'That range is ' + span + ' days; the most is ' + MAX_RANGE_DAYS + '.' }, 400, headers);

  const key = process.env.SQUARESPACE_API_KEY;
  if (!key) return json({ error: 'SQUARESPACE_API_KEY is not set.' }, 500, headers);

  try {
    const st = getStore({ name: 'online', consistency: 'strong' });
    const sync = await syncOrders(st, key, Date.now() + BUDGET_MS);
    const orders = await readRange(st, a, b);
    const sales = orders.map(toSale).sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
    const byDay = new Map();
    for (const s of sales) { if (!byDay.has(s.day)) byDay.set(s.day, []); byDay.get(s.day).push(s); }
    const days = [...byDay.keys()].sort().map(day => ({ day, store: 'online', ...aggregate(byDay.get(day)) }));
    return json({ from: a, to: b, days, totals: aggregate(sales), sales, sync }, 200, headers);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500, headers);
  }
};

export const config = { path: '/api/online' };

/* ---------------- keeping the copy up to date ---------------- */

async function syncOrders(st, key, deadline) {
  const since = sinceDay();
  const now = Date.now();
  const cur = await getWithEtag(st, 'state');
  let state = cur.data || {};
  // ONLINE_SINCE moved earlier, or orders now keep more fields: read them all again.
  if (!state.since || since < state.since || state.v !== STATE_VERSION) state = { ...state, since, syncedTo: null, v: STATE_VERSION };

  const startIso = state.syncedTo || new Date(Date.parse(since + 'T00:00:00Z') - 86400000).toISOString();
  const caughtUp = now - Date.parse(startIso) < MIN_GAP_MS + OVERLAP_MS;
  if (state.syncedTo && caughtUp) return { complete: true, syncedTo: state.syncedTo };

  // One sync at a time: claim the state blob, or answer from the copy as it is.
  if (state.lockUntil && Date.parse(state.lockUntil) > now) {
    return { complete: !!state.syncedTo && caughtUp, syncedTo: state.syncedTo || null, busy: true };
  }
  const lockUntil = new Date(now + BUDGET_MS + 5000).toISOString();
  const claim = await st.setJSON('state', { ...state, lockUntil }, cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
  if (claim && claim.modified === false) return { complete: false, syncedTo: state.syncedTo || null, busy: true };

  const start = Date.parse(startIso) - (state.syncedTo ? OVERLAP_MS : 0);
  let from = start;
  let windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(1, Number(state.windowDays) || MAX_WINDOW_DAYS));
  let error = null;
  try {
    while (from < now && Date.now() < deadline) {
      const to = Math.min(from + windowDays * 86400000, now);
      const r = await readWindow(st, key, from, to, deadline);
      if (r.done) { from = to; windowDays = Math.min(MAX_WINDOW_DAYS, windowDays * 2); }
      else if (r.progress) { from = r.progress; break; }
      else { windowDays = Math.max(1, Math.floor(windowDays / 2)); break; }   // too many to finish in time: smaller bites next run
    }
  } catch (e) {
    error = friendly(e);
  }
  // No progress (Squarespace refused, or time ran out at once): keep the old mark.
  const syncedTo = from > start ? new Date(Math.min(from, now)).toISOString() : (state.syncedTo || null);
  const next = { v: STATE_VERSION, since: state.since, syncedTo, windowDays, lastRun: new Date().toISOString() };
  try { await st.setJSON('state', next); } catch (e) { /* next read retries */ }
  const out = { complete: !error && !!syncedTo && now - Date.parse(syncedTo) < MIN_GAP_MS + OVERLAP_MS, syncedTo };
  if (error) out.error = error;
  return out;
}

// Every order modified in (from, to]. Pages come back oldest-modified first, so
// when time runs out part-way the last order filed is a safe place to resume.
async function readWindow(st, key, from, to, deadline) {
  let url = SQ + '?modifiedAfter=' + encodeURIComponent(new Date(from).toISOString()) +
    '&modifiedBefore=' + encodeURIComponent(new Date(to).toISOString());
  let progress = 0, ascending = true, guard = 0;
  while (url && guard++ < 200) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key, 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) throw new Error('Squarespace ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const data = await r.json();
    const list = Array.isArray(data.result) ? data.result : [];
    await fileOrders(st, list);
    for (const o of list) {
      const t = Date.parse(o.modifiedOn);
      if (!isFinite(t)) continue;
      if (t < progress) ascending = false;
      progress = Math.max(progress, t);
    }
    const p = data.pagination;
    url = p && p.hasNextPage && p.nextPageCursor ? SQ + '?cursor=' + encodeURIComponent(p.nextPageCursor) : null;
    if (url && Date.now() > deadline) return { done: false, progress: ascending && progress > from ? progress : 0 };
  }
  return { done: true };
}

// File (or drop) each order in the month it was created.
async function fileOrders(st, list) {
  const byMonth = new Map();
  for (const o of list) {
    if (!o || !o.id) continue;
    const day = localDay(o.createdOn);
    if (!day) continue;
    const m = day.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push([o, day]);
  }
  for (const [m, rows] of byMonth) {
    const key = 'month/' + m;
    const cur = await getJSON(st, key);
    const orders = (cur && cur.orders && typeof cur.orders === 'object') ? cur.orders : {};
    for (const [o, day] of rows) {
      if (counts(o)) orders[o.id] = compact(o, day); else delete orders[o.id];
    }
    await st.setJSON(key, { orders });
  }
}

function counts(o) {
  if (o.testmode) return false;
  if (String(o.channel || '').toLowerCase() === 'pos') return false;      // Squarespace's own in-store POS
  if (o.fulfillmentStatus === 'CANCELED') return false;
  if (o.paymentState && !COUNTED.has(o.paymentState)) return false;
  return amt(o.grandTotal) - amt(o.refundedTotal) > 0.004;
}

function compact(o, day) {
  const grand = amt(o.grandTotal), refunded = amt(o.refundedTotal);
  return {
    id: o.id, no: String(o.orderNumber || o.id), ts: o.createdOn, day,
    grand, refunded, shipping: amt(o.shippingTotal), tax: amt(o.taxTotal),
    discount: amt(o.discountTotal), status: o.fulfillmentStatus || '',
    shipMethod: String((Array.isArray(o.shippingLines) && o.shippingLines[0] && o.shippingLines[0].method) || '').trim(),
    tracking: (Array.isArray(o.fulfillments) ? o.fulfillments : [])
      .map(f => String((f && f.trackingNumber) || '').trim()).filter(Boolean),
    items: (Array.isArray(o.lineItems) ? o.lineItems : []).map(li => ({
      sku: String(li.sku || '').trim(),
      name: [li.productName, ...(Array.isArray(li.variantOptions) ? li.variantOptions.map(v => v && v.value).filter(Boolean) : [])]
        .filter(Boolean).join(' — ') || 'Online item',
      qty: Number(li.quantity) || 0,
      price: amt(li.unitPricePaid),
    })),
  };
}

/* ---------------- reading ---------------- */

async function readRange(st, from, to) {
  const months = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = nextMonth(m)) months.push(m);
  const docs = await Promise.all(months.map(m => getJSON(st, 'month/' + m)));
  const out = [];
  for (const d of docs) {
    for (const o of Object.values((d && d.orders) || {})) if (o && o.day >= from && o.day <= to) out.push(o);
  }
  return out;
}

// An order as a till sale: what was kept after refunds, GST from Squarespace
// (or worked out at 10% inclusive if the store reports none), shipping apart.
function toSale(o) {
  const total = r2(o.grand - o.refunded);
  const keep = o.grand ? total / o.grand : 0;
  const gst = r2(o.tax > 0 ? o.tax * keep : total * GST_RATE / (100 + GST_RATE));
  return {
    no: 'WEB-' + o.no, orderId: o.id, day: o.day, ts: o.ts,
    store: 'online', storeName: 'Online', method: 'online', kind: 'online',
    total, gst, sub: r2(total - gst), shipping: r2(o.shipping * keep),
    refunded: o.refunded || 0, discount: o.discount || 0, status: o.status,
    delivery: deliveryOf(o), shipMethod: o.shipMethod || '', tracking: o.tracking || [],
    servedBy: 'Website', items: o.items,
  };
}

// Only what the order itself says: the option's name, or a tracking number.
function deliveryOf(o) {
  if (PICKUP_RE.test(o.shipMethod || '')) return 'pickup';
  if (o.tracking && o.tracking.length) return 'delivery';
  return '';
}

function aggregate(sales) {
  let online = 0, gst = 0, sub = 0, shipping = 0, pickup = 0, delivery = 0, unmarked = 0;
  for (const s of sales) {
    online += s.total; gst += s.gst; sub += s.sub; shipping += s.shipping;
    if (s.delivery === 'pickup') pickup++; else if (s.delivery === 'delivery') delivery++; else unmarked++;
  }
  online = r2(online);
  return { count: sales.length, cash: 0, card: 0, online, gst: r2(gst), sub: r2(sub), total: online, shipping: r2(shipping),
           pickup, delivery, unmarked };
}

/* ---------------- plumbing ---------------- */

function sinceDay() {
  const v = String(process.env.ONLINE_SINCE || '').trim();
  return DAY_RE.test(v) ? v : DEFAULT_SINCE;
}

// The calendar day an ISO time falls on in the stores' time zone.
const dayFmt = (() => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.STORE_TZ || 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch (e) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }); }
})();
function localDay(iso) {
  const t = Date.parse(iso);
  if (!isFinite(t)) return '';
  const d = dayFmt.format(new Date(t));
  return DAY_RE.test(d) ? d : '';
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/Squarespace (401|403)/.test(m)) return 'Squarespace won’t share orders with this key. Give SQUARESPACE_API_KEY the Orders: Read permission (Squarespace → Settings → Developer API Keys).';
  return m;
}

async function getWithEtag(st, key) {
  try {
    const r = await st.getWithMetadata(key, { type: 'json' });
    return r ? { data: r.data, etag: r.etag || null } : { data: null, etag: null };
  } catch (e) { return { data: null, etag: null }; }
}
async function getJSON(st, key) { try { return await st.get(key, { type: 'json' }); } catch (e) { return null; } }
function nextMonth(m) { const y = +m.slice(0, 4), n = +m.slice(5, 7); return n === 12 ? (y + 1) + '-01' : y + '-' + String(n + 1).padStart(2, '0'); }
function amt(v) { const n = Number(v && typeof v === 'object' ? v.value : v); return isFinite(n) ? n : 0; }
function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
