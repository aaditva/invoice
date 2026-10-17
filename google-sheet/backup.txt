/* ------------------------------------------------------------------ *
 *  Google Apps Script — weekly backup of the till into the "Till Backup" sheet.
 * ------------------------------------------------------------------ *
 *  Paste into the Till Backup sheet: Extensions → Apps Script → replace
 *  Code.gs → Save. Fill in ADMIN_PIN (and SALES_TOKEN if you set one), then
 *  run setup() once (Run ▶, allow access). From then on it runs by itself
 *  every Sunday night around BACKUP_HOUR.
 *
 *  Each run rewrites this sheet with everything the till keeps on the site:
 *  every sale and refund since BACKUP_FROM (both stores), each item sold,
 *  expenses, money added, website cost prices, the box → pack list, and a
 *  copy of the main sheet's Products tab (your cost prices). Everything is
 *  fetched before anything is written, so a failed run leaves last week's
 *  backup as it was. 🧾 Backup → Back up now runs it any time.
 * ------------------------------------------------------------------ */

const SITE_URL      = 'https://invoiceremactables.netlify.app'; // the till's site
const SALES_TOKEN   = '';   // same as the SALES_TOKEN env var; blank if you didn't set one
const ADMIN_PIN     = '';   // the till's Admin password — type it here in Apps Script; never commit it
const DEVICE_KEY    = '';   // only once the site has DEVICE_KEYS on: this script's own key (see README → Per-device keys); never commit it
const MAIN_SHEET_ID = '1UoB2JQP8PdtavFA3c60FIk_pwrVXt00uc5Vgz3IUXHs'; // the main till sheet (for its Products tab); '' to skip
const PRODUCTS_TAB  = 'Products';
const BACKUP_FROM   = '2026-07-01'; // first day of sales to include
const BACKUP_HOUR   = 23;           // Sunday, around this hour
const TIME_ZONE     = 'Australia/Melbourne';

function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'weeklyBackup')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('weeklyBackup').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(BACKUP_HOUR).inTimezone(TIME_ZONE).create();
  weeklyBackup();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🧾 Backup').addItem('Back up now', 'weeklyBackup').addToUi();
}

function authHeaders() {
  const h = {};
  if (SALES_TOKEN) h['x-sales-token'] = SALES_TOKEN;
  if (ADMIN_PIN) h['x-admin-pin'] = ADMIN_PIN;
  if (DEVICE_KEY) h['x-device-key'] = DEVICE_KEY;
  return h;
}

function fetchSiteCosts() { return getJson('/api/costs'); }

// Rewrites the backup spreadsheet with everything the site holds. Every part is
// fetched before anything is written, so a failed fetch leaves last week's
// backup as it was instead of half-empty.
function weeklyBackup() {
  const now = new Date();
  const today = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd');
  const chunks = backupChunks(BACKUP_FROM, today);

  const sales = [];
  const expenses = [];
  const added = [];
  chunks.forEach(c => {
    const s = fetchAll('sales', c[0], c[1], '&include=sales');
    (s.sales || []).forEach(x => sales.push(x));
    tryFetch(() => (fetchAll('expenses', c[0], c[1], '').entries || []).forEach(x => expenses.push(x)));
    tryFetch(() => (fetchAll('money-added', c[0], c[1], '').entries || []).forEach(x => added.push(x)));
  });
  let costs = null, boxes = null;
  tryFetch(() => { costs = fetchSiteCosts(); });
  tryFetch(() => { boxes = getJson('/api/boxes'); });

  const fmtTime = ts => ts ? Utilities.formatDate(new Date(ts), TIME_ZONE, 'HH:mm:ss') : '';
  const saleRows = sales.map(s => {
    const card = s.method === 'split' ? Number(s.cardPaid) || 0 : (s.method === 'cash' ? 0 : Number(s.total) || 0);
    const cash = s.method === 'split' ? Number(s.cashPaid) || 0 : (s.method === 'cash' ? Number(s.paid != null ? s.paid : s.total) || 0 : 0);
    return [s.day, fmtTime(s.ts), s.storeName || s.store || '', s.no, s.kind === 'refund' ? 'Refund' : 'Sale',
      s.refundOf || '', s.servedBy || '', s.customer || '', s.contact || '', s.order === 'pickup' ? 'Pick up later' : 'On the spot',
      s.method || '', card, cash, Number(s.discount) || 0, Number(s.sub) || 0, Number(s.gst) || 0, Number(s.total) || 0,
      s.voided ? 'VOID' : '', (s.refunds || []).join(', '), s.pickedUp ? 'Yes' : ''];
  });
  const lineRows = [];
  sales.forEach(s => (s.items || []).forEach(it => lineRows.push([s.day, s.storeName || s.store || '', s.no,
    s.kind === 'refund' ? 'Refund' : 'Sale', String(it.sku || ''), it.name || '', Number(it.price) || 0, Number(it.qty) || 0,
    Math.round((Number(it.price) || 0) * (Number(it.qty) || 0) * 100) / 100, s.voided ? 'VOID' : ''])));
  const costRows = Object.keys((costs && costs.items) || {}).map(k => {
    const c = costs.items[k] || {};
    return [k, c.name || '', c.brand || '', c.cost == null ? '' : Number(c.cost)];
  });
  const boxRows = ((boxes && boxes.boxes) || []).map(b => [String(b.box || ''), String(b.pack || ''), Number(b.packs) || '', b.name || '']);

  const ss = SpreadsheetApp.getActive();
  writeTab(ss, 'Sales', ['Date', 'Time', 'Store', 'Invoice', 'Type', 'Refund of', 'Served by', 'Customer', 'Contact', 'Order',
    'Method', 'Card', 'Cash', 'Discount', 'Subtotal ex GST', 'GST', 'Total', 'Voided', 'Refunds', 'Picked up'], saleRows, [12, 13, 14, 15, 16, 17]);
  writeTab(ss, 'Items sold', ['Date', 'Store', 'Invoice', 'Type', 'Barcode', 'Name', 'Price', 'Qty', 'Line total', 'Voided'], lineRows, [7, 9], [8]);
  writeEntries(ss, 'Expenses', expenses);
  writeEntries(ss, 'Money added', added);
  writeTab(ss, 'Website costs', ['Barcode', 'Name', 'Brand', 'Cost'], costRows, [4]);
  writeTab(ss, 'Boxes', ['Box barcode', 'Pack barcode', 'Packs per box', 'Name'], boxRows, [], [3]);
  if (PRODUCTS_TAB) {
    const src = (MAIN_SHEET_ID ? SpreadsheetApp.openById(MAIN_SHEET_ID) : null);
    const tab = src && src.getSheetByName(PRODUCTS_TAB);
    if (tab && tab.getLastRow() > 0) {
      const vals = tab.getRange(1, 1, tab.getLastRow(), tab.getLastColumn()).getValues();
      writeTab(ss, 'Products', vals[0].map(String), vals.slice(1), [], [], true);
    }
  }
  writeTab(ss, 'About', ['What', 'Value'], [
    ['Last backup', Utilities.formatDate(now, TIME_ZONE, 'EEE d MMM yyyy, HH:mm')],
    ['From the site', SITE_URL],
    ['Sales from', BACKUP_FROM],
    ['Sales & refunds', saleRows.length],
    ['Items sold rows', lineRows.length],
    ['Expenses', expenses.length],
    ['Money added', added.length],
    ['Next backup', 'Sunday around ' + BACKUP_HOUR + ':00'],
  ], [], [], true);
  const first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  console.log('Backup done: ' + saleRows.length + ' sales → ' + ss.getUrl());
}

// [from, to] pairs of at most 60 days — the site reads at most 62 at once.
function backupChunks(from, to) {
  const out = [];
  let a = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (a <= end) {
    let b = new Date(a.getTime() + 59 * 86400000);
    if (b > end) b = end;
    out.push([a.toISOString().slice(0, 10), b.toISOString().slice(0, 10)]);
    a = new Date(b.getTime() + 86400000);
  }
  return out;
}

// Every store (the backup ignores STORE).
function fetchAll(what, from, to, extra) {
  return getJson('/api/' + what + '?from=' + from + '&to=' + to + extra);
}

function getJson(path) {
  const res = UrlFetchApp.fetch(SITE_URL.replace(/\/$/, '') + path, { headers: authHeaders(), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error(path + ' failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  }
  return JSON.parse(res.getContentText());
}

// Optional parts (expenses, costs…) are logged and skipped rather than stopping the backup.
function tryFetch(fn) {
  try { fn(); } catch (e) { console.log('Backup: skipped a part — ' + e.message); }
}

// Expense / money-added entries: whatever fields the site keeps, one column each.
function writeEntries(ss, name, entries) {
  const keys = [];
  entries.forEach(e => Object.keys(e || {}).forEach(k => {
    if (keys.indexOf(k) < 0 && typeof e[k] !== 'object') keys.push(k);
  }));
  const rows = entries.map(e => keys.map(k => e[k] == null ? '' : e[k]));
  writeTab(ss, name, keys.length ? keys : ['(none yet)'], rows, []);
}

// Cells are written as text (so barcodes and dates stay exactly as the site has
// them) except moneyCols, written as $ amounts, and numCols, as plain numbers.
// asIs: keep the values' own types (the Products copy).
function writeTab(ss, name, heads, rows, moneyCols, numCols, asIs) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  const w = heads.length;
  sheet.getRange(1, 1, 1, w).setValues([heads]).setFontWeight('bold').setBackground('#eeeeee');
  if (rows.length) {
    const body = rows.map(r => { const x = r.slice(0, w); while (x.length < w) x.push(''); return x; });
    if (!asIs) sheet.getRange(2, 1, body.length, w).setNumberFormat('@');
    (moneyCols || []).forEach(c => sheet.getRange(2, c, body.length, 1).setNumberFormat('$#,##0.00'));
    (numCols || []).forEach(c => sheet.getRange(2, c, body.length, 1).setNumberFormat('0'));
    sheet.getRange(2, 1, body.length, w).setValues(body);
  }
  sheet.setFrozenRows(1);
}
