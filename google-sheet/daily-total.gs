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
 * ------------------------------------------------------------------ */

const SITE_URL     = 'https://invoiceremactables.netlify.app'; // the till's site
const SALES_TOKEN  = '';          // same as the SALES_TOKEN env var; blank if you didn't set one
const STORE        = 'south-melbourne'; // 'all', or one store id, e.g. 'south-melbourne' or 'roxy'
const SHEET_NAME   = '{year}';    // the tab to write into; {year} becomes e.g. 2026
const DATE_COLUMN  = 'A';         // column holding the dates
const TOTAL_HEADER = 'Games';     // row-1 heading of the column the total goes into
const EXPENSES_HEADER  = 'Expenses'; // row-1 heading of the expenses column; '' to turn off
const EXPENSE_LOOKBACK = 14;         // days back to re-check for late-entered expenses
const TIME_ZONE    = 'Australia/Melbourne';

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
    try { writeExpenses(now); } catch (e) { console.log('Expenses skipped: ' + e.message); }
  }
}

function writeTotal(when) {
  const day = Utilities.formatDate(when, TIME_ZONE, 'yyyy-MM-dd');
  const data = fetchApi('sales', day, day);
  writeCell(day, TOTAL_HEADER, Number((data.totals || {}).total) || 0);
}

// One request covers the look-back window. Only days with expenses recorded on
// the till are written, so anything typed into the sheet by hand for other
// days is left alone. (Deleting a day's last till expense therefore leaves the
// old figure in the sheet — clear that cell by hand.)
function writeExpenses(now) {
  const to = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd');
  const from = Utilities.formatDate(new Date(now.getTime() - EXPENSE_LOOKBACK * 86400000), TIME_ZONE, 'yyyy-MM-dd');
  const data = fetchApi('expenses', from, to);
  const byDay = {};
  (data.days || []).forEach(r => { byDay[r.day] = (byDay[r.day] || 0) + (Number(r.total) || 0); });
  Object.keys(byDay).sort().forEach(day => {
    writeCell(day, EXPENSES_HEADER, Math.round(byDay[day] * 100) / 100);
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
