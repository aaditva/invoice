/* ------------------------------------------------------------------ *
 *  Netlify Function — website orders to print (and Store Pickups to collect)
 * ------------------------------------------------------------------ *
 *  Watches the Squarespace store for new paid orders and keeps a print queue.
 *  The till ticked "Print website orders on this till" (Settings) asks here
 *  every minute, prints what's waiting on its receipt printer, then says so.
 *  An order stays queued until a till has actually printed it, so nothing is
 *  lost while the till, the wifi or the printer is off: it prints when it's back.
 *
 *  How an order reaches the customer, from the order itself (never guessed):
 *    pickup    its checkout shipping option (shippingLines[0].method, or for a
 *              pickup order, which has no shipping line, shippingOptionName) says pick up,
 *              e.g. "Store Pickup". It also goes on that store's Pick ups list with
 *              a pick-up barcode; ticking it there fulfils the order in Squarespace.
 *    delivery  any other shipping option, or a shipping address. Printed only.
 *    other     no shipping at all (e.g. digital). Printed only.
 *
 *  Routes:
 *    GET  /api/web-orders?device=ID
 *      → { pending:[sale…], sync:{ ok, error? } }   orders waiting to print. A
 *      sale here is shaped like a till sale (items, total, gst…) plus `web`:
 *      { orderId, orderNumber, kind, shipMethod, email, phone, billTo, shipTo,
 *        notes, discounts, payment }.
 *    POST /api/web-orders?claim=1     body { id, device, store, storeName }
 *      → { ok, sale }   this till prints it. Another till's claim lasts 2 minutes.
 *      A pickup is filed under `store` (the claiming till's) and put on its list.
 *    POST /api/web-orders?printed=1   body { id, device }   → { ok }   off the queue.
 *    POST /api/web-orders?release=1   body { id, device }   → { ok }   print failed: back to waiting.
 *
 *  Kept up to date with Squarespace: an order cancelled or fully refunded there
 *  leaves the queue and the Pick ups list; one fulfilled there is ticked off.
 *
 *  Env vars:
 *    SQUARESPACE_API_KEY  Orders: Read (to see orders) and Write (to fulfil pickups).
 *                         Transactions: Read adds the card type to the printout.
 *    WEB_PRINT_SINCE      optional ISO time to start from. Default: 30 minutes before
 *                         the first time a till asks, so older orders don't all print.
 *                         An order more than 4 days old when first seen never prints.
 *    SQ_PICKUP_NOTIFY     '0' = no Squarespace email to the customer when a pickup is ticked
 *                         (by default they get Squarespace's "order fulfilled" email).
 *    STORE_TZ             optional, default Australia/Melbourne (the day an order is filed under)
 *    SALES_TOKEN          optional; if set, requests need a matching x-sales-token
 *
 *  Storage (Netlify Blobs, store "sales", next to the tills' sales):
 *    web/order/<orderId>  the order as a sale. Not under sale/…, so it's never counted
 *                         in a store's takings (/api/online already counts it).
 *    web/queue/<orderId>  { id, claimedBy, claimUntil }  still to print
 *    web/state            { since, syncedTo, lockUntil }  how far Squarespace has been read
 * ------------------------------------------------------------------ */

import { corsHeaders, preflight, json, tokenOk } from '../lib/http.mjs';
import { salesBlobs, webKey, openKey, newPickupCode, pointerOf, getJSON, setPickedUp } from '../lib/pickups.mjs';
import { sqFetch, sqKey, paymentOf, shipMethodOf } from '../lib/squarespace.mjs';

const STORE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const QUEUE = 'web/queue/';
const STATE = 'web/state';
const MIN_GAP_MS = 30 * 1000;            // ask Squarespace at most twice a minute
const OVERLAP_MS = 2 * 60 * 1000;        // re-read a little before syncedTo, in case of clock skew
const FIRST_LOOKBACK_MS = 30 * 60 * 1000;
// An order older than this when first seen isn't printed: the tills printing
// website orders by default could otherwise turn up weeks of them at once (a
// queue nobody read for a while). Four days still covers a long weekend offline.
const MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;
const BUDGET_MS = 6000;
const CLAIM_MS = 2 * 60 * 1000;
const GST_RATE = 10;                     // fallback only, when Squarespace reports no tax
const COUNTED = new Set(['PAID', 'REFUNDED', 'REFUND_PENDING', 'REFUND_FAILED']);   // money was taken
const PICKUP_NAME_RE = /pick\s*-?\s*up/i;

export default async (req) => {
  const headers = corsHeaders('GET, POST');
  if (req.method === 'OPTIONS') return preflight(headers);
  if (!tokenOk(req)) return json({ error: 'Bad or missing x-sales-token.' }, 401, headers);
  try {
    const st = salesBlobs();
    if (req.method === 'GET') {
      const device = cleanDevice(new URL(req.url).searchParams.get('device'));
      const sync = await syncOrders(st, Date.now() + BUDGET_MS);
      const pending = await listPending(st, device);
      return json({ pending, sync }, 200, headers);
    }
    if (req.method === 'POST') {
      const sp = new URL(req.url).searchParams;
      let body = {};
      try { body = await req.json(); } catch (e) { return json({ error: 'Body must be JSON.' }, 400, headers); }
      const id = String((body && body.id) || '').trim();
      const device = cleanDevice(body && body.device);
      if (!id || !device) return json({ error: 'id and device are needed.' }, 400, headers);
      if (sp.get('claim')) return await claim(st, id, device, body, headers);
      if (sp.get('printed')) return await printed(st, id, device, headers);
      if (sp.get('release')) return await release(st, id, device, headers);
      return json({ error: 'Say claim, printed or release.' }, 400, headers);
    }
    return json({ error: 'Method not allowed.' }, 405, headers);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500, headers);
  }
};

export const config = { path: '/api/web-orders' };

/* ---------------- the print queue ---------------- */

async function listPending(st, device) {
  let listed;
  try { listed = await st.list({ prefix: QUEUE }); } catch (e) { return []; }
  const now = Date.now();
  const out = [];
  for (const b of (listed && listed.blobs) || []) {
    const q = await getJSON(st, b.key);
    if (!q || !q.id) continue;
    const sale = await getJSON(st, webKey(q.id));
    if (!sale || sale.voided) { try { await st.delete(b.key); } catch (e) { /* next time */ } continue; }
    const takenByOther = q.claimedBy && q.claimedBy !== device && Date.parse(q.claimUntil) > now;
    if (!takenByOther) out.push(sale);
  }
  return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

async function claim(st, id, device, body, headers) {
  const key = QUEUE + encodeURIComponent(id);
  const cur = await getWithEtag(st, key);
  if (!cur.data) return json({ error: 'That order isn\'t waiting to print.' }, 404, headers);
  const q = cur.data;
  if (q.claimedBy && q.claimedBy !== device && Date.parse(q.claimUntil) > Date.now()) {
    return json({ error: 'Another till is printing it.' }, 409, headers);
  }
  const res = await st.setJSON(key, { ...q, claimedBy: device, claimUntil: new Date(Date.now() + CLAIM_MS).toISOString() },
    cur.etag ? { onlyIfMatch: cur.etag } : {});
  if (res && res.modified === false) return json({ error: 'Another till is printing it.' }, 409, headers);

  const sale = await getJSON(st, webKey(id));
  if (!sale || sale.voided) return json({ error: 'That order was cancelled.' }, 410, headers);
  let changed = false;
  // A pickup belongs to the store whose till prints it first.
  if (!sale.store) {
    const store = String((body && body.store) || '').trim().toLowerCase();
    if (!STORE_RE.test(store)) return json({ error: 'Bad store id.' }, 400, headers);
    sale.store = store;
    sale.storeName = String((body && body.storeName) || '').slice(0, 60) || store;
    changed = true;
  }
  if (!sale.web.paymentChecked) {
    sale.web.payment = await paymentOf(id);
    sale.web.paymentChecked = true;
    changed = true;
  }
  if (changed) await st.setJSON(webKey(id), sale);
  if (sale.order === 'pickup' && sale.pickupCode && !sale.pickedUp && !sale.web.fulfilledAt) {
    await st.setJSON(openKey(sale.store, sale.pickupCode), pointerOf(sale));
  }
  return json({ ok: true, sale }, 200, headers);
}

async function printed(st, id, device, headers) {
  const key = QUEUE + encodeURIComponent(id);
  const q = await getJSON(st, key);
  if (q && q.claimedBy && q.claimedBy !== device && Date.parse(q.claimUntil) > Date.now()) {
    return json({ error: 'Another till is printing it.' }, 409, headers);
  }
  const sale = await getJSON(st, webKey(id));
  if (sale && !sale.printedAt) {
    sale.printedAt = new Date().toISOString();
    sale.printedBy = device;
    await st.setJSON(webKey(id), sale);
  }
  try { await st.delete(key); } catch (e) { /* already gone */ }
  return json({ ok: true }, 200, headers);
}

async function release(st, id, device, headers) {
  const key = QUEUE + encodeURIComponent(id);
  const q = await getJSON(st, key);
  if (q && q.claimedBy === device) await st.setJSON(key, { id: q.id });
  return json({ ok: true }, 200, headers);
}

/* ---------------- reading Squarespace ---------------- */

async function syncOrders(st, deadline) {
  if (!sqKey()) return { ok: false, error: 'SQUARESPACE_API_KEY is not set.' };
  const now = Date.now();
  const cur = await getWithEtag(st, STATE);
  let state = cur.data || {};
  if (!state.since) {
    const env = Date.parse(process.env.WEB_PRINT_SINCE || '');
    const since = new Date(isFinite(env) ? env : now - FIRST_LOOKBACK_MS).toISOString();
    state = { since, syncedTo: since };
  }
  if (now - Date.parse(state.syncedTo) < MIN_GAP_MS) return { ok: true };
  if (state.lockUntil && Date.parse(state.lockUntil) > now) return { ok: true, busy: true };
  const claim = await st.setJSON(STATE, { ...state, lockUntil: new Date(now + BUDGET_MS + 5000).toISOString() },
    cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
  if (claim && claim.modified === false) return { ok: true, busy: true };

  const from = Date.parse(state.syncedTo) - OVERLAP_MS;
  let reached = Date.parse(state.syncedTo);
  let error = null;
  try {
    let path = '/orders?modifiedAfter=' + encodeURIComponent(new Date(from).toISOString()) +
      '&modifiedBefore=' + encodeURIComponent(new Date(now).toISOString());
    let guard = 0;
    while (path && guard++ < 50) {
      const r = await sqFetch(path);
      if (!r.ok) throw new Error('Squarespace ' + r.status + ': ' + (await r.text()).slice(0, 200));
      const data = await r.json();
      for (const o of (Array.isArray(data.result) ? data.result : [])) await fileOrder(st, o, state.since);
      const p = data.pagination;
      path = p && p.hasNextPage && p.nextPageCursor ? '/orders?cursor=' + encodeURIComponent(p.nextPageCursor) : null;
      if (path && Date.now() > deadline) break;       // carry on from the same mark next time
      if (!path) reached = now;
    }
  } catch (e) {
    error = friendly(e);
  }
  try { await st.setJSON(STATE, { since: state.since, syncedTo: new Date(reached).toISOString(), lastRun: new Date().toISOString() }); }
  catch (e) { /* next read retries */ }
  return error ? { ok: false, error } : { ok: true };
}

async function fileOrder(st, o, since) {
  if (!o || !o.id) return;
  const key = webKey(o.id);
  const rec = await getJSON(st, key);
  const live = counts(o);
  if (!rec) {
    const made = Date.parse(o.createdOn);
    if (!live || !(made >= Date.parse(since)) || Date.now() - made > MAX_AGE_MS) return;
    const sale = toWebSale(o);
    await st.setJSON(key, sale);
    await st.setJSON(QUEUE + encodeURIComponent(o.id), { id: o.id });
    return;
  }
  if (rec.voided) return;
  if (!live) {
    // Cancelled or fully refunded in Squarespace: off the queue and the Pick ups list.
    rec.voided = true;
    rec.voidedWhy = o.fulfillmentStatus === 'CANCELED' ? 'Cancelled in Squarespace' : 'Refunded in Squarespace';
    await st.setJSON(key, rec);
    try { await st.delete(QUEUE + encodeURIComponent(o.id)); } catch (e) { /* gone */ }
    if (rec.store && rec.pickupCode) { try { await st.delete(openKey(rec.store, rec.pickupCode)); } catch (e) { /* gone */ } }
    return;
  }
  // Fulfilled in Squarespace itself: tick it off the Pick ups list too. One not
  // printed yet is on no list; it still prints, but doesn't go on the list.
  if (o.fulfillmentStatus === 'FULFILLED' && rec.order === 'pickup' && !rec.pickedUp && !rec.web.fulfilledAt) {
    rec.web.fulfilledAt = o.fulfilledOn || new Date().toISOString();
    const fromKey = rec.store && rec.pickupCode ? openKey(rec.store, rec.pickupCode) : '';
    const ptr = fromKey ? await getJSON(st, fromKey) : null;
    if (ptr) {
      await setPickedUp(st, { store: rec.store, code: rec.pickupCode, ptr, fromKey, sale: rec, done: true,
        day: localDay(rec.web.fulfilledAt) || localDay(new Date().toISOString()), by: 'Squarespace' });
    } else {
      await st.setJSON(key, rec);
    }
  }
}

function counts(o) {
  if (o.testmode) return false;
  if (String(o.channel || '').toLowerCase() === 'pos') return false;      // Squarespace's own in-store POS
  if (o.fulfillmentStatus === 'CANCELED') return false;
  if (o.paymentState && !COUNTED.has(o.paymentState)) return false;
  return amt(o.grandTotal) - amt(o.refundedTotal) > 0.004;
}

// The order as a till sale, so the till's receipt and Pick ups code can use it.
function toWebSale(o) {
  const shipMethod = shipMethodOf(o);
  const kind = PICKUP_NAME_RE.test(shipMethod) ? 'pickup' : (shipMethod || hasAddress(o.shippingAddress)) ? 'delivery' : 'other';
  const bill = o.billingAddress || {}, ship = o.shippingAddress || {};
  const name = a => [a.firstName, a.lastName].map(x => String(x || '').trim()).filter(Boolean).join(' ');
  const phone = String(bill.phone || ship.phone || '').trim();
  const email = String(o.customerEmail || '').trim();
  const day = localDay(o.createdOn);
  const total = amt(o.grandTotal);
  const gst = r2(amt(o.taxTotal) > 0 ? amt(o.taxTotal) : total * GST_RATE / (100 + GST_RATE));
  const notes = [];
  for (const f of (Array.isArray(o.formSubmission) ? o.formSubmission : [])) {
    if (f && String(f.value || '').trim()) notes.push({ label: String(f.label || '').trim(), value: String(f.value).trim() });
  }
  const items = (Array.isArray(o.lineItems) ? o.lineItems : []).map(li => {
    for (const c of (Array.isArray(li.customizations) ? li.customizations : [])) {
      if (c && String(c.value || '').trim()) notes.push({ label: (li.productName || 'Item') + ' · ' + String(c.label || '').trim(), value: String(c.value).trim() });
    }
    return {
      sku: String(li.sku || '').trim(),
      name: [li.productName, ...(Array.isArray(li.variantOptions) ? li.variantOptions.map(v => v && v.value).filter(Boolean) : [])]
        .filter(Boolean).join(' — ') || 'Online item',
      qty: Number(li.quantity) || 0,
      price: amt(li.unitPricePaid),
    };
  });
  const sale = {
    no: 'WEB-' + String(o.orderNumber || o.id), orderNo: '#' + String(o.orderNumber || o.id),
    day, ts: o.createdOn, store: '', storeName: '',
    kind: 'online', method: 'online', servedBy: 'Website',
    order: kind === 'pickup' ? 'pickup' : 'web',
    customer: name(bill) || name(ship), contact: phone || email,
    items, gross: amt(o.subtotal), discount: amt(o.discountTotal), shipping: amt(o.shippingTotal),
    sub: r2(total - gst), gst, total, rate: GST_RATE, paid: total,
    web: {
      orderId: o.id, orderNumber: String(o.orderNumber || ''), kind, shipMethod, email, phone,
      billTo: addressLines(bill, false), shipTo: kind === 'delivery' ? addressLines(ship, true) : [],
      notes, discounts: (Array.isArray(o.discountLines) ? o.discountLines : [])
        .map(d => [d.name, d.promoCode && '(' + d.promoCode + ')'].filter(Boolean).join(' ')).filter(Boolean),
      payment: '', paymentState: o.paymentState || '',
    },
  };
  if (kind === 'pickup') { sale.pickupCode = newPickupCode(Date.parse(o.createdOn) || Date.now()); sale.pickupOn = day; }
  return sale;
}

function hasAddress(a) { return !!(a && (a.address1 || a.city || a.postalCode)); }
// The address as Squarespace has it, a line each. The ship-to name and phone
// can differ from the buyer's (a gift), so a delivery address keeps its own.
function addressLines(a, withWho) {
  if (!hasAddress(a)) return [];
  const t = v => String(v || '').trim();
  return [
    withWho ? [t(a.firstName), t(a.lastName)].filter(Boolean).join(' ') : '',
    t(a.address1), t(a.address2),
    [t(a.city), t(a.state), t(a.postalCode)].filter(Boolean).join(' '),
    t(a.countryCode), withWho ? t(a.phone) : '',
  ].filter(Boolean);
}

/* ---------------- plumbing ---------------- */

function cleanDevice(v) { const s = String(v || '').trim(); return DEVICE_RE.test(s) ? s : ''; }

const dayFmt = (() => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.STORE_TZ || 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch (e) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }); }
})();
function localDay(iso) {
  const t = Date.parse(iso);
  return isFinite(t) ? dayFmt.format(new Date(t)) : '';
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/Squarespace (401|403)/.test(m)) return 'Squarespace won’t share orders with this key. Give SQUARESPACE_API_KEY the Orders permission (Squarespace → Settings → Developer API Keys).';
  return m;
}

async function getWithEtag(st, key) {
  try {
    const r = await st.getWithMetadata(key, { type: 'json' });
    return r ? { data: r.data, etag: r.etag || null } : { data: null, etag: null };
  } catch (e) { return { data: null, etag: null }; }
}
function amt(v) { const n = Number(v && typeof v === 'object' ? v.value : v); return isFinite(n) ? n : 0; }
function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
