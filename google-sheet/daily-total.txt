/* ------------------------------------------------------------------ *
 *  Google Apps Script — puts each day's total sales into your sheet.
 * ------------------------------------------------------------------ *
 *  Paste into the sheet: Extensions → Apps Script → replace Code.gs → Save.
 *  Fill in the settings below, then run setup() once (Run ▶, allow access).
 *  From then on it runs on its own.
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
 *  Products tab — every product with its sell price and live stock, checked
 *  against the site every PRODUCTS_EVERY_MINUTES minutes and every time the
 *  sheet is opened (or 🧾 Till → Refresh products now). A product just added
 *  on Squarespace shows up at the TOP of the list with its Cost cell in red,
 *  ready for you to type the cost. Only Name, Price and Stock are ever
 *  rewritten, so the Cost and Brand you type are never touched. Margin and
 *  stock value are formulas and update the moment you type.
 *
 *  Profit tab — one row per trading day (newest first): takings, cost of
 *  goods sold, gross profit, margin and how many items sold had no cost yet,
 *  with a summary box for today / this week / this month / last 30 days.
 *
 *  Charts live on the website now (Admin → 📊 Insights): the sheet sends the
 *  cost prices and brands to the site each refresh, and straight away when
 *  you edit a Cost or Brand cell.
 *
 *  Costs typed on the website (Admin → 🏷️ No cost) come back the other way:
 *  each refresh copies them into the Products tab's Cost column, and from then
 *  on the sheet holds them. Costs typed there for Miscellaneous sales stay on
 *  the site, and the Profit tab counts them.
 *
 *  Cost prices are never guessed. When a product's SKU or price changes, the
 *  site lists it as a new line; each refresh copies the cost from the older
 *  line of the same product (matched by name) into the new line's empty Cost
 *  cell. A cost already in a cell is never overwritten.
 *
 *  Weekly backup — every Sunday night (BACKUP_HOUR) it writes everything the
 *  till keeps on the site into a separate spreadsheet in your Google Drive,
 *  named BACKUP_NAME: every sale and refund since BACKUP_FROM (all stores),
 *  each item sold, expenses, money added, website cost prices, the box → pack
 *  list, and a copy of this sheet's Products tab. Each run rewrites the file
 *  with the full history, and it's the same file every week (its link is under
 *  🧾 Till → Back up now's log, and on the backup's "About" tab). Run it any
 *  time from 🧾 Till → Back up now.
 * ------------------------------------------------------------------ */

const SITE_URL     = 'https://invoiceremactables.netlify.app'; // the till's site
const SALES_TOKEN  = '';          // same as the SALES_TOKEN env var; blank if you didn't set one
const ADMIN_PIN    = '';          // the till's Admin password — type it here in Apps Script (same as ADMIN_PIN on Netlify); never commit it
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
const PRODUCTS_EVERY_MINUTES = 5; // how often new products are pulled in: 1, 5, 10, 15 or 30
const BACKUP_NAME  = 'Till Backup'; // the backup spreadsheet in your Drive; '' to turn the backup off
const BACKUP_FROM  = '2026-07-01';  // first day of sales to include
const BACKUP_HOUR  = 23;            // Sunday, around this hour (0–23, TIME_ZONE)

function setup() {
  const ss = SpreadsheetApp.getActive();
  const mine = ['updateDailyTotal', 'refreshProducts', 'openRefresh', 'onSheetEdit', 'weeklyBackup'];
  ScriptApp.getProjectTriggers()
    .filter(t => mine.indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('updateDailyTotal').timeBased().everyHours(1).create();
  if (PRODUCTS_TAB) {
    ScriptApp.newTrigger('refreshProducts').timeBased().everyMinutes(PRODUCTS_EVERY_MINUTES).create();
    ScriptApp.newTrigger('openRefresh').forSpreadsheet(ss).onOpen().create();
    ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  }
  if (BACKUP_NAME) {
    ScriptApp.newTrigger('weeklyBackup').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY)
      .atHour(BACKUP_HOUR).inTimezone(TIME_ZONE).create();
  }
  removeOldCharts();
  refreshProducts();
  updateDailyTotal();
}

// Menu in the sheet's toolbar. (Runs by itself whenever the sheet opens.)
function onOpen() {
  SpreadsheetApp.getUi().createMenu('🧾 Till')
    .addItem('Refresh products now', 'refreshProducts')
    .addItem('Refresh sales & profit now', 'updateDailyTotal')
    .addItem('Send costs to the website now', 'pushCosts')
    .addItem('Back up now', 'weeklyBackup')
    .addToUi();
}

// Opening the sheet pulls in anything new from Squarespace straight away.
function openRefresh() { refreshProducts(); }

// Typing a cost or brand on the Products tab sends it to the website at once,
// so Admin → Insights has the new profit figures without waiting.
function onSheetEdit(e) {
  if (!e || !e.range || !PRODUCTS_TAB) return;
  if (e.range.getSheet().getName() !== PRODUCTS_TAB || e.range.getRow() < 2) return;
  const c1 = e.range.getColumn(), c2 = e.range.getLastColumn();
  if (c2 < 3 || c1 > 5) return; // only Brand (C), Price (D), Cost (E)
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try { pushCosts(); } catch (err) { console.log('Push costs failed: ' + err.message); }
  finally { lock.releaseLock(); }
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
  if (PROFIT_TAB && PRODUCTS_TAB) {
    try { updateProfit(now); } catch (e) { console.log('Profit skipped: ' + e.message); }
  }
}

// Products refresh on its own (short) timer, so a new product is in the
// sheet within a few minutes of going up on Squarespace.
function refreshProducts() {
  if (!PRODUCTS_TAB) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return; // another refresh is already running
  try {
    updateProducts();
    let copied = [];
    try { copied = fillSiteCosts(); } catch (e) { console.log('Website costs skipped: ' + e.message); }
    carryOverCosts();
    try {
      pushCosts();
      if (copied.length) clearSiteCosts(copied); // only once the site has the sheet's copy
    } catch (e) { console.log('Push costs failed: ' + e.message); }
  } finally { lock.releaseLock(); }
}

/* ---------------- products, cost price & brands ---------------- */

const PRODUCT_HEADS = ['Barcode', 'Name', 'Brand', 'Price', 'Cost', 'Stock',
  'Margin $', 'Margin %', 'Stock value (cost)', 'Stock value (retail)', 'Added'];
const STYLE_VERSION = '2'; // bump to re-apply the tab styling
const HEAD_BG = '#1a73e8', HEAD_INK = '#ffffff', INK = '#202124';

// Brand guessed from the product name when the Brand cell is empty or
// "Other". First match wins, so put the more specific rules first. Anything
// else you type in the Brand column yourself is kept and beats these guesses. (index.html has the
// same list, for products the sheet hasn't sent yet — keep the two in step.)
const BRAND_RULES = [
  ['Pokémon (Japanese)', /pok[eé]mon/i, /japan|\bjp\b|\bjpn\b/i],
  ['Pokémon (English)',  /pok[eé]mon/i],
  ['One Piece',          /one\s*piece/i],
  ['Yu-Gi-Oh!',          /yu-?gi-?oh/i],
  ['Magic: The Gathering', /magic|\bmtg\b/i],
  ['Lorcana',            /lorcana/i],
  ['Dragon Ball',        /dragon\s*ball/i],
  ['Digimon',            /digimon/i],
  ['Weiss Schwarz',      /wei(ss|ß)\s*schwarz/i],
  ['Flesh and Blood',    /flesh\s*(and|&)\s*blood/i],
  ['Star Wars',          /star\s*wars/i],
  // Sport — checked after the card games, so "Pokémon World Championships" stays Pokémon.
  ['AFL',                /\bafl\b|footy|teamcoach|aussie rules/i],
  ['NRL',                /\bnrl\b|rugby league|state of origin/i],
  ['Rugby',              /rugby|wallabies/i],
  ['NFL',                /\bnfl\b|american football|optic football|donruss.*football|football.*(donruss|mosaic|prizm)/i],
  ['Soccer',             /soccer|premier league|champions league|uefa|fifa|world cup|adrenalyn|match attax|a-?league|matildas|socceroos|la liga|serie a|bundesliga|\bepl\b/i],
  ['Basketball',         /\bnba\b|\bnbl\b|\bwnba\b|basketball|hoops/i],
  ['F1',                 /\bf1\b|formula\s*(1|one)|turbo attax/i],
  ['Cricket',            /cricket|\bbbl\b|\bipl\b/i],
  ['Tennis',             /tennis/i],
  ['Baseball',           /\bmlb\b|baseball/i],
  ['Wrestling & UFC',    /\bwwe\b|\baew\b|wrestl|\bufc\b/i],
  ['Harry Potter',       /harry\s*potter/i],
];

function guessBrand(name) {
  const n = String(name || '');
  for (const r of BRAND_RULES) {
    if (r.slice(1).every(re => re.test(n))) return r[0];
  }
  return 'Other';
}

function tabNamed(name) {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// Last row with something in column A (array formulas elsewhere don't count).
function lastDataRow(sheet) {
  const colA = sheet.getRange('A:A').getValues();
  let last = colA.length;
  while (last > 0 && String(colA[last - 1][0]).trim() === '') last--;
  return last;
}

// What you've typed in the Products tab, keyed by barcode: { cost, brand }.
// Columns are found by heading, so tabs made by the older script still work.
function readProducts() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(PRODUCTS_TAB);
  const out = {};
  if (!sheet) return out;
  const last = lastDataRow(sheet);
  if (last < 2) return out;
  const vals = sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues();
  const heads = vals[0].map(h => String(h).trim().toLowerCase());
  const cSku = heads.indexOf('barcode'), cName = heads.indexOf('name'),
    cCost = heads.indexOf('cost'), cBrand = heads.indexOf('brand');
  vals.slice(1).forEach(r => {
    const sku = String(r[cSku]).trim();
    if (!sku) return;
    const c = cCost < 0 ? '' : r[cCost];
    out[sku] = {
      name: cName < 0 ? '' : String(r[cName]),
      cost: c !== '' && c !== null && isFinite(Number(c)) ? Number(c) : null,
      brand: cBrand < 0 ? '' : String(r[cBrand]).trim(),
    };
  });
  return out;
}

// Brings the Products tab in line with the live catalog WITHOUT rewriting the
// whole tab: existing rows get their Name, Price and Stock updated in place
// (Cost and Brand are never written, so typing while it runs is safe), and
// new products are added at the top. Products that disappear from the
// catalog stay, marked "(no longer in catalog)", so nothing you typed is lost.
function updateProducts() {
  const res = UrlFetchApp.fetch(SITE_URL.replace(/\/$/, '') + '/api/catalog', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('catalog fetch failed (' + res.getResponseCode() + ')');
  const items = JSON.parse(res.getContentText()).items || [];
  if (!items.length) throw new Error('catalog came back empty — not touching the Products tab');

  const sheet = tabNamed(PRODUCTS_TAB);
  styleProducts(sheet);
  const last = lastDataRow(sheet);
  const vals = last > 1 ? sheet.getRange(2, 1, last - 1, 6).getValues() : [];
  const rowOf = {};
  vals.forEach((r, i) => { const s = String(r[0]).trim(); if (s && !(s in rowOf)) rowOf[s] = i; });

  const seen = {}, fresh = [], reBrand = [];
  items.forEach(it => {
    const sku = String(it.sku).trim();
    if (!sku || seen[sku]) return;
    seen[sku] = true;
    const price = Number(it.price) || 0;
    const stock = it.stock === null || it.stock === undefined ? '' : Number(it.stock);
    if (sku in rowOf) {
      const r = vals[rowOf[sku]];
      r[1] = it.name; r[3] = price; r[5] = stock;
      // A blank or "Other" brand gets another guess, so new brand rules reach
      // products already in the tab. A brand you've typed is never changed.
      const b = String(r[2]).trim();
      if (!b || b === 'Other') {
        const g = guessBrand(it.name);
        if (g !== b) reBrand.push([rowOf[sku] + 2, g]);
      }
    } else {
      fresh.push([sku, it.name, guessBrand(it.name), price, '', stock]); // cost: carried over from the same product, never guessed
    }
  });
  vals.forEach(r => {
    const s = String(r[0]).trim();
    if (!s || seen[s]) return;
    r[5] = '';
    if (String(r[1]).indexOf('(no longer in catalog)') !== 0) r[1] = '(no longer in catalog) ' + r[1];
  });

  // Existing rows first (before inserting shifts them): three narrow columns.
  const n = vals.length;
  if (n) {
    sheet.getRange(2, 2, n, 1).setValues(vals.map(r => [r[1]]));
    sheet.getRange(2, 4, n, 1).setValues(vals.map(r => [r[3]]));
    sheet.getRange(2, 6, n, 1).setValues(vals.map(r => [r[5]]));
    // Brand is only written cell by cell, and only where it was blank or "Other".
    reBrand.forEach(([row, brand]) => sheet.getRange(row, 3).setValue(brand));
    if (reBrand.length) console.log('Brands re-guessed: ' + reBrand.length);
  }
  if (fresh.length) {
    const k = fresh.length;
    sheet.insertRowsBefore(2, k);
    const rows = sheet.getRange(2, 1, k, PRODUCT_HEADS.length);
    // Rows inserted under the header copy its look — put them back to plain.
    rows.setFontWeight('normal').setFontColor(INK).setBackground(null).setWrap(false);
    sheet.getRange(2, 1, k, 3).setHorizontalAlignment('left');
    sheet.getRange(2, 4, k, 8).setHorizontalAlignment('right');
    sheet.setRowHeights(2, k, 21);
    sheet.getRange(2, 1, k, 1).setNumberFormat('@'); // keep long barcodes as text
    sheet.getRange(2, 11, k, 1).setNumberFormat('@');
    sheet.getRange(2, 1, k, 6).setValues(fresh);
    // The first fill of an empty tab isn't "new", so it gets no Added date.
    const added = n ? Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd') : '';
    sheet.getRange(2, 11, k, 1).setValues(fresh.map(() => [added]));
    // Inserting at row 2 shifts the column formulas' A2:A down to A3:A etc.,
    // misaligning margins with their rows — put them back on row 2.
    setMarginFormulas(sheet);
    console.log('New products: ' + k);
  }
  productFormats(sheet);
}

// Number formats on whole columns, so new rows pick them up too.
function productFormats(sheet) {
  const max = sheet.getMaxRows();
  if (max < 2) return;
  sheet.getRange(2, 4, max - 1, 2).setNumberFormat('$#,##0.00');
  sheet.getRange(2, 6, max - 1, 1).setNumberFormat('0');
  sheet.getRange(2, 7, max - 1, 1).setNumberFormat('$#,##0.00');
  sheet.getRange(2, 8, max - 1, 1).setNumberFormat('0.0%');
  sheet.getRange(2, 9, max - 1, 2).setNumberFormat('$#,##0.00');
}

// Column-wide Margin / Stock value formulas in G1:J1, starting at row 2.
function setMarginFormulas(sheet) {
  sheet.getRange(1, 7, 1, 4).setFormulas([[
    '={"Margin $";ARRAYFORMULA(IF((A2:A="")+(D2:D="")+(E2:E=""),"",D2:D-E2:E))}',
    '={"Margin %";ARRAYFORMULA(IFERROR(IF((A2:A="")+(D2:D="")+(E2:E="")+(D2:D=0),"",(D2:D-E2:E)/D2:D),""))}',
    '={"Stock value (cost)";ARRAYFORMULA(IF((A2:A="")+(E2:E="")+(F2:F=""),"",E2:E*F2:F))}',
    '={"Stock value (retail)";ARRAYFORMULA(IF((A2:A="")+(D2:D="")+(F2:F=""),"",D2:D*F2:F))}',
  ]]);
}

// One-off look & layout for the Products tab: coloured header, margin
// formulas that fill the whole column, red Cost cells where a cost is still
// missing, margin colours, filter buttons, frozen header and name column.
function styleProducts(sheet) {
  const props = PropertiesService.getDocumentProperties();
  if (props.getProperty('productsStyle') === STYLE_VERSION && String(sheet.getRange('G1').getFormula())) return;

  const w = PRODUCT_HEADS.length;
  if (sheet.getMaxColumns() < w) sheet.insertColumnsAfter(sheet.getMaxColumns(), w - sheet.getMaxColumns());
  // The old script put a formula on every row of G:J — the column-wide
  // formulas below need those cells empty.
  const last = lastDataRow(sheet);
  if (last > 1) sheet.getRange(2, 7, last - 1, 4).clearContent();
  sheet.getRange(1, 1, 1, 6).setValues([PRODUCT_HEADS.slice(0, 6)]);
  sheet.getRange(1, 11).setValue(PRODUCT_HEADS[10]);
  setMarginFormulas(sheet);

  const head = sheet.getRange(1, 1, 1, w);
  head.setBackground(HEAD_BG).setFontColor(HEAD_INK).setFontWeight('bold')
    .setVerticalAlignment('middle').setWrap(true);
  sheet.getRange(1, 5).setBackground('#f9ab00').setFontColor('#202124')
    .setNote('Type your cost price here (incl GST, same as Price). It is kept every refresh. Red = still needs a cost.');
  sheet.setRowHeight(1, 36);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);
  [130, 340, 160, 90, 90, 70, 90, 85, 120, 125, 95].forEach((px, i) => sheet.setColumnWidth(i + 1, px));
  sheet.getRange(1, 4, sheet.getMaxRows(), 8).setHorizontalAlignment('right');
  sheet.getRange(1, 1, 1, w).setHorizontalAlignment('center');

  sheet.getBandings().forEach(b => b.remove());
  sheet.getRange(1, 1, sheet.getMaxRows(), w)
    .applyRowBanding(SpreadsheetApp.BandingTheme.BLUE, true, false)
    .setHeaderRowColor(HEAD_BG).setFirstRowColor('#ffffff').setSecondRowColor('#f1f6fe');

  const all = r => sheet.getRange(r + '2:' + r + sheet.getMaxRows());
  const rules = [
    // Cost still to type: red. Filled in: soft yellow, so the typing column stands out.
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($A2<>"",$E2="")')
      .setBackground('#fad2cf').setRanges([all('E')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$E2<>""')
      .setBackground('#fef7e0').setRanges([all('E')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($H2<>"",$H2<0)')
      .setFontColor('#c5221f').setBold(true).setRanges([all('G'), all('H')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($H2<>"",$H2<0.15)')
      .setFontColor('#b06000').setRanges([all('G'), all('H')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($H2<>"",$H2>=0.15)')
      .setFontColor('#137333').setRanges([all('G'), all('H')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($F2<>"",$F2<=0)')
      .setFontColor('#c5221f').setRanges([all('F')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=LEFT($B2,22)="(no longer in catalog)"')
      .setFontColor('#9aa0a6').setItalic(true).setRanges([all('A'), all('B'), all('C')]).build(),
  ];
  sheet.setConditionalFormatRules(rules);

  if (!sheet.getFilter()) sheet.getRange(1, 1, sheet.getMaxRows(), w).createFilter();
  productFormats(sheet);
  props.setProperty('productsStyle', STYLE_VERSION);
}

// Sends every product's cost and brand to the site (Admin → Insights reads it).
function pushCosts() {
  const prods = readProducts();
  const items = Object.keys(prods).map(sku => ({ sku, cost: prods[sku].cost, brand: prods[sku].brand, name: prods[sku].name }));
  if (!items.length) return;
  const res = UrlFetchApp.fetch(SITE_URL.replace(/\/$/, '') + '/api/costs', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ items }),
    headers: authHeaders(), muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode() + ': ' + res.getContentText());
}

// Cost prices from the site: the full list (sheet + website-typed) and the
// Miscellaneous line costs. Null if the site can't be reached.
function fetchSiteCosts() {
  const res = UrlFetchApp.fetch(SITE_URL.replace(/\/$/, '') + '/api/costs', { headers: authHeaders(), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode() + ': ' + res.getContentText());
  return JSON.parse(res.getContentText());
}

// Costs typed on the website (Admin → 🏷️ No cost) for products sold with no
// cost: write them into the Products tab's Cost column. The website entry is
// the newest thing typed, so it wins. Returns the barcodes copied, which
// clearSiteCosts() then removes from the site — the sheet holds them now.
function fillSiteCosts() {
  const site = fetchSiteCosts();
  const manual = (site && site.manual) || {};
  if (!Object.keys(manual).length) return [];
  const sheet = SpreadsheetApp.getActive().getSheetByName(PRODUCTS_TAB);
  const last = sheet ? lastDataRow(sheet) : 0;
  if (last < 2) return [];
  const vals = sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues();
  const heads = vals[0].map(h => String(h).trim().toLowerCase());
  const cSku = heads.indexOf('barcode'), cCost = heads.indexOf('cost');
  if (cSku < 0 || cCost < 0) return [];
  const norm = v => String(v).trim().toUpperCase().replace(/\s+/g, '');
  const done = [];
  vals.slice(1).forEach((r, i) => {
    const k = norm(r[cSku]);
    const m = k && manual[k];
    if (!m || m.cost === null || m.cost === undefined) return;
    if (Number(r[cCost]) !== Number(m.cost) || r[cCost] === '') {
      sheet.getRange(i + 2, cCost + 1).setValue(Number(m.cost)).setNumberFormat('$#,##0.00');
    }
    done.push(k);
  });
  console.log('Website costs copied in: ' + done.length);
  return done;
}

function clearSiteCosts(skus) {
  const res = UrlFetchApp.fetch(SITE_URL.replace(/\/$/, '') + '/api/costs', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ clear: skus }),
    headers: authHeaders(), muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) console.log('Clearing website costs failed: HTTP ' + res.getResponseCode());
}

function authHeaders() {
  const h = {};
  if (SALES_TOKEN) h['x-sales-token'] = SALES_TOKEN;
  if (ADMIN_PIN) h['x-admin-pin'] = ADMIN_PIN;
  return h;
}

/* ---------------- carry a cost over to the same product's new line ---------------- */

// Same product, ignoring case, spacing, punctuation and accents — and the
// "(no longer in catalog)" tag the sheet puts on a line that has been replaced.
function productKey(name) {
  return String(name || '').replace(/^\(no longer in catalog\)\s*/i, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// When a product's SKU or price changes, the site lists it as a new line and
// the old line is left behind with the cost you typed. This copies that cost
// onto the new line: any line with an EMPTY Cost cell gets the cost of another
// line with the same product name. A cost already in a cell is never changed,
// and nothing is guessed — a product with no costed line stays blank (red).
// Costs are per product, so lines are matched by name only.
function carryOverCosts() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(PRODUCTS_TAB);
  const last = sheet ? lastDataRow(sheet) : 0;
  if (last < 2) return 0;
  const vals = sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues();
  const heads = vals[0].map(h => String(h).trim().toLowerCase());
  const cName = heads.indexOf('name'), cCost = heads.indexOf('cost');
  if (cName < 0 || cCost < 0) return 0;
  const has = c => c !== '' && c !== null && isFinite(Number(c));
  const costOf = {};
  // Oldest lines are at the bottom, so go bottom-up: the newest costed line wins.
  for (let i = vals.length - 1; i >= 1; i--) {
    const k = productKey(vals[i][cName]);
    if (k && has(vals[i][cCost])) costOf[k] = Number(vals[i][cCost]);
  }
  let filled = 0;
  vals.slice(1).forEach((r, i) => {
    if (has(r[cCost])) return;
    const k = productKey(r[cName]);
    if (!k || !(k in costOf)) return;
    sheet.getRange(i + 2, cCost + 1).setValue(costOf[k]).setNumberFormat('$#,##0.00');
    filled++;
  });
  console.log('Costs carried over to new lines: ' + filled);
  return filled;
}

// For the last EXPENSE_LOOKBACK days: one row per day in the Profit tab.
// Older days are kept as they are. Newest day at the top.
function updateProfit(now) {
  const prods = readProducts();
  // Website costs: products not yet copied into the sheet, and Miscellaneous
  // lines (costed per sale, as "<invoice no>#<line>").
  let site = null;
  try { site = fetchSiteCosts(); } catch (e) { console.log('Website costs skipped: ' + e.message); }
  const siteItems = {};
  Object.keys((site && site.items) || {}).forEach(k => {
    siteItems[String(k).trim().toUpperCase().replace(/\s+/g, '')] = site.items[k];
  });
  const miscCosts = (site && site.misc) || {};
  const costOf = sku => {
    if (prods[sku] && prods[sku].cost !== null) return prods[sku].cost;
    const s = siteItems[sku.toUpperCase().replace(/\s+/g, '')];
    return s && s.cost !== null && s.cost !== undefined ? Number(s.cost) : null;
  };
  const isMisc = it => !String(it.sku || '').trim() || /^MISC-/i.test(String(it.sku));

  removeOldCharts();
  const sheet = tabNamed(PROFIT_TAB);
  const heads = ['Date', 'Takings', 'Cost of goods', 'Gross profit', 'Margin %', 'Items without cost'];
  sheet.getRange(1, 1, 1, heads.length).setValues([heads]);
  const last0 = lastDataRow(sheet);
  let last = last0;
  const rowOf = {};
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
      (s.items || []).forEach((it, i) => {
        const q = Number(it.qty) || 0;
        const m = isMisc(it) ? miscCosts[s.no + '#' + i] : null;
        const c = isMisc(it) ? (m && m.cost !== null && m.cost !== undefined ? Number(m.cost) : null)
          : costOf(String(it.sku || '').trim());
        if (c !== null) cogs += c * q; else missing += q;
      });
    });
    takings = Math.round(takings * 100) / 100;
    cogs = Math.round(cogs * 100) / 100;
    let row = rowOf[day];
    if (!row) { row = ++last; rowOf[day] = row; }
    sheet.getRange(row, 1).setNumberFormat('@').setValue(day);
    sheet.getRange(row, 2, 1, 5).setValues([[takings, cogs, Math.round((takings - cogs) * 100) / 100,
      takings ? (takings - cogs) / takings : '', missing]]);
  }
  if (last > 1) {
    const n = last - 1;
    sheet.getRange(2, 1, n, heads.length).sort({ column: 1, ascending: false });
  }
  styleProfit(sheet);
}

// The graphs and brand/month tables the older script made — gone. The charts
// are on the website now (Admin → 📊 Insights).
function removeOldCharts() {
  const ss = SpreadsheetApp.getActive();
  const sheet = PROFIT_TAB && ss.getSheetByName(PROFIT_TAB);
  if (sheet) {
    sheet.getCharts().forEach(c => sheet.removeChart(c));
    if (String(sheet.getRange('H1').getValue()) === 'By brand (all time)') {
      sheet.getRange('H:N').clear();
    }
  }
  const lines = ss.getSheetByName('Sales lines');
  if (lines && ss.getSheets().length > 1) ss.deleteSheet(lines);
}

// Look & layout for the Profit tab, plus a summary box on the right that
// answers "how are we doing" without scrolling: today, this week, this month,
// last 30 days, this year and all time.
function styleProfit(sheet) {
  const max = sheet.getMaxRows();
  sheet.getRange(2, 2, max - 1, 3).setNumberFormat('$#,##0.00');
  sheet.getRange(2, 5, max - 1, 1).setNumberFormat('0.0%');
  sheet.getRange(2, 6, max - 1, 1).setNumberFormat('0');

  const props = PropertiesService.getDocumentProperties();
  if (props.getProperty('profitStyle') === STYLE_VERSION) return;

  if (sheet.getMaxColumns() < 13) sheet.insertColumnsAfter(sheet.getMaxColumns(), 13 - sheet.getMaxColumns());
  sheet.getRange(1, 1, 1, 6).setBackground(HEAD_BG).setFontColor(HEAD_INK).setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sheet.setRowHeight(1, 36);
  sheet.setFrozenRows(1);
  [110, 110, 120, 120, 90, 110, 24, 130, 120, 120, 120, 90].forEach((px, i) => sheet.setColumnWidth(i + 1, px));
  sheet.getRange(2, 1, max - 1, 1).setHorizontalAlignment('left').setFontWeight('bold');

  sheet.getBandings().forEach(b => b.remove());
  sheet.getRange(1, 1, max, 6).applyRowBanding(SpreadsheetApp.BandingTheme.BLUE, true, false)
    .setHeaderRowColor(HEAD_BG).setFirstRowColor('#ffffff').setSecondRowColor('#f1f6fe');

  const col = r => sheet.getRange(r + '2:' + r + max);
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0)
      .setFontColor('#c5221f').setBold(true).setRanges([col('D'), col('E')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0)
      .setFontColor('#137333').setRanges([col('D')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0)
      .setBackground('#fad2cf').setRanges([col('F')]).build(),
  ]);
  sheet.getRange('F1').setNote('Items sold that have no cost on the Products tab yet — their cost is missing from Cost of goods, so profit reads high until you fill them in.');

  // Summary box (H1:L8). Dates in column A are text (yyyy-mm-dd), so the
  // FILTERs compare them as text, which sorts the same as the dates do.
  const iso = x => 'TEXT(' + x + ',"yyyy-mm-dd")';
  const periods = [
    ['Today', 'TODAY()', 'TODAY()'],
    ['This week', 'TODAY()-WEEKDAY(TODAY(),3)', 'TODAY()'],
    ['This month', 'EOMONTH(TODAY(),-1)+1', 'TODAY()'],
    ['Last 30 days', 'TODAY()-29', 'TODAY()'],
    ['This year', 'DATE(YEAR(TODAY()),1,1)', 'TODAY()'],
    ['All time', 'DATE(2000,1,1)', 'TODAY()'],
  ];
  sheet.getRange('H1:L1').setValues([['Summary', 'Takings', 'Cost of goods', 'Gross profit', 'Margin']])
    .setBackground('#188038').setFontColor('#ffffff').setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  const sum = (c, p) => '=IFERROR(SUM(FILTER($' + c + '$2:$' + c + ',$A$2:$A>=' + iso(p[1]) + ',$A$2:$A<=' + iso(p[2]) + ')),0)';
  sheet.getRange(2, 8, periods.length, 5).setFormulas(periods.map((p, i) => [
    '="' + p[0] + '"', sum('B', p), sum('C', p), sum('D', p), '=IF(I' + (i + 2) + '=0,"",K' + (i + 2) + '/I' + (i + 2) + ')',
  ]));
  const box = sheet.getRange(2, 8, periods.length, 5);
  box.setBackground('#e6f4ea').setBorder(true, true, true, true, true, true, '#ceead6', SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange(2, 8, periods.length, 1).setFontWeight('bold').setHorizontalAlignment('left');
  sheet.getRange(2, 9, periods.length, 3).setNumberFormat('$#,##0.00');
  sheet.getRange(2, 12, periods.length, 1).setNumberFormat('0.0%');
  sheet.getRange('H9').setValue('Charts: till website → Admin → 📊 Insights').setFontColor('#5f6368').setFontStyle('italic');
  props.setProperty('profitStyle', STYLE_VERSION);
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

/* ---------------- weekly backup to Google Drive ---------------- */

// Rewrites the backup spreadsheet with everything the site holds. Every part is
// fetched before anything is written, so a failed fetch leaves last week's
// backup as it was instead of half-empty.
function weeklyBackup() {
  if (!BACKUP_NAME) return;
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

  const ss = backupFile();
  writeTab(ss, 'Sales', ['Date', 'Time', 'Store', 'Invoice', 'Type', 'Refund of', 'Served by', 'Customer', 'Contact', 'Order',
    'Method', 'Card', 'Cash', 'Discount', 'Subtotal ex GST', 'GST', 'Total', 'Voided', 'Refunds', 'Picked up'], saleRows, [12, 13, 14, 15, 16, 17]);
  writeTab(ss, 'Items sold', ['Date', 'Store', 'Invoice', 'Type', 'Barcode', 'Name', 'Price', 'Qty', 'Line total', 'Voided'], lineRows, [7, 9], [8]);
  writeEntries(ss, 'Expenses', expenses);
  writeEntries(ss, 'Money added', added);
  writeTab(ss, 'Website costs', ['Barcode', 'Name', 'Brand', 'Cost'], costRows, [4]);
  writeTab(ss, 'Boxes', ['Box barcode', 'Pack barcode', 'Packs per box', 'Name'], boxRows, [], [3]);
  if (PRODUCTS_TAB) {
    const src = SpreadsheetApp.getActive().getSheetByName(PRODUCTS_TAB);
    if (src && src.getLastRow() > 0) {
      const vals = src.getRange(1, 1, src.getLastRow(), src.getLastColumn()).getValues();
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

// The backup spreadsheet: the one made last time (its id is remembered), or a new one.
function backupFile() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('BACKUP_ID');
  if (id) {
    try {
      const f = DriveApp.getFileById(id);
      if (!f.isTrashed()) return SpreadsheetApp.openById(id);
    } catch (e) { console.log('Backup file gone, making a new one: ' + e.message); }
  }
  const ss = SpreadsheetApp.create(BACKUP_NAME);
  props.setProperty('BACKUP_ID', ss.getId());
  return ss;
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
