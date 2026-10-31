/* Shared by sales.mjs and web-orders.mjs: where pick-ups live in the "sales"
   Blobs store, and how one is ticked (or unticked) as collected.

   A pick-up is a pointer, pickup/<store>/open/<code> while waiting and
   pickup/<store>/done/<day>/<code> once collected, at the sale it belongs to.
   A till sale lives at sale/<day>/<store>/<no>; a website order lives at
   web/order/<orderId> (kept out of sale/… so it's never counted in a store's
   takings: /api/online already counts it), and its pointer says so in `key`. */

import { getStore } from '@netlify/blobs';

export const PICKUP_RE = /^PU[0-9A-Z]{6,20}$/;  // the code printed as the pick-up barcode
// Collected-or-not lives on the server and only changes through a tick.
export const PICKUP_STATE = ['pickedUp', 'pickedUpAt', 'pickedUpDay', 'pickedUpBy'];

export function salesBlobs() {
  // Strong consistency: a till must read back the sale it just wrote.
  return getStore({ name: 'sales', consistency: 'strong' });
}

export function saleKey(day, store, no) { return 'sale/' + day + '/' + store + '/' + encodeURIComponent(no); }
export function webKey(orderId) { return 'web/order/' + encodeURIComponent(orderId); }
export function openKey(store, code) { return 'pickup/' + store + '/open/' + code; }
export function doneKey(store, day, code) { return 'pickup/' + store + '/done/' + day + '/' + code; }

// Where a pointer's sale is: a website order names its own blob.
export function saleKeyOf(ptr, store) { return ptr.key || saleKey(ptr.day, store || ptr.store, ptr.no); }

export function pointerOf(sale) {
  const p = { code: sale.pickupCode, no: sale.no, day: sale.day, store: sale.store, ts: sale.ts };
  if (sale.web && sale.web.orderId) p.key = webKey(sale.web.orderId);
  return p;
}

// Same shape as the till's: PU + base-36 time + 2 random characters.
export function newPickupCode(t) {
  const rnd = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
  return ('PU' + Math.floor(t).toString(36) + rnd).toUpperCase();
}

export async function getJSON(st, key) {
  try { return await st.get(key, { type: 'json' }); } catch (e) { return null; }
}

// Tick (done) or untick a pick-up whose pointer sits at fromKey: write the state
// onto the sale, then move the pointer. `afterSave(sale, etag)` lets the caller
// refresh its own read cache (sales.mjs's day index) for till sales.
export async function setPickedUp(st, { store, code, ptr, fromKey, sale, done, day, by, afterSave }) {
  if (done) {
    sale.pickedUp = true;
    sale.pickedUpAt = new Date().toISOString();
    sale.pickedUpDay = day;
    if (by) sale.pickedUpBy = String(by).slice(0, 60); else delete sale.pickedUpBy;
  } else {
    for (const k of PICKUP_STATE) delete sale[k];
  }
  const res = await st.setJSON(saleKeyOf(ptr, store), sale);
  if (afterSave) await afterSave(sale, (res && res.etag) || null);

  // New pointer first, then drop the old one — never lose it in between.
  const p = pointerOf(sale);
  if (done) await st.setJSON(doneKey(store, sale.pickedUpDay, code), p);
  else await st.setJSON(openKey(store, code), p);
  try { await st.delete(fromKey); } catch (e) { /* a stray pointer is ignored on read */ }
  return sale;
}
