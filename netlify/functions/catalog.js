/* ------------------------------------------------------------------ *
 *  Netlify Function — read-only Squarespace catalog proxy
 * ------------------------------------------------------------------ *
 *  Lets you host the WHOLE thing on one public Netlify site: the till
 *  (index.html) is static, and this function holds the SECRET key in an
 *  environment variable so it is NEVER sent to the browser.
 *
 *  DEPLOY:
 *    1. Push this folder to GitHub, then netlify.com → Add new site → import it.
 *       (netlify.toml already points the app at this function.)
 *    2. Site → Site configuration → Environment variables:
 *         SQUARESPACE_API_KEY = your Squarespace API key
 *         (optional) ALLOW_ORIGIN = your Netlify site URL
 *    3. Your endpoint is  https://<your-site>.netlify.app/api/catalog
 *       Put that in the till's Settings → "Catalog proxy URL".
 *  Netlify runs Node 18+, which provides global fetch.
 * ------------------------------------------------------------------ */

const API_VERSIONS = ['1.0', 'v2', 'v1', '1.1'];

exports.handler = async function (event) {
  const origin = process.env.ALLOW_ORIGIN || '*';
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const key = process.env.SQUARESPACE_API_KEY;
  if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'SQUARESPACE_API_KEY is not set.' }) };

  try {
    const products = await fetchAllProducts(key);
    const items = flatten(products);
    return { statusCode: 200, headers, body: JSON.stringify({ count: items.length, syncedAt: new Date().toISOString(), items }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};

async function fetchAllProducts(key) {
  let lastErr;
  for (const v of API_VERSIONS) {
    try {
      return await pageThrough(key, v);
    } catch (e) {
      lastErr = e;
      if (!/(^|\D)404(\D|$)/.test(String(e && e.message))) throw e;
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
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        'User-Agent': 'StoreTill/1.0 (+invoicing)',
        Accept: 'application/json',
      },
    });
    if (r.status === 404) throw new Error('404 not found for version ' + version);
    if (!r.ok) throw new Error(`Squarespace API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
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
      if (!sku) continue;
      const attrs = v.attributes ? Object.values(v.attributes).filter(Boolean).join(' / ') : '';
      const name = attrs ? `${pname} (${attrs})` : pname;
      const bp = v.pricing && v.pricing.basePrice;
      const price = bp ? Number(bp.value) || 0 : 0;
      const currency = (bp && bp.currency) || 'AUD';
      const stock = v.stock && v.stock.unlimited ? null : (v.stock ? (v.stock.quantity ?? null) : null);
      const variantId = v.id || v.variantId || null;   // Inventory API keys stock adjustments off this
      items.push({ sku, name, price, currency, stock, variantId });
    }
  }
  return items;
}
