/* One cash ledger kept in Netlify Blobs, filed by day and store — the shape
   shared by /api/expenses (cash paid out), /api/money-added (cash put in)
   and /api/misc-sales (miscellaneous sales).
   One blob per entry (<prefix>/<day>/<store>/<id>), so two devices adding at
   once can never clobber each other.

   GET    ?from=YYYY-MM-DD&to=YYYY-MM-DD[&store=ID]   (day=… works as a one-day range)
          → { from, to, days:[{day,store,total,count}], totals:{total,count}, entries:[...] }
   POST   body = { day, store, amount, note?, counts? }  → { ok, entry }
   DELETE ?day=YYYY-MM-DD&store=ID&id=ID */

import { getStore } from '@netlify/blobs';
import { corsHeaders, preflight, json, tokenOk, pinOk } from './http.mjs';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STORE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID_RE = /^[a-z0-9-]{1,40}$/;
const MAX_RANGE_DAYS = 62;

// adminWrites: POST/DELETE also need x-admin-pin (when ADMIN_PIN is set).
export function ledger({ store: storeName, prefix, adminWrites }) {
  return async (req) => {
    const headers = corsHeaders('GET, POST, DELETE');
    if (req.method === 'OPTIONS') return preflight(headers);
    if (!tokenOk(req)) return json({ error: 'Bad or missing x-sales-token.' }, 401, headers);
    if (adminWrites && req.method !== 'GET' && !pinOk(req)) return json({ error: 'Admin password required.' }, 401, headers);

    const st = getStore({ name: storeName, consistency: 'strong' });
    const q = new URL(req.url).searchParams;
    try {
      if (req.method === 'GET') {
        const from = (q.get('from') || q.get('day') || '').trim();
        const to = (q.get('to') || from).trim();
        if (!DAY_RE.test(from) || !DAY_RE.test(to)) return json({ error: 'from/to must be YYYY-MM-DD.' }, 400, headers);
        const days = dayRange(from, to);
        if (!days.length) return json({ error: 'from is after to.' }, 400, headers);
        if (days.length > MAX_RANGE_DAYS) return json({ error: 'The most this can read at once is ' + MAX_RANGE_DAYS + ' days.' }, 400, headers);
        const storeParam = (q.get('store') || '').trim();
        const store = storeParam && storeParam !== 'all' ? storeParam : '';
        if (store && !STORE_RE.test(store)) return json({ error: 'Bad store id.' }, 400, headers);

        const entries = [];
        await Promise.all(days.map(async d => {
          const listed = await st.list({ prefix: prefix + '/' + d + '/' + (store ? store + '/' : '') }).catch(() => null);
          const keys = ((listed && listed.blobs) || []).map(b => b.key);
          const got = await Promise.all(keys.map(k => st.get(k, { type: 'json' }).catch(() => null)));
          for (const e of got) if (e && e.id) entries.push(e);
        }));
        entries.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

        const byKey = new Map();
        let total = 0;
        for (const e of entries) {
          const k = e.day + '|' + e.store;
          const row = byKey.get(k) || { day: e.day, store: e.store, total: 0, count: 0 };
          row.total = r2(row.total + num(e.amount)); row.count++;
          byKey.set(k, row);
          total += num(e.amount);
        }
        const rows = [...byKey.values()].sort((x, y) => x.day.localeCompare(y.day) || x.store.localeCompare(y.store));
        return json({ from: days[0], to: days[days.length - 1], days: rows,
          totals: { total: r2(total), count: entries.length }, entries }, 200, headers);
      }

      if (req.method === 'POST') {
        let b;
        try { b = await req.json(); } catch (e) { return json({ error: 'Body must be JSON.' }, 400, headers); }
        const day = String((b && b.day) || '').trim();
        const store = String((b && b.store) || '').trim();
        const amount = r2(num(b && b.amount));
        if (!DAY_RE.test(day)) return json({ error: 'day must be YYYY-MM-DD.' }, 400, headers);
        if (!STORE_RE.test(store)) return json({ error: 'Bad store id.' }, 400, headers);
        if (!(amount > 0) || amount > 100000) return json({ error: 'Amount must be more than 0.' }, 400, headers);
        const counts = {};
        if (b.counts && typeof b.counts === 'object') {
          for (const [k, v] of Object.entries(b.counts)) {
            const n = Math.round(num(v));
            if (/^\d+(\.\d+)?$/.test(k) && n > 0) counts[k] = n;
          }
        }
        const entry = {
          id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          day, store, amount, counts,
          note: String(b.note || '').trim().slice(0, 200),
          ts: new Date().toISOString(),
        };
        await st.setJSON(prefix + '/' + day + '/' + store + '/' + entry.id, entry);
        return json({ ok: true, entry }, 200, headers);
      }

      if (req.method === 'DELETE') {
        const day = (q.get('day') || '').trim(), store = (q.get('store') || '').trim(), id = (q.get('id') || '').trim();
        if (!DAY_RE.test(day) || !STORE_RE.test(store) || !ID_RE.test(id)) return json({ error: 'Need day, store and id.' }, 400, headers);
        await st.delete(prefix + '/' + day + '/' + store + '/' + id);
        return json({ ok: true }, 200, headers);
      }

      return json({ error: 'Method not allowed.' }, 405, headers);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500, headers);
    }
  };
}

function dayRange(from, to) {
  const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b) || b < a) return [];
  const out = [];
  for (let t = a; t <= b && out.length <= MAX_RANGE_DAYS; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
