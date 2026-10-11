/* ------------------------------------------------------------------ *
 *  Netlify Function — shared sales log (the till's "website memory")
 * ------------------------------------------------------------------ *
 *  Every finalised sale is POSTed here and stored in Netlify Blobs, so the
 *  record lives on the site rather than in one browser's localStorage. Any
 *  till — or the Admin tab — can then read back a store's sales for today or
 *  any earlier day, from any device.
 *
 *  Routes (all on /api/sales):
 *    POST /api/sales                     body = the sale object
 *      Upsert by invoice number. Re-POSTing the same invoice overwrites it,
 *      which is how a void/refund propagates. A *different* sale (other ts)
 *      that arrives with a number already taken is never allowed to overwrite
 *      it: it's filed as <no>-2 (-3…) and the reply's `no` says so, so the
 *      till renames its own copy and every reprint shows the same number.
 *
 *    POST /api/sales?counter=next        body = { store, min? }
 *      → { ok, store, n }   the store's next invoice number, handed out once.
 *      Every device draws from this one sequence, so two tills at the same
 *      store can never print the same number. `min` (the device's own
 *      counter) only ever pushes the sequence up, never back.
 *
 *    POST /api/sales?counter=set         body = { store, next }
 *      → { ok, store, next }   Settings → Next invoice #.
 *
 *    GET  /api/sales?counter=1&store=ID  → { store, next }
 *
 *    GET  /api/sales?pickups=1[&store=ID|all][&days=7]
 *      → { store, open:[sale…], done:[sale…] }   the "Pick up later" orders.
 *      open = not collected yet (any day); done = collected in the last
 *      `days` days. The first read for a store also adopts pick-up orders
 *      rung up before pick-up codes existed (last BACKFILL_DAYS days).
 *
 *    POST /api/sales?pickup=done         body = { store, code, done, day?, by? }
 *      Tick (done:true) or untick (done:false) a pick-up. Writes
 *      pickedUp / pickedUpAt / pickedUpDay / pickedUpBy onto the sale itself,
 *      so every view of that invoice shows it. `day` is the till's local day
 *      it was collected; untick needs the sale's pickedUpDay.
 *
 *    GET  /api/sales?day=YYYY-MM-DD[&store=ID]
 *      → { day, store, sales:[...] }     one day, one store or all stores
 *
 *    GET  /api/sales?from=YYYY-MM-DD&to=YYYY-MM-DD[&store=ID][&include=sales]
 *      → { from, to, stores, days:[{day,store,...agg}], byStore, totals }
 *      Per-day/per-store takings for the Admin tab. include=sales also
 *      returns the raw sales (used by Admin → Export CSV).
 *
 *  Env vars (Site configuration → Environment variables):
 *    SALES_TOKEN    optional shared secret. If set, every request must send a
 *                   matching x-sales-token header. The same token the till's
 *                   Settings → Shared log token holds.
 *    ALLOW_ORIGIN   optional, locks CORS to your site URL (default *).
 *
 *  Storage layout — two kinds of blob:
 *    sale/<day>/<store>/<invoiceNo>   the sale itself. SOURCE OF TRUTH.
 *                                     One blob per sale, so two tills writing
 *                                     at once can never clobber each other.
 *    index/<day>/<store>              { sales:[...], etags:{} } — a read cache
 *                                     so a day costs 2 requests instead of one
 *                                     per sale. Rebuilt automatically from the
 *                                     sale blobs whenever it looks out of date,
 *                                     so a lost index write never hides a sale.
 *    counter/<store>                  { next } — the store's shared invoice
 *                                     counter. Bumped with a compare-and-swap,
 *                                     so two tills asking at once get two numbers.
 *    pickup/<store>/open/<code>       { code, no, day, store, ts } — a pick-up
 *                                     still waiting. Points at the sale blob.
 *    pickup/<store>/done/<day>/<code> the same pointer once collected, filed
 *                                     under the day it was collected so the
 *                                     "recently collected" list stays cheap.
 *    pickupscan/<store>               marker: older pick-ups already adopted.
 * ------------------------------------------------------------------ */

import { getStore } from '@netlify/blobs';
import { corsHeaders, preflight, json, tokenOk } from '../lib/http.mjs';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STORE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const UNASSIGNED = 'unassigned';       // where sales without a store used to be filed (pre-store-selector tills)
const DEFAULT_STORE = 'south-melbourne'; // …they belong to South Melbourne, so that's where they go now
const DEFAULT_STORE_NAME = 'South Melbourne';
const MAX_RANGE_DAYS = 62;             // keeps an Admin range inside the function timeout
const CONCURRENCY = 10;                // parallel blob reads
const INDEX_V = 1;
const PICKUP_RE = /^PU[0-9A-Z]{6,20}$/;  // the code printed as the pick-up barcode
const BACKFILL_DAYS = 45;              // how far back to adopt pick-ups made before codes existed
const MAX_DONE_DAYS = 31;

// Local bookkeeping the till uses to track its own offline queue. It means
// nothing once the sale is on the server, so it doesn't get stored.
const LOCAL_ONLY = ['synced', 'stockAdjusted', 'restocked', 'stockItems'];
// Collected-or-not lives on the server and only changes through ?pickup=done.
// A till re-sending its own copy of a sale (a void) must not undo a tick.
const PICKUP_STATE = ['pickedUp', 'pickedUpAt', 'pickedUpDay', 'pickedUpBy'];

export default async (req) => {
  const headers = corsHeaders('GET, POST');
  if (req.method === 'OPTIONS') return preflight(headers);
  if (!tokenOk(req)) return json({ error: 'Bad or missing x-sales-token.' }, 401, headers);

  try {
    if (req.method === 'POST') return await handlePost(req, headers);
    if (req.method === 'GET') return await handleGet(req, headers);
    return json({ error: 'Method not allowed.' }, 405, headers);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500, headers);
  }
};

export const config = { path: '/api/sales' };

/* ---------------- write ---------------- */

async function handlePost(req, headers) {
  const sp = new URL(req.url).searchParams;
  const counter = sp.get('counter');
  if (counter) return await handleCounter(req, headers, counter);
  if (sp.get('pickup')) return await handlePickupDone(req, headers);

  let sale;
  try { sale = await req.json(); } catch (e) { return json({ error: 'Body must be JSON.' }, 400, headers); }
  if (!sale || typeof sale !== 'object' || Array.isArray(sale)) {
    return json({ error: 'Body must be a sale object.' }, 400, headers);
  }

  const no = String(sale.no == null ? '' : sale.no).trim();
  if (!no) return json({ error: 'Sale is missing an invoice number (no).' }, 400, headers);

  const day = String(sale.day == null ? '' : sale.day).trim();
  if (!DAY_RE.test(day)) return json({ error: 'Sale needs day = YYYY-MM-DD.' }, 400, headers);

  const store = slugStore(sale.store);
  const clean = { ...sale, no, day, store };
  if (store === DEFAULT_STORE && sale.store !== DEFAULT_STORE) clean.storeName = DEFAULT_STORE_NAME; // no store → South Melbourne
  for (const k of LOCAL_ONLY) delete clean[k];
  for (const k of PICKUP_STATE) delete clean[k];
  if (clean.pickupCode != null) {
    clean.pickupCode = String(clean.pickupCode).trim().toUpperCase();
    if (!PICKUP_RE.test(clean.pickupCode)) delete clean.pickupCode;
  }

  const st = blobs();
  // A different sale already holds this number (two tills that counted on their
  // own, or one that was offline): file this one under the next free suffix
  // rather than overwrite it. Same ts = the same sale coming back (a void).
  let finalNo = no;
  let prev = null;
  for (let i = 2; ; i++) {
    const there = await getJSON(st, saleKey(day, store, finalNo));
    if (!there) break;
    if (String(there.ts) === String(clean.ts)) { prev = there; break; }
    if (i > 50) return json({ error: 'Invoice number ' + no + ' is taken.' }, 409, headers);
    finalNo = no + '-' + i;
  }
  clean.no = finalNo;
  if (prev) {
    for (const k of PICKUP_STATE) if (prev[k] !== undefined) clean[k] = prev[k];
    if (!clean.pickupCode && prev.pickupCode) clean.pickupCode = prev.pickupCode;
  }
  // A pick-up from a till still running an older page arrives with no code.
  if (clean.order === 'pickup' && !clean.pickupCode) clean.pickupCode = newPickupCode(Date.parse(clean.ts) || Date.now());

  // Sale blob first: once this lands the sale is recorded, whatever happens to the index.
  const res = await st.setJSON(saleKey(day, store, finalNo), clean);
  const etag = (res && res.etag) || null;
  await mergeIntoIndex(st, day, store, clean, etag);
  await syncPickupPointer(st, clean);

  return json({ ok: true, store, day, no: finalNo, pickupCode: clean.pickupCode || undefined }, 200, headers);
}

/* ---------------- pick up later ---------------- */

// Keep the "still waiting" pointer in step with the sale: there while it's an
// uncollected, un-voided pick-up, gone otherwise.
async function syncPickupPointer(st, sale) {
  if (sale.order !== 'pickup' || !sale.pickupCode) return;
  const key = openKey(sale.store, sale.pickupCode);
  try {
    if (sale.voided || sale.pickedUp) await st.delete(key);
    else await st.setJSON(key, pointerOf(sale));
  } catch (e) { /* the sale itself is saved; the next re-POST or scan repairs this */ }
}

function pointerOf(sale) {
  return { code: sale.pickupCode, no: sale.no, day: sale.day, store: sale.store, ts: sale.ts };
}

async function handlePickupDone(req, headers) {
  let body = {};
  try { body = await req.json(); } catch (e) { return json({ error: 'Body must be JSON.' }, 400, headers); }
  const store = slugStore(body && body.store);
  const code = String((body && body.code) || '').trim().toUpperCase();
  if (!PICKUP_RE.test(code)) return json({ error: 'Bad pick-up code.' }, 400, headers);
  const done = !!(body && body.done);
  const st = blobs();

  let fromKey, ptr;
  if (done) {
    fromKey = openKey(store, code);
    ptr = await getJSON(st, fromKey);
    if (!ptr) {
      // Already ticked (another till got there first)? Then that's fine.
      const sale = await findPickupSale(st, store, code);
      if (sale && sale.pickedUp) return json({ ok: true, sale }, 200, headers);
      return json({ error: 'That pick-up isn\'t waiting any more.' }, 404, headers);
    }
  } else {
    const dd = String((body && body.day) || '').trim();
    if (!DAY_RE.test(dd)) return json({ error: 'Unticking needs the day it was collected.' }, 400, headers);
    fromKey = doneKey(store, dd, code);
    ptr = await getJSON(st, fromKey);
    if (!ptr) return json({ error: 'That pick-up isn\'t marked collected.' }, 404, headers);
  }

  const sk = saleKey(ptr.day, store, ptr.no);
  const sale = await getJSON(st, sk);
  if (!sale) return json({ error: 'The invoice for that pick-up is missing.' }, 404, headers);

  if (done) {
    const day = DAY_RE.test(String(body.day || '')) ? String(body.day) : utcToday();
    sale.pickedUp = true;
    sale.pickedUpAt = new Date().toISOString();
    sale.pickedUpDay = day;
    if (body.by) sale.pickedUpBy = String(body.by).slice(0, 60); else delete sale.pickedUpBy;
  } else {
    for (const k of PICKUP_STATE) delete sale[k];
  }
  const res = await st.setJSON(sk, sale);
  await mergeIntoIndex(st, sale.day, store, sale, (res && res.etag) || null);

  // New pointer first, then drop the old one — never lose it in between.
  const p = pointerOf(sale);
  if (done) await st.setJSON(doneKey(store, sale.pickedUpDay, code), p);
  else await st.setJSON(openKey(store, code), p);
  try { await st.delete(fromKey); } catch (e) { /* a stray pointer is ignored on read */ }

  return json({ ok: true, sale }, 200, headers);
}

// The sale a code belongs to, wherever its pointer is (open or done lately).
async function findPickupSale(st, store, code) {
  let ptr = await getJSON(st, openKey(store, code));
  if (!ptr) {
    try {
      const l = await st.list({ prefix: 'pickup/' + store + '/done/' });
      const hit = ((l && l.blobs) || []).find(b => String(b.key).endsWith('/' + code));
      if (hit) ptr = await getJSON(st, hit.key);
    } catch (e) { /* not found */ }
  }
  return ptr ? await getJSON(st, saleKey(ptr.day, store, ptr.no)) : null;
}

async function listPickups(storeFilter, doneDays) {
  const st = blobs();
  let listed;
  try { listed = await st.list({ prefix: 'pickup/' + (storeFilter ? storeFilter + '/' : '') }); }
  catch (e) { return { open: [], done: [] }; }
  const since = shiftUtcDay(utcToday(), -(doneDays + 1));   // +1: the till's day can be ahead of UTC
  const openKeys = [], doneKeys = [];
  for (const b of (listed && listed.blobs) || []) {
    const parts = String(b.key).split('/');           // pickup/<store>/open/<code> | pickup/<store>/done/<day>/<code>
    if (parts[2] === 'open' && parts.length === 4) openKeys.push(b.key);
    else if (parts[2] === 'done' && parts.length === 5 && parts[3] >= since) doneKeys.push(b.key);
  }
  const load = async key => {
    const ptr = await getJSON(st, key);
    if (!ptr || !ptr.no || !DAY_RE.test(String(ptr.day))) return null;
    const sale = await getJSON(st, saleKey(ptr.day, slugStore(ptr.store), ptr.no));
    return sale && !sale.voided && sale.order === 'pickup' ? sale : null;
  };
  const open = (await mapLimit(openKeys, CONCURRENCY, load)).filter(s => s && !s.pickedUp).sort(byTs);
  const done = (await mapLimit(doneKeys, CONCURRENCY, load)).filter(s => s && s.pickedUp)
    .sort((a, b) => String(b.pickedUpAt).localeCompare(String(a.pickedUpAt)));
  return { open, done };
}

// Pick-up orders rung up before codes existed have no pointer. Adopt them once
// per store: give each a code (so a reprint carries a barcode) and a pointer.
async function adoptOldPickups(store) {
  const st = blobs();
  const mark = 'pickupscan/' + store;
  if (await getJSON(st, mark)) return;
  const today = utcToday();
  const days = dayRange(shiftUtcDay(today, -BACKFILL_DAYS), shiftUtcDay(today, 1));
  const perDay = await mapLimit(days, CONCURRENCY, d => readDay(d, store));
  for (const list of perDay) {
    for (const s of list) {
      if (!s || s.order !== 'pickup' || s.voided || s.pickedUp) continue;
      if (s.pickupCode && await getJSON(st, openKey(store, s.pickupCode))) continue;
      const sale = { ...s };
      if (!sale.pickupCode) {
        sale.pickupCode = newPickupCode(Date.parse(sale.ts) || Date.now());
        const res = await st.setJSON(saleKey(sale.day, store, sale.no), sale);
        await mergeIntoIndex(st, sale.day, store, sale, (res && res.etag) || null);
      }
      await st.setJSON(openKey(store, sale.pickupCode), pointerOf(sale));
    }
  }
  await st.setJSON(mark, { at: new Date().toISOString() });
}

// Same shape as the till's: PU + base-36 time + 2 random characters.
function newPickupCode(t) {
  const rnd = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
  return ('PU' + Math.floor(t).toString(36) + rnd).toUpperCase();
}

/* ---------------- the shared invoice counter ---------------- */

async function handleCounter(req, headers, mode) {
  let body = {};
  try { body = await req.json(); } catch (e) { /* empty body is fine */ }
  const store = slugStore(body && body.store);
  const st = blobs();
  const key = counterKey(store);

  if (mode === 'set') {
    const next = Math.floor(Number(body && body.next));
    if (!isFinite(next) || next < 1) return json({ error: 'next must be a whole number ≥ 1.' }, 400, headers);
    await st.setJSON(key, { next });
    return json({ ok: true, store, next }, 200, headers);
  }
  if (mode !== 'next') return json({ error: 'counter must be next or set.' }, 400, headers);

  const min = Math.max(1, Math.floor(Number(body && body.min)) || 1);
  // Compare-and-swap: read, bump, write only if nobody else wrote in between.
  for (let attempt = 0; attempt < 20; attempt++) {
    const cur = await getWithEtag(st, key);
    const n = Math.max(min, Math.floor(Number(cur.data && cur.data.next)) || 1);
    const opts = cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true };
    const res = await st.setJSON(key, { next: n + 1 }, opts);
    if (!res || res.modified !== false) return json({ ok: true, store, n }, 200, headers);
  }
  return json({ error: 'The invoice counter is busy — try again.' }, 503, headers);
}

async function getWithEtag(st, key) {
  try {
    const r = await st.getWithMetadata(key, { type: 'json' });
    return r ? { data: r.data, etag: r.etag || null } : { data: null, etag: null };
  } catch (e) { return { data: null, etag: null }; }
}

// Add (or replace) one sale in the day's index. A concurrent write at the same
// store can lose this update; readDay() notices and rebuilds, so it stays correct.
async function mergeIntoIndex(st, day, store, sale, etag) {
  const key = indexKey(day, store);
  const idx = await readIndex(st, key);
  const i = idx.sales.findIndex(s => String(s.no) === String(sale.no));
  if (i >= 0) idx.sales[i] = sale; else idx.sales.push(sale);
  idx.sales.sort(byTs);
  if (etag) idx.etags[sale.no] = etag; else delete idx.etags[sale.no];
  try {
    await st.setJSON(key, { v: INDEX_V, day, store, sales: idx.sales, etags: idx.etags });
  } catch (e) { /* cache only — readDay() rebuilds it from the sale blobs */ }
}

/* ---------------- read ---------------- */

async function handleGet(req, headers) {
  const q = new URL(req.url).searchParams;

  if (q.get('counter')) {
    const store = slugStore(q.get('store'));
    const v = await getJSON(blobs(), counterKey(store));
    return json({ store, next: Math.floor(Number(v && v.next)) || null }, 200, headers);
  }

  const storeParam = (q.get('store') || '').trim();
  let store = null;
  if (storeParam && storeParam !== 'all') {
    store = slugStore(storeParam);
    if (!STORE_RE.test(store)) return json({ error: 'Bad store id.' }, 400, headers);
  }

  if (q.get('pickups')) {
    const doneDays = Math.min(MAX_DONE_DAYS, Math.max(0, Math.floor(Number(q.get('days'))) || 7));
    if (store) { try { await adoptOldPickups(store); } catch (e) { /* retried on the next read */ } }
    const { open, done } = await listPickups(store, doneDays);
    return json({ store: store || 'all', open, done }, 200, headers);
  }

  const from = (q.get('from') || '').trim();
  const to = (q.get('to') || '').trim();

  // Range → per-day/per-store takings (Admin tab).
  if (from || to) {
    const a = from || to, b = to || from;
    if (!DAY_RE.test(a) || !DAY_RE.test(b)) return json({ error: 'from/to must be YYYY-MM-DD.' }, 400, headers);
    // Count first, so an over-long range can say how long it actually was.
    const span = Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
    if (!isFinite(span) || span < 1) return json({ error: 'from is after to.' }, 400, headers);
    if (span > MAX_RANGE_DAYS) {
      return json({ error: 'That range is ' + span + ' days; the most this can read at once is ' + MAX_RANGE_DAYS + '.' }, 400, headers);
    }
    const days = dayRange(a, b);
    if (!days.length) return json({ error: 'from is after to.' }, 400, headers);

    const perDay = await mapLimit(days, CONCURRENCY, d => readDay(d, store));
    const rows = [];
    const all = [];
    const byStore = {};
    days.forEach((d, i) => {
      const group = new Map();
      for (const s of perDay[i]) {
        const id = slugStore(s.store);
        if (!group.has(id)) group.set(id, []);
        group.get(id).push(s);
        all.push(s);
      }
      for (const [id, list] of group) {
        rows.push({ day: d, store: id, ...aggregate(list) });
        byStore[id] = addAgg(byStore[id], aggregate(list));
      }
    });
    rows.sort((x, y) => x.day.localeCompare(y.day) || x.store.localeCompare(y.store));

    const out = {
      from: days[0], to: days[days.length - 1],
      stores: Object.keys(byStore).sort(),
      days: rows, byStore, totals: aggregate(all),
    };
    if (q.get('include') === 'sales') out.sales = all.sort(byTs);
    return json(out, 200, headers);
  }

  // Single day (the till's own Today / Invoices / Takings views).
  const day = (q.get('day') || '').trim() || utcToday();
  if (!DAY_RE.test(day)) return json({ error: 'day must be YYYY-MM-DD.' }, 400, headers);
  const sales = await readDay(day, store);
  return json({ day, store: store || 'all', sales: sales.sort(byTs) }, 200, headers);
}

// Every sale for one day, for one store or all of them. Reads the per-day index
// and repairs it from the sale blobs when the two disagree, so a sale can never
// be missing from a total just because an index write was lost or raced.
async function readDay(day, storeFilter) {
  const st = blobs();
  const prefix = 'sale/' + day + '/' + (storeFilter ? storeFilter + '/' : '');

  // Sales once filed as Unassigned belong to South Melbourne: move any still
  // sitting there the first time their day is read. An all-stores read sees
  // them in its own listing; a South Melbourne read has to look for them.
  if (!storeFilter || storeFilter === DEFAULT_STORE) {
    try {
      const legacy = await st.list({ prefix: 'sale/' + day + '/' + UNASSIGNED + '/' });
      if (legacy && legacy.blobs && legacy.blobs.length) await moveUnassigned(st, day, legacy.blobs);
    } catch (e) { /* try again on the next read */ }
  }

  let listed;
  try { listed = await st.list({ prefix }); } catch (e) { return []; }
  const blobList = (listed && listed.blobs) || [];
  if (!blobList.length) return [];

  // key = sale/<day>/<store>/<encoded invoice no>
  const byStore = new Map();
  for (const b of blobList) {
    const parts = String(b.key).split('/');
    if (parts.length < 4) continue;
    const store = parts[2];
    const no = safeDecode(parts.slice(3).join('/'));
    if (!store || !no) continue;
    if (!byStore.has(store)) byStore.set(store, new Map());
    byStore.get(store).set(no, { key: b.key, etag: b.etag || null });
  }

  const out = [];
  for (const [store, wanted] of byStore) {
    const idx = await readIndex(st, indexKey(day, store));
    const have = new Map(idx.sales.map(s => [String(s.no), s]));

    // Refetch anything the index has never seen, or whose blob has changed
    // since it was indexed (a void re-POST whose index update went missing).
    const stale = [];
    for (const [no, info] of wanted) {
      const known = idx.etags[no];
      if (!have.has(no)) stale.push(no);
      else if (known && info.etag && known !== info.etag) stale.push(no);
    }

    if (stale.length) {
      const fetched = await mapLimit(stale, CONCURRENCY, no => getJSON(st, wanted.get(no).key));
      stale.forEach((no, i) => {
        const s = fetched[i];
        if (s && s.no) {
          have.set(String(s.no), s);
          const e = wanted.get(no).etag;
          if (e) idx.etags[no] = e;
        }
      });
      // Drop index entries whose sale blob is gone, then write the repair back.
      const rebuilt = [...have.values()].filter(s => wanted.has(String(s.no))).sort(byTs);
      const etags = {};
      for (const s of rebuilt) { if (idx.etags[s.no]) etags[s.no] = idx.etags[s.no]; }
      try {
        await st.setJSON(indexKey(day, store), { v: INDEX_V, day, store, sales: rebuilt, etags });
      } catch (e) { /* best effort — the data we're returning is already correct */ }
      out.push(...rebuilt);
    } else {
      out.push(...idx.sales.filter(s => wanted.has(String(s.no))));
    }
  }
  return out;
}

// Re-file a day's Unassigned sales under South Melbourne, then drop the old
// blobs and index. Each sale lands in its new home before its old copy goes,
// so a failure part-way leaves it in one place or both — never neither.
async function moveUnassigned(st, day, blobList) {
  for (const b of blobList) {
    const old = await getJSON(st, b.key);
    if (!old || !old.no) continue;
    let no = String(old.no);
    // Old tills numbered INV-0001 and South Melbourne numbers INV-SM-0001, so
    // a clash is unlikely — but never overwrite a different sale if there is one.
    const there = await getJSON(st, saleKey(day, DEFAULT_STORE, no));
    if (there && String(there.ts) !== String(old.ts)) no = no + '-U';
    const moved = { ...old, no, store: DEFAULT_STORE, storeName: DEFAULT_STORE_NAME };
    const res = await st.setJSON(saleKey(day, DEFAULT_STORE, no), moved);
    await mergeIntoIndex(st, day, DEFAULT_STORE, moved, (res && res.etag) || null);
    await st.delete(b.key);
  }
  try { await st.delete(indexKey(day, UNASSIGNED)); } catch (e) { /* cache only */ }
}

async function readIndex(st, key) {
  const v = await getJSON(st, key);
  const sales = v && Array.isArray(v.sales) ? v.sales : (Array.isArray(v) ? v : []);
  const etags = v && v.etags && typeof v.etags === 'object' ? { ...v.etags } : {};
  return { sales, etags };
}

/* ---------------- totals ----------------
   Mirrors aggregate() in index.html — voided sales don't count, refunds
   (kind:'refund') are negative, a split counts its cash and card parts, cash is the
   5c-rounded amount actually taken, card is the exact total. Keep the two in
   step: the till aggregates single days itself and trusts these for a range. */

function aggregate(sales) {
  const live = (sales || []).filter(s => s && !s.voided);
  let cash = 0, card = 0, gst = 0, sub = 0;
  for (const s of live) {
    const total = num(s.total);
    if (s.method === 'split') { cash += num(s.cashPaid); card += num(s.cardPaid); }
    else if (s.method === 'cash') cash += (s.paid != null ? num(s.paid) : total);
    else card += total;
    gst += num(s.gst);
    sub += num(s.sub);
  }
  cash = r2(cash); card = r2(card);
  return { count: live.filter(s => s.kind !== 'refund').length, cash, card, gst: r2(gst), sub: r2(sub), total: r2(cash + card) };
}

function addAgg(a, b) {
  if (!a) return { ...b };
  return {
    count: a.count + b.count, cash: r2(a.cash + b.cash), card: r2(a.card + b.card),
    gst: r2(a.gst + b.gst), sub: r2(a.sub + b.sub), total: r2(a.total + b.total),
  };
}

/* ---------------- plumbing ---------------- */

function blobs() {
  // Strong consistency: a till must read back the sale it just wrote.
  return getStore({ name: 'sales', consistency: 'strong' });
}

function saleKey(day, store, no) { return 'sale/' + day + '/' + store + '/' + encodeURIComponent(no); }
function indexKey(day, store) { return 'index/' + day + '/' + store; }
function counterKey(store) { return 'counter/' + store; }
function openKey(store, code) { return 'pickup/' + store + '/open/' + code; }
function doneKey(store, day, code) { return 'pickup/' + store + '/done/' + day + '/' + code; }

async function getJSON(st, key) {
  try { return await st.get(key, { type: 'json' }); } catch (e) { return null; }
}

function slugStore(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s && STORE_RE.test(s) && s !== UNASSIGNED ? s : DEFAULT_STORE;
}

function dayRange(from, to) {
  const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b) || b < a) return [];
  const out = [];
  // The caller checks the span first; this cap is only a guard against looping away.
  for (let t = a; t <= b && out.length < 400; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function utcToday() { return new Date().toISOString().slice(0, 10); }
function shiftUtcDay(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  });
  await Promise.all(workers);
  return out;
}

function byTs(a, b) { return String(a && a.ts).localeCompare(String(b && b.ts)); }
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
