import fs from 'node:fs';
import { requirePhotos } from './testutil.js';
import crypto from 'node:crypto';
import { signNonce } from './auth.js';
import { purgeExpiredBytes, driver, sniffContentType } from './storage.js';
import { withSystem, maintPool, identityPool } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); }
};

async function login(key) {
  const d = devices[key];
  const ch = await (await fetch(`${BASE}/identity/v1/auth/challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: d.publicKey }) })).json();
  return (await (await fetch(`${BASE}/identity/v1/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: d.publicKey, nonce: ch.nonce,
      signature: signNonce(d.privateKey, ch.nonce), second_factor_satisfied: true, role: d.role })
  })).json());
}
const call = (tok, path, method = 'GET', body) =>
  fetch(`${BASE}/maintenance/v1${path}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };

/* A minimal but genuine JPEG: SOI, APP0/JFIF, then padding to a plausible
   size for a phone photograph after compression. Real enough that the
   server's own sniffing accepts it, which is the point. */
function makeJpeg(sizeBytes = 380 * 1024) {
  const head = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00
  ]);
  const body = crypto.randomBytes(Math.max(0, sizeBytes - head.length - 2));
  return Buffer.concat([head, body, Buffer.from([0xff, 0xd9])]);
}
function makeWebp(sizeBytes = 200 * 1024) {
  const body = crypto.randomBytes(Math.max(0, sizeBytes - 12));
  const head = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WEBP', 'ascii')
  ]);
  return Buffer.concat([head, body]);
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function upload(tok, ticketId, purpose, buf, opts = {}) {
  const askRes = await call(tok, '/media/upload-url', 'POST',
    { ticket_id: ticketId, purpose, content_type: opts.content_type || 'image/jpeg' });
  const ask = await j(askRes);
  if (!ask.media_id) return { status: askRes.status, body: ask };
  const url = ask.upload_url.startsWith('http') ? ask.upload_url : BASE + ask.upload_url;
  await fetch(url, { method: 'PUT', body: buf,
    headers: { 'content-type': opts.content_type || 'image/jpeg' } });
  const confirm = await call(tok, `/media/${ask.media_id}/confirm`, 'POST', {
    captured_at: new Date().toISOString(),
    content_hash: opts.hash === null ? undefined : (opts.hash || sha(buf)),
    capture_verified: opts.capture_verified ?? true,
    // every photograph is located since 2026-10-12; latitude: null sends none
    latitude: opts.latitude === undefined ? 24.1102 : opts.latitude ?? undefined,
    longitude: opts.longitude === undefined ? 82.6531 : opts.longitude ?? undefined,
    gps_accuracy_m: opts.latitude === null ? undefined : (opts.gps_accuracy_m ?? 6.0),
    content_type: opts.declared_type || opts.content_type || 'image/jpeg' });
  return { media_id: ask.media_id, status: confirm.status, body: await j(confirm) };
}

async function run() {
  await requirePhotos();   // this suite tests the photograph gate as HQ will switch it on
  const resident   = await login('RESIDENT:R. K. Singh');
  const overseer   = await login('CIVIL_OVERSEER:A. K. Dubey');
  const incharge   = await login('MAINTENANCE_INCHARGE:P. N. Mishra');
  const contractor = await login('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const admin      = await login('ADMINISTRATOR:System Admin');
  const nigahiOvr  = await login('CIVIL_OVERSEER:Nigahi Overseer');

  const cats = await j(await call(resident.token, '/masters/categories'));
  const post = (tok, p, b) => call(tok, p, 'POST', b);
  const sub = cats.find((c) => c.name_en.startsWith('Leaking tap'));

  const t = await j(await post(resident.token, '/tickets', { sub_category_id: sub.id }));
  check('a complaint exists to photograph', !!t.id, JSON.stringify(t).slice(0, 120));

  /* ---------------- the two-step upload ---------------- */
  const img = makeJpeg(400 * 1024);
  const ask = await j(await call(resident.token, '/media/upload-url', 'POST',
    { ticket_id: t.id, purpose: 'COMPLAINT', content_type: 'image/jpeg' }));
  check('a pre-signed upload URL is issued', !!ask.upload_url && !!ask.media_id,
    JSON.stringify(ask).slice(0, 140));
  check('the URL carries an expiry and a size limit',
    ask.expires_in > 0 && ask.max_bytes > 0);

  const pending = await withSystem(maintPool, (c) => c.query(
    `SELECT upload_state, storage_key FROM ticket_media WHERE id=$1`, [ask.media_id]));
  check('the record starts PENDING, before any bytes exist',
    pending.rows[0].upload_state === 'PENDING');
  check('the object key groups a premises\' photographs together',
    /\/.*\/.*\/complaint-/.test(pending.rows[0].storage_key),
    pending.rows[0].storage_key);

  /* a pending photograph must not satisfy a lifecycle gate */
  await post(overseer.token, `/tickets/${t.id}/verify`);
  const dv = await j(await call(incharge.token, '/devices/assignable'));
  await post(incharge.token, `/tickets/${t.id}/assign`,
    { supervisor_id: dv[0].actor_id });
  await post(contractor.token, `/tickets/${t.id}/start`, { workmen_assigned: 'Ram Prasad' });

  const askPending = await j(await call(contractor.token, '/media/upload-url', 'POST',
    { ticket_id: t.id, purpose: 'COMPLETION' }));
  let r = await post(contractor.token, `/tickets/${t.id}/complete`);
  check('an upload that never arrived does not satisfy the completion gate',
    r.status === 422, `status ${r.status}`);

  /* now upload for real */
  const done = await upload(contractor.token, t.id, 'COMPLETION', img);
  check('the contractor uploads a completion photograph', done.status === 200,
    JSON.stringify(done.body).slice(0, 140));
  check('the server records the true size, not one the client claimed',
    done.body.size_bytes === img.length, `${done.body.size_bytes} vs ${img.length}`);

  // since 2026-10-07 a claim also needs a "before" photograph of the round
  const before = await upload(contractor.token, t.id, 'BEFORE', img);
  check('the contractor uploads a before photograph too', before.status === 200,
    JSON.stringify(before.body).slice(0, 140));
  r = await post(contractor.token, `/tickets/${t.id}/complete`);
  check('and the completion gate now opens', r.status === 200);

  /* ---------------- integrity ---------------- */
  const wrongHash = await upload(contractor.token, t.id, 'COMPLETION', makeJpeg(50 * 1024),
    { hash: sha(Buffer.from('something else')) });
  check('an image that does not match its hash is refused',
    wrongHash.status === 422, `status ${wrongHash.status}`);

  const notAnImage = await upload(contractor.token, t.id, 'COMPLETION',
    Buffer.from('This is a text file pretending to be a photograph'));
  check('a file that is not a photograph is refused',
    notAnImage.status === 422, JSON.stringify(notAnImage.body).slice(0, 120));

  const mislabelled = await upload(contractor.token, t.id, 'COMPLETION', makeWebp(30 * 1024),
    { content_type: 'image/webp', declared_type: 'image/jpeg' });
  check('an image whose declared type is wrong is refused',
    mislabelled.status === 422, JSON.stringify(mislabelled.body).slice(0, 120));

  const webp = await upload(contractor.token, t.id, 'COMPLETION', makeWebp(30 * 1024),
    { content_type: 'image/webp' });
  check('WebP is accepted alongside JPEG', webp.status === 200,
    JSON.stringify(webp.body).slice(0, 120));

  const askPdf = await call(contractor.token, '/media/upload-url', 'POST',
    { ticket_id: t.id, purpose: 'COMPLETION', content_type: 'application/pdf' });
  check('a content type that is not an image is refused at the URL stage',
    askPdf.status === 422);

  const oversize = await upload(contractor.token, t.id, 'COMPLETION', makeJpeg(6 * 1024 * 1024));
  check('an image over the size limit is refused and not kept',
    oversize.status === 422, `status ${oversize.status}`);

  /* rejected uploads must not leave bytes behind */
  const leftovers = await withSystem(maintPool, (c) => c.query(
    `SELECT storage_key FROM ticket_media WHERE upload_state='FAILED'`));
  let orphans = 0;
  for (const row of leftovers.rows) {
    if (await driver.stat(row.storage_key)) orphans++;
  }
  check('a refused upload leaves no bytes in the store', orphans === 0,
    `${orphans} orphaned objects`);

  /* ---------------- the inspection control ---------------- */
  const noGeo = await upload(overseer.token, t.id, 'INSPECTION', img,
    { capture_verified: true, latitude: null, longitude: null });
  check('an inspection photograph without coordinates is refused',
    noGeo.status === 422, JSON.stringify(noGeo.body).slice(0, 120));

  const gallery = await upload(overseer.token, t.id, 'INSPECTION', img,
    { capture_verified: false, latitude: 24.11, longitude: 82.65 });
  check('an inspection photograph not taken in the app is refused',
    gallery.status === 422, JSON.stringify(gallery.body).slice(0, 120));

  r = await post(overseer.token, `/tickets/${t.id}/inspect`, { accepted: true });
  check('and the inspection gate stays shut', r.status === 422);

  const good = await upload(overseer.token, t.id, 'INSPECTION', img,
    { capture_verified: true, latitude: 24.1102, longitude: 82.6531 });
  check('an in-app geo-tagged inspection photograph is accepted',
    good.status === 200, JSON.stringify(good.body).slice(0, 120));

  r = await post(overseer.token, `/tickets/${t.id}/inspect`, { accepted: true });
  check('and the inspection gate opens', r.status === 200);

  /* ---------------- retrieval and scope ---------------- */
  const image = await fetch(`${BASE}/maintenance/v1/media/${good.media_id}/image`,
    { headers: { authorization: `Bearer ${overseer.token}` } });
  const bytes = Buffer.from(await image.arrayBuffer());
  check('the photograph can be retrieved', image.status === 200 && bytes.length === img.length,
    `${bytes.length} bytes`);
  check('what comes back is byte-identical to what went in', sha(bytes) === sha(img));
  check('and it really is a JPEG', sniffContentType(bytes) === 'image/jpeg');

  const foreign = await fetch(`${BASE}/maintenance/v1/media/${good.media_id}/image`,
    { headers: { authorization: `Bearer ${nigahiOvr.token}` } });
  check('an out-of-area officer cannot fetch the image', foreign.status === 404,
    `status ${foreign.status}`);

  const noToken = await fetch(`${BASE}/maintenance/v1/media/${good.media_id}/image`);
  check('and neither can an unauthenticated caller', noToken.status === 401);

  /* a client cannot confirm somebody else's upload */
  const someone = await j(await call(contractor.token, '/media/upload-url', 'POST',
    { ticket_id: t.id, purpose: 'COMPLETION' }));
  const stolen = await call(resident.token, `/media/${someone.media_id}/confirm`, 'POST',
    { content_hash: sha(img), capture_verified: true });
  check('one device cannot confirm another device\'s upload', stolen.status === 403);

  const twice = await call(overseer.token, `/media/${good.media_id}/confirm`, 'POST',
    { content_hash: sha(img), capture_verified: true,
      latitude: 24.11, longitude: 82.65 });
  check('a photograph cannot be confirmed twice', twice.status === 409);

  /* ---------------- retention ---------------- */
  const usage = await j(await call(admin.token, '/admin/media/usage'));
  check('storage usage is reported by purpose', Array.isArray(usage.by_purpose) &&
    usage.by_purpose.length >= 2, JSON.stringify(usage.by_purpose).slice(0, 140));
  check('and the store reports what it actually holds',
    usage.store.objects > 0 && usage.store.bytes > 0, JSON.stringify(usage.store));

  await withSystem(maintPool, (c) => c.query(
    `UPDATE ticket_media SET purge_after = now() - interval '1 day' WHERE id=$1`,
    [good.media_id]));
  const purged = await withSystem(maintPool, (c) => purgeExpiredBytes(c, { quiet: true }));
  check('expired photographs are purged from the store', purged.bytes_removed >= 1,
    JSON.stringify(purged));

  const gone = await driver.stat(
    (await withSystem(maintPool, (c) => c.query(
      `SELECT storage_key FROM ticket_media WHERE id=$1`, [good.media_id]))).rows[0].storage_key);
  check('the bytes are actually gone', gone === null);

  const record = await withSystem(maintPool, (c) => c.query(
    `SELECT content_hash, latitude, captured_at, bytes_purged_at
       FROM ticket_media WHERE id=$1`, [good.media_id]));
  check('but the record of the inspection outlives the image',
    record.rows[0].content_hash && record.rows[0].latitude !== null &&
    record.rows[0].bytes_purged_at !== null,
    JSON.stringify(record.rows[0]));

  const after = await fetch(`${BASE}/maintenance/v1/media/${good.media_id}/image`,
    { headers: { authorization: `Bearer ${overseer.token}` } });
  check('fetching a purged photograph says so, rather than 404',
    after.status === 410, `status ${after.status}`);

  r = await post(overseer.token, '/admin/media/purge');
  check('only the administrator may run the purge', r.status === 403);
  r = await post(admin.token, '/admin/media/purge');
  check('the administrator may run it', r.status === 200);

  console.log('');
  for (const [st, n, d] of out) {
    console.log(`  ${st}  ${n}${d ? '\n         ' + String(d).slice(0, 170) : ''}`);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await maintPool.end(); await identityPool.end();
  process.exit(fail ? 1 : 0);
}

function report() {
  console.log('');
  for (const [st, n, d] of out) {
    console.log(`  ${st}  ${n}${d ? '\n         ' + String(d).slice(0, 170) : ''}`);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
}
run().catch((e) => { report(); console.error('crashed:', e.message); process.exit(1); });
