/* ------------------------------------------------------------------ *
 *  Netlify Function — per-device keys (Admin → Devices)
 * ------------------------------------------------------------------ *
 *  Every till, phone and sheet script gets its own key, so one can be
 *  switched off without retyping a shared token everywhere. How keys are
 *  checked, and the DEVICE_KEYS switch, are in lib/devices.mjs. While
 *  DEVICE_KEYS is unset this only answers ?me=1 with { mode:'off' }.
 *
 *  Routes (all on /api/devices):
 *    GET  ?me=1               → { mode, device|null, known }   no auth; known:false =
 *                               the key sent isn't one the site holds (drop it)
 *    GET                      → { mode, devices:[...] }               admin
 *    POST ?invite=1  { name, store, role }  → { code, expires }       admin
 *    POST ?pair=1    { code }               → { key, device }         no auth
 *    POST ?pair=1    { pin, name, store, role } — the Admin password instead of a
 *                    code: how the first device is paired, or any device if all
 *                    the paired ones are lost                         no auth
 *    POST ?claim=1   { name, store }        → { key, device }         x-sales-token
 *                    DEVICE_KEYS=on only: a till already holding the shared
 *                    token takes a key of its own (a 'till', named for now)
 *    POST ?update=1  { id, name?, store?, role? }                     admin
 *    POST ?revoke=1  { id }    stops the key working (sales rung up before
 *                              now can still come in from its offline queue)
 *    POST ?remove=1  { id }    forgets a device completely               admin
 *
 *  Admin = an admin device, or the Admin password in x-admin-pin.
 *
 *  Env vars:
 *    DEVICE_KEYS   off (default) | on | required — see lib/devices.mjs
 *    ADMIN_PIN     the Admin password; also pairs a device without a code
 *    SALES_TOKEN   the old shared token; ?claim needs it to be set
 * ------------------------------------------------------------------ */

import { randomBytes } from 'node:crypto';
import { corsHeaders, preflight, json, same } from '../lib/http.mjs';
import { auth, adminOk, deviceMode, devicesStore, newDevice, publicDevice, forget, ROLES } from '../lib/devices.mjs';

const STORE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID_RE = /^[a-z0-9]{10}$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z0-9]{8}$/;
const CODE_MS = 10 * 60 * 1000;

export default async (req) => {
  const headers = corsHeaders('GET, POST');
  if (req.method === 'OPTIONS') return preflight(headers);
  const q = new URL(req.url).searchParams;
  const mode = deviceMode();

  try {
    if (req.method === 'GET' && q.get('me')) return await me(req, headers, mode);
    if (mode === 'off') return json({ mode, error: 'Device keys are switched off on this site (DEVICE_KEYS).' }, 503, headers);

    if (req.method === 'POST' && q.get('pair')) return await pair(req, headers);
    if (req.method === 'POST' && q.get('claim')) return await claim(req, headers, mode);

    const who = await auth(req);
    if (!who.ok) return json({ error: who.error, code: who.code }, 401, headers);
    if (!adminOk(req, who)) return json({ error: 'Admin password required.' }, 401, headers);

    if (req.method === 'GET') return await list(headers, mode);
    if (req.method === 'POST') {
      let b;
      try { b = await req.json(); } catch (e) { return json({ error: 'Body must be JSON.' }, 400, headers); }
      if (q.get('invite')) return await invite(b, who, headers);
      if (q.get('update')) return await edit(b, headers, rec => Object.assign(rec, fields(b, rec)));
      if (q.get('revoke')) return await edit(b, headers, rec => { if (!rec.revokedAt) rec.revokedAt = new Date().toISOString(); });
      if (q.get('remove')) {
        const id = String((b && b.id) || '');
        if (!ID_RE.test(id)) return json({ error: 'Bad device id.' }, 400, headers);
        await devicesStore().delete('dev/' + id);
        forget(id);
        return json({ ok: true }, 200, headers);
      }
    }
    return json({ error: 'Method not allowed.' }, 405, headers);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500, headers);
  }
};

export const config = { path: '/api/devices' };

// The till asks this when it opens: is the switch on, and is my key still good?
async function me(req, headers, mode) {
  if (mode === 'off') return json({ mode, device: null, known: true }, 200, headers);
  const hasKey = !!(req.headers.get('x-device-key') || '').trim();
  const who = await auth(req);
  const device = who.device ? publicDevice(who.device) : null;
  return json({ mode, device, known: !hasKey || !!device }, 200, headers);
}

async function list(headers, mode) {
  const st = devicesStore();
  const listed = await st.list({ prefix: 'dev/' });
  const recs = await Promise.all(((listed && listed.blobs) || []).map(b => st.get(b.key, { type: 'json' }).catch(() => null)));
  const devices = recs.filter(Boolean).map(publicDevice)
    .sort((a, b) => (a.revokedAt ? 1 : 0) - (b.revokedAt ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  return json({ mode, devices }, 200, headers);
}

async function invite(b, who, headers) {
  const f = fields(b, {});
  if (!f.name) return json({ error: 'Give the device a name.' }, 400, headers);
  const code = [...randomBytes(8)].map(x => CODE_CHARS[x % CODE_CHARS.length]).join('');
  const expires = new Date(Date.now() + CODE_MS).toISOString();
  const by = who.device ? who.device.name : 'Admin password';
  await devicesStore().setJSON('pair/' + code, { code, ...f, role: f.role || 'till', by, expires });
  return json({ ok: true, code, expires }, 200, headers);
}

async function pair(req, headers) {
  let b;
  try { b = await req.json(); } catch (e) { return json({ error: 'Body must be JSON.' }, 400, headers); }
  const st = devicesStore();

  if (b && b.pin !== undefined) {
    const pin = process.env.ADMIN_PIN;
    if (!pin) return json({ error: 'No Admin password is set on the site (ADMIN_PIN).' }, 503, headers);
    if (!same(String(b.pin), pin)) {
      await new Promise(r => setTimeout(r, 800));   // slows down guessing, as /api/admin does
      return json({ error: 'Wrong password' }, 401, headers);
    }
    const f = fields(b, {});
    if (!f.name) return json({ error: 'Give this device a name.' }, 400, headers);
    return await create(st, { ...f, role: f.role || 'till' }, headers);
  }

  const code = String((b && b.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!CODE_RE.test(code)) return json({ error: 'That isn\'t a pairing code (8 letters and numbers).' }, 400, headers);
  const got = await st.getWithMetadata('pair/' + code, { type: 'json' }).catch(() => null);
  const inv = got && got.data;
  if (!inv || inv.used || Date.parse(inv.expires) < Date.now()) {
    await new Promise(r => setTimeout(r, 800));
    return json({ error: 'That code is wrong, already used or more than 10 minutes old. Make a new one in Admin → Devices.' }, 400, headers);
  }
  // Mark it used with a compare-and-swap, so two devices typing it at once can't both pair.
  const res = await st.setJSON('pair/' + code, { ...inv, used: new Date().toISOString() }, got.etag ? { onlyIfMatch: got.etag } : {});
  if (res && res.modified === false) return json({ error: 'That code was just used by another device.' }, 409, headers);
  const out = await create(st, { name: inv.name, store: inv.store || '', role: inv.role }, headers);
  await st.delete('pair/' + code).catch(() => {});
  return out;
}

async function claim(req, headers, mode) {
  if (mode !== 'on') return json({ error: 'Claiming a key with the shared token only works while DEVICE_KEYS=on.' }, 403, headers);
  const want = process.env.SALES_TOKEN;
  if (!want) return json({ error: 'The site has no SALES_TOKEN, so tills pair with a code from Admin → Devices instead.' }, 403, headers);
  if (!same(req.headers.get('x-sales-token') || '', want)) return json({ error: 'Bad or missing x-sales-token.', code: 'token' }, 401, headers);
  let b = {};
  try { b = await req.json(); } catch (e) { /* no body — name it below */ }
  const f = fields(b, {});
  return await create(devicesStore(), { name: f.name || 'Unnamed till', store: f.store || '', role: 'till' }, headers);
}

async function create(st, f, headers) {
  const { key, rec } = newDevice(f);
  await st.setJSON('dev/' + rec.id, rec);
  return json({ ok: true, key, device: publicDevice(rec) }, 200, headers);
}

async function edit(b, headers, change) {
  const id = String((b && b.id) || '');
  if (!ID_RE.test(id)) return json({ error: 'Bad device id.' }, 400, headers);
  const st = devicesStore();
  const rec = await st.get('dev/' + id, { type: 'json' }).catch(() => null);
  if (!rec) return json({ error: 'No such device.' }, 404, headers);
  change(rec);
  await st.setJSON('dev/' + id, rec);
  forget(id);
  return json({ ok: true, device: publicDevice(rec) }, 200, headers);
}

// The editable bits of a device, checked; anything missing keeps `prev`'s value.
function fields(b, prev) {
  const out = {};
  if (b && b.name !== undefined) out.name = String(b.name).trim().slice(0, 60);
  if (b && b.store !== undefined) { const s = String(b.store).trim(); out.store = STORE_RE.test(s) ? s : ''; }
  if (b && ROLES.includes(b.role)) out.role = b.role;
  if (out.name === '' && prev.name) delete out.name;
  return out;
}
