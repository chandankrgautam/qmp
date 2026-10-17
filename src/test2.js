import fs from 'node:fs';
import crypto from 'node:crypto';
import { signNonce, generateDeviceKeypair } from './auth.js';
import { uploadCompletion, uploadInspection } from './testutil.js';
import { runSlaSweep } from './notify.js';
import { withSystem, maintPool, identityPool } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; out.push([' ok ', name, '']); }
  else { fail++; out.push(['FAIL', name, detail]); }
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

/* Registration requires a mobile proved by OTP (FRS 4.4 step 2). Outside
   production the code is returned, so a test can complete the step. */
let mobileSeq = 0;
async function registrationToken() {
  const mobile = `96${String(++mobileSeq).padStart(8, '0')}`;
  const hdr = { 'content-type': 'application/json' };
  const otp = await j(await fetch(`${BASE}/identity/v1/auth/otp/request`, {
    method: 'POST', headers: hdr, body: JSON.stringify({ mobile }) }));
  const ok = await j(await fetch(`${BASE}/identity/v1/auth/otp/verify`, {
    method: 'POST', headers: hdr, body: JSON.stringify({ mobile, code: otp.dev_code }) }));
  return ok.registration_token;
}

async function run() {
  const incharge = await login('MAINTENANCE_INCHARGE:P. N. Mishra');
  const overseer = await login('CIVIL_OVERSEER:A. K. Dubey');
  const contractor = await login('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const resident = await login('RESIDENT:R. K. Singh');
  const nigahiInc = await login('CIVIL_OVERSEER:Nigahi Overseer');

  /* ---------------- registration ---------------- */
  const colonies = await (await fetch(`${BASE}/identity/v1/masters/colonies`)).json();
  check('colony list is public and covers all twelve areas', colonies.length >= 12);
  const jayant = colonies.find((c) => c.area === 'Jayant');

  const kp = generateDeviceKeypair();
  let r = await fetch(`${BASE}/identity/v1/registrations`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      'x-registration-token': await registrationToken() },
    body: JSON.stringify({ public_key: kp.publicKey, name: 'New Resident',
      personnel_no: '99990001', mobile: '9876500001', colony_id: jayant.id,
      sector: 'Sector 3', identifier: 'b 512', role: 'RESIDENT' })
  });
  const reg = await j(r);
  check('registration is accepted with a verified mobile and no device token', r.status === 201 && reg.status === 'PENDING',
    JSON.stringify(reg));

  // an unapproved device must not be able to obtain a token
  const ch = await (await fetch(`${BASE}/identity/v1/auth/challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: kp.publicKey }) })).json();
  const denied = await (await fetch(`${BASE}/identity/v1/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: kp.publicKey, nonce: ch.nonce,
      signature: signNonce(kp.privateKey, ch.nonce) }) })).json();
  check('a pending device cannot obtain a token', !!denied.error, JSON.stringify(denied));

  let queue = await j(await call(incharge.token, '/registrations', 'GET', null, '/identity/v1'));
  check('registration appears in the Incharge queue',
    queue.items.some((i) => i.submitted_identifier === 'b 512'));
  check('queue shows how long it has been waiting',
    queue.items.every((i) => 'waiting_hours' in i));

  const nigahiQueue = await j(await call(nigahiInc.token, '/registrations', 'GET', null, '/identity/v1'));
  check('an out-of-area officer does not see this registration',
    !nigahiQueue.items.some((i) => i.submitted_identifier === 'b 512'));

  r = await call(resident.token, `/registrations/${reg.id}/approve`, 'POST',
    { corrected_identifier: 'B-512' }, '/identity/v1');
  check('a resident cannot approve a registration', r.status === 403);

  r = await call(incharge.token, `/registrations/${reg.id}/approve`, 'POST',
    { corrected_identifier: 'B-512', corrected_sector: 'Sector 3',
      premises_type: 'QUARTER', quarter_type: 'B', occupancy_model: 'RESIDENT_BOUND' },
    '/identity/v1');
  const approved = await j(r);
  check('Incharge approves and corrects the quarter number',
    r.status === 200 && approved.premises.identifier === 'B-512', JSON.stringify(approved));
  check('the correction is recorded as such', approved.corrected === true);

  // the whole point: the premises master grew
  const master = await withSystem(identityPool, (c) => c.query(
    `SELECT identifier, verified FROM identity.premises WHERE identifier='B-512'`));
  check('premises master gained a verified record', master.rowCount === 1 && master.rows[0].verified);

  const proj = await withSystem(maintPool, (c) => c.query(
    `SELECT identifier FROM premises_ref WHERE identifier='B-512'`));
  check('projection reached the maintenance database', proj.rowCount === 1);

  const newDev = await login;  // now sign in as the newly approved device
  const ch2 = await (await fetch(`${BASE}/identity/v1/auth/challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: kp.publicKey }) })).json();
  const tok2 = await (await fetch(`${BASE}/identity/v1/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: kp.publicKey, nonce: ch2.nonce,
      signature: signNonce(kp.privateKey, ch2.nonce) }) })).json();
  check('the approved device can now sign in', !!tok2.token, JSON.stringify(tok2));
  check('its token carries the corrected premises', !!tok2.premises_id);

  const inbox = await j(await call(tok2.token, '/notifications'));
  check('the applicant is told their registration was approved',
    inbox.items.some((n) => n.event_type === 'REGISTRATION_APPROVED'));

  // sector is now offered as a verified value for future registrations
  const sectors = await withSystem(identityPool, (c) => c.query(
    `SELECT name FROM identity.sector WHERE verified AND name='Sector 3'`));
  check('the verified sector is recorded for future dropdowns', sectors.rowCount === 1);

  /* rejection */
  const kp2 = generateDeviceKeypair();
  const reg2 = await j(await fetch(`${BASE}/identity/v1/registrations`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      'x-registration-token': await registrationToken() },
    body: JSON.stringify({ public_key: kp2.publicKey, name: 'Bogus',
      colony_id: jayant.id, identifier: 'ZZ-1', role: 'RESIDENT' }) }));
  r = await call(incharge.token, `/registrations/${reg2.id}/reject`, 'POST', {}, '/identity/v1');
  check('rejection without a reason is refused', r.status === 422);
  r = await call(incharge.token, `/registrations/${reg2.id}/reject`, 'POST',
    { reason: 'No such quarter in this colony' }, '/identity/v1');
  check('Incharge rejects with a reason', r.status === 200);

  /* duplicate claim flagged */
  const kp3 = generateDeviceKeypair();
  await fetch(`${BASE}/identity/v1/registrations`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      'x-registration-token': await registrationToken() },
    body: JSON.stringify({ public_key: kp3.publicKey, name: 'Claim Jumper',
      colony_id: jayant.id, identifier: 'B-512', role: 'RESIDENT' }) });
  queue = await j(await call(incharge.token, '/registrations', 'GET', null, '/identity/v1'));
  const jumper = queue.items.find((i) => i.name === 'Claim Jumper');
  check('a premises already held by an active device is flagged before approval',
    jumper?.already_claimed === true, JSON.stringify(jumper));

  /* ---------------- escalation ---------------- */
  const cats = await j(await call(resident.token, '/masters/categories'));
  const leak = cats.find((c) => c.name_en.startsWith('Leaking tap'));
  const t = await j(await call(resident.token, '/tickets', 'POST',
    { sub_category_id: leak.id, description: 'Escalation test' }));
  await call(overseer.token, `/tickets/${t.id}/verify`, 'POST');

  let sweep = await runSlaSweep({ quiet: true });
  check('the sweep can see tickets at all', sweep.tickets_visible > 0,
    JSON.stringify(sweep));
  check('a ticket inside its SLA is not escalated', sweep.escalated === 0);

  // push the deadline into the past, as if time had run on
  await withSystem(maintPool, (c) => c.query(
    `UPDATE ticket SET completion_deadline_at = now() - interval '30 hours' WHERE id=$1`,
    [t.id]));

  sweep = await runSlaSweep({ quiet: true });
  check('an overdue ticket produces a breach record', sweep.new_breaches >= 1);
  check('and is escalated', sweep.escalated >= 1, JSON.stringify(sweep));

  const after = await j(await call(overseer.token, `/tickets/${t.id}`));
  check('escalation level reflects how long it is overdue',
    after.escalation_level >= 2, `level ${after.escalation_level}`);

  const ovrInbox = await j(await call(overseer.token, '/notifications'));
  check('the Overseer is notified at L1',
    ovrInbox.items.some((n) => n.event_type === 'SLA_BREACH_L1'));
  const incInbox = await j(await call(incharge.token, '/notifications'));
  check('the Incharge is notified at L2',
    incInbox.items.some((n) => n.event_type === 'SLA_BREACH_L2'));

  const nigInbox = await j(await call(nigahiInc.token, '/notifications'));
  check('an out-of-area officer is not notified',
    !nigInbox.items.some((n) => n.event_type?.startsWith('SLA_BREACH')),
    JSON.stringify(nigInbox.items.map((n) => n.event_type)));

  const resInbox = await j(await call(resident.token, '/notifications'));
  check('the resident can see that their complaint was escalated',
    resInbox.items.some((n) => n.event_type === 'ESCALATED'));

  const repeat = await runSlaSweep({ quiet: true });
  check('a second sweep does not re-escalate the same ticket', repeat.escalated === 0,
    JSON.stringify(repeat));

  /* ---------------- notifications generally ---------------- */
  check('unread count drives the badge', resInbox.unread_count > 0);
  await call(resident.token, '/notifications/read', 'POST', {});
  const cleared = await j(await call(resident.token, '/notifications'));
  check('marking read clears the badge', cleared.unread_count === 0);

  const family = await login('RESIDENT:Mrs S. Singh');
  const famInbox = await j(await call(family.token, '/notifications'));
  check('every handset at the premises is notified, not only the raiser',
    famInbox.items.some((n) => n.event_type === 'ESCALATED'));

  check('notifications carry both languages',
    resInbox.items.every((n) => n.title_en && n.title_hi));

  const contractorInbox = await j(await call(contractor.token, '/notifications'));
  check('a contractor sees only their own inbox',
    !contractorInbox.items.some((n) => n.event_type === 'REGISTRATION_APPROVED'));

  /* ---------------- inspection backlog alert ---------------- */
  const t2 = await j(await call(resident.token, '/tickets', 'POST',
    { sub_category_id: cats.find((c) => c.name_en.startsWith('Roof')).id }));
  await call(overseer.token, `/tickets/${t2.id}/verify`, 'POST');
  const assignable = await j(await call(incharge.token, '/devices/assignable'));
  await call(incharge.token, `/tickets/${t2.id}/assign`, 'POST',
    { supervisor_id: assignable[0].actor_id });
  await call(contractor.token, `/tickets/${t2.id}/start`, 'POST',
    { workmen_assigned: 'Ram Prasad' });
  await uploadCompletion(BASE, contractor.token, t2.id);
  await call(contractor.token, `/tickets/${t2.id}/complete`, 'POST');
  await withSystem(maintPool, (c) => c.query(
    `UPDATE ticket SET completed_claim_at = now() - interval '60 hours' WHERE id=$1`,
    [t2.id]));
  await runSlaSweep({ quiet: true });
  const incInbox2 = await j(await call(incharge.token, '/notifications'));
  check('the Incharge is warned when the inspection backlog passes 48 hours',
    incInbox2.items.some((n) => n.event_type === 'INSPECTION_BACKLOG'));

  /* ---------------- revocation ---------------- */
  const devId = devices['CONTRACTOR_SUPERVISOR:M/s Verma — Supr'].device_id;
  r = await call(incharge.token, `/devices/${devId}/revoke`, 'POST',
    { reason: 'Contract transferred' }, '/identity/v1');
  check('Incharge revokes a device with a reason', r.status === 200, JSON.stringify(await j(r)));
  const revoked = await login('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  check('a revoked device can no longer obtain a token', !!revoked.error,
    JSON.stringify(revoked));

  console.log('');
  for (const [s, n, d] of out) {
    console.log(`  ${s}  ${n}${d ? '\n         ' + String(d).slice(0, 180) : ''}`);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await maintPool.end(); await identityPool.end();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
