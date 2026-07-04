/* ------------------------------------------------------------------ *
 *  Cloudflare Worker — read-only Squarespace catalog proxy
 * ------------------------------------------------------------------ *
 *  Holds your SECRET Squarespace API key so the till app never sees it.
 *  Returns a slim JSON list: { count, syncedAt, items:[{sku,name,price,currency,stock}] }
 *
 *  DEPLOY (no command line needed):
 *    1. dash.cloudflare.com → Workers & Pages → Create → Worker.
 *    2. Replace the code with this file, click Deploy.
 *    3. Worker → Settings → Variables → add a SECRET named
 *         SQUARESPACE_API_KEY   (paste your Squarespace API key).
 *       (Optional) ALLOW_ORIGIN = your till app's URL to lock down CORS.
 *    4. Copy the worker URL (…​.workers.dev) into the till app's
 *       Settings → "Catalog proxy URL".
 * ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const key = env.SQUARESPACE_API_KEY;
    if (!key) return json({ error: 'SQUARESPACE_API_KEY is not set on this Worker.' }, 500, cors);

    try {
      const products = await fetchAllProducts(key);
      const items = flatten(products);
      return json({ count: items.length, syncedAt: new Date().toISOString(), items }, 200, cors);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502, cors);
    }
  },
};

// Squarespace has renamed its version segment over time (1.0 -> v2).
// Try known versions so a rename never silently breaks the till.
const API_VERSIONS = ['1.0', 'v2', 'v1', '1.1'];

async function fetchAllProducts(key) {
  let lastErr;
  for (const v of API_VERSIONS) {
    try {
      return await pageThrough(key, v);
    } catch (e) {
      lastErr = e;
      if (!/(^|\D)404(\D|$)/.test(String(e && e.message))) throw e; // only fall through on "not found"
    }
  }
  throw lastErr || new Error('Could not reach the Squarespace Products API.');
}

async function pageThrough(key, version) {
  const base = `https://api.squarespace.com/${version}/commerce/products`;
  let url = base;
  const all = [];
  let guard = 0;
  while (url && guard++ < 200) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        'User-Agent': 'StoreTill/1.0 (+invoicing)',
        Accept: 'application/json',
      },
    });
    if (res.status === 404) throw new Error('404 not found for version ' + version);
    if (!res.ok) throw new Error(`Squarespace API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    if (Array.isArray(data.products)) all.push(...data.products);
    const p = data.pagination;
    url = p && p.hasNextPage && p.nextPageCursor
      ? `${base}?cursor=${encodeURIComponent(p.nextPageCursor)}`
      : null;
  }
  return all;
}

function flatten(products) {
  const items = [];
  for (const p of products) {
    const pname = p.name || p.title || 'Item';
    const variants = Array.isArray(p.variants) ? p.variants : [];
    for (const v of variants) {
      const sku = (v.sku || '').trim();
      if (!sku) continue; // no SKU = nothing to scan
      const attrs = v.attributes ? Object.values(v.attributes).filter(Boolean).join(' / ') : '';
      const name = attrs ? `${pname} (${attrs})` : pname;
      const bp = v.pricing && v.pricing.basePrice;
      const price = bp ? Number(bp.value) || 0 : 0;
      const currency = (bp && bp.currency) || 'AUD';
      const stock = v.stock && v.stock.unlimited ? null : (v.stock ? (v.stock.quantity ?? null) : null);
      items.push({ sku, name, price, currency, stock });
    }
  }
  return items;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
