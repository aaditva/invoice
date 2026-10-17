/* Shared by the Netlify functions: CORS headers, JSON replies, and the
   x-sales-token / x-admin-pin checks (lib/devices.mjs builds on these) (compared without leaking timing). */

import { createHash, timingSafeEqual } from 'node:crypto';

export function corsHeaders(methods) {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': methods + ', OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-sales-token, x-admin-pin, x-device-key',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  };
}

// Non-empty body: Netlify's lambda decoder 502s on an empty 204.
export function preflight(headers) { return new Response('{}', { status: 200, headers }); }

export function json(obj, status, headers) { return new Response(JSON.stringify(obj), { status, headers }); }

export function same(a, b) {
  const h = s => createHash('sha256').update(String(s)).digest();
  return timingSafeEqual(h(a), h(b));
}

// SALES_TOKEN is optional: when set, every request must carry it.
export function tokenOk(req) {
  const want = process.env.SALES_TOKEN;
  return !want || same(req.headers.get('x-sales-token') || '', want);
}

// ADMIN_PIN is optional here (admin.mjs insists on it): when set, the request must carry it.
export function pinOk(req) {
  const want = process.env.ADMIN_PIN;
  return !want || same(req.headers.get('x-admin-pin') || '', want);
}
