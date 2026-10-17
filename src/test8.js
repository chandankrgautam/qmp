import fs from 'node:fs';
import { signNonce } from './auth.js';
import { uploadCompletion, uploadInspection } from './testutil.js';
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
const call = (tok, path, method = 'GET', body, prefix = '/maintenance/v1') =>
  fetch(`${BASE}${prefix}${path}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };

async function run() {
  const resident   = await login('RESIDENT:R. K. Singh');
  const family     = await login('RESIDENT:Mrs S. Singh');
  const overseer   = await login('CIVIL_OVERSEER:A. K. Dubey');
  const incharge   = await login('MAINTENANCE_INCHARGE:P. N. Mishra');
  const staffOff   = await login('STAFF_OFFICER_CIVIL:S. Tiwari');
  const contractor = await login('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');

  const cats = await j(await call(resident.token, '/masters/categories'));
  const post = (tok, p, b) => call(tok, p, 'POST', b);

  async function ticketTo(code, upto) {
    const sub = cats.find((c) => c.name_en.startsWith(code));
    const t = await j(await post(resident.token, '/tickets', { sub_category_id: sub.id }));
    if (upto === 'RAISED') return t;
    await post(overseer.token, `/tickets/${t.id}/verify`);
    if (upto === 'VERIFIED') return t;
    const dv = await j(await call(incharge.token, '/devices/assignable'));
    await post(incharge.token, `/tickets/${t.id}/assign`,
      { supervisor_id: dv[0].actor_id });
    await post(contractor.token, `/tickets/${t.id}/start`,
      { workmen_assigned: 'Ram Prasad' });
    if (upto === 'IN_PROGRESS') return t;
    await uploadCompletion(BASE, contractor.token, t.id);
    await post(contractor.token, `/tickets/${t.id}/complete`);
    if (upto === 'WORK_COMPLETED') return t;
    await uploadInspection(BASE, overseer.token, t.id);
    await post(overseer.token, `/tickets/${t.id}/inspect`, { accepted: true });
    if (upto === 'INSPECTED') return t;
    await post(overseer.token, `/tickets/${t.id}/close`);
    return t;
  }

  /* ---------------- A1: the SLA clock ---------------- */
  const t1 = await ticketTo('Leaking tap', 'IN_PROGRESS');

  let r = await post(contractor.token, `/tickets/${t1.id}/pause`,
    { attribution: 'OCCUPANT', reason: 'Quarter locked' });
  check('a contractor cannot pause the clock they are measured against',
    r.status === 403 || r.status === 422, `status ${r.status}`);

  r = await post(overseer.token, `/tickets/${t1.id}/pause`,
    { attribution: 'CONTRACTOR', reason: 'No manpower' });
  check('want of labour is not a pausing reason', r.status === 422);

  r = await post(overseer.token, `/tickets/${t1.id}/pause`,
    { attribution: 'OCCUPANT', reason: 'Quarter locked, no access' });
  check('the Overseer pauses for a locked quarter', r.status === 201,
    JSON.stringify(await j(r)).slice(0, 130));

  r = await post(overseer.token, `/tickets/${t1.id}/pause`,
    { attribution: 'OCCUPANT', reason: 'Again' });
  check('the same clock cannot be paused twice', r.status === 409);

  const before = await withSystem(maintPool, (c) => c.query(
    `SELECT completion_deadline_at, original_completion_deadline_at
       FROM ticket WHERE id=$1`, [t1.id]));
  await withSystem(maintPool, (c) => c.query(
    `UPDATE sla_pause SET paused_at = now() - interval '6 hours'
      WHERE ticket_id=$1 AND resumed_at IS NULL`, [t1.id]));

  r = await post(overseer.token, `/tickets/${t1.id}/resume`, {});
  check('the Overseer resumes it', r.status === 200);

  const after = await withSystem(maintPool, (c) => c.query(
    `SELECT completion_deadline_at, original_completion_deadline_at,
            total_paused_minutes FROM ticket WHERE id=$1`, [t1.id]));
  const moved = new Date(after.rows[0].completion_deadline_at) -
                new Date(before.rows[0].completion_deadline_at);
  check('the deadline moves forward by the time the premises was locked',
    moved > 5.5 * 3600e3 && moved < 6.5 * 3600e3, `${(moved / 3600e3).toFixed(1)} hours`);
  check('but the original commitment is left untouched',
    String(after.rows[0].original_completion_deadline_at) ===
    String(before.rows[0].original_completion_deadline_at));
  check('and the paused time is recorded',
    Number(after.rows[0].total_paused_minutes) >= 350);

  r = await post(overseer.token, `/tickets/${t1.id}/resume`, {});
  check('resuming a clock that is running is refused', r.status === 403);

  const pauses = await j(await call(overseer.token, `/tickets/${t1.id}/pauses`));
  check('the pause history is readable', Array.isArray(pauses) && pauses.length === 1);

  /* ---------------- A2: delay attribution ---------------- */
  await withSystem(maintPool, (c) => c.query(
    `INSERT INTO sla_breach (ticket_id, clock) VALUES ($1,'COMPLETION')`, [t1.id]));
  let breaches = await j(await call(staffOff.token, '/breaches?unattributed=true'));
  check('unattributed breaches can be listed', breaches.items?.length >= 1);
  const breachId = breaches.items[0].id;

  r = await call(contractor.token, `/breaches/${breachId}/attribute`, 'POST',
    { attribution: 'DEPARTMENT' });
  check('the contractor cannot attribute a delay away from themselves', r.status === 403);
  r = await call(resident.token, `/breaches/${breachId}/attribute`, 'POST',
    { attribution: 'CONTRACTOR' });
  check('nor can a resident attribute one', r.status === 403);

  r = await call(staffOff.token, `/breaches/${breachId}/attribute`, 'POST',
    { attribution: 'NONSENSE' });
  check('an attribution outside the four recognised causes is refused', r.status === 422);

  r = await call(staffOff.token, `/breaches/${breachId}/attribute`, 'POST',
    { attribution: 'CONTRACTOR', note: 'No labour deployed for three days' });
  check('the Staff Officer attributes the delay', r.status === 200);

  const audited = await withSystem(maintPool, (c) => c.query(
    `SELECT 1 FROM audit_log WHERE event_type='DELAY_ATTRIBUTED'`));
  check('the attribution is written to the audit log', audited.rowCount >= 1);

  breaches = await j(await call(staffOff.token, '/breaches?unattributed=true'));
  check('and it leaves the unattributed list',
    !breaches.items.some((b) => b.id === breachId));

  const ct = await withSystem(maintPool, (c) => c.query(
    `SELECT contract_id FROM ticket WHERE id=$1`, [t1.id]));
  const perf = await j(await call(staffOff.token,
    `/contracts/${ct.rows[0].contract_id}/performance`));
  check('and reaches the contract performance report',
    (perf.delay_attribution || []).some((a) => a.attribution === 'CONTRACTOR'),
    JSON.stringify(perf.delay_attribution));

  /* ---------------- A3: answering an objection ---------------- */
  const t2 = await ticketTo('Roof leakage', 'IN_PROGRESS');
  const obj = await j(await post(family.token, `/tickets/${t2.id}/objections`,
    { note: 'Old sheet refitted, not replaced' }));
  check('an objection is raised', !!obj.id);

  const open = await j(await call(overseer.token, '/objections?open=true'));
  check('open objections are listed with their deadline',
    open.items?.some((o) => o.id === obj.id && o.response_deadline_at));

  r = await call(contractor.token, `/objections/${obj.id}/respond`, 'POST',
    { response_note: 'Nothing wrong' });
  check('the contractor cannot answer an objection about their own work',
    r.status === 403);

  r = await call(overseer.token, `/objections/${obj.id}/respond`, 'POST', {});
  check('an empty response is refused', r.status === 422);

  r = await call(overseer.token, `/objections/${obj.id}/respond`, 'POST',
    { response_note: 'Inspected; sheet is being replaced today' });
  check('the Overseer answers it', r.status === 200);

  const famInbox = await j(await call(family.token, '/notifications'));
  check('the occupant who raised it is told the answer',
    famInbox.items.some((n) => n.event_type === 'OBJECTION_ANSWERED'));

  r = await call(overseer.token, `/objections/${obj.id}/respond`, 'POST',
    { response_note: 'Again' });
  check('an objection cannot be answered twice', r.status === 403);

  /* ---------------- A4: referral out of the contract ---------------- */
  const t3 = await ticketTo('Structural crack', 'VERIFIED');
  r = await post(incharge.token, `/tickets/${t3.id}/refer-special-repair`, {});
  check('a referral without a reason is refused', r.status === 422);

  r = await post(incharge.token, `/tickets/${t3.id}/refer-special-repair`,
    { reason: 'Beam replacement, beyond the maintenance contract' });
  check('the Incharge refers structural work out of the contract', r.status === 200,
    JSON.stringify(await j(r)).slice(0, 120));

  const referred = await j(await call(overseer.token, `/tickets/${t3.id}`));
  check('the ticket leaves the contractor\'s workload',
    referred.state === 'REFERRED_SPECIAL_REPAIR', referred.state);

  /* ---------------- A5: push token ---------------- */
  r = await call(resident.token, '/notifications/push-token', 'PUT',
    { fcm_token: 'token-abc' });
  check('a device registers its push token', r.status === 204, `status ${r.status}`);
  r = await call(resident.token, '/notifications/push-token', 'PUT',
    { fcm_token: 'token-def' });
  check('and can replace it', r.status === 204);
  const tok = await withSystem(maintPool, (c) => c.query(
    `SELECT count(*) n FROM push_token`));
  check('one token per device, not one per registration',
    Number(tok.rows[0].n) === 1, `${tok.rows[0].n} rows`);

  /* ---------------- A8: confirmation and rating ---------------- */
  const t4 = await ticketTo('Wall seepage', 'INSPECTED');
  r = await post(contractor.token, `/tickets/${t4.id}/feedback`,
    { confirmed: true, rating: 5 });
  check('the contractor cannot rate their own work', r.status === 403);

  r = await post(resident.token, `/tickets/${t4.id}/feedback`,
    { confirmed: true, rating: 9 });
  check('a rating outside one to five is refused', r.status === 422);

  r = await post(resident.token, `/tickets/${t4.id}/feedback`,
    { confirmed: true, rating: 4, comment: 'Done properly' });
  check('the resident confirms and rates the work', r.status === 200,
    JSON.stringify(await j(r)).slice(0, 120));

  const fb = await j(await call(resident.token, `/tickets/${t4.id}/feedback`));
  check('the rating is readable', fb?.rating === 4);

  const c4 = await withSystem(maintPool, (c) => c.query(
    `SELECT contract_id FROM ticket WHERE id=$1`, [t4.id]));
  const perf2 = await j(await call(staffOff.token,
    `/contracts/${c4.rows[0].contract_id}/performance`));
  check('and reaches the contract performance report, which it never did before',
    perf2.overall?.avg_rating !== null && perf2.overall?.avg_rating !== undefined,
    `avg_rating ${perf2.overall?.avg_rating}`);

  const t5 = await ticketTo('Door damaged', 'INSPECTED');
  await post(resident.token, `/tickets/${t5.id}/feedback`,
    { confirmed: false, comment: 'Still will not close' });
  const ovrInbox = await j(await call(overseer.token, '/notifications'));
  check('a disputed repair reaches the Overseer',
    ovrInbox.items.some((n) => n.event_type === 'WORK_DISPUTED'));

  const hostel = await withSystem(maintPool, (c) => c.query(
    `SELECT premises_id FROM premises_ref WHERE identifier='Hostel-1'`));
  const ht = await j(await post(overseer.token, '/tickets',
    { sub_category_id: cats.find((c) => c.name_en.startsWith('Leaking tap')).id,
      premises_id: hostel.rows[0].premises_id }));
  r = await post(resident.token, `/tickets/${ht.id}/feedback`, { confirmed: true });
  check('nobody confirms work on a building with no occupant',
    r.status === 403 || r.status === 422, `status ${r.status}`);

  /* ---------------- identity ---------------- */
  const me = await j(await call(resident.token, '/me', 'GET', null, '/identity/v1'));
  check('a device can ask what it is bound to',
    me.role === 'RESIDENT' && me.identifier === 'B-234', JSON.stringify(me).slice(0, 130));
  check('and which Area it belongs to', me.ticket_code === 'JNT', me.ticket_code);

  const meOvr = await j(await call(overseer.token, '/me', 'GET', null, '/identity/v1'));
  check('an accountable role is marked as needing a second factor',
    meOvr.requires_second_factor === true);

  const otp = await (await fetch(`${BASE}/identity/v1/auth/otp/request`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile: '9876500123' }) })).json();
  check('an OTP can be requested', otp.sent === true && !!otp.dev_code);

  const bad = await fetch(`${BASE}/identity/v1/auth/otp/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile: '9876500123', code: '000000' }) });
  check('a wrong code is refused', bad.status === 422);

  const ok = await (await fetch(`${BASE}/identity/v1/auth/otp/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile: '9876500123', code: otp.dev_code }) })).json();
  check('the right code yields a registration token', !!ok.registration_token);

  const reuse = await fetch(`${BASE}/identity/v1/auth/otp/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile: '9876500123', code: otp.dev_code }) });
  check('a code cannot be used twice', reuse.status === 422);

  let limited = 0;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${BASE}/identity/v1/auth/otp/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mobile: '9876500999' }) });
    if (res.status === 429) limited++;
  }
  check('OTP requests are rate limited — the one endpoint anyone can reach',
    limited >= 1, `${limited} refused of 5`);

  const refreshed = await (await fetch(`${BASE}/identity/v1/auth/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: resident.token }) })).json();
  check('an access token can be renewed', !!refreshed.token,
    JSON.stringify(refreshed).slice(0, 100));

  const nig = await login('RESIDENT:Nigahi resident');
  await withSystem(identityPool, (c) => c.query(
    `UPDATE identity.device SET status='REVOKED', revocation_reason='test'
      WHERE public_key=$1`, [devices['RESIDENT:Nigahi resident'].publicKey]));
  const denied = await (await fetch(`${BASE}/identity/v1/auth/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: nig.token }) })).json();
  check('a revoked device is refused at renewal — revocation bites here',
    !!denied.error, JSON.stringify(denied).slice(0, 100));

  const prem = await j(await call(incharge.token, '/premises?q=B-234', 'GET', null,
    '/identity/v1'));
  check('premises can be searched', prem.items?.some((p) => p.identifier === 'B-234'));
  const devList = await j(await call(incharge.token, '/devices', 'GET', null,
    '/identity/v1'));
  check('devices can be listed within scope', Array.isArray(devList) && devList.length > 0);

  r = await call(incharge.token, '/devices/revoke-bulk', 'POST',
    { reason: 'no selector' }, '/identity/v1');
  check('bulk revocation needs exactly one selector', r.status === 422);

  const bulk = await j(await call(incharge.token, '/devices/revoke-bulk', 'POST',
    { role: 'CUSTODIAN', reason: 'Custodian devices are not in use' }, '/identity/v1'));
  check('bulk revocation reports what it revoked',
    typeof bulk.revoked_count === 'number', JSON.stringify(bulk));

  console.log('');
  for (const [st, n, d] of out) {
    console.log(`  ${st}  ${n}${d ? '\n         ' + String(d).slice(0, 170) : ''}`);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await maintPool.end(); await identityPool.end();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
