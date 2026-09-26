/* ------------------------------------------------------------------ *
 *  Google Apps Script — puts each day's total sales into your sheet.
 * ------------------------------------------------------------------ *
 *  Paste into the sheet: Extensions → Apps Script → replace Code.gs → Save.
 *  Fill in the settings below, then run setup() once (Run ▶, allow access).
 *  From then on it runs every hour on its own and keeps today's row current.
 *
 *  How it writes: it looks down DATE_COLUMN for today's date. If it finds it,
 *  it writes the total into TOTAL_COLUMN on that row. If not, it adds a new
 *  row at the bottom with the date and the total. Nothing else is touched.
 * ------------------------------------------------------------------ */

const SITE_URL     = 'https://YOUR-SITE.netlify.app'; // the till's site
const SALES_TOKEN  = '';          // same as the SALES_TOKEN env var; blank if you didn't set one
const STORE        = 'all';       // 'all', or one store id, e.g. 'south-melbourne' or 'roxy'
const SHEET_NAME   = 'Sheet1';    // the tab to write into
const DATE_COLUMN  = 'A';         // column holding the dates
const TOTAL_COLUMN = 'B';         // column the day's total goes into
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
}

function writeTotal(when) {
  const day = Utilities.formatDate(when, TIME_ZONE, 'yyyy-MM-dd');
  const url = SITE_URL.replace(/\/$/, '') + '/api/sales?from=' + day + '&to=' + day +
    (STORE && STORE !== 'all' ? '&store=' + encodeURIComponent(STORE) : '');
  const res = UrlFetchApp.fetch(url, {
    headers: SALES_TOKEN ? { 'x-sales-token': SALES_TOKEN } : {},
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Sales fetch failed (' + res.getResponseCode() + '): ' + res.getContentText());
  }
  const total = Number((JSON.parse(res.getContentText()).totals || {}).total) || 0;

  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('No tab called "' + SHEET_NAME + '".');
  const dateCol = colNum(DATE_COLUMN), totalCol = colNum(TOTAL_COLUMN);
  const last = sheet.getLastRow();
  const dates = last ? sheet.getRange(1, dateCol, last, 1).getValues() : [];

  // Matches real date cells and text like 2026-09-26 or 26/09/2026.
  let row = 0;
  for (let i = 0; i < dates.length; i++) {
    const v = dates[i][0];
    const key = v instanceof Date ? Utilities.formatDate(v, TIME_ZONE, 'yyyy-MM-dd') : normDay(String(v));
    if (key === day) { row = i + 1; break; }
  }
  if (!row) {
    row = last + 1;
    sheet.getRange(row, dateCol).setValue(Utilities.parseDate(day, TIME_ZONE, 'yyyy-MM-dd'));
  }
  sheet.getRange(row, totalCol).setValue(total);
}

function normDay(s) {
  s = s.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // Australian dd/mm/yyyy
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return '';
}

function colNum(letters) {
  return String(letters).toUpperCase().split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
}
