/* ------------------------------------------------------------------ *
 *  Netlify Function — shared "money added" log (💰 Money Added on the till)
 * ------------------------------------------------------------------ *
 *  Money put into the till (tapped as $2/$4/$10/$20/$50 or typed in), filed
 *  by the day and the store. Open to everyone — no admin password needed.
 *  Every device and the Google Sheet script read the same list.
 *  Routes: see lib/ledger.mjs.
 *
 *  Env vars:
 *    SALES_TOKEN   optional; if set, every request needs a matching x-sales-token
 *    ALLOW_ORIGIN  optional, locks CORS to your site URL
 * ------------------------------------------------------------------ */

import { ledger } from '../lib/ledger.mjs';

export default ledger({ store: 'money-added', prefix: 'add', adminWrites: false });

export const config = { path: '/api/money-added' };
