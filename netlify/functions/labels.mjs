/* ------------------------------------------------------------------ *
 *  Netlify Function — one-off products with a barcode made here
 * ------------------------------------------------------------------ *
 *  Some things come in with no barcode (a single card, a one-off). Admin →
 *  🏷️ Barcodes types in the name, price, cost and stock; this function gives
 *  it a new barcode and keeps the list in Netlify Blobs, so every till can
 *  scan the printed label. These products live only on the website: they are
 *  not in Squarespace and not in the catalog feed the Google Sheet reads.
 *  The till adds them to its product list after each catalog sync, and
 *  /api/inventory counts their stock down (and back up on a void/refund).
 *  Their cost price is kept with the website's other typed costs (/api/costs),
 *  so Admin → Insights can work out the profit.
 *
 *  Barcodes are 12 digits starting with 2 — the range shops keep for their own
 *  in-store codes, so it can't clash with a maker's barcode — e.g. 290000012345.
 *
 *  Routes (all on /api/labels):
 *    GET  /api/labels   → { items:[{ sku, name, price, stock, at }] }
 *    POST /api/labels   body = { add:{ name, price, stock } }        → { ok, item, items }
 *    POST /api/labels   body = { update:{ sku, name?, price?, stock? } } → { ok, item, items }
 *    POST /api/labels   body = { remove:<sku> }                      → { ok, items }
 *
 *  Env vars:
 *    SALES_TOKEN   optional; if set, every request needs a matching x-sales-token
 *    ADMIN_PIN     optional; if set, POST also needs a matching x-admin-pin
 *    ALLOW_ORIGIN  optional, locks CORS to your site URL
 * ------------------------------------------------------------------ */

import { getStore } from '@netlify/blobs';
import { corsHeaders, preflight, json, tokenOk, pinOk } from '../lib/http.mjs';
import { labelsStore, readLabels, norm } from '../lib/labels.mjs';

const MAX = 5000;

export default async (req) => {
  const headers = corsHeaders('GET, POST');
  if (req.method === 'OPTIONS') return preflight(headers);

  if (!tokenOk(req)) return json({ error: 'Bad or missing x-sales-token.' }, 401, headers);

  const st = labelsStore();
  try {
    if (req.method === 'GET') {
      const d = await readLabels(st);
      return json({ items: d.items }, 200, headers);
    }
    if (req.method === 'POST') {
      if (!pinOk(req)) return json({ error: 'Admin password required.' }, 401, headers);
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: 'Body must be JSON.' }, 400, headers); }
      const d = await readLabels(st);
      let item = null;

      if (body && body.add) {
        if (d.items.length >= MAX) return json({ error: 'Too many products (' + MAX + ').' }, 400, headers);
        const f = fields(body.add, true);
        if (f.error) return json({ error: f.error }, 400, headers);
        const sku = await newCode(d.items);
        item = { sku, ...f.v, at: new Date().toISOString() };
        d.items.unshift(item);
      } else if (body && body.update) {
        item = d.items.find(x => x.sku === norm(body.update.sku));
        if (!item) return json({ error: 'No product with that barcode.' }, 404, headers);
        const f = fields(body.update, false);
        if (f.error) return json({ error: f.error }, 400, headers);
        Object.assign(item, f.v);
      } else if (body && body.remove !== undefined) {
        const k = norm(body.remove);
        d.items = d.items.filter(x => x.sku !== k);
      } else {
        return json({ error: 'Body must be { add } | { update } | { remove }.' }, 400, headers);
      }
      await st.setJSON('items', d);
      return json({ ok: true, item, items: d.items }, 200, headers);
    }
    return json({ error: 'Method not allowed.' }, 405, headers);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500, headers);
  }
};

export const config = { path: '/api/labels' };

// Name/price/stock off a request. need = all of name and price must be there (a new product).
function fields(r, need) {
  const v = {};
  if (need || r.name !== undefined) {
    const name = String(r.name || '').trim().slice(0, 120);
    if (!name) return { error: 'Give it a name.' };
    v.name = name;
  }
  if (need || r.price !== undefined) {
    const p = Number(r.price);
    if (!(isFinite(p) && p >= 0 && p < 1e6) || r.price === '' || r.price === null) return { error: 'Sell price must be a number, 0 or more.' };
    v.price = Math.round(p * 100) / 100;
  }
  if (need || r.stock !== undefined) {
    const s = r.stock === '' || r.stock === null || r.stock === undefined ? 1 : Math.round(Number(r.stock));
    if (!(isFinite(s) && s >= 0 && s < 1e6)) return { error: 'Stock must be a whole number, 0 or more.' };
    v.stock = s;
  }
  return { v };
}

// 2 + 10 digits + a check digit (EAN-style), not already used here or by any
// product the catalog has ever seen.
async function newCode(items) {
  const used = new Set(items.map(x => x.sku));
  try {
    const seen = await getStore({ name: 'catalog', consistency: 'strong' }).get('seen', { type: 'json' });
    Object.keys(seen || {}).forEach(k => used.add(k));
  } catch (e) { /* no catalog memory yet */ }
  for (let i = 0; i < 50; i++) {
    let body = '2';
    for (let j = 0; j < 10; j++) body += Math.floor(Math.random() * 10);
    const code = body + checkDigit(body);
    if (!used.has(code)) return code;
  }
  throw new Error('Could not find a free barcode. Try again.');
}

function checkDigit(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += Number(digits[digits.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}
