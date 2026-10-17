/* Per-device keys — who is calling, not just "someone with the token".

   Each till, phone or sheet script holds its own key, dk_<id>_<secret>. The
   site keeps only sha256(secret), in Netlify Blobs ('devices' store):
     dev/<id>     { id, name, store, role:'till'|'admin', keyHash, created,
                    lastSeen, revokedAt? }
     pair/<CODE>  { code, name, store, role, by, expires, used? }  a one-time
                  pairing code from Admin → Devices (10 minutes)

   The DEVICE_KEYS env var is the switch:
     unset / off  nothing changes: x-sales-token works as it always has, keys
                  are ignored and /api/devices only answers ?me=1 with { mode:'off' }.
     on           keys work AND the shared token still works, so devices can be
                  paired one at a time. Sales are stamped with the paired device.
     required     only keys work; SALES_TOKEN no longer opens anything.
                  Admin's password still works where it did. */

import { getStore } from '@netlify/blobs';
import { createHash, randomBytes } from 'node:crypto';
import { same, tokenOk, pinOk } from './http.mjs';

export const ROLES = ['till', 'admin'];
const ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';   // 32: every byte maps evenly
const KEY_RE = /^dk_([a-z0-9]{10})_([A-Za-z0-9_-]{43})$/;
const CACHE_MS = 60 * 1000;        // a revoke reaches every running copy of a function within this
const SEEN_MS = 60 * 60 * 1000;    // lastSeen is written at most once an hour per device
const cache = new Map();           // id → { rec, at }

export function deviceMode() {
  const m = String(process.env.DEVICE_KEYS || '').trim().toLowerCase();
  return m === 'on' || m === 'required' ? m : 'off';
}

export function devicesStore() { return getStore({ name: 'devices', consistency: 'strong' }); }

export function hashSecret(secret) { return createHash('sha256').update(String(secret)).digest('hex'); }

// A fresh device record plus the key to hand back (once — it's never stored).
export function newDevice({ name, store, role }) {
  const id = [...randomBytes(10)].map(b => ID_CHARS[b % ID_CHARS.length]).join('');
  const secret = randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  return {
    key: 'dk_' + id + '_' + secret,
    rec: { id, name, store, role, keyHash: hashSecret(secret), created: now, lastSeen: now },
  };
}

export function publicDevice(rec) {
  if (!rec) return null;
  const { keyHash, ...out } = rec;
  return out;
}

export function forget(id) { cache.delete(id); }

// The device record behind an x-device-key, revoked or not; null when it isn't one of ours.
async function lookup(key) {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const [, id, secret] = m;
  let hit = cache.get(id);
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    const rec = await devicesStore().get('dev/' + id, { type: 'json' }).catch(() => null);
    hit = { rec, at: Date.now() };
    if (rec) cache.set(id, hit); else cache.delete(id);
  }
  const rec = hit.rec;
  if (!rec || !same(hashSecret(secret), rec.keyHash)) return null;
  if (!rec.revokedAt && Date.now() - Date.parse(rec.lastSeen || 0) > SEEN_MS) {
    rec.lastSeen = new Date().toISOString();
    await devicesStore().setJSON('dev/' + id, rec).catch(() => {});
  }
  return rec;
}

/* Who is asking. { ok:true, device } — device is null when the request came in
   on the shared token (or keys are off). { ok:false, code, error } otherwise:
     token    bad or missing x-sales-token (the old check, unchanged)
     missing  keys are required and this request has none
     unknown  the key isn't one the site knows (removed in Admin → Devices)
     revoked  the key was revoked — device holds the record, so sales.mjs can
              still take sales rung up before revokedAt */
export async function auth(req) {
  const mode = deviceMode();
  const key = (req.headers.get('x-device-key') || '').trim();
  if (mode !== 'off' && key) {
    const rec = await lookup(key);
    if (rec && !rec.revokedAt) return { ok: true, device: rec, mode };
    if (rec) return { ok: false, code: 'revoked', device: rec, mode,
      error: 'This device was removed from the site. Pair it again: Admin → Devices on another device.' };
    if (mode === 'required') return { ok: false, code: 'unknown', mode,
      error: 'This device isn\'t paired with the site any more. Pair it again: Admin → Devices on another device.' };
  }
  if (mode === 'required') return { ok: false, code: 'missing', mode,
    error: 'This device needs pairing with the site first: Admin → Devices on another device.' };
  if (!tokenOk(req)) return { ok: false, code: 'token', mode, error: 'Bad or missing x-sales-token.' };
  return { ok: true, device: null, mode };
}

// Admin-level access: an admin device, or the Admin password (pinOk, as before).
export function adminOk(req, who) {
  return !!(who && who.device && who.device.role === 'admin') || pinOk(req);
}
