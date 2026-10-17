/* The one-off products made in Admin → 🏷️ Barcodes (see functions/labels.mjs):
   reading the list, and counting their stock down on a sale / back up on a
   void or refund (functions/inventory.mjs). */

import { getStore } from '@netlify/blobs';

const DONE_KEEP = 2000;   // how many applied stock changes are remembered, so a retry can't apply twice

export function labelsStore() { return getStore({ name: 'labels', consistency: 'strong' }); }

export async function readLabels(st) {
  const v = await st.get('items', { type: 'json' }).catch(() => null);
  return {
    items: v && Array.isArray(v.items) ? v.items : [],
    done: v && v.done && typeof v.done === 'object' ? v.done : {},
  };
}

// Barcodes are matched the way the till matches them: trimmed, upper-case, no spaces.
export function norm(v) { return String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, ''); }

/* Takes the lines that are our own products out of `lines` / `ups` and moves
   their stock: `lines` by `dir` (-1 a sale, +1 a void/refund), `ups` always up.
   `key` makes it happen once — the same key again changes nothing.
   Returns { lines, ups, inventory } — the lines left for Squarespace, and
   [{ sku, quantity }] for the till to show the new stock. */
export async function takeLabelLines(lines, ups, dir, key) {
  const st = labelsStore();
  const d = await readLabels(st);
  if (!d.items.length) return { lines, ups, inventory: [] };
  const bySku = new Map(d.items.map(x => [x.sku, x]));
  const mine = l => !l.variantId && bySku.has(norm(l.sku));
  const ours = [...lines.filter(mine).map(l => [l, dir]), ...ups.filter(mine).map(l => [l, 1])];
  if (!ours.length) return { lines, ups, inventory: [] };

  if (!(key && d.done[key])) {
    for (const [l, sign] of ours) {
      const it = bySku.get(norm(l.sku));
      it.stock = Math.max(0, (Number(it.stock) || 0) + sign * l.quantity);
    }
    if (key) {
      d.done[key] = Date.now();
      const keys = Object.keys(d.done);
      if (keys.length > DONE_KEEP) keys.sort((a, b) => d.done[a] - d.done[b]).slice(0, keys.length - DONE_KEEP).forEach(k => delete d.done[k]);
    }
    await st.setJSON('items', d);
  }
  const inventory = ours.map(([l]) => { const it = bySku.get(norm(l.sku)); return { sku: it.sku, quantity: it.stock }; });
  return { lines: lines.filter(l => !mine(l)), ups: ups.filter(l => !mine(l)), inventory };
}
