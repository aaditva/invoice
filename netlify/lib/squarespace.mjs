/* Calls to the Squarespace Commerce API that more than one function makes.
   The key is SQUARESPACE_API_KEY (server-side only). Field names are the ones in
   Squarespace's published schema (Order, TransactionDocument, TransactionPayment). */

const API = 'https://api.squarespace.com/1.0/commerce';
const UA = 'StoreTill/1.0 (+web-orders)';

export function sqKey() { return process.env.SQUARESPACE_API_KEY || ''; }

export async function sqFetch(path, init = {}) {
  const key = sqKey();
  if (!key) throw new Error('SQUARESPACE_API_KEY is not set.');
  return fetch(API + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + key, 'User-Agent': UA, Accept: 'application/json',
               ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
  });
}

// The shipping option chosen at checkout, as named in Squarespace (e.g. "Store
// Pickup"). A pickup order has no shipping line — its name is only in
// shippingOptionName — so read that when shippingLines is empty.
export function shipMethodOf(o) {
  const line = Array.isArray(o && o.shippingLines) && o.shippingLines[0];
  return String((line && line.method) || (o && o.shippingOptionName) || '').trim();
}

// Mark an order fulfilled (Squarespace has no partial fulfilment through the API).
// Squarespace emails the customer that it's done, unless SQ_PICKUP_NOTIFY=0.
// 409 = already fulfilled, which is what we wanted anyway. A pickup has no
// shipment: an empty list first, and if Squarespace won't take that, none at all.
export async function fulfilOrder(orderId) {
  try {
    const notify = process.env.SQ_PICKUP_NOTIFY !== '0';
    const send = body => sqFetch('/orders/' + encodeURIComponent(orderId) + '/fulfillments', { method: 'POST', body: JSON.stringify(body) });
    let r = await send({ shouldSendNotification: notify, shipments: [] });
    if (r.status === 400) r = await send({ shouldSendNotification: notify });
    if (r.ok || r.status === 409) return { ok: true };
    const text = (await r.text()).slice(0, 200);
    if (r.status === 401 || r.status === 403) {
      return { ok: false, error: 'Squarespace won\'t let this key fulfil orders. Give SQUARESPACE_API_KEY the Orders: Read and Write permission (Squarespace → Settings → Developer API Keys).' };
    }
    return { ok: false, error: 'Squarespace ' + r.status + ': ' + text };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// How an order was paid, in Squarespace's own words: card type and gateway, or a
// gift card. Needs the Transactions: Read permission; without it, '' (the receipt
// then just says the order was paid online).
export async function paymentOf(orderId) {
  try {
    const r = await sqFetch('/transactions?orderId=' + encodeURIComponent(orderId));
    if (!r.ok) return '';
    const data = await r.json();
    const bits = [];
    for (const doc of (Array.isArray(data.documents) ? data.documents : [])) {
      for (const p of (Array.isArray(doc.payments) ? doc.payments : [])) {
        const card = String(p.creditCardType || '').trim();
        const via = String(p.provider || '').trim();
        const what = p.giftCardId ? 'Gift card'
          : card ? cap(card) + (via ? ' (' + cap(via) + ')' : '')
          : via ? cap(via) : '';
        if (what && !bits.includes(what)) bits.push(what);
      }
    }
    return bits.join(' + ');
  } catch (e) { return ''; }
}

function cap(s) {
  const t = String(s).toLowerCase().replace(/_/g, ' ');
  return t === 'amex' ? 'AMEX' : t.replace(/\b\w/g, c => c.toUpperCase());
}
