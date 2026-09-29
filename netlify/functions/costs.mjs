/* ------------------------------------------------------------------ *
 *  Netlify Function — cost prices & brands for Admin → Insights
 * ------------------------------------------------------------------ *
 *  The Google Sheet is where cost prices are typed (Products tab). The
 *  sheet script pushes that list here every few minutes, and straight away
 *  whenever a Cost or Brand cell is edited, so the Admin → Insights charts
 *  can work out profit. The till never reads this — cost prices are not
 *  shown at the counter or printed anywhere.
 *
 *  Routes (all on /api/costs):
 *    GET  /api/costs     → { updated, count, items:{ <barcode>:{ cost, brand, name } } }
 *    POST /api/costs     body = { items:[{ sku, cost, brand, name }] } — replaces the list
 *
 *  Env vars:
 *    SALES_TOKEN   optional; if set, every request needs a matching x-sales-token
 *    ADMIN_PIN     optional but recommended; if set, GET and POST both need a
 *                  matching x-admin-pin, so cost prices can't be read without it
 *    ALLOW_ORIGIN  optional, locks CORS to your site URL
 * ------------------------------------------------------------------ */

import { getStore } from '@netlify/blobs';

const KEY = 'costs';
const MAX = 20000;

export default async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': process.env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-sales-token, x-admin-pin',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('{}', { status: 200, headers });

  const tok = process.env.SALES_TOKEN;
  if (tok && req.headers.get('x-sales-token') !== tok) return json({ error: 'Bad or missing x-sales-token.' }, 401, headers);
  const pin = process.env.ADMIN_PIN;
  if (pin && req.headers.get('x-admin-pin') !== pin) return json({ error: 'Admin password required.' }, 401, headers);

  const st = getStore({ name: 'costs', consistency: 'strong' });
  try {
    if (req.method === 'GET') {
      const saved = await st.get(KEY, { type: 'json' }).catch(() => null);
      const items = saved && saved.items && typeof saved.items === 'object' ? saved.items : {};
      return json({ updated: (saved && saved.updated) || null, count: Object.keys(items).length, items }, 200, headers);
    }
    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: 'Body must be JSON.' }, 400, headers); }
      if (!body || !Array.isArray(body.items)) return json({ error: 'Body must be { items:[{ sku, cost, brand }] }.' }, 400, headers);
      const items = {};
      for (const r of body.items.slice(0, MAX)) {
        const sku = String((r && r.sku) || '').trim();
        if (!sku || sku.length > 64) continue;
        const c = r.cost === '' || r.cost === null || r.cost === undefined ? null : Number(r.cost);
        items[sku] = {
          cost: c !== null && isFinite(c) && c >= 0 ? Math.round(c * 100) / 100 : null,
          brand: String(r.brand || '').trim().slice(0, 60),
          name: String(r.name || '').trim().slice(0, 200),
        };
      }
      const updated = new Date().toISOString();
      await st.setJSON(KEY, { items, updated });
      return json({ ok: true, count: Object.keys(items).length, updated }, 200, headers);
    }
    return json({ error: 'Method not allowed.' }, 405, headers);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500, headers);
  }
};

export const config = { path: '/api/costs' };

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}
