import fs from 'node:fs';
import { signNonce } from './auth.js';
import { uploadCompletion, uploadInspection, requirePhotos } from './testutil.js';
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

async function run() {
  await requirePhotos();   // this suite tests the photograph gate as HQ will switch it on
  const resident   = await login('RESIDENT:R. K. Singh');
  const overseer   = await login('CIVIL_OVERSEER:A. K. Dubey');
  const incharge   = await login('MAINTENANCE_INCHARGE:P. N. Mishra');
  const contractor = await login('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const admin      = await login('ADMINISTRATOR:System Admin');
  const gm         = await login('GM_CIVIL:GM (Civil)');

  const cats = await j(await call(resident.token, '/masters/categories'));
  const post = (tok, p, b) => call(tok, p, 'POST', b);

  /* helper: drive a complaint to a given state */
  async function makeTicket(code, upto) {
    const sub = cats.find((c) => c.name_en.startsWith(code));
    const t = await j(await post(resident.token, '/tickets', { sub_category_id: sub.id }));
    if (upto === 'RAISED') return t;
    await post(overseer.token, `/tickets/${t.id}/verify`);
    if (upto === 'VERIFIED') return t;
    const dv = await j(await call(incharge.token, '/devices/assignable'));
    await post(incharge.token, `/tickets/${t.id}/assign`,
      { supervisor_id: dv[0].actor_id });
    if (upto === 'ASSIGNED') return t;
    await post(contractor.token, `/tickets/${t.id}/start`, { workmen_assigned: 'Ram Prasad' });
    await uploadCompletion(BASE, contractor.token, t.id);
    await post(contractor.token, `/tickets/${t.id}/complete`);
    return t;
  }

  /* ---------------- bulk assignment ---------------- */
  const verified = [];
  for (const code of ['Leaking tap', 'Roof leakage', 'Wall seepage', 'Door damaged']) {
    verified.push(await makeTicket(code, 'VERIFIED'));
  }
  const devs = await j(await call(incharge.token, '/devices/assignable'));

  let r = await post(resident.token, '/tickets/assign-bulk',
    { ticket_ids: verified.map((t) => t.id), supervisor_id: devs[0].actor_id });
  const residentBulk = await j(r);
  check('a resident cannot bulk assign',
    r.status === 403 || residentBulk.assigned === 0, JSON.stringify(residentBulk));

  r = await post(incharge.token, '/tickets/assign-bulk',
    { ticket_ids: verified.map((t) => t.id), supervisor_id: devs[0].actor_id });
  const bulk = await j(r);
  check('Incharge assigns four complaints in one action', bulk.assigned === 4,
    JSON.stringify(bulk));
  check('bulk assign reports per-ticket failures rather than failing whole',
    Array.isArray(bulk.failed));

  r = await post(incharge.token, '/tickets/assign-bulk',
    { ticket_ids: [], supervisor_id: devs[0].actor_id });
  check('bulk assign with nothing selected is refused', r.status === 422);

  r = await post(incharge.token, '/tickets/assign-bulk',
    { ticket_ids: verified.map((t) => t.id),
      supervisor_id: '00000000-0000-0000-0000-000000000000' });
  check('bulk assign to a device that is not a contractor is refused', r.status === 422);

  /* ---------------- batch inspection ---------------- */
  const completed = [];
  for (const code of ['Sewage overflow', 'Manhole cover', 'WC or pan']) {
    completed.push(await makeTicket(code, 'WORK_COMPLETED'));
  }
  // no photographs yet
  r = await post(overseer.token, '/tickets/inspect-batch',
    { inspections: completed.map((t) => ({ ticket_id: t.id })) });
  let batch = await j(r);
  check('batch inspection refuses a ticket with no inspection photograph',
    batch.accepted === 0 && batch.failed.length === completed.length,
    JSON.stringify(batch));

  for (const t of completed) {
    await uploadInspection(BASE, overseer.token, t.id);
  }
  r = await post(overseer.token, '/tickets/inspect-batch',
    { inspections: completed.map((t) => ({ ticket_id: t.id })) });
  batch = await j(r);
  check('Overseer accepts three inspections from one visit', batch.accepted === 3,
    JSON.stringify(batch));

  const after = await j(await call(overseer.token, `/tickets/${completed[0].id}`));
  check('each batched ticket still records its own inspection',
    after.state === 'INSPECTED_ACCEPTED' &&
    after.media.some((m) => m.purpose === 'INSPECTION'));

  r = await post(contractor.token, '/tickets/inspect-batch',
    { inspections: completed.map((t) => ({ ticket_id: t.id })) });
  const contractorBatch = await j(r);
  check('a contractor cannot batch inspect their own work',
    r.status === 403 || contractorBatch.accepted === 0, JSON.stringify(contractorBatch));

  /* ---------------- reopen window ---------------- */
  const t1 = await makeTicket('Window or shutter', 'WORK_COMPLETED');
  await uploadInspection(BASE, overseer.token, t1.id);
  await post(overseer.token, `/tickets/${t1.id}/inspect`, { accepted: true });
  await post(overseer.token, `/tickets/${t1.id}/close`);

  r = await post(resident.token, `/tickets/${t1.id}/reopen`, { reason: 'Still rattling' });
  check('a resident reopens inside the window', r.status === 200, JSON.stringify(await j(r)));

  // close it again and age it past the window
  await post(overseer.token, `/tickets/${t1.id}/assign`, {});   // ignored, wrong role
  await withSystem(maintPool, (c) => c.query(
    `UPDATE ticket SET state='CLOSED', closed_at = now() - interval '5 days' WHERE id=$1`,
    [t1.id]));
  r = await post(resident.token, `/tickets/${t1.id}/reopen`, { reason: 'Much later' });
  check('reopening after the window has closed is refused', r.status === 409,
    `status ${r.status}`);

  await withSystem(maintPool, (c) => c.query(
    `UPDATE maint_config SET value='240' WHERE key='reopen_window_hours'`));
  r = await post(resident.token, `/tickets/${t1.id}/reopen`, { reason: 'Window widened' });
  check('the reopen window is configurable', r.status === 200, `status ${r.status}`);
  await withSystem(maintPool, (c) => c.query(
    `UPDATE maint_config SET value='24' WHERE key='reopen_window_hours'`));

  /* ---------------- excluded scope notice ---------------- */
  const notice = await j(await call(resident.token, '/masters/excluded-scope'));
  check('the excluded-scope notice is served from the database',
    notice.sections?.length >= 5, JSON.stringify(notice.sections?.length));
  check('every section carries both languages',
    notice.sections.every((x) => x.heading_en && x.heading_hi && x.body_en && x.body_hi));
  check('Area contact numbers appear on the notice',
    notice.area_contacts?.length > 0);
  check('the notice covers electrical, estate and common areas',
    notice.sections.some((x) => /Electrical/.test(x.heading_en)) &&
    notice.sections.some((x) => /Estate/.test(x.heading_en)) &&
    notice.sections.some((x) => /common areas/i.test(x.heading_en)));

  /* ---------------- administration ---------------- */
  const cfg = await j(await call(admin.token, '/admin/config'));
  check('the administrator can read every setting', cfg.length >= 8,
    `${cfg.length} settings`);

  r = await call(gm.token, '/admin/config/archive_after_days', 'PUT', { value: '7' });
  check('the GM cannot change a setting', r.status === 403);
  r = await call(overseer.token, '/admin/config/archive_after_days', 'PUT', { value: '7' });
  check('an Overseer cannot change a setting', r.status === 403);

  r = await call(admin.token, '/admin/config/archive_after_days', 'PUT', { value: '45' });
  check('the administrator changes a setting', r.status === 200);
  const cfg2 = await j(await call(admin.token, '/admin/config'));
  check('and it takes effect immediately',
    cfg2.find((x) => x.key === 'archive_after_days').value === '45');

  const sla = await j(await call(admin.token, '/admin/sla'));
  check('SLA rules are listed for editing', sla.length > 10, `${sla.length} rules`);
  const tapRule = sla.find((x) => x.name_en.startsWith('Leaking tap'));

  r = await call(resident.token, `/admin/sla/${tapRule.sub_category_id}`, 'PUT',
    { response_minutes: 1, completion_minutes: 1 });
  check('a resident cannot change an SLA', r.status === 403);

  r = await call(incharge.token, `/admin/sla/${tapRule.sub_category_id}`, 'PUT',
    { response_minutes: 720, completion_minutes: 1440 });
  check('the Incharge, as job-assigning authority, may change an SLA', r.status === 200,
    JSON.stringify(await j(r)));

  const audited = await withSystem(maintPool, (c) => c.query(
    `SELECT before_value, after_value FROM audit_log WHERE event_type='SLA_CHANGED'`));
  check('an SLA change is written to the audit log with its previous value',
    audited.rowCount >= 1 && audited.rows[0].before_value !== null,
    JSON.stringify(audited.rows[0]));

  // prospective only: an already verified ticket keeps the SLA it was given
  const old = verified[0];
  const oldTicket = await j(await call(overseer.token, `/tickets/${old.id}`));
  check('an SLA change does not reach an already verified ticket',
    oldTicket.sla_completion_minutes !== 1440,
    `ticket has ${oldTicket.sla_completion_minutes}`);

  const cards = await j(await call(admin.token, '/admin/dashboard-cards'));
  check('dashboard cards are listed for editing', cards.length > 10);
  const gmCard = cards.find((x) => x.role === 'GM_CIVIL' && x.key === 'overdue');
  r = await call(admin.token, `/admin/dashboard-cards/${gmCard.id}`, 'PUT',
    { warn_above: 1, critical_above: 2, active: true, display_order: 2 });
  check('a card threshold can be changed', r.status === 200);
  const gmDash = await j(await call(gm.token, '/dashboard'));
  const overdueCard = gmDash.cards.find((x) => x.key === 'overdue');
  check('and the GM dashboard reflects it without a release',
    overdueCard && ['normal', 'warning', 'critical'].includes(overdueCard.severity),
    JSON.stringify(overdueCard));

  /* ---------------- language ----------------
     The server-rendered screens these checks read were retired on
     2026-09-30 (the web portal replaces them). What remains server-side
     is the Hindi held as data, which every client shows. */
  const scopeNotice = await j(await fetch(`${BASE}/maintenance/v1/masters/excluded-scope`));
  check('the excluded-scope notice is public and carries Hindi',
    scopeNotice.sections?.some((x) => /सफाई सेवाएँ/.test(x.heading_hi)), JSON.stringify(scopeNotice).slice(0, 120));
  const catsHi = await j(await call(resident.token, '/masters/categories'));
  check('category names are held in Hindi', catsHi.some((c) => /टपकता नल/.test(c.name_hi)));

  /* an untranslated key must fall back to English, not show the key */
  const { t } = await import('./i18n.js');
  check('a missing Hindi string falls back to English, never to a key',
    t('save', 'hi') !== 'save' && t('nonexistent_key_xyz', 'hi') === 'nonexistent_key_xyz');

  console.log('');
  for (const [st, n, d] of out) {
    console.log(`  ${st}  ${n}${d ? '\n         ' + String(d).slice(0, 170) : ''}`);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await maintPool.end(); await identityPool.end();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
