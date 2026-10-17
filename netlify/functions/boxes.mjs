/* ------------------------------------------------------------------ *
 *  Netlify Function — shared box → pack list ("Open box")
 * ------------------------------------------------------------------ *
 *  Which sealed box breaks into which single pack, and how many packs are
 *  in it. Kept in Netlify Blobs so every till reads the same list.
 *
 *  Routes (all on /api/boxes):
 *    GET  /api/boxes            → { boxes:[{ box, pack, packs, name }] }
 *    POST /api/boxes            body = { boxes:[...] } — replaces the list
 *
 *  Env vars:
 *    SALES_TOKEN   optional; if set, every request needs a matching x-sales-token
 *    ADMIN_PIN     optional; if set, POST also needs a matching x-admin-pin
 *                  (the till sends its Admin password)
 *    ALLOW_ORIGIN  optional, locks CORS to your site URL
 *
 *  Until the list is first saved, GET returns SEED — the boxes found in the
 *  product feed, with pack counts checked against the manufacturers' listings.
 * ------------------------------------------------------------------ */

import { getStore } from '@netlify/blobs';
import { corsHeaders, preflight, json } from '../lib/http.mjs';
import { auth, adminOk } from '../lib/devices.mjs';

const KEY = 'boxes';
const MAX = 500;

const SEED = [
  { box: '4521329362342', pack: '4521329362335', packs: 10, name: 'Pokémon Terastal Festival ex (SV8a) JP' },
  { box: '4521329394824', pack: '4521329394817', packs: 10, name: 'Pokémon Shiny Treasure ex (SV4a) JP' },
  { box: '4521329305981', pack: '4521329305974', packs: 10, name: 'Pokémon Shiny Star V (S4a) JP' },
  { box: '4521329373362', pack: '4521329373355', packs: 10, name: 'Pokémon VSTAR Universe (S12a) JP' },
  { box: '4521329346038', pack: '4521329346045', packs: 20, name: 'Pokémon 151 (SV2a) JP' },
  { box: '4521329462233', pack: '4521329462226', packs: 30, name: 'Pokémon Storm Emeralda (M6) JP' },
  { box: '196214157514',  pack: '196214157507',  packs: 36, name: 'Pokémon Pitch Black (ME05)' },
  { box: '850077307348',  pack: '850077307331',  packs: 36, name: 'AFL Footy Stars 2026' },
  { box: '744517006024',  pack: '744517006000',  packs: 36, name: 'AFL Teamcoach 2026' },
];

export default async (req) => {
  const headers = corsHeaders('GET, POST');
  if (req.method === 'OPTIONS') return preflight(headers);

  const who = await auth(req);
  if (!who.ok) return json({ error: who.error, code: who.code }, 401, headers);

  const st = getStore({ name: 'boxes', consistency: 'strong' });
  try {
    if (req.method === 'GET') {
      const saved = await st.get(KEY, { type: 'json' }).catch(() => null);
      return json({ boxes: saved && Array.isArray(saved.boxes) ? saved.boxes : SEED, seeded: !saved }, 200, headers);
    }
    if (req.method === 'POST') {
      if (!adminOk(req, who)) return json({ error: 'Admin password required.' }, 401, headers);
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: 'Body must be JSON.' }, 400, headers); }
      const boxes = clean(body && body.boxes);
      if (!boxes) return json({ error: 'Body must be { boxes:[{ box, pack, packs }] }.' }, 400, headers);
      await st.setJSON(KEY, { boxes, savedAt: new Date().toISOString() });
      return json({ ok: true, boxes }, 200, headers);
    }
    return json({ error: 'Method not allowed.' }, 405, headers);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500, headers);
  }
};

// Keep only well-formed rows; one row per box barcode.
function clean(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Map();
  for (const r of list.slice(0, MAX)) {
    const box = String((r && r.box) || '').trim();
    const pack = String((r && r.pack) || '').trim();
    const packs = Math.round(Number(r && r.packs) || 0);
    if (!box || !pack || box === pack || packs < 1 || packs > 1000) continue;
    seen.set(box.toUpperCase(), { box, pack, packs, name: String((r && r.name) || '').slice(0, 120) });
  }
  return [...seen.values()];
}

export const config = { path: '/api/boxes' };
