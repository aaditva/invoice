/* ------------------------------------------------------------------ *
 *  Netlify Function — shared miscellaneous sales log (🧾 Misc Sales on the till)
 * ------------------------------------------------------------------ *
 *  Sales that don't go through the till basket (typed amount + what it
 *  was), filed by the day and the store. Open to everyone — no admin
 *  password needed. Every device and the Google Sheet script read the same
 *  list; the script writes each day's total into the sheet's
 *  "Miscellaneous Sales" column.
 *  Routes: see lib/ledger.mjs.
 *
 *  Env vars:
 *    SALES_TOKEN   optional; if set, every request needs a matching x-sales-token
 *    ALLOW_ORIGIN  optional, locks CORS to your site URL
 * ------------------------------------------------------------------ */

import { ledger } from '../lib/ledger.mjs';

export default ledger({ store: 'misc-sales', prefix: 'misc', adminWrites: false });

export const config = { path: '/api/misc-sales' };
