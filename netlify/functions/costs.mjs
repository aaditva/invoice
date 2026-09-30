/* ------------------------------------------------------------------ *
 *  Netlify Function — cost prices & brands for Admin → Insights
 * ------------------------------------------------------------------ *
 *  The Google Sheet is where cost prices are typed (Products tab). The
 *  sheet script pushes that list here every few minutes, and straight away
 *  whenever a Cost or Brand cell is edited, so the Admin → Insights charts
 *  can work out profit. The till never reads this — cost prices are not
 *  shown at the counter or printed anywhere.
 *
 *  Costs can also be typed on the website (Admin → 🏷️ No cost) for things
 *  sold with no cost yet. Those are kept apart from the sheet's list (so the
 *  sheet's next push can't wipe them):
 *    - products, by barcode — used until the sheet has a cost of its own.
 *      The sheet script copies them into its Cost column, then clears them here.
 *    - Miscellaneous lines, by "<invoice no>#<line>" — these have no barcode,
 *      so each one sold gets its own cost. They stay here.
 *
 *  Routes (all on /api/costs):
 *    GET  /api/costs     → { updated, count, items:{ <barcode>:{ cost, brand, name, src? } },
 *                            manual:{ <barcode>:{ cost, name, at } }, misc:{ <no#line>:{ cost, at } } }
 *                          items already has the website's costs filled in (src:'site').
 *    POST /api/costs     body = { items:[{ sku, cost, brand, name }] } — replaces the sheet's list
 *    POST /api/costs     body = { set:[{ sku, cost, name } | { misc, cost }] } — website edits;
 *                          cost '' or null removes the entry
 *    POST /api/costs     body = { clear:[<barcode>, …] } — the sheet has these now
 *
 *  Env vars:
 *    SALES_TOKEN   optional; if set, every request needs a matching x-sales-token
 *    ADMIN_PIN     optional but recommended; if set, GET and POST both need a
 *                  matching x-admin-pin, so cost prices can't be read without it
 *    ALLOW_ORIGIN  optional, locks CORS to your site URL
 * ------------------------------------------------------------------ */

import { getStore } from '@netlify/blobs';

const KEY = 'costs';
const MANUAL = 'manual';
const MAX = 20000;
const MISC_RE = /^[^#]{1,80}#\d{1,4}$/;

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
      const items = { ...(saved && saved.items && typeof saved.items === 'object' ? saved.items : {}) };
      const man = await readManual(st);
      // A website cost fills in until the sheet has one of its own.
      const byNorm = new Map(Object.keys(items).map(k => [norm(k), k]));
      for (const [sku, m] of Object.entries(man.items)) {
        const k = byNorm.get(sku);
        if (k === undefined) items[sku] = { cost: m.cost, brand: '', name: m.name || '', src: 'site' };
        else if (items[k].cost === null || items[k].cost === undefined) items[k] = { ...items[k], cost: m.cost, src: 'site' };
      }
      return json({ updated: (saved && saved.updated) || null, count: Object.keys(items).length, items,
        manual: man.items, misc: man.misc }, 200, headers);
    }
    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: 'Body must be JSON.' }, 400, headers); }
      if (body && (Array.isArray(body.set) || Array.isArray(body.clear))) return await editManual(st, body, headers);
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

async function readManual(st) {
  const v = await st.get(MANUAL, { type: 'json' }).catch(() => null);
  return {
    items: v && v.items && typeof v.items === 'object' ? v.items : {},
    misc: v && v.misc && typeof v.misc === 'object' ? v.misc : {},
  };
}

async function editManual(st, body, headers) {
  const man = await readManual(st);
  const at = new Date().toISOString();
  let changed = 0;
  for (const r of (body.set || []).slice(0, 500)) {
    if (!r || typeof r !== 'object') continue;
    const c = r.cost === '' || r.cost === null || r.cost === undefined ? null : Number(r.cost);
    if (c !== null && !(isFinite(c) && c >= 0 && c < 1e6)) return json({ error: 'Cost must be a number, 0 or more.' }, 400, headers);
    const cost = c === null ? null : Math.round(c * 100) / 100;
    if (r.misc !== undefined) {
      const k = String(r.misc).trim();
      if (!MISC_RE.test(k)) return json({ error: 'Bad misc line id.' }, 400, headers);
      if (cost === null) delete man.misc[k]; else man.misc[k] = { cost, at };
    } else {
      const k = norm(r.sku);
      if (!k || k.length > 64) return json({ error: 'Bad barcode.' }, 400, headers);
      if (cost === null) delete man.items[k];
      else man.items[k] = { cost, name: String(r.name || '').trim().slice(0, 200), at };
    }
    changed++;
  }
  for (const sku of (body.clear || []).slice(0, MAX)) { if (man.items[norm(sku)]) { delete man.items[norm(sku)]; changed++; } }
  await st.setJSON(MANUAL, { ...man, updated: at });
  return json({ ok: true, changed, manual: man.items, misc: man.misc }, 200, headers);
}

// Barcodes are matched the way the till matches them: trimmed, upper-case, no spaces.
function norm(v) { return String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, ''); }

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}
