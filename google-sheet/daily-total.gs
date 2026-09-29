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
 *
 *  Brands: the Products tab has a Brand column, guessed from the product
 *  name (Pokémon Japanese and English are kept apart — see BRAND_RULES).
 *  Overwrite any guess and your label is kept. Every item sold is logged in
 *  a LINES_TAB tab, and the Profit tab shows revenue & profit by brand and by
 *  month, with two pie charts (revenue / profit by brand) and a monthly
 *  profit bar chart that update on their own.
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
    try { updateProducts(); fillInvoiceCosts(); } catch (e) { console.log('Products skipped: ' + e.message); }
  }
  if (PROFIT_TAB && PRODUCTS_TAB) {
    try { updateProfit(now); } catch (e) { console.log('Profit skipped: ' + e.message); }
  }
}

/* ---------------- products, cost price, brands & profit ---------------- */

const PRODUCT_HEADS = ['Barcode', 'Name', 'Brand', 'Price', 'Cost', 'Stock',
  'Margin $', 'Margin %', 'Stock value (cost)', 'Stock value (retail)'];
const LINES_TAB = 'Sales lines'; // one row per item sold; feeds the brand & monthly charts

// Brand guessed from the product name when the Brand cell is empty. First
// match wins, so put the more specific rules first. Anything you type in the
// Brand column yourself is kept and beats these guesses.
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

// What you've typed in the Products tab, keyed by barcode: { cost, brand }.
// Columns are found by heading, so tabs made by the older script still work.
function readProducts() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(PRODUCTS_TAB);
  const out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;
  const vals = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
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

// Rewrites the Products tab from the live catalog, keeping every Cost and
// Brand you've entered. Products that disappear from the catalog but have a
// cost or brand stay at the bottom (stock blank) so nothing you typed is lost.
function updateProducts() {
  const res = UrlFetchApp.fetch(SITE_URL.replace(/\/$/, '') + '/api/catalog', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('catalog fetch failed (' + res.getResponseCode() + ')');
  const items = JSON.parse(res.getContentText()).items || [];
  const known = readProducts();
  const seen = {};
  const rows = [];
  items.forEach(it => {
    const sku = String(it.sku).trim();
    if (!sku || seen[sku]) return;
    seen[sku] = true;
    const k = known[sku] || {};
    rows.push([sku, it.name, k.brand || guessBrand(it.name), Number(it.price) || 0,
      k.cost === null || k.cost === undefined ? '' : k.cost,
      it.stock === null || it.stock === undefined ? '' : Number(it.stock)]);
  });
  Object.keys(known).forEach(sku => {
    const k = known[sku];
    if (!seen[sku] && (k.cost !== null || k.brand)) rows.push([sku, '(no longer in catalog)', k.brand, '', k.cost === null ? '' : k.cost, '']);
  });

  const sheet = tabNamed(PRODUCTS_TAB);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, PRODUCT_HEADS.length).setValues([PRODUCT_HEADS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (!rows.length) return;
  const n = rows.length;
  sheet.getRange(2, 1, n, 1).setNumberFormat('@'); // keep long barcodes as text
  sheet.getRange(2, 1, n, 6).setValues(rows);
  const f = [];
  for (let r = 2; r < n + 2; r++) {
    f.push([
      '=IF(OR(D' + r + '="",E' + r + '=""),"",D' + r + '-E' + r + ')',
      '=IF(OR(D' + r + '="",E' + r + '="",D' + r + '=0),"",(D' + r + '-E' + r + ')/D' + r + ')',
      '=IF(OR(E' + r + '="",F' + r + '=""),"",E' + r + '*F' + r + ')',
      '=IF(OR(D' + r + '="",F' + r + '=""),"",D' + r + '*F' + r + ')',
    ]);
  }
  sheet.getRange(2, 7, n, 4).setFormulas(f);
  sheet.getRange(2, 4, n, 2).setNumberFormat('$#,##0.00');
  sheet.getRange(2, 7, n, 1).setNumberFormat('$#,##0.00');
  sheet.getRange(2, 8, n, 1).setNumberFormat('0.0%');
  sheet.getRange(2, 9, n, 2).setNumberFormat('$#,##0.00');
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
  // [all words, words that must NOT appear, cost incl. $0.50 delivery]  — invoice item
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
];

function invoiceCostFor(name) {
  const n = ' ' + String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  for (const [all, none, cost] of INVOICE_COSTS) {
    if (all.every(w => n.includes(w)) && !none.some(w => n.includes(w))) return cost;
  }
  return null;
}

// Run once from the editor (or it runs after each Products refresh).
function fillInvoiceCosts() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(PRODUCTS_TAB);
  if (!sheet || sheet.getLastRow() < 2) return;
  const vals = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
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

const LINE_HEADS = ['Date', 'Month', 'Invoice', 'Barcode', 'Name', 'Brand', 'Qty', 'Revenue', 'Cost', 'Profit'];

// For the last EXPENSE_LOOKBACK days: one row per day in the Profit tab and
// one row per item sold in the Sales lines tab. Older days are kept as they
// are, but every run re-applies the Brand from Products (so re-labelling a
// product fixes its history) and fills in costs you've added since.
function updateProfit(now) {
  const prods = readProducts();
  const costOf = sku => prods[sku] && prods[sku].cost !== null ? prods[sku].cost : null;
  const brandOf = (sku, name) => (prods[sku] && prods[sku].brand) || (sku ? guessBrand(name) : 'Misc');

  const sheet = tabNamed(PROFIT_TAB);
  const heads = ['Date', 'Takings', 'Cost of goods', 'Gross profit', 'Margin %', 'Items without cost'];
  sheet.getRange(1, 1, 1, heads.length).setValues([heads]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  // Column A only: the summary tables to the right can run further down.
  const colA = sheet.getRange('A:A').getValues();
  let last = colA.length;
  while (last > 0 && colA[last - 1][0] === '') last--;
  const rowOf = {};
  if (last > 1) sheet.getRange(2, 1, last - 1, 1).getValues().forEach((v, i) => {
    const key = v[0] instanceof Date ? Utilities.formatDate(v[0], TIME_ZONE, 'yyyy-MM-dd') : normDay(String(v[0]));
    if (key) rowOf[key] = i + 2;
  });

  const newLines = {}; // day -> rows
  for (let d = EXPENSE_LOOKBACK; d >= 0; d--) {
    const day = Utilities.formatDate(new Date(now.getTime() - d * 86400000), TIME_ZONE, 'yyyy-MM-dd');
    const url = SITE_URL.replace(/\/$/, '') + '/api/sales?day=' + day +
      (STORE && STORE !== 'all' ? '&store=' + encodeURIComponent(STORE) : '');
    const res = UrlFetchApp.fetch(url, { headers: SALES_TOKEN ? { 'x-sales-token': SALES_TOKEN } : {}, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('sales fetch failed (' + res.getResponseCode() + ')');
    const sales = (JSON.parse(res.getContentText()).sales || []).filter(s => s && !s.voided);
    newLines[day] = [];
    if (!sales.length) continue;
    let takings = 0, cogs = 0, missing = 0;
    sales.forEach(s => {
      takings += Number(s.total) || 0;
      const items = s.items || [];
      const gross = items.reduce((a, it) => a + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
      const share = gross ? (Number(s.total) || 0) / gross : 1; // spreads any discount across the lines
      items.forEach(it => {
        const q = Number(it.qty) || 0;
        const sku = String(it.sku || '').trim();
        const c = costOf(sku);
        if (c !== null) cogs += c * q; else missing += q;
        const rev = Math.round((Number(it.price) || 0) * q * share * 100) / 100;
        newLines[day].push([day, day.slice(0, 7), s.no || '', sku, it.name || '', brandOf(sku, it.name), q, rev,
          c === null ? '' : Math.round(c * q * 100) / 100, '']);
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
    sheet.getRange(2, 2, n, 3).setNumberFormat('$#,##0.00');
    sheet.getRange(2, 5, n, 1).setNumberFormat('0.0%');
    sheet.getRange(2, 1, n, heads.length).sort(1);
  }

  writeLines(newLines, prods, brandOf);
  buildCharts(sheet);
}

function writeLines(newLines, prods, brandOf) {
  const lines = tabNamed(LINES_TAB);
  let rows = [];
  if (lines.getLastRow() > 1) {
    rows = lines.getRange(2, 1, lines.getLastRow() - 1, LINE_HEADS.length).getValues()
      .map(r => { if (r[0] instanceof Date) r[0] = Utilities.formatDate(r[0], TIME_ZONE, 'yyyy-MM-dd'); r[0] = String(r[0]); return r; })
      .filter(r => r[0] && !(r[0] in newLines));
  }
  Object.keys(newLines).forEach(d => { rows = rows.concat(newLines[d]); });
  rows.forEach(r => {
    const sku = String(r[3]).trim();
    r[1] = String(r[0]).slice(0, 7);
    r[5] = brandOf(sku, r[4]);
    if (r[8] === '' && prods[sku] && prods[sku].cost !== null) r[8] = Math.round(prods[sku].cost * Number(r[6]) * 100) / 100;
    r[9] = r[8] === '' ? '' : Math.round((Number(r[7]) - Number(r[8])) * 100) / 100;
  });
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  lines.clearContents();
  lines.getRange(1, 1, 1, LINE_HEADS.length).setValues([LINE_HEADS]).setFontWeight('bold');
  lines.setFrozenRows(1);
  if (!rows.length) return;
  lines.getRange(2, 1, rows.length, 4).setNumberFormat('@');
  lines.getRange(2, 1, rows.length, LINE_HEADS.length).setValues(rows);
  lines.getRange(2, 8, rows.length, 3).setNumberFormat('$#,##0.00');
}

// Summary tables (live formulas over Sales lines) and charts, placed to the
// right of the daily table on the Profit tab. Charts are made once; after
// that they just follow the formulas, so they update on their own.
function buildCharts(sheet) {
  const L = "'" + LINES_TAB + "'!";
  sheet.getRange('H1').setValue('By brand (all time)').setFontWeight('bold');
  sheet.getRange('H2').setFormula('=QUERY(' + L + 'A:J,"select F, sum(H), sum(J) where F is not null and F <> \'\' ' +
    'group by F order by sum(H) desc label F \'Brand\', sum(H) \'Revenue\', sum(J) \'Profit\'",1)');
  sheet.getRange('L1').setValue('By month').setFontWeight('bold');
  sheet.getRange('L2').setFormula('=QUERY(' + L + 'A:J,"select B, sum(H), sum(J) where B is not null and B <> \'\' ' +
    'group by B order by B label B \'Month\', sum(H) \'Revenue\', sum(J) \'Profit\'",1)');
  sheet.getRange('I3:J40').setNumberFormat('$#,##0.00');
  sheet.getRange('M3:N200').setNumberFormat('$#,##0.00');
  if (sheet.getCharts().length) return;

  sheet.insertChart(sheet.newChart().asPieChart()
    .addRange(sheet.getRange('H2:I40'))
    .setNumHeaders(1)
    .setOption('title', 'Revenue by brand')
    .setOption('pieHole', 0.4)
    .setPosition(1, 16, 0, 0).setOption('width', 480).setOption('height', 320)
    .build());
  sheet.insertChart(sheet.newChart().asPieChart()
    .addRange(sheet.getRange('H2:H40'))
    .addRange(sheet.getRange('J2:J40'))
    .setNumHeaders(1)
    .setOption('title', 'Profit by brand')
    .setOption('pieHole', 0.4)
    .setPosition(18, 16, 0, 0).setOption('width', 480).setOption('height', 320)
    .build());
  sheet.insertChart(sheet.newChart().asColumnChart()
    .addRange(sheet.getRange('L2:L200'))
    .addRange(sheet.getRange('N2:N200'))
    .setNumHeaders(1)
    .setOption('title', 'Profit by month')
    .setOption('legend', { position: 'none' })
    .setPosition(35, 16, 0, 0).setOption('width', 480).setOption('height', 320)
    .build());
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
