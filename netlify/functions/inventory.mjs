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

const SQ = 'https://api.squarespace.com/1.0/commerce';
const UA = 'StoreTill/1.0 (+inventory)';

export default async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': process.env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-sales-token',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('{}', { status: 200, headers });  // non-empty body: Netlify's lambda decoder 502s on an empty 204

  const need = process.env.SALES_TOKEN;
  if (need && req.headers.get('x-sales-token') !== need) return json({ error: 'Unauthorized' }, 401, headers);
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);

  const key = process.env.SQUARESPACE_API_KEY;
  if (!key) return json({ error: 'SQUARESPACE_API_KEY is not set.' }, 500, headers);

  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400, headers); }

  // Merge duplicate lines and drop non-positive quantities.
  const wanted = new Map();  // key = variantId  OR  'sku:' + SKU
  for (const it of (Array.isArray(body && body.items) ? body.items : [])) {
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
  const lines = [...wanted.values()];
  if (!lines.length) return json({ ok: true, adjusted: [], note: 'nothing to adjust' }, 200, headers);

  try {
    // Resolve sku-only lines → variantId via the Inventory API.
    const needSku = lines.filter(l => !l.variantId && l.sku);
    if (needSku.length) {
      const map = await skuToVariant(key);                 // { SKU(uppercase): variantId }
      for (const l of needSku) { const v = map[l.sku.toUpperCase()]; if (v) l.variantId = v; }
    }

    const ops = lines.filter(l => l.variantId).map(l => ({ variantId: l.variantId, quantity: l.quantity }));
    const unresolved = lines.filter(l => !l.variantId).map(l => l.sku);
    if (!ops.length) return json({ ok: true, adjusted: [], unresolved }, 200, headers);

    // Idempotency-Key = the invoice number, so an offline resync can't double-deduct.
    const idem = 'till-' + String((body && body.invoiceNo) || ops.map(o => o.variantId).join('-')).slice(0, 240);
    const r = await fetch(`${SQ}/inventory/adjustments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Idempotency-Key': idem,
      },
      body: JSON.stringify({ decrementOperations: ops }),
    });
    const text = await r.text();
    if (!r.ok) return json({ error: `Squarespace ${r.status}: ${text.slice(0, 300)}`, ops }, 502, headers);
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { /* empty/opaque body is fine */ }
    const inventory = Array.isArray(data.inventory) ? data.inventory : (Array.isArray(data) ? data : []);
    return json({ ok: true, adjusted: ops, unresolved, inventory }, 200, headers);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502, headers);
  }
};

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

function json(obj, status, headers) { return new Response(JSON.stringify(obj), { status, headers }); }

export const config = { path: '/api/inventory' };
