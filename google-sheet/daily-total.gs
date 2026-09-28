/* ------------------------------------------------------------------ *
 *  Google Apps Script — puts each day's total sales into your sheet.
 * ------------------------------------------------------------------ *
 *  Paste into the sheet: Extensions → Apps Script → replace Code.gs → Save.
 *  Fill in the settings below, then run setup() once (Run ▶, allow access).
 *  From then on it runs every hour on its own and keeps today's row current.
 *
 *  How it writes: it opens the tab named after the year (e.g. "2026"), finds
 *  the column headed TOTAL_HEADER ("Games") in row 1, looks down DATE_COLUMN
 *  for today's date and writes the total on that row. If the date isn't in
 *  the sheet (a day you didn't open), it skips it. Nothing else is touched.
 *
 *  Expenses (Admin → 💸 Expenses on the till) go the same way into the column
 *  headed EXPENSES_HEADER, on the row for the date the expense was for. Each
 *  run also refreshes the last EXPENSE_LOOKBACK days, so an expense entered
 *  later against an earlier date still lands next to that date.
 *
 *  Money added (💰 Money Added on the till) works exactly the same, into the
 *  column headed MONEY_ADDED_HEADER.
 *
 *  Cost prices & profit (private — never sent to the till or customers):
 *  each run also refreshes a PRODUCTS_TAB tab with every product, its sell
 *  price and live stock from the site. Type your cost price into the Cost
 *  column; it is kept (matched by barcode) every time the list refreshes.
 *  Margin and stock value are sheet formulas, so they update as you type.
 *  A PROFIT_TAB tab gets one row per day: takings, cost of goods sold,
 *  gross profit, and how many items sold had no cost entered yet.
 * ------------------------------------------------------------------ */

const SITE_URL     = 'https://invoiceremactables.netlify.app'; // the till's site
const SALES_TOKEN  = '';          // same as the SALES_TOKEN env var; blank if you didn't set one
const STORE        = 'south-melbourne'; // 'all', or one store id, e.g. 'south-melbourne' or 'roxy'
const SHEET_NAME   = '{year}';    // the tab to write into; {year} becomes e.g. 2026
const DATE_COLUMN  = 'A';         // column holding the dates
const TOTAL_HEADER = 'Games';     // row-1 heading of the column the total goes into
const EXPENSES_HEADER  = 'Expenses'; // row-1 heading of the expenses column; '' to turn off
const EXPENSE_LOOKBACK = 14;         // days back to re-check for late-entered expenses / money added
const MONEY_ADDED_HEADER = 'Money Added'; // row-1 heading of the money-added column; '' to turn off
const TIME_ZONE    = 'Australia/Melbourne';
const PRODUCTS_TAB = 'Products';  // tab listing products, stock and YOUR cost price; '' to turn off
const PROFIT_TAB   = 'Profit';    // tab with daily takings / cost / profit; '' to turn off

function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'updateDailyTotal')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('updateDailyTotal').timeBased().everyHours(1).create();
  updateDailyTotal();
}

function updateDailyTotal() {
  const now = new Date();
  // Just after midnight, finish off yesterday before starting today.
  if (Number(Utilities.formatDate(now, TIME_ZONE, 'H')) < 1) {
    writeTotal(new Date(now.getTime() - 3600 * 1000));
  }
  writeTotal(now);
  // Expenses are extra: if that part fails (e.g. the site hasn't got
  // /api/expenses yet) log it and carry on, rather than failing the run.
  if (EXPENSES_HEADER) {
    try { writeByDay('expenses', EXPENSES_HEADER, now); } catch (e) { console.log('Expenses skipped: ' + e.message); }
  }
  if (MONEY_ADDED_HEADER) {
    try { writeByDay('money-added', MONEY_ADDED_HEADER, now); } catch (e) { console.log('Money added skipped: ' + e.message); }
  }
  if (PRODUCTS_TAB) {
    try { updateProducts(); } catch (e) { console.log('Products skipped: ' + e.message); }
  }
  if (PROFIT_TAB && PRODUCTS_TAB) {
    try { updateProfit(now); } catch (e) { console.log('Profit skipped: ' + e.message); }
  }
}

/* ---------------- products, cost price & profit ---------------- */

const PRODUCT_HEADS = ['Barcode', 'Name', 'Price', 'Cost', 'Stock',
  'Margin $', 'Margin %', 'Stock value (cost)', 'Stock value (retail)'];

function tabNamed(name) {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// Cost prices you've typed, keyed by barcode.
function readCosts() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(PRODUCTS_TAB);
  const costs = {};
  if (!sheet || sheet.getLastRow() < 2) return costs;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues().forEach(r => {
    const sku = String(r[0]).trim();
    if (sku && r[3] !== '' && r[3] !== null && isFinite(Number(r[3]))) costs[sku] = Number(r[3]);
  });
  return costs;
}

// Rewrites the Products tab from the live catalog, keeping every Cost you've
// entered. Products that disappear from the catalog but have a cost stay at
// the bottom (stock blank) so you don't lose what you typed.
function updateProducts() {
  const res = UrlFetchApp.fetch(SITE_URL.replace(/\/$/, '') + '/api/catalog', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('catalog fetch failed (' + res.getResponseCode() + ')');
  const items = JSON.parse(res.getContentText()).items || [];
  const costs = readCosts();
  const seen = {};
  const rows = [];
  items.forEach(it => {
    const sku = String(it.sku).trim();
    if (!sku || seen[sku]) return;
    seen[sku] = true;
    rows.push([sku, it.name, Number(it.price) || 0, sku in costs ? costs[sku] : '',
      it.stock === null || it.stock === undefined ? '' : Number(it.stock)]);
  });
  Object.keys(costs).forEach(sku => { if (!seen[sku]) rows.push([sku, '(no longer in catalog)', '', costs[sku], '']); });

  const sheet = tabNamed(PRODUCTS_TAB);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, PRODUCT_HEADS.length).setValues([PRODUCT_HEADS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (!rows.length) return;
  const n = rows.length;
  sheet.getRange(2, 1, n, 1).setNumberFormat('@'); // keep long barcodes as text
  sheet.getRange(2, 1, n, 5).setValues(rows);
  const f = [];
  for (let r = 2; r < n + 2; r++) {
    f.push([
      '=IF(OR(C' + r + '="",D' + r + '=""),"",C' + r + '-D' + r + ')',
      '=IF(OR(C' + r + '="",D' + r + '="",C' + r + '=0),"",(C' + r + '-D' + r + ')/C' + r + ')',
      '=IF(OR(D' + r + '="",E' + r + '=""),"",D' + r + '*E' + r + ')',
      '=IF(OR(C' + r + '="",E' + r + '=""),"",C' + r + '*E' + r + ')',
    ]);
  }
  sheet.getRange(2, 6, n, 4).setFormulas(f);
  sheet.getRange(2, 3, n, 2).setNumberFormat('$#,##0.00');
  sheet.getRange(2, 6, n, 1).setNumberFormat('$#,##0.00');
  sheet.getRange(2, 7, n, 1).setNumberFormat('0.0%');
  sheet.getRange(2, 8, n, 2).setNumberFormat('$#,##0.00');
}

// One row per day in the Profit tab for the last EXPENSE_LOOKBACK days
// (so a cost typed in later fixes recent days too). Days you've never
// traded are left out; existing rows for a day are overwritten in place.
function updateProfit(now) {
  const costs = readCosts();
  const sheet = tabNamed(PROFIT_TAB);
  const heads = ['Date', 'Takings', 'Cost of goods', 'Gross profit', 'Margin %', 'Items without cost'];
  sheet.getRange(1, 1, 1, heads.length).setValues([heads]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  const rowOf = {};
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, 1).getValues().forEach((v, i) => {
    const key = v[0] instanceof Date ? Utilities.formatDate(v[0], TIME_ZONE, 'yyyy-MM-dd') : normDay(String(v[0]));
    if (key) rowOf[key] = i + 2;
  });

  for (let d = EXPENSE_LOOKBACK; d >= 0; d--) {
    const day = Utilities.formatDate(new Date(now.getTime() - d * 86400000), TIME_ZONE, 'yyyy-MM-dd');
    const url = SITE_URL.replace(/\/$/, '') + '/api/sales?day=' + day +
      (STORE && STORE !== 'all' ? '&store=' + encodeURIComponent(STORE) : '');
    const res = UrlFetchApp.fetch(url, { headers: SALES_TOKEN ? { 'x-sales-token': SALES_TOKEN } : {}, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('sales fetch failed (' + res.getResponseCode() + ')');
    const sales = (JSON.parse(res.getContentText()).sales || []).filter(s => s && !s.voided);
    if (!sales.length) continue;
    let takings = 0, cogs = 0, missing = 0;
    sales.forEach(s => {
      takings += Number(s.total) || 0;
      (s.items || []).forEach(it => {
        const q = Number(it.qty) || 0;
        const sku = String(it.sku || '').trim();
        if (sku in costs) cogs += costs[sku] * q; else missing += q;
      });
    });
    takings = Math.round(takings * 100) / 100;
    cogs = Math.round(cogs * 100) / 100;
    let row = rowOf[day];
    if (!row) { row = sheet.getLastRow() + 1; rowOf[day] = row; }
    sheet.getRange(row, 1).setNumberFormat('@').setValue(day);
    sheet.getRange(row, 2, 1, 5).setValues([[takings, cogs, Math.round((takings - cogs) * 100) / 100,
      takings ? (takings - cogs) / takings : '', missing]]);
  }
  if (sheet.getLastRow() > 1) {
    const n = sheet.getLastRow() - 1;
    sheet.getRange(2, 2, n, 3).setNumberFormat('$#,##0.00');
    sheet.getRange(2, 5, n, 1).setNumberFormat('0.0%');
    sheet.getRange(2, 1, n, heads.length).sort(1);
  }
}

function writeTotal(when) {
  const day = Utilities.formatDate(when, TIME_ZONE, 'yyyy-MM-dd');
  const data = fetchApi('sales', day, day);
  writeCell(day, TOTAL_HEADER, Number((data.totals || {}).total) || 0);
}

// One request covers the look-back window. Only days with entries recorded on
// the till are written, so anything typed into the sheet by hand for other
// days is left alone. (Deleting a day's last till entry therefore leaves the
// old figure in the sheet — clear that cell by hand.)
function writeByDay(what, header, now) {
  const to = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd');
  const from = Utilities.formatDate(new Date(now.getTime() - EXPENSE_LOOKBACK * 86400000), TIME_ZONE, 'yyyy-MM-dd');
  const data = fetchApi(what, from, to);
  const byDay = {};
  (data.days || []).forEach(r => { byDay[r.day] = (byDay[r.day] || 0) + (Number(r.total) || 0); });
  Object.keys(byDay).sort().forEach(day => {
    writeCell(day, header, Math.round(byDay[day] * 100) / 100);
  });
}

function fetchApi(what, from, to) {
  const url = SITE_URL.replace(/\/$/, '') + '/api/' + what + '?from=' + from + '&to=' + to +
    (STORE && STORE !== 'all' ? '&store=' + encodeURIComponent(STORE) : '');
  const res = UrlFetchApp.fetch(url, {
    headers: SALES_TOKEN ? { 'x-sales-token': SALES_TOKEN } : {},
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(what + ' fetch failed (' + res.getResponseCode() + '): ' + res.getContentText());
  }
  return JSON.parse(res.getContentText());
}

function writeCell(day, header, value) {
  const tab = SHEET_NAME.replace('{year}', day.slice(0, 4));
  const sheet = SpreadsheetApp.getActive().getSheetByName(tab);
  if (!sheet) { console.log('No tab called "' + tab + '", skipped ' + day); return; }
  const dateCol = colNum(DATE_COLUMN);
  const heads = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h).trim().toLowerCase());
  const totalCol = heads.indexOf(header.toLowerCase()) + 1;
  if (!totalCol) throw new Error('No "' + header + '" heading in row 1 of tab "' + tab + '".');
  const last = sheet.getLastRow();
  const dates = last ? sheet.getRange(1, dateCol, last, 1).getValues() : [];

  // Matches real date cells and text like 2026-09-26, 26/09/2026 or
  // "Saturday, 26 September 2026".
  let row = 0;
  for (let i = 0; i < dates.length; i++) {
    const v = dates[i][0];
    const key = v instanceof Date ? Utilities.formatDate(v, TIME_ZONE, 'yyyy-MM-dd') : normDay(String(v));
    if (key === day) { row = i + 1; break; }
  }
  if (!row) { console.log('No row for ' + day + ' in tab "' + tab + '", skipped'); return; }
  sheet.getRange(row, totalCol).setValue(value);
}

function normDay(s) {
  s = s.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // Australian dd/mm/yyyy
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  m = s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);  // "Saturday, 26 September 2026"
  if (m) {
    const mo = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
      .indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    if (mo) return m[3] + '-' + String(mo).padStart(2, '0') + '-' + m[1].padStart(2, '0');
  }
  return '';
}

function colNum(letters) {
  return String(letters).toUpperCase().split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
}
