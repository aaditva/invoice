/* ------------------------------------------------------------------ *
 *  Netlify Function — shared expenses log (💸 Expenses / Admin → Expenses)
 * ------------------------------------------------------------------ *
 *  Cash paid out of the till (notes and coins counted on the Expenses pad),
 *  filed by the day it was spent and the store it came out of. Every device
 *  and the Google Sheet script read the same list. Routes: see lib/ledger.mjs.
 *
 *  Env vars:
 *    SALES_TOKEN   optional; if set, every request needs a matching x-sales-token
 *    ADMIN_PIN     optional; if set, POST/DELETE also need a matching x-admin-pin
 *    ALLOW_ORIGIN  optional, locks CORS to your site URL
 * ------------------------------------------------------------------ */

import { ledger } from '../lib/ledger.mjs';

export default ledger({ store: 'expenses', prefix: 'exp', adminWrites: true });

export const config = { path: '/api/expenses' };
