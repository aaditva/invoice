/* ------------------------------------------------------------------ *
 *  Netlify Function — inventory write-back to Squarespace
 * ------------------------------------------------------------------ *
 *  When a sale is finalised, the till POSTs the sold lines here and this
 *  function DECREMENTS the matching Squarespace stock, so the quantity on
 *  remactables.com drops too. The secret key stays server-side (env var);
 *  it is never sent to the browser.
 *
 *  Route:  POST /api/inventory
 *    body = { invoiceNo, items:[{ variantId, sku, quantity }] }
 *    - variantId is preferred (comes straight from /api/catalog).
 *    - if only a sku is given, it's resolved to a variantId via the
 *      Inventory API, so a Google-Sheet till can still drop stock as long
 *      as the sheet's barcode/sku matches the Squarespace variant SKU.
 *
 *  Env vars (Site configuration → Environment variables):
 *    SQUARESPACE_API_KEY   key with **Inventory Read/Write** permission
 *                          (the same key can also keep Products Read for /api/catalog)
 *    SALES_TOKEN           optional shared secret (same one the sales log uses);
 *                          if set, the till must send a matching x-sales-token
 *    ALLOW_ORIGIN          optional, locks CORS to your site URL
 * ------------------------------------------------------------------ */

import { corsHeaders, preflight, json } from '../lib/http.mjs';
import { auth } from '../lib/devices.mjs';
import { takeLabelLines } from '../lib/labels.mjs';

const SQ = 'https://api.squarespace.com/1.0/commerce';
const UA = 'StoreTill/1.0 (+inventory)';

export default async (req) => {
  const headers = corsHeaders('POST');
  if (req.method === 'OPTIONS') return preflight(headers);
  const who = await auth(req);
  if (!who.ok) return json({ error: who.error, code: who.code }, 401, headers);
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);

  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400, headers); }

  // Merge duplicate lines and drop non-positive quantities. `items` follow `mode`
  // (decrement by default); `increments` always go up — an "Open box" sends the box
  // in `items` and its single packs in `increments`, so both land in one adjustment.
  let lines = mergeLines(body && body.items);
  let ups = mergeLines(body && body.increments);
  if (!lines.length && !ups.length) return json({ ok: true, adjusted: [], note: 'nothing to adjust' }, 200, headers);

  // Products given a barcode in Admin → 🏷️ Barcodes aren't in Squarespace: their
  // stock is kept on the site, so move it here and send Squarespace the rest.
  let own = [];
  try {
    const dir = (body && body.mode) === 'increment' ? 1 : -1;
    const idemKey = body && body.idemKey ? String(body.idemKey) + '|' + (dir > 0 ? 'up' : 'down') : '';
    const t = await takeLabelLines(lines, ups, dir, idemKey);
    lines = t.lines; ups = t.ups; own = t.inventory;
  } catch (e) {
    return json({ error: 'Could not update stock for barcodes made here: ' + ((e && e.message) || e) }, 500, headers);
  }
  if (!lines.length && !ups.length) return json({ ok: true, adjusted: [], unresolved: [], inventory: own }, 200, headers);

  const key = process.env.SQUARESPACE_API_KEY;
  if (!key) return json({ error: 'SQUARESPACE_API_KEY is not set.' }, 500, headers);

  try {
    // Resolve sku-only lines → variantId via the Inventory API.
    const needSku = [...lines, ...ups].filter(l => !l.variantId && l.sku);
    if (needSku.length) {
      const map = await skuToVariant(key);                 // { SKU(uppercase): variantId }
      for (const l of needSku) { const v = map[l.sku.toUpperCase()]; if (v) l.variantId = v; }
    }

    const toOps = ls => ls.filter(l => l.variantId).map(l => ({ variantId: l.variantId, quantity: l.quantity }));
    const ops = toOps(lines), upOps = toOps(ups);
    const unresolved = [...lines, ...ups].filter(l => !l.variantId).map(l => l.sku);
    // A box opening is all-or-nothing: never drop the box without adding its packs.
    if (ups.length && unresolved.length) return json({ error: 'Not found in Squarespace: ' + unresolved.join(', '), unresolved }, 404, headers);
    if (!ops.length && !upOps.length) return json({ ok: true, adjusted: [], unresolved, inventory: own }, 200, headers);

    // Idempotency-Key must be UNIQUE per sale (else Squarespace silently skips a "seen" key —
    // invoice numbers repeat over time) yet STABLE for retries (so an offline resync can't
    // double-deduct). The till sends idemKey = invoiceNo + '|' + sale timestamp, which is both.
    // Squarespace restricts this header to [a-zA-Z0-9-_], so sanitize (the till's key has ':'/'.' from the timestamp).
    const idem = ('till-' + String((body && body.idemKey) || (body && body.invoiceNo) || [...ops, ...upOps].map(o => o.variantId).join('-')))
      .replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 240);
    // mode:'increment' PUTS stock back (a void/refund); default decrements (a sale).
    const opKey = (body && body.mode) === 'increment' ? 'incrementOperations' : 'decrementOperations';
    const payload = {};
    if (ops.length) payload[opKey] = ops;
    if (upOps.length) payload.incrementOperations = (payload.incrementOperations || []).concat(upOps);
    const r = await fetch(`${SQ}/inventory/adjustments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Idempotency-Key': idem,
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    if (!r.ok) return json({ error: `Squarespace ${r.status}: ${text.slice(0, 300)}`, ops }, 502, headers);
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { /* empty/opaque body is fine */ }
    const inventory = Array.isArray(data.inventory) ? data.inventory : (Array.isArray(data) ? data : []);
    return json({ ok: true, adjusted: ops, increased: upOps, unresolved, inventory: inventory.concat(own) }, 200, headers);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502, headers);
  }
};

function mergeLines(list) {
  const wanted = new Map();  // key = variantId  OR  'sku:' + SKU
  for (const it of (Array.isArray(list) ? list : [])) {
    const qty = Math.round(Number(it && it.quantity) || 0);
    if (qty <= 0) continue;
    const vid = it.variantId ? String(it.variantId) : '';
    const sku = it.sku ? String(it.sku).trim() : '';
    if (!vid && !sku) continue;
    const k = vid || ('sku:' + sku.toUpperCase());
    const prev = wanted.get(k) || { variantId: vid, sku, quantity: 0 };
    prev.quantity += qty;
    wanted.set(k, prev);
  }
  return [...wanted.values()];
}

// Build a { SKU(uppercase): variantId } map from the Inventory API (paginated).
async function skuToVariant(key) {
  const map = {};
  let url = `${SQ}/inventory`;
  let guard = 0;
  while (url && guard++ < 100) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Inventory read ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const d = await r.json();
    for (const it of (Array.isArray(d.inventory) ? d.inventory : [])) {
      if (it && it.sku && it.variantId) map[String(it.sku).toUpperCase()] = it.variantId;
    }
    const p = d.pagination;
    url = p && p.hasNextPage && p.nextPageCursor ? `${SQ}/inventory?cursor=${encodeURIComponent(p.nextPageCursor)}` : null;
  }
  return map;
}

export const config = { path: '/api/inventory' };
