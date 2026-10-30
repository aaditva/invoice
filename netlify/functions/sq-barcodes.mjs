/* ------------------------------------------------------------------ *
 *  Netlify Function — put a scanned barcode on a Squarespace product
 * ------------------------------------------------------------------ *
 *  A product added in Squarespace gets a made-up SKU (SQ1234567) until its
 *  real barcode is typed in. Admin → 🏷️ Barcodes → Squarespace lists every
 *  variant (the SQ ones first) and scans the box's barcode with the phone's
 *  camera; this function writes it to the variant's SKU, and to its GTIN when
 *  it's a real shop barcode (8, 12, 13 or 14 digits with a valid check digit),
 *  so the till can scan it and Google Shopping knows the product.
 *
 *  Routes (both on /api/sq-barcodes):
 *    GET  → { items:[{ productId, variantId, name, sku, gtin, physical, image, createdOn }] }
 *    POST body = { productId, variantId, sku, gtin?, oldSku? } → { ok, item }
 *         gtin: a string sets it, omitted leaves it as it is. oldSku: the code
 *         it replaces, dropped from the catalog's memory (see forget()).
 *
 *  Env vars:
 *    SQUARESPACE_API_KEY   needs **Products: Read/Write** permission
 *    SALES_TOKEN           optional; if set, every request needs a matching x-sales-token
 *    ADMIN_PIN             optional; if set, every request also needs a matching x-admin-pin
 *    ALLOW_ORIGIN          optional, locks CORS to your site URL
 * ------------------------------------------------------------------ */

import { getStore } from '@netlify/blobs';
import { corsHeaders, preflight, json } from '../lib/http.mjs';
import { auth, adminOk } from '../lib/devices.mjs';
import { norm } from '../lib/labels.mjs';

const SQ = 'https://api.squarespace.com';
const UA = 'StoreTill/1.0 (+barcodes)';

export default async (req) => {
  const headers = corsHeaders('GET, POST');
  if (req.method === 'OPTIONS') return preflight(headers);
  const who = await auth(req);
  if (!who.ok) return json({ error: who.error, code: who.code }, 401, headers);
  if (!adminOk(req, who)) return json({ error: 'Admin password required.' }, 401, headers);

  const key = process.env.SQUARESPACE_API_KEY;
  if (!key) return json({ error: 'SQUARESPACE_API_KEY is not set.' }, 500, headers);

  try {
    if (req.method === 'GET') return json({ items: flatten(await allProducts(key)) }, 200, headers);
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, headers);

    let body;
    try { body = await req.json(); } catch (e) { return json({ error: 'Body must be JSON.' }, 400, headers); }
    const productId = String((body && body.productId) || '').trim();
    const variantId = String((body && body.variantId) || '').trim();
    const sku = String((body && body.sku) || '').trim();
    const gtin = body && body.gtin != null && body.gtin !== '' ? String(body.gtin).replace(/[\s_-]/g, '') : null;
    if (!productId || !variantId) return json({ error: 'Which product? (productId and variantId)' }, 400, headers);
    if (!sku || sku.length > 60) return json({ error: 'The barcode must be 1 to 60 characters.' }, 400, headers);
    if (gtin !== null && !validGtin(gtin)) return json({ error: 'Not a valid GTIN: ' + gtin }, 400, headers);

    // Plain strings: the API rejects the { present, value } wrappers its docs show.
    const change = { sku };
    if (gtin !== null) change.gtin = gtin;
    const url = `${SQ}/v2/commerce/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(variantId)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(change),
    });
    const text = await r.text();
    if (!r.ok) {
      console.log(`Squarespace refused ${variantId}: ${r.status} ${text.slice(0, 500)}`);
      const why = r.status === 409 ? 'Another product in Squarespace already has that SKU.'
        : r.status === 401 || r.status === 403 ? `Squarespace ${r.status}: the key needs the Products: Read/Write permission. (${text.slice(0, 160)})`
        : `Squarespace ${r.status}: ${text.slice(0, 300)}`;
      return json({ error: why }, r.status === 409 ? 409 : 502, headers);
    }
    let v = {};
    try { v = text ? JSON.parse(text) : {}; } catch (e) { /* an empty body still means it saved */ }
    const oldSku = String((body && body.oldSku) || '').trim();
    if (oldSku && norm(oldSku) !== norm(sku)) await forget(oldSku);
    return json({ ok: true, item: { productId, variantId, sku: v.sku || sku, gtin: v.gtin != null ? v.gtin : gtin } }, 200, headers);
  } catch (e) {
    console.log('sq-barcodes failed: ' + ((e && e.stack) || e));
    return json({ error: String((e && e.message) || e) }, 502, headers);
  }
};

export const config = { path: '/api/sq-barcodes' };

// Every product, trying the newer API first (it carries gtin).
async function allProducts(key) {
  let lastErr;
  for (const v of ['v2', '1.0']) {
    try { return await pageThrough(key, v); } catch (e) {
      lastErr = e;
      if (!/(^|\D)404(\D|$)/.test(String(e && e.message))) throw e;
    }
  }
  throw lastErr || new Error('Could not reach the Squarespace Products API.');
}

async function pageThrough(key, version) {
  const base = `${SQ}/${version}/commerce/products`;
  let url = base, guard = 0;
  const all = [];
  while (url && guard++ < 200) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA, Accept: 'application/json' } });
    if (r.status === 404) throw new Error('404 not found for version ' + version);
    if (!r.ok) throw new Error(`Squarespace API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    if (Array.isArray(d.products)) all.push(...d.products);
    const p = d.pagination;
    url = p && p.hasNextPage && p.nextPageCursor ? `${base}?cursor=${encodeURIComponent(p.nextPageCursor)}` : null;
  }
  return all;
}

function flatten(products) {
  const items = [];
  for (const p of products) {
    const pname = p.name || p.title || 'Item';
    const pimg = Array.isArray(p.images) && p.images[0] && p.images[0].url;
    for (const v of (Array.isArray(p.variants) ? p.variants : [])) {
      if (!p.id || !v.id) continue;
      const attrs = v.attributes ? Object.values(v.attributes).filter(Boolean).join(' / ') : '';
      items.push({
        productId: p.id, variantId: v.id,
        name: attrs ? `${pname} (${attrs})` : pname,
        sku: String(v.sku || '').trim(),
        gtin: v.gtin ? String(v.gtin) : '',
        physical: !p.type || String(p.type).toUpperCase() === 'PHYSICAL',   // only physical products take a GTIN
        image: (v.image && v.image.url) || pimg || '',
        createdOn: p.createdOn || p.modifiedOn || '',
      });
    }
  }
  return items;
}

// 8, 12, 13 or 14 digits whose last is the GS1 check digit.
function validGtin(g) {
  if (!/^(\d{8}|\d{12,14})$/.test(g)) return false;
  let sum = 0;
  for (let i = g.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(g[i]) * w;
  return (10 - sum % 10) % 10 === Number(g[g.length - 1]);
}

// The catalog remembers every SKU it has seen so a deleted product still scans
// (catalog.js). The old SQ… code wasn't deleted, it was replaced, so drop it
// rather than have it come back as a "removed" twin of the same product.
async function forget(oldSku) {
  try {
    const st = getStore({ name: 'catalog', consistency: 'strong' });
    const seen = await st.get('seen', { type: 'json' }).catch(() => null);
    const k = norm(oldSku);
    if (seen && seen[k]) { delete seen[k]; await st.setJSON('seen', seen); }
  } catch (e) { console.log('Old SKU not forgotten: ' + ((e && e.message) || e)); }
}
