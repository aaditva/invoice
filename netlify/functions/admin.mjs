/* ------------------------------------------------------------------ *
 *  Netlify Function — Admin login check
 * ------------------------------------------------------------------ *
 *  The till's Admin password is no longer in index.html (anyone can read a
 *  public page's source). The till sends what was typed here; this compares it
 *  with the ADMIN_PIN env var and says yes or no. The till then keeps the
 *  password on that device and sends it as x-admin-pin, which /api/boxes,
 *  /api/costs and /api/expenses already check.
 *
 *  Route:
 *    POST /api/admin   header x-admin-pin   → { ok:true } | 401 | 503
 *
 *  Env vars:
 *    ADMIN_PIN     required — the Admin password. Without it nobody can log in.
 *    SALES_TOKEN   optional; if set, the request needs a matching x-sales-token
 *    ALLOW_ORIGIN  optional, locks CORS to your site URL (default *)
 * ------------------------------------------------------------------ */

import { createHash, timingSafeEqual } from 'node:crypto';

export default async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': process.env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-sales-token, x-admin-pin',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('{}', { status: 200, headers });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, headers);

  const tok = process.env.SALES_TOKEN;
  if (tok && req.headers.get('x-sales-token') !== tok) return json({ error: 'Bad or missing x-sales-token.' }, 401, headers);

  const pin = process.env.ADMIN_PIN;
  if (!pin) {
    return json({ error: 'No Admin password is set on the site. Netlify → Site configuration → Environment variables → add ADMIN_PIN, then redeploy.' }, 503, headers);
  }
  if (!same(req.headers.get('x-admin-pin') || '', pin)) {
    await new Promise(r => setTimeout(r, 800));   // slows down guessing
    return json({ error: 'Wrong password' }, 401, headers);
  }
  return json({ ok: true }, 200, headers);
};

export const config = { path: '/api/admin' };

// Compare without leaking how many characters matched.
function same(a, b) {
  const h = s => createHash('sha256').update(String(s)).digest();
  return timingSafeEqual(h(a), h(b));
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}
