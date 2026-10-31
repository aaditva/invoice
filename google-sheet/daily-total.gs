/* ------------------------------------------------------------------ *
 *  Google Apps Script — puts each day's total sales into your sheet.
 * ------------------------------------------------------------------ *
 *  Paste into the sheet: Extensions → Apps Script → replace Code.gs → Save.
 *  Fill in the settings below, then run setup() once (Run ▶, allow access).
 *  From then on it runs on its own.
 *
 *  How it writes: it opens the tab named after the year (SHEET_NAME, e.g. "2026 SM"), finds
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
 *  Barcode changed? If a new product has EXACTLY the same name as a row
 *  already in the tab (e.g. the old barcode's row), its Cost is copied from
 *  that row, so you don't type it again. No exact name match = no copy.
 *
 *  A product is never removed from the tab — even if you delete it from
 *  Squarespace. Its row stays with its name, last price, cost and brand
 *  (so the site's profit and brand charts keep counting its past sales);
 *  only its Stock is blanked and the "Squarespace" column says when it
 *  went. Put it back on Squarespace and that note clears by itself.
 *
 *  Profit tab — one row per trading day (newest first): takings, cost of
 *  goods sold, gross profit, margin and how many items sold had no cost yet,
 *  with a summary box for today / this week / this month / last 30 days.
 *  Website (Squarespace) orders are counted here too (INCLUDE_ONLINE), with
 *  shipping left out of takings, the same as Admin → Insights. They are read
 *  with ADMIN_PIN, so it must be filled in. The daily Games column stays
 *  store-only.
 *
 *  Charts live on the website now (Admin → 📊 Insights): the sheet sends the
 *  cost prices and brands to the site each refresh, and straight away when
 *  you edit a Cost or Brand cell.
 *
 *  Costs typed on the website (Admin → 🏷️ No cost) come back the other way:
 *  each refresh copies them into the Products tab's Cost column, and from then
 *  on the sheet holds them. Costs typed there for Miscellaneous sales stay on
 *  the site, and the Profit tab counts them.
 * ------------------------------------------------------------------ */

const SITE_URL     = 'https://invoiceremactables.netlify.app'; // the till's site
const SALES_TOKEN  = '';          // same as the SALES_TOKEN env var; blank if you didn't set one
const ADMIN_PIN    = '';          // the till's Admin password — type it here in Apps Script (same as ADMIN_PIN on Netlify); never commit it
const STORE        = 'south-melbourne'; // 'all', or one store id, e.g. 'south-melbourne' or 'roxy'
const SHEET_NAME   = '{year} SM'; // the tab to write into; {year} becomes e.g. 2026, so "2026 SM" (must match the tab name exactly)
const DATE_COLUMN  = 'A';         // column holding the dates
const TOTAL_HEADER = 'Games';     // row-1 heading of the column the total goes into
const EXPENSES_HEADER  = 'Expenses'; // row-1 heading of the expenses column; '' to turn off
const EXPENSE_LOOKBACK = 14;         // days back to re-check for late-entered expenses / money added
const MONEY_ADDED_HEADER = 'Money Added'; // row-1 heading of the money-added column; '' to turn off
const TIME_ZONE    = 'Australia/Melbourne';
const PRODUCTS_TAB = 'Products';  // tab listing products, stock and YOUR cost price; '' to turn off
const PROFIT_TAB   = 'Profit';    // tab with daily takings / cost / profit; '' to turn off
const INCLUDE_ONLINE = true;      // Profit tab also counts website (Squarespace) orders, like Admin → Insights does
const PRODUCTS_EVERY_MINUTES = 5; // how often new products are pulled in: 1, 5, 10, 15 or 30

function setup() {
  const ss = SpreadsheetApp.getActive();
  const mine = ['updateDailyTotal', 'refreshProducts', 'openRefresh', 'onSheetEdit'];
  ScriptApp.getProjectTriggers()
    .filter(t => mine.indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('updateDailyTotal').timeBased().everyHours(1).create();
  if (PRODUCTS_TAB) {
    ScriptApp.newTrigger('refreshProducts').timeBased().everyMinutes(PRODUCTS_EVERY_MINUTES).create();
    ScriptApp.newTrigger('openRefresh').forSpreadsheet(ss).onOpen().create();
    ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
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
  // Also re-check the last EXPENSE_LOOKBACK days (like expenses below), so a day
  // the script missed — e.g. while the tab was renamed — is put right, not left short.
  try { writeByDay('sales', TOTAL_HEADER, now); } catch (e) { console.log('Sales catch-up skipped: ' + e.message); }
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
    fillSameNameCosts();
    fillInvoiceCosts();
    try {
      pushCosts();
      if (copied.length) clearSiteCosts(copied); // only once the site has the sheet's copy
    } catch (e) { console.log('Push costs failed: ' + e.message); }
  } finally { lock.releaseLock(); }
}

/* ---------------- products, cost price & brands ---------------- */

const PRODUCT_HEADS = ['Barcode', 'Name', 'Brand', 'Price', 'Cost', 'Stock',
  'Margin $', 'Margin %', 'Stock value (cost)', 'Stock value (retail)', 'Added', 'Squarespace'];
const GONE = '(no longer in catalog) '; // the old script put this in front of the name
const STYLE_VERSION = '4'; // bump to re-apply the tab styling
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
      name: cName < 0 ? '' : String(r[cName]).replace(GONE, ''),
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
// catalog are NEVER removed: the row keeps its name, price, cost and brand,
// its stock goes blank and column L says "Removed <date>", so its sales
// still count for profit. If it comes back, column L clears.
function updateProducts() {
  const res = UrlFetchApp.fetch(SITE_URL.replace(/\/$/, '') + '/api/catalog', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('catalog fetch failed (' + res.getResponseCode() + ')');
  // Products deleted from Squarespace still come back (removed:true) so they
  // keep scanning at the till — here they count as gone.
  const items = (JSON.parse(res.getContentText()).items || []).filter(it => !it.removed);
  if (!items.length) throw new Error('catalog came back empty — not touching the Products tab');

  const sheet = tabNamed(PRODUCTS_TAB);
  styleProducts(sheet);
  const last = lastDataRow(sheet);
  const vals = last > 1 ? sheet.getRange(2, 1, last - 1, 6).getValues() : [];
  const gone = last > 1 ? sheet.getRange(2, 12, last - 1, 1).getValues() : [];
  const today = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
  const rowOf = {};
  vals.forEach((r, i) => { const s = String(r[0]).trim(); if (s && !(s in rowOf)) rowOf[s] = i; });

  // Costs already in the tab by exact product name, so a product whose
  // barcode changed on Squarespace keeps the cost of its old row.
  const costByName = {};
  vals.forEach(r => {
    const k = nameKey(r[1]);
    if (k && !(k in costByName) && r[4] !== '' && r[4] !== null && isFinite(Number(r[4]))) costByName[k] = Number(r[4]);
  });

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
      gone[rowOf[sku]][0] = '';
      // A blank or "Other" brand gets another guess, so new brand rules reach
      // products already in the tab. A brand you've typed is never changed.
      const b = String(r[2]).trim();
      if (!b || b === 'Other') {
        const g = guessBrand(it.name);
        if (g !== b) reBrand.push([rowOf[sku] + 2, g]);
      }
    } else {
      const k = nameKey(it.name);
      const cost = k in costByName ? costByName[k] : invoiceCostFor(it.name);
      fresh.push([sku, it.name, guessBrand(it.name), price, cost === null ? '' : cost, stock]);
    }
  });
  vals.forEach((r, i) => {
    const s = String(r[0]).trim();
    if (!s || seen[s]) return;
    r[5] = '';                                      // not for sale any more → no stock value
    r[1] = String(r[1]).replace(GONE, '');          // keep its real name (old rows had a prefix)
    if (!String(gone[i][0]).trim()) gone[i][0] = 'Removed ' + today;
  });

  // Existing rows first (before inserting shifts them): three narrow columns.
  const n = vals.length;
  if (n) {
    sheet.getRange(2, 2, n, 1).setValues(vals.map(r => [r[1]]));
    sheet.getRange(2, 4, n, 1).setValues(vals.map(r => [r[3]]));
    sheet.getRange(2, 6, n, 1).setValues(vals.map(r => [r[5]]));
    sheet.getRange(2, 12, n, 1).setValues(gone);
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
    const added = n ? today : '';
    sheet.getRange(2, 11, k, 1).setValues(fresh.map(() => [added]));
    productRules(sheet);
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
  sheet.getRange(1, 11, 1, 2).setValues([PRODUCT_HEADS.slice(10, 12)]);
  // Whole-column references (A:A, not A2:A): new products are inserted at
  // row 2, and Sheets shifts an "A2:A" reference down to "A3:A" when rows go
  // in above it — that put every G:J value one row out per insert.
  sheet.getRange(1, 7, 1, 4).setFormulas([[
    '=ARRAYFORMULA(IF(ROW(A:A)=1,"Margin $",IF((A:A="")+(D:D="")+(E:E=""),"",D:D-E:E)))',
    '=ARRAYFORMULA(IF(ROW(A:A)=1,"Margin %",IFERROR(IF((A:A="")+(D:D="")+(E:E="")+(D:D=0),"",(D:D-E:E)/D:D),"")))',
    '=ARRAYFORMULA(IF(ROW(A:A)=1,"Stock value (cost)",IF((A:A="")+(E:E="")+(F:F=""),"",E:E*F:F)))',
    '=ARRAYFORMULA(IF(ROW(A:A)=1,"Stock value (retail)",IF((A:A="")+(D:D="")+(F:F=""),"",D:D*F:F)))',
  ]]);

  const head = sheet.getRange(1, 1, 1, w);
  head.setBackground(HEAD_BG).setFontColor(HEAD_INK).setFontWeight('bold')
    .setVerticalAlignment('middle').setWrap(true);
  sheet.getRange(1, 5).setBackground('#f9ab00').setFontColor('#202124')
    .setNote('Type your cost price here (incl GST, same as Price). It is kept every refresh. Red = still needs a cost.');
  sheet.setRowHeight(1, 36);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);
  [130, 340, 160, 90, 90, 70, 90, 85, 120, 125, 95, 140].forEach((px, i) => sheet.setColumnWidth(i + 1, px));
  sheet.getRange(1, 4, sheet.getMaxRows(), 8).setHorizontalAlignment('right');
  sheet.getRange(1, 1, 1, w).setHorizontalAlignment('center');

  sheet.getBandings().forEach(b => b.remove());
  sheet.getRange(1, 1, sheet.getMaxRows(), w)
    .applyRowBanding(SpreadsheetApp.BandingTheme.BLUE, true, false)
    .setHeaderRowColor(HEAD_BG).setFirstRowColor('#ffffff').setSecondRowColor('#f1f6fe');

  productRules(sheet);

  if (!sheet.getFilter()) sheet.getRange(1, 1, sheet.getMaxRows(), w).createFilter();
  productFormats(sheet);
  props.setProperty('productsStyle', STYLE_VERSION);
}

// Colour rules for the Products tab. Re-applied after new rows are inserted
// at row 2, because the insert shifts the rule ranges down off row 2.
function productRules(sheet) {
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
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$L2<>""')
      .setFontColor('#9aa0a6').setItalic(true).setRanges([all('A'), all('B'), all('C'), all('L')]).build(),
  ];
  sheet.setConditionalFormatRules(rules);
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

/* ---------------- cost prices from supplier invoices ---------------- */

// Cost prices from the Banter Toys invoices (Feb–Sep 2026): the invoice unit
// price (ex GST) plus $0.50 per item to cover delivery — delivery is folded
// into each item's cost, never counted separately. Booster boxes are 36 x the
// booster price + $0.50. fillInvoiceCosts() writes these into any EMPTY Cost
// cell in the Products tab whose name contains every word in the first list
// and none in the second; a cost you've typed yourself is never overwritten.
// First match wins, so the more specific rules come first.
const INVOICE_COSTS = [
  // [all words, words that must NOT appear, cost incl. delivery]  — invoice item
  [["one touch", " x "], [], 3.57], // Ultra Pro UP16401 35PT UV One-Touch X Magnetic Card Holder — $3.25 + $0.32 (Tax Invoice 388075)
  [["pitch black", "elite"], [], 59.00], // ME5 Pitch Black Elite Trainer Box — $58.50 + $0.50 (13.07.2026)
  [["pitch black", "bundle"], [], 29.60], // ME5 Pitch Black Booster Bundle — $29.10 + $0.50 (13.07.2026)
  [["pitch black", "blister"], [], 15.70], // ME5 Pitch Black Three Booster Blister — $15.20 + $0.50 (13.07.2026)
  [["pitch black", "booster", "box"], ["bundle", "elite"], 169.70], // ME5 Pitch Black Booster Box (36 x booster) — $4.70 x 36 + $0.50 (13.07.2026)
  [["pitch black", "booster"], ["bundle", "blister", "elite", "etb", "box", "display", "36", "tin", "collection"], 5.20], // ME5 Pitch Black Booster pack — $4.70 + $0.50 (13.07.2026)
  [["chaos rising", "elite"], [], 59.00], // ME4 Chaos Rising Elite Trainer Box — $58.50 + $0.50 (15.05.2026)
  [["chaos rising", "bundle"], [], 29.60], // ME4 Chaos Rising Booster Bundle — $29.10 + $0.50 (15.05.2026)
  [["chaos rising", "blister"], [], 15.70], // ME4 Chaos Rising Three Booster Blister — $15.20 + $0.50 (15.05.2026)
  [["chaos rising", "booster", "box"], ["bundle", "elite"], 178.70], // ME4 Chaos Rising Booster Box (36 x booster) — $4.95 x 36 + $0.50 (16.06.2026)
  [["chaos rising", "booster"], ["bundle", "blister", "elite", "etb", "box", "display", "36", "tin", "collection"], 5.45], // ME4 Chaos Rising Booster pack — $4.95 + $0.50 (16.06.2026)
  [["perfect order", "elite"], [], 59.00], // ME3 Perfect Order Elite Trainer Box — $58.50 + $0.50 (23.03.2026)
  [["perfect order", "bundle"], [], 29.60], // ME3 Perfect Order Booster Bundle — $29.10 + $0.50 (23.03.2026)
  [["perfect order", "blister"], [], 15.70], // ME3 Perfect Order Three Booster Blister — $15.20 + $0.50 (23.03.2026)
  [["perfect order", "booster", "box"], ["bundle", "elite"], 178.70], // ME3 Perfect Order Booster Box (36 x booster) — $4.95 x 36 + $0.50 (23.03.2026)
  [["perfect order", "booster"], ["bundle", "blister", "elite", "etb", "box", "display", "36", "tin", "collection"], 5.45], // ME3 Perfect Order Booster pack — $4.95 + $0.50 (23.03.2026)
  [["ascended heroes", "elite"], [], 59.00], // ME2.5 Ascended Heroes Elite Trainer Box — $58.50 + $0.50 (16.02.2026)
  [["ascended heroes", "bundle"], [], 32.00], // ME2.5 Ascended Heroes Booster Bundle — $31.50 + $0.50 (17.04.2026)
  [["ascended heroes", "sticker"], [], 19.20], // ME2.5 Ascended Heroes Tech Sticker Blister — $18.70 + $0.50 (10.02.2026)
  [["ascended heroes", "poster"], [], 59.00], // ME2.5 Ascended Heroes Premium Poster Collection — $58.50 + $0.50 (14.03.2026)
  [["ascended heroes", "pin"], [], 29.60], // ME2.5 Ascended Heroes Deluxe Pin Collection — $29.10 + $0.50 (16.02.2026)
  [["ascended heroes", "tin"], [], 12.20], // ME2.5 Ascended Heroes Mini Tin — $11.70 + $0.50 (16.02.2026)
  [["ascended heroes", "blister"], [], 12.20], // ME2.5 Ascended Heroes 2pk Blister — $11.70 + $0.50 (16.02.2026)
  [["30th", "elite"], [], 59.00], // 30th Celebration Elite Trainer Box — $58.50 + $0.50 (10.09.2026)
  [["30th", "sticker"], [], 18.00], // 30th Celebration Tech Sticker Blister — $17.50 + $0.50 (10.09.2026)
  [["30th", "binder"], [], 38.30], // 30th Celebration Binder Box — $37.80 + $0.50 (10.09.2026)
  [["30th", "poster"], [], 18.00], // 30th Celebration Poster Box — $17.50 + $0.50 (10.09.2026)
  [["30th", "knock out"], [], 12.20], // 30th Celebration Knock Out Collection — $11.70 + $0.50 (10.09.2026)
  [["30th", " ex ", "box"], [], 27.00], // 30th Celebration ex Box — $26.50 + $0.50 (10.09.2026)
  [["pokemon", "knock out"], [], 12.20], // Pokemon Knock Out Collection — $11.70 + $0.50 (10.02.2026)
  [["pokemon", "binder"], ["30th"], 28.40], // Pokemon Premium Red Snap Binder — $27.90 + $0.50 (10.02.2026)
  [["charizard", "tin"], [], 26.10], // Pokemon Mega Charizard ex Tin — $25.60 + $0.50 (16.02.2026)
  [["pokemon", "enhanced", "blister"], [], 13.30], // Pokemon Enhanced 2PK Blister — $12.80 + $0.50 (01.04.2026)
  [["pokemon", "blister"], ["three", "3 booster", "sticker", "enhanced"], 12.20], // Pokemon 2PK Blister 26Q1 — $11.70 + $0.50 (16.02.2026)
  [["first partner"], [], 18.00], // Pokemon First Partner Illustration Collection — $17.50 + $0.50 (31.07.2026)
  [["pokemon", "portfolio"], [], 6.90], // Pokemon Mini Portfolio — $6.40 + $0.50 (23.03.2026)
  [["zygarde"], [], 47.10], // Pokemon Mega Zygarde ex Premium Collection — $46.60 + $0.50 (15.05.2026)
  [["greninja"], [], 47.10], // Pokemon Mega Greninja ex Premium Collection — $46.60 + $0.50 (26.06.2026)
  [["lumiose", "tin"], [], 12.20], // Pokemon Lumiose City Mini Tin — $11.70 + $0.50 (01.06.2026)
  [["moonlight", "tin"], [], 26.10], // Pokemon Mega Moonlight Tin — $25.60 + $0.50 (01.06.2026)
  [["triple whammy"], [], 18.00], // Pokemon Triple Whammy Collector Tin — $17.50 + $0.50 (16.06.2026)
  [["world championship"], [], 23.80], // Pokemon 2025 World Championships Deck — $23.30 + $0.50 (16.06.2026)
  [["pokeball"], [], 6.90], // Pokemon Pokeball Magnetic Card Holder — $6.40 + $0.50 (06.07.2026)
  [["one touch", " s "], [], 13.50], // Ultra Pro One Touch S (5 count retail pack) — $13.00 + $0.50 (31.07.2026)
  [["one touch", "black"], [], 10.50], // One Touch 35PT Black Border Magnetic 5PK — $10.00 + $0.50 (06.07.2026)
  [["one touch", "35"], [], 2.90], // One Touch 35PT Magnetic Closure — $2.40 + $0.50 (06.07.2026)
  [["chaos origins"], [], 4.75], // YuGiOh Chaos Origins 9 Card Blister — $4.25 + $0.50 (06.07.2026)
  [["arc v"], [], 39.50], // YuGiOh Legendary Arc-V Decks — $39.00 + $0.50 (31.07.2026)
  [["magnificent monster"], [], 49.10], // YuGiOh Magnificent Monster Boxset — $48.60 + $0.50 (17.09.2026)
  [["tennis", "chrome"], [], 15.20], // Topps 2025 Tennis Chrome Hobby pack — $14.70 + $0.50 (24.02.2026)
  [["premier league", "2026", "starter"], ["adrenalyn"], 20.30], // Topps 2026 Premier League Starter Pack — $19.80 + $0.50 (01.04.2026)
  [["premier league", "2026"], ["adrenalyn", "album", "starter", "box", "tin"], 3.40], // Topps 2026 Premier League Cards pack — $2.90 + $0.50 (01.04.2026)
  [["hanger"], [], 13.30], // UEFA Champions League 25/26 ECO Hanger Box — $12.80 + $0.50 (24.02.2026)
  [["gladiators"], [], 16.80], // UEFA Champions League 25/26 Gladiators Mega Tin — $16.30 + $0.50 (24.02.2026)
  [["champions league", "starter"], [], 18.00], // UEFA Champions League 25/26 Starter Pack — $17.50 + $0.50 (24.02.2026)
  [["optic", "fat pack"], [], 21.20], // Panini Donruss Optic Football Fat Pack — $20.70 + $0.50 (01.04.2026)
  [["wwe"], [], 38.70], // Topps 2025 WWE Universe Hobby Value Box — $38.20 + $0.50 (01.04.2026)
  [["teenymates"], [], 32.30], // Teenymates 2026 NBA Collector Tin — $31.80 + $0.50 (01.04.2026)
  [["adrenalyn", "world cup", "classic tin"], [], 30.80], // FIFA World Cup 2026 Adrenalyn Classic Tin — $30.30 + $0.50 (06.07.2026)
  [["adrenalyn", "world cup", "pocket tin"], [], 20.30], // FIFA World Cup 2026 Adrenalyn Pocket Tin — $19.80 + $0.50 (11.05.2026)
  [["adrenalyn", "world cup", "starter"], [], 23.20], // FIFA World Cup 2026 Adrenalyn Starter Pack Deluxe — $22.70 + $0.50 (08.04.2026)
  [["adrenalyn", "world cup"], ["tin", "starter", "album", "box", "binder", "blister"], 3.40], // FIFA World Cup 2026 Adrenalyn booster pack — $2.90 + $0.50 (08.04.2026)
  [["world cup", "update set"], [], 20.30], // FIFA World Cup 2026 Sticker Update Set — $19.80 + $0.50 (31.07.2026)
  [["world cup", "1970"], [], 96.50], // FIFA World Cup 1970-2026 Book — $96.00 + $0.50 (31.07.2026)
  [["world cup", "sticker"], ["album", "update", "book", "box"], 2.90], // FIFA World Cup 2026 Sticker pack — $2.40 + $0.50 (31.07.2026)
  [["turbo attax", "starter"], [], 9.50], // F1 Turbo Attax 2025 Starter Pack — $9.00 + $0.50 (11.05.2026)
  [["harry potter", "blaster"], [], 47.10], // Kakawow Harry Potter 25th Blaster — $46.60 + $0.50 (31.07.2026)
  [["harry potter"], ["blaster"], 20.85], // Kakawow Harry Potter 25th Regular pack — $20.35 + $0.50 (31.07.2026)
  [["tom and jerry"], [], 17.40], // Kakawow Phantom Tom and Jerry pack — $16.90 + $0.50 (26.08.2026)
  [["road to", "world cup", "mega"], [], 70.30], // Panini Select Road to World Cup Mega Box — $69.80 + $0.50 (17.09.2026)
  [["road to", "world cup", "blaster"], [], 41.25], // Panini Select Road to World Cup Blaster — $40.75 + $0.50 (26.08.2026)
  [["chrome", "uefa", "value"], [], 41.85], // Topps Chrome UEFA Club Competitions 25/26 Value Box — $41.35 + $0.50 (27.06.2026)
  // Tax Invoice 388075: invoice unit price (ex GST) + $0.32 each — the $8.00 delivery split over the 25 units on the order
  [["marvel", "jumpstart"], ["pack"], 164.96], // Magic Marvel Super Heroes Jumpstart Booster Display — $164.64 + $0.32
  [["marvel", "collector"], ["pack"], 494.24], // Magic Marvel Super Heroes Collector Booster Display — $493.92 + $0.32
  [["marvel", "play", "booster"], ["jumpstart", "collector", "pack"], 206.12], // Magic Marvel Super Heroes Play Booster Display — $205.80 + $0.32
  [["poker chip"], [], 19.81], // Bicycle 8 Gram Clay Poker Chip Set 100 Count — $19.49 + $0.32
  [["dp 12"], [], 109.63], // One Piece Double Pack Display DP-12 — $109.31 + $0.32
  [["op 17", "dash"], [], 0.32], // One Piece OP-17 Dash Pack (free with the order) — $0.00 + $0.32
  [["op 17", "booster"], ["dash", "pack", "case"], 127.36], // One Piece OP-17 Booster Display — $127.04 + $0.32
];

/* ---- Japanese products (different rules from the Banter Toys items) ----
 * Cost of one PACK   = box price / packs in the box, + 5% commission + 1.75%
 *                      card-processing fee (both charged on the goods), then
 *                      + $0.50 delivery.
 * Cost of a whole BOX = packs in the box x the cost of one pack.
 * The 1.75% is worked out from the invoices' "Additional fees" line: it is
 * 6.75% of the goods in all six orders that have it, i.e. the 5% commission
 * plus 1.75% card processing. Box prices are the latest invoice (ex fees,
 * ex shipping); the packs-per-box counts are the standard Japanese boxes, so
 * fix any that don't match what's actually in your boxes. A Japanese product
 * only matches if its name says Japan / Japanese / JP / JPN, same as the
 * Pokémon (Japanese) brand rule. */
const JP_COMMISSION = 0.05;
const JP_CARD_FEE  = 0.0175;
const JP_DELIVERY  = 0.50; // per pack
const JAPAN_SETS = [
  // [name in the set, regex on the tidied-up product name, packs per box, latest box price]
  ['Pokemon 151 sv2a',                /\b151\b|\bsv2a\b/,                          20, 492.07],
  ['Shiny Treasure ex sv4a',          /shiny treasure|\bsv4a\b/,                   10, 171.35],
  ['Battle Partners sv9',             /battle partners|\bsv9\b/,                   30,  96.33],
  ['Vstar Universe s12a',             /vstar universe|\bs12a\b/,                   10, 278.55],
  ['Shiny Star V s4a',                /shiny star|\bs4a\b/,                        10, 196.83],
  ['Terastal Fest ex sv8a',           /terastal|\bsv8a\b/,                         10, 174.86],
  ['Super Electric Breaker sv8',      /super electric|\bsv8\b/,                    30, 298.94],
  ['White Flare sv11w',               /white flare|\bsv11w\b/,                     20, 199.46],
  ['Storm Emeralda M6',               /storm emeralda|\bm6\b/,                     30, 134.44],
  ['One Piece PRB-01 The Best',       /\bprb ?01\b|the best/,                      10, 214.69],
  ['One Piece OP-16 Decisive Battle', /\bop ?16\b|decisive battle/,                24, 109.84],
];
const JP_RANDOM_PACK_PRICE = 1.58; // Random Packs bulk sale, per pack (latest invoice)

function round2(x) { return Math.round(x * 100) / 100; }

// Cost of one pack, and of the box that holds `packs` of them.
function japanCosts(boxPrice, packs) {
  const pack = round2(boxPrice / packs * (1 + JP_COMMISSION + JP_CARD_FEE) + JP_DELIVERY);
  return { pack: pack, box: round2(pack * packs) };
}

function japanCostFor(n) {
  if (!/\b(japan|japanese|jp|jpn)\b/.test(n)) return null;
  const isBox = /\bbox\b|display|carton/.test(n);
  const isPack = !isBox && /\bpacks?\b|booster|random/.test(n);
  if (!isBox && !isPack) return null;
  if (/\brandom\b/.test(n)) return isPack ? japanCosts(JP_RANDOM_PACK_PRICE, 1).pack : null;
  for (const [, re, packs, boxPrice] of JAPAN_SETS) {
    if (re.test(n)) { const c = japanCosts(boxPrice, packs); return isBox ? c.box : c.pack; }
  }
  return null;
}

/* ---- Footy items (AFL Footy Stars / Luminous, NRL League Heroes, AFL Team Coach) ----
 * Prices are what the supplier invoices / price list show (GST included, same
 * as the Cost column). Footy Stars, Luminous and NRL League Heroes are free
 * shipping, so NO $0.50 delivery is added. Team Coach adds $0.10 per pack.
 * Per-unit costs are worked out from the case / box price:
 *   Footy Stars: case of 12 boxes $1,611.00 -> box $134.25; blaster case of 12
 *                $419.88 -> $34.99; vinyl album case of 10 $240.00; binder
 *                album case of 10 $118.90.
 *   Luminous:    album case of 10 $220.00.
 *   NRL League Heroes: box (36 packs) $107.64 -> $2.99 a pack.
 *   Team Coach:  case of 12 display boxes $1,620.00 (36 packs a box, $3.75 a
 *                pack) + $0.10 a pack; collector albums $123.20 for 14 = $8.80.
 * FOOTY_STARS_PACKS is a guess (36 a box) — fix it if your boxes differ. */
const FOOTY_STARS_CASE_PRICE    = 1611.00; // case of 12 boxes
const FOOTY_STARS_BOXES         = 12;
const FOOTY_STARS_PACKS         = 36;      // packs per box (check)
const FOOTY_STARS_BLASTER_CASE  = 419.88;  // case of 12 blasters
const FOOTY_STARS_VINYL_CASE    = 240.00;  // case of 10 vinyl albums
const FOOTY_STARS_BINDER_CASE   = 118.90;  // case of 10 binder albums
const LUMINOUS_ALBUM_CASE       = 220.00;  // case of 10 albums
const NRL_HEROES_BOX_PRICE      = 107.64;  // box of 36 packs
const NRL_HEROES_PACKS          = 36;
const TC_CASE_PRICE             = 1620.00; // case of 12 display boxes
const TC_BOXES                  = 12;
const TC_PACKS                  = 36;      // packs per display box
const TC_PACK_EXTRA             = 0.10;    // per pack
const TC_ALBUM_BOX_PRICE        = 123.20;  // box of 14 collector albums
const TC_ALBUMS                 = 14;

function footyCostFor(n) {
  const isCase    = /\bcase\b|\bcarton\b/.test(n);
  const isAlbum   = /\b(albums?|binders?)\b/.test(n);
  const isBlaster = /\bblasters?\b/.test(n);
  const isBox     = /\bbox\b|display/.test(n);
  const isPack    = /\bpacks?\b|booster/.test(n);

  if (/\bfooty ?stars\b/.test(n)) {
    const box = FOOTY_STARS_CASE_PRICE / FOOTY_STARS_BOXES;
    if (isAlbum) {
      const unit = /\bvinyl\b/.test(n) ? FOOTY_STARS_VINYL_CASE / 10
                 : /\bbinder\b/.test(n) ? FOOTY_STARS_BINDER_CASE / 10 : null;
      return unit === null ? null : round2(isCase ? unit * 10 : unit);
    }
    if (isBlaster) return round2(isCase ? FOOTY_STARS_BLASTER_CASE : FOOTY_STARS_BLASTER_CASE / 12);
    if (isCase) return round2(FOOTY_STARS_CASE_PRICE);
    if (isBox) return round2(box);
    if (isPack) return round2(box / FOOTY_STARS_PACKS);
    return null;
  }
  if (/\bluminous\b/.test(n) && isAlbum) {
    return round2(isCase ? LUMINOUS_ALBUM_CASE : LUMINOUS_ALBUM_CASE / 10);
  }
  if (/\bleague heroes\b/.test(n)) {
    if (isBox) return round2(NRL_HEROES_BOX_PRICE);
    if (isPack) return round2(NRL_HEROES_BOX_PRICE / NRL_HEROES_PACKS);
    return null;
  }
  if (/\bteam ?coach\b/.test(n)) {
    const pack = round2(TC_CASE_PRICE / TC_BOXES / TC_PACKS + TC_PACK_EXTRA);
    if (isAlbum) return round2(TC_ALBUM_BOX_PRICE / TC_ALBUMS);
    if (isCase) return round2(pack * TC_PACKS * TC_BOXES);
    if (isBox) return round2(pack * TC_PACKS);
    if (isPack) return pack;
    return null;
  }
  return null;
}

function invoiceCostFor(name) {
  const n = ' ' + String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  const jp = japanCostFor(n);
  if (jp !== null) return jp;
  const footy = footyCostFor(n);
  if (footy !== null) return footy;
  for (const [all, none, cost] of INVOICE_COSTS) {
    if (all.every(w => n.includes(w)) && !none.some(w => n.includes(w))) return cost;
  }
  return null;
}

/* ---------------- same product, new barcode ---------------- */

// A product name, ready to compare: the old "no longer in catalog" prefix
// and spaces at the ends are dropped, runs of spaces count as one. Nothing
// else is changed, so only names that are exactly the same match.
function nameKey(name) {
  return String(name || '').replace(GONE, '').replace(/\s+/g, ' ').trim();
}

// When a barcode changes on Squarespace the product comes in as a new row
// with an empty Cost. This copies the Cost from the row with exactly the
// same name (the old barcode's row), so you don't type it again. It never
// guesses: no row with that exact name and a cost = the cell stays empty.
// Only EMPTY Cost cells are filled; if several rows share the name, the top
// (newest) one with a cost is used.
function fillSameNameCosts() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(PRODUCTS_TAB);
  const last = sheet ? lastDataRow(sheet) : 0;
  if (last < 3) return;
  const vals = sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues();
  const heads = vals[0].map(h => String(h).trim().toLowerCase());
  const cName = heads.indexOf('name'), cCost = heads.indexOf('cost');
  if (cName < 0 || cCost < 0) return;
  const has = v => v !== '' && v !== null && isFinite(Number(v));
  const costByName = {};
  vals.slice(1).forEach(r => {
    const k = nameKey(r[cName]);
    if (k && !(k in costByName) && has(r[cCost])) costByName[k] = Number(r[cCost]);
  });
  let filled = 0;
  vals.slice(1).forEach((r, i) => {
    if (r[cCost] !== '' && r[cCost] !== null) return;
    const k = nameKey(r[cName]);
    if (!k || !(k in costByName)) return;
    sheet.getRange(i + 2, cCost + 1).setValue(costByName[k]).setNumberFormat('$#,##0.00');
    filled++;
  });
  console.log('Costs copied from same-name products: ' + filled);
}

// Run once from the editor (or it runs after each Products refresh).
function fillInvoiceCosts() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(PRODUCTS_TAB);
  const last = sheet ? lastDataRow(sheet) : 0;
  if (last < 2) return;
  const vals = sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues();
  const heads = vals[0].map(h => String(h).trim().toLowerCase());
  const cName = heads.indexOf('name'), cCost = heads.indexOf('cost');
  if (cName < 0 || cCost < 0) return;
  let filled = 0;
  vals.slice(1).forEach((r, i) => {
    if (r[cCost] !== '' && r[cCost] !== null) return;
    const cost = invoiceCostFor(r[cName]);
    if (cost === null) return;
    sheet.getRange(i + 2, cCost + 1).setValue(cost).setNumberFormat('$#,##0.00');
    filled++;
  });
  console.log('Invoice costs filled: ' + filled);
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

  // Website orders for the whole window, by day. If they can't be read, the
  // Profit tab is left as it is (a run without them would understate the days).
  const online = INCLUDE_ONLINE ? fetchOnlineByDay(now) : {};

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
    const sales = (JSON.parse(res.getContentText()).sales || []).filter(s => s && !s.voided)
      .concat(online[day] || []);
    if (!sales.length) continue;
    let takings = 0, cogs = 0, missing = 0;
    sales.forEach(s => {
      takings += (Number(s.total) || 0) - (Number(s.shipping) || 0); // shipping isn't product revenue
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

// Website (Squarespace) orders for the look-back window, grouped by day, each
// shaped like a till sale. Throws if the site can't give them (e.g. ADMIN_PIN
// missing or wrong), so the caller can leave the Profit tab alone.
function fetchOnlineByDay(now) {
  const to = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd');
  const from = Utilities.formatDate(new Date(now.getTime() - EXPENSE_LOOKBACK * 86400000), TIME_ZONE, 'yyyy-MM-dd');
  const url = SITE_URL.replace(/\/$/, '') + '/api/online?from=' + from + '&to=' + to;
  let data = null;
  // The first read of older orders can take a few goes (sync.complete false).
  for (let tries = 0; tries < 6; tries++) {
    const res = UrlFetchApp.fetch(url, { headers: authHeaders(), muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      throw new Error('online orders fetch failed (' + res.getResponseCode() + '): ' + res.getContentText() +
        (res.getResponseCode() === 401 ? ' — check ADMIN_PIN at the top of the script' : ''));
    }
    data = JSON.parse(res.getContentText());
    if (!data.sync || data.sync.complete || data.sync.error) break;
    Utilities.sleep(2000);
  }
  if (data.sync && !data.sync.complete) throw new Error('online orders still syncing from Squarespace');
  const byDay = {};
  (data.sales || []).forEach(s => { if (s && s.day) (byDay[s.day] = byDay[s.day] || []).push(s); });
  return byDay;
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
