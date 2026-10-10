#!/usr/bin/env node
/**
 * ESC/POS bridge for the Epson TM-T88V.
 *
 * WHY THIS EXISTS
 * ---------------
 * The TM-T88V speaks ESC/POS. macOS has no driver for it any more (Epson pulled
 * the Mac package), so the printer gets auto-assigned "Epson 24-Pin Series" —
 * an ESC/P2 dot-matrix driver. The printer doesn't understand ESC/P2, so it
 * prints the raw escape bytes as characters. That's the "binary code" output.
 *
 * Fix: don't use a driver at all. Build ESC/POS ourselves and hand it to CUPS
 * with `lp -o raw`, which passes the bytes through untouched.
 *
 * The till POSTs JSON here instead of calling window.print().
 *
 *   node escpos-bridge.js              # serve on 127.0.0.1:9100
 *   node escpos-bridge.js --selftest   # print one test docket and exit
 *   node escpos-bridge.js --dry-run    # print ESC/POS to stdout, don't spool
 */

'use strict';

const http = require('http');
const { spawn } = require('child_process');

const PORT  = Number(process.env.BRIDGE_PORT || 9100);
const QUEUE = process.env.BRIDGE_QUEUE || 'EPSON_TM_T88V';
const COLS  = 42;                     // Font A on 80mm roll = 42 characters

/* ---------------- ESC/POS primitives ---------------- */
const ESC = 0x1b, GS = 0x1d;
const CMD = {
  init:       [ESC, 0x40],
  alignLeft:  [ESC, 0x61, 0],
  alignCentre:[ESC, 0x61, 1],
  boldOn:     [ESC, 0x45, 1],
  boldOff:    [ESC, 0x45, 0],
  bigOn:      [GS, 0x21, 0x11],       // double width + height
  bigOff:     [GS, 0x21, 0x00],
  // Partial cut, feeding 3 lines first so the text clears the blade.
  cut:        [GS, 0x56, 0x42, 0x03],
  // Kick drawer pin 2: ESC p 0 <on=25ms> <off=250ms>
  drawer:     [ESC, 0x70, 0x00, 0x19, 0xfa],
};

/* Code 128 barcode, centred, human-readable code underneath. Set B ("{B");
   the data is letters and digits only, so nothing needs escaping. Module
   width 2 keeps a 12-character code well inside the 72mm print area. */
function barcode128(d, data){
  data = String(data || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!data) return;
  d.raw(CMD.alignCentre)
   .raw([GS, 0x68, 80])                 // height in dots
   .raw([GS, 0x77, 2])                  // module width
   .raw([GS, 0x48, 2])                  // text below the bars
   .raw([GS, 0x66, 0])
   .raw([GS, 0x6b, 73, data.length + 2]).text('{B' + data).ln()
   .raw(CMD.alignLeft);
}

class Doc {
  constructor(){ this.parts = []; }
  raw(bytes){ this.parts.push(Buffer.from(bytes)); return this; }
  /* CP437 is the TM-T88V default codepage; latin1 is close enough for the
     ASCII + currency text we emit, and never throws on odd input. */
  text(s){ this.parts.push(Buffer.from(String(s), 'latin1')); return this; }
  ln(s = ''){ return this.text(s + '\n'); }
  build(){ return Buffer.concat(this.parts); }
}

/* ---------------- layout helpers ---------------- */

/**
 * Reduce to printable ASCII so the printer never emits mojibake.
 * NFD-decompose first so accented letters keep their base character —
 * "Pokémon" must become "Pokemon", not "Pokmon".
 */
function ascii(s){
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // drop combining diacritics, keep the letter
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—‑]/g, '-')
    .replace(/[…]/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/ {2,}/g, ' ')   // tidy gaps left by removed symbols
    .trim();
}

function money(n){
  const v = Number(n || 0);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
}

/** Left text and right text on one line, padded to the full width. */
function pair(left, right){
  const l = ascii(left), r = ascii(right);
  const gap = COLS - l.length - r.length;
  if (gap >= 1) return l + ' '.repeat(gap) + r;
  // Too long: put the amount on its own right-aligned line.
  return wrap(l, COLS).join('\n') + '\n' + r.padStart(COLS);
}

function wrap(s, width = COLS){
  const words = ascii(s).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words){
    if (!cur.length)            cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
    while (cur.length > width){ lines.push(cur.slice(0, width)); cur = cur.slice(width); }
  }
  if (cur.length) lines.push(cur);
  return lines.length ? lines : [''];
}

const rule = () => '-'.repeat(COLS);

function centre(s){
  const t = ascii(s);
  if (t.length >= COLS) return t;
  return ' '.repeat(Math.floor((COLS - t.length) / 2)) + t;
}

/* ---------------- documents ---------------- */

function header(d, store){
  d.raw(CMD.alignCentre);
  if (store.name){ d.raw(CMD.bigOn).raw(CMD.boldOn).ln(ascii(store.name)).raw(CMD.boldOff).raw(CMD.bigOff); }
  for (const f of ['address','phone']) if (store[f]) d.ln(ascii(store[f]));
  if (store.abn) d.ln('ABN ' + ascii(store.abn));
  d.raw(CMD.alignLeft);
}

function footer(d, store, opts, cashSale){
  d.ln(rule());
  d.raw(CMD.alignCentre);
  if (store.footer) for (const l of wrap(store.footer)) d.ln(l);
  d.ln(new Date().toLocaleString('en-AU'));
  d.raw(CMD.alignLeft);
  if (opts.drawer && cashSale) d.raw(CMD.drawer);
  if (opts.cut !== false) d.raw(CMD.cut);
}

function buildReceipt({ store = {}, sale = {}, options = {} }){
  const d = new Doc().raw(CMD.init);
  header(d, store);

  d.ln(rule());
  d.raw(CMD.alignCentre).raw(CMD.boldOn).ln(sale.kind === 'refund' ? 'REFUND - ADJUSTMENT NOTE' : 'TAX INVOICE').raw(CMD.boldOff).raw(CMD.alignLeft);
  if (sale.kind === 'refund') d.ln('Refund of: ' + ascii(sale.refundOf || ''));

  const when = new Date(sale.ts || Date.now());
  d.ln(pair(sale.no || '', when.toLocaleDateString('en-AU') + ' ' +
        when.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })));
  // Wrap these — a long customer name would otherwise run past the paper edge.
  if (sale.servedBy) for (const l of wrap('Served by: ' + ascii(sale.servedBy))) d.ln(l);
  if (sale.customer) for (const l of wrap('Customer: '  + ascii(sale.customer))) d.ln(l);
  if (sale.contact)  for (const l of wrap((/@/.test(sale.contact) ? 'Email: ' : 'Phone: ') + ascii(sale.contact))) d.ln(l);
  if (sale.order === 'pickup') d.raw(CMD.boldOn).ln('Order: PICK UP LATER').raw(CMD.boldOff);
  else d.ln('Order: Served on the spot');
  d.ln(rule());

  for (const it of (sale.items || [])){
    for (const l of wrap(it.name)) d.ln(l);
    d.ln(pair(`${it.qty} x ${money(it.price)}`, money(it.price * it.qty)));
  }

  d.ln(rule());
  d.ln(pair('Subtotal (ex GST)', money(sale.sub)));
  d.ln(pair(`GST (${sale.rate ?? 10}%)`, money(sale.gst)));
  d.raw(CMD.boldOn).ln(pair('TOTAL', money(sale.total))).raw(CMD.boldOff);
  d.ln('Total price includes GST ' + money(sale.gst));
  d.ln();

  const cash = sale.method === 'cash' || sale.method === 'split';
  if (sale.kind === 'refund'){
    if (sale.rounding) d.ln(pair('Rounding', (sale.rounding > 0 ? '+' : '') + money(sale.rounding)));
    d.raw(CMD.boldOn).ln(pair('REFUNDED TO ' + (sale.method === 'cash' ? 'CASH' : 'CARD'), money(-sale.paid))).raw(CMD.boldOff);
  } else if (sale.method === 'split'){
    d.ln(pair('CARD', money(sale.cardPaid)));
    if (sale.rounding) d.ln(pair('Cash rounding', (sale.rounding > 0 ? '+' : '') + money(sale.rounding)));
    d.ln(pair('CASH', money(sale.tendered != null ? sale.tendered : sale.cashPaid)));
    if (sale.change != null) d.ln(pair('Change', money(sale.change)));
  } else if (cash){
    if (sale.rounding) d.ln(pair('Rounding', (sale.rounding > 0 ? '+' : '') + money(sale.rounding)));
    d.ln(pair('Rounded total', money(sale.paid)));
    d.ln(pair('CASH', money(sale.tendered != null ? sale.tendered : sale.paid)));
    if (sale.change != null) d.ln(pair('Change', money(sale.change)));
  } else {
    d.ln(pair('CARD', money(sale.paid)));
  }

  if (sale.order === 'pickup' && sale.pickupCode){
    d.ln(rule()).raw(CMD.alignCentre).raw(CMD.boldOn).ln('PICK-UP BARCODE').raw(CMD.boldOff)
     .ln('Bring this receipt to collect your order').raw(CMD.alignLeft);
    barcode128(d, sale.pickupCode);
  }

  footer(d, store, options, cash);
  return d.build();
}

function buildReport({ store = {}, report = {}, options = {} }){
  const d = new Doc().raw(CMD.init);
  header(d, store);
  d.ln(rule());
  d.raw(CMD.alignCentre).raw(CMD.boldOn).ln(ascii(report.title || 'REPORT')).raw(CMD.boldOff);
  if (report.subtitle) for (const l of wrap(report.subtitle)) d.ln(l);
  d.raw(CMD.alignLeft).ln(rule());
  for (const row of (report.rows || [])){
    if (row === '-'){ d.ln(rule()); continue; }
    const [label, value, bold] = row;
    if (bold) d.raw(CMD.boldOn);
    d.ln(pair(label, value));
    if (bold) d.raw(CMD.boldOff);
  }
  footer(d, store, options, false);
  return d.build();
}

/* ---------------- spooling ---------------- */

function spool(buf){
  return new Promise((resolve, reject) => {
    if (process.argv.includes('--dry-run')){
      process.stdout.write(buf);
      return resolve('dry-run');
    }
    // -o raw tells CUPS to skip every filter, so the driver never sees the data.
    const lp = spawn('lp', ['-d', QUEUE, '-o', 'raw']);
    let err = '';
    lp.stderr.on('data', c => { err += c; });
    lp.on('error', reject);
    lp.on('close', code => code === 0 ? resolve('spooled')
                                      : reject(new Error(`lp exited ${code}: ${err.trim()}`)));
    lp.stdin.end(buf);
  });
}

/* ---------------- HTTP ---------------- */

// Access-Control-Allow-Private-Network is what lets an HTTPS page (the till on
// Netlify) reach this plain-HTTP server on localhost. Chrome 104+ blocks such
// "private network" requests unless the preflight returns it, and Chrome 142+
// enforces that with no fallback.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '86400',
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();

  if (req.method === 'GET' && req.url === '/health')
    return res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
              .end(JSON.stringify({ ok: true, queue: QUEUE, cols: COLS, fields: ['order', 'contact', 'pickupCode', 'split', 'refund'] }));

  if (req.method !== 'POST' || req.url !== '/print')
    return res.writeHead(404, CORS).end('not found');

  let body = '';
  req.on('data', c => {
    body += c;
    if (body.length > 1e6) req.destroy();       // don't let a bad client OOM us
  });
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const buf = payload.type === 'report' ? buildReport(payload) : buildReceipt(payload);
      const how = await spool(buf);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
         .end(JSON.stringify({ ok: true, how, bytes: buf.length }));
    } catch (e) {
      console.error('[bridge] print failed:', e.message);
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' })
         .end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
});

/* ---------------- entry ---------------- */

// Only act when run directly — `require()`ing this (tests) must not open a port.
if (require.main !== module){
  // exports only
} else if (process.argv.includes('--selftest')){
  const buf = buildReceipt({
    store: { name: 'Remactables', address: '111 Cecil St', abn: '12 345 678 901',
             footer: 'Bridge self-test - not a real sale' },
    sale: { no: 'SELFTEST', ts: Date.now(), servedBy: 'bridge',
            items: [{ name: 'Prizm Basketball 2025-26 Hobby Box', qty: 1, price: 449.95 },
                    { name: 'Ultra Pro Penny Sleeves 100ct', qty: 3, price: 4.95 }],
            sub: 422.59, rate: 10, gst: 42.26, total: 464.85,
            method: 'cash', rounding: 0, paid: 464.85, tendered: 500, change: 35.15 },
    options: { cut: true, drawer: false },      // no drawer kick during a test
  });
  spool(buf)
    .then(() => { console.log(`Self-test sent to "${QUEUE}" (${buf.length} bytes).`); process.exit(0); })
    .catch(e => { console.error('Self-test FAILED:', e.message); process.exit(1); });
} else {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[bridge] listening on http://127.0.0.1:${PORT}  ->  queue "${QUEUE}"`);
  });
}

module.exports = { buildReceipt, buildReport, pair, wrap, ascii, COLS };
