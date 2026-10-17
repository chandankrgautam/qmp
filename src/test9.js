/**
 * Suite 9 — the four control defects found on 2026-09-24.
 *
 *   D1  registration: self-chosen roles, no OTP, Incharge approving officers
 *   D2  photographs: anyone could supply the "inspection" photograph
 *   D3  photographs: old photographs reopened the gates after rework
 *   D4  SLA: contractor judged at the Overseer's acceptance, not their claim
 *
 * Written before the fixes, and run against the old code to watch every
 * check fail. Needs a freshly reset and seeded database.
 */
import fs from 'node:fs';
import { signNonce, generateDeviceKeypair } from './auth.js';
import { uploadCompletion, uploadInspection, requirePhotos } from './testutil.js';
import { withScope, withSystem, maintPool, identityPool } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); }
};
/* A check whose setup throws still counts as a failure, rather than
   stopping the suite and hiding every check after it. */
async function attempt(n, fn) {
  try { await fn(); } catch (e) { check(n, false, `threw: ${e.message}`.slice(0, 200)); }
}

const json = { 'content-type': 'application/json' };
async function loginWith(publicKey, privateKey, role) {
  const ch = await (await fetch(`${BASE}/identity/v1/auth/challenge`, {
    method: 'POST', headers: json, body: JSON.stringify({ public_key: publicKey }) })).json();
  return (await (await fetch(`${BASE}/identity/v1/auth/token`, {
    method: 'POST', headers: json,
    body: JSON.stringify({ public_key: publicKey, nonce: ch.nonce,
      signature: signNonce(privateKey, ch.nonce), second_factor_satisfied: true, role })
  })).json());
}
const login = (key) => loginWith(devices[key].publicKey, devices[key].privateKey, devices[key].role);
const call = (tok, path, method = 'GET', body, prefix = '/maintenance/v1') =>
  fetch(`${BASE}${prefix}${path}`, { method,
    headers: { ...json, authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined });
const post = (tok, p, b) => call(tok, p, 'POST', b);
const idCall = (tok, p, method, b) => call(tok, p, method, b, '/identity/v1');
const j = async (r) => { try { return await r.json(); } catch { return {}; } };

/* OTP, as a handset would do it. Outside production the code comes back
   in the response, which is how a test can complete the step. */
let mobileSeq = 0;
async function registrationToken(given) {
  const mobile = given || `97${String(++mobileSeq).padStart(8, '0')}`;
  const req = await j(await fetch(`${BASE}/identity/v1/auth/otp/request`, {
    method: 'POST', headers: json, body: JSON.stringify({ mobile }) }));
  const ver = await j(await fetch(`${BASE}/identity/v1/auth/otp/verify`, {
    method: 'POST', headers: json, body: JSON.stringify({ mobile, code: req.dev_code }) }));
  return { mobile, token: ver.registration_token };
}
async function register(fields, { withToken = true, mobile } = {}) {
  const kp = generateDeviceKeypair();
  const otp = withToken ? await registrationToken(mobile) : {};
  const r = await fetch(`${BASE}/identity/v1/registrations`, {
    method: 'POST',
    headers: { ...json, ...(otp.token ? { 'x-registration-token': otp.token } : {}) },
    body: JSON.stringify({ public_key: kp.publicKey, mobile: otp.mobile, ...fields }) });
  return { status: r.status, body: await j(r), kp, mobile: otp.mobile };
}

const sys = (pool, sql, params) => withSystem(pool, (c) => c.query(sql, params));
const ticketRow = async (id) => (await sys(maintPool,
  `SELECT state::text, completion_met, contractor_minutes, completion_deadline_at
     FROM ticket WHERE id=$1`, [id])).rows[0];

async function run() {
  await requirePhotos();   // this suite tests the photograph gate as HQ will switch it on
  const resident   = await login('RESIDENT:R. K. Singh');
  const overseer   = await login('CIVIL_OVERSEER:A. K. Dubey');
  const incharge   = await login('MAINTENANCE_INCHARGE:P. N. Mishra');
  const admin      = await login('ADMINISTRATOR:System Admin');
  const contractor = await login('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const colonies = await j(await fetch(`${BASE}/identity/v1/masters/colonies`));
  const jayant = colonies.find((c) => c.area === 'Jayant');

  /* ================= D1 — registration and approval ================= */

  let r = await register({ name: 'No OTP', colony_id: jayant.id, identifier: 'D-99',
    role: 'RESIDENT' }, { withToken: false });
  check('D1 registration without a verified mobile is refused', r.status === 422,
    `${r.status} ${JSON.stringify(r.body)}`);

  for (const role of ['ADMINISTRATOR', 'GM_CIVIL']) {
    r = await register({ name: `Would-be ${role}`, colony_id: jayant.id,
      identifier: 'X-1', role });
    check(`D1 nobody can register as ${role}`, r.status === 422,
      `${r.status} ${JSON.stringify(r.body)}`);
  }

  const res = await register({ name: 'D1 Resident', colony_id: jayant.id,
    identifier: 'D-41', role: 'RESIDENT' });
  check('D1 a resident registers after verifying their mobile', res.status === 201,
    `${res.status} ${JSON.stringify(res.body)}`);
  const stored = (await sys(identityPool,
    `SELECT pe.mobile FROM identity.device d JOIN identity.person pe ON pe.id=d.person_id
      WHERE d.id=$1`, [res.body.id])).rows[0];
  check('D1 the mobile recorded is the one verified by OTP', stored?.mobile === res.mobile,
    JSON.stringify(stored));

  // Officials' roles come from the Area HR office (decision 2026-09-30);
  // the official then registers a phone, which only an Area administrator
  // may approve.
  const hr = await login('AREA_HR_ADMIN:R. Kumar');
  const sysAdm = await login('AREA_SYS_ADMIN:V. Sharma');
  const offMobile = '9733300001';
  const offPerson = await j(await idCall(hr.token, '/persons', 'POST',
    { name: 'D1 Overseer', personnel_no: '55015501', mobile: offMobile, designation: 'Civil Overseer' }));
  r = await idCall(hr.token, '/assignments', 'POST',
    { person_id: offPerson.id, role: 'CIVIL_OVERSEER', scope_path: 'ncl.jayant', reason: 'Posted to Jayant' });
  check('D1 the Area HR office assigns the Overseer role', r.status === 201, `${r.status} ${JSON.stringify(await j(r))}`);
  r = await register({ name: 'D1 Overseer', colony_id: jayant.id, role: 'CIVIL_OVERSEER' });
  check('D1 an official role cannot be asked for at registration', r.status === 422, `${r.status}`);
  const off = await register({ name: 'D1 Overseer', colony_id: jayant.id }, { mobile: offMobile });
  check('D1 the official registers a phone with the mobile on record', off.status === 201,
    `${off.status} ${JSON.stringify(off.body)}`);
  const linked = (await sys(identityPool, `SELECT person_id FROM identity.device WHERE id=$1`, [off.body.id])).rows[0];
  check('D1 the phone is linked to the person the HR office entered', linked?.person_id === offPerson.id, JSON.stringify(linked));

  const incQueue = await j(await idCall(incharge.token, '/registrations', 'GET'));
  const resItem = (incQueue.items || []).find((i) => i.id === res.body.id);
  check('D1 the Incharge sees the requested role on the approval queue',
    resItem?.role === 'RESIDENT', JSON.stringify(resItem));
  check("D1 an official's phone is not in the Incharge's queue",
    !(incQueue.items || []).some((i) => i.id === off.body.id));

  r = await idCall(incharge.token, `/registrations/${off.body.id}/approve`, 'POST', {});
  check("D1 the Incharge cannot approve an official's phone", r.status === 403,
    `${r.status} ${JSON.stringify(await j(r))}`);

  // and the database refuses it too, whatever the application does
  let dbRefused = false;
  try {
    const inc = devices['MAINTENANCE_INCHARGE:P. N. Mishra'];
    await withScope(identityPool, { role: 'MAINTENANCE_INCHARGE', scope_path: 'ncl.jayant',
      actor_id: inc.actor_id, person_id: inc.person_id },
      (c) => c.query(`UPDATE identity.device SET status='ACTIVE', approved_at=now() WHERE id=$1`, [off.body.id]));
  } catch (e) { dbRefused = /Area administrator/.test(e.message); }
  check("D1 the database refuses an Incharge activating an official's phone", dbRefused);

  const admQueue = await j(await idCall(sysAdm.token, '/registrations', 'GET'));
  check('D1 the Area administrator sees the phone waiting',
    (admQueue.items || []).some((i) => i.id === off.body.id), JSON.stringify(admQueue).slice(0, 200));
  r = await idCall(sysAdm.token, `/registrations/${off.body.id}/approve`, 'POST', {});
  check('D1 the Area administrator approves it', r.status === 200, `${r.status} ${JSON.stringify(await j(r))}`);

  r = await idCall(incharge.token, `/registrations/${res.body.id}/approve`, 'POST',
    { corrected_identifier: 'D-41' });
  const noType = await j(r);
  check('D1 approving a quarter without its type gets a plain refusal',
    r.status === 422 && /quarter type/i.test(noType.detail || ''), JSON.stringify(noType));
  r = await idCall(incharge.token, `/registrations/${res.body.id}/approve`, 'POST',
    { corrected_identifier: 'D-41', quarter_type: 'D' });
  check('D1 the Incharge still approves residents', r.status === 200,
    `${r.status} ${JSON.stringify(await j(r))}`);

  // the second Jayant Overseer, used below to show one Overseer's
  // photograph cannot close another's inspection
  const overseer2 = await loginWith(off.kp.publicKey, off.kp.privateKey, 'CIVIL_OVERSEER');
  check('D1 the approved official signs in as Overseer, scoped to the Area',
    overseer2.role === 'CIVIL_OVERSEER' && overseer2.scope_path === 'ncl.jayant', JSON.stringify(overseer2).slice(0, 200));

  /* ================= shared: a ticket at a given state ================= */
  const cats = await j(await call(resident.token, '/masters/categories'));
  const assignable = await j(await call(incharge.token, '/devices/assignable'));
  const verma = assignable.find((d) => d.person_name?.startsWith('M/s Verma'))
             || assignable[0];
  async function inProgress(code) {
    const sub = cats.find((c) => c.name_en.startsWith(code));
    const t = await j(await post(resident.token, '/tickets', { sub_category_id: sub.id }));
    await post(overseer.token, `/tickets/${t.id}/verify`);
    await post(incharge.token, `/tickets/${t.id}/assign`,
      { supervisor_id: verma.actor_id });
    await post(contractor.token, `/tickets/${t.id}/start`, { workmen_assigned: 'Ram Prasad' });
    return t;
  }
  const askUpload = (tok, ticketId, purpose) =>
    post(tok, '/media/upload-url', { ticket_id: ticketId, purpose, content_type: 'image/jpeg' });

  /* ================= D2 — who may supply which photograph ================= */
  await attempt('D2 setup', async () => {
    const t = await inProgress('Leaking tap');

    r = await askUpload(contractor.token, t.id, 'INSPECTION');
    check('D2 the contractor cannot supply an inspection photograph', r.status === 403,
      `${r.status} ${JSON.stringify(await j(r))}`);
    r = await askUpload(resident.token, t.id, 'INSPECTION');
    check('D2 a resident cannot supply an inspection photograph', r.status === 403,
      `${r.status}`);
    r = await askUpload(resident.token, t.id, 'COMPLETION');
    check('D2 a resident cannot supply a completion photograph', r.status === 403,
      `${r.status}`);

    // a photograph taken before the contractor claimed completion
    const early = await uploadInspection(BASE, overseer.token, t.id);
    check('D2 (setup) the Overseer may photograph during the work', early.ok,
      JSON.stringify(early));

    const done = await uploadCompletion(BASE, contractor.token, t.id);
    r = await post(contractor.token, `/tickets/${t.id}/complete`);
    check('D2 (setup) contractor claims completion with a photograph',
      done.ok && r.status === 200, `${r.status}`);

    r = await post(overseer.token, `/tickets/${t.id}/inspect`, { accepted: true });
    check('D2 a photograph from before the claim does not open the inspection gate',
      r.status === 422, `${r.status} ${JSON.stringify(await j(r))}`);

    const other = await uploadInspection(BASE, overseer2.token, t.id);
    r = await post(overseer.token, `/tickets/${t.id}/inspect`, { accepted: true });
    check('D2 another Overseer\'s photograph does not open this Overseer\'s gate',
      other.ok && r.status === 422, `${other.status} ${r.status}`);

    await uploadInspection(BASE, overseer.token, t.id);
    r = await post(overseer.token, `/tickets/${t.id}/inspect`, { accepted: true });
    check('D2 the inspecting Overseer\'s own photograph after the claim opens it',
      r.status === 200, `${r.status} ${JSON.stringify(await j(r))}`);
  });

  /* ================= D3 — rework needs fresh photographs ================= */
  await attempt('D3 setup', async () => {
    const t = await inProgress('Internal pipe');
    await uploadCompletion(BASE, contractor.token, t.id);
    await post(contractor.token, `/tickets/${t.id}/complete`);
    await uploadInspection(BASE, overseer.token, t.id);
    r = await post(overseer.token, `/tickets/${t.id}/inspect`,
      { accepted: false, remark: 'Joint still weeping' });
    check('D3 (setup) the Overseer sends the work back', r.status === 200, `${r.status}`);

    r = await post(contractor.token, `/tickets/${t.id}/start`,
      { workmen_assigned: 'Ram Prasad' });
    check('D3 (setup) the contractor resumes', r.status === 200, `${r.status}`);
    r = await post(contractor.token, `/tickets/${t.id}/complete`);
    check('D3 the first completion photograph does not support a second claim',
      r.status === 422, `${r.status} ${JSON.stringify(await j(r))}`);

    await uploadCompletion(BASE, contractor.token, t.id);
    r = await post(contractor.token, `/tickets/${t.id}/complete`);
    check('D3 a fresh completion photograph does', r.status === 200, `${r.status}`);

    r = await post(overseer.token, `/tickets/${t.id}/inspect`, { accepted: true });
    check('D3 the photograph of the rejected work cannot accept the redone work',
      r.status === 422, `${r.status} ${JSON.stringify(await j(r))}`);

    await uploadInspection(BASE, overseer.token, t.id);
    r = await post(overseer.token, `/tickets/${t.id}/inspect`, { accepted: true });
    check('D3 a fresh inspection photograph accepts it', r.status === 200, `${r.status}`);
  });

  /* ================= D4 — the contractor's SLA ================= */
  // Time is simulated by moving the start of the contractor's current
  // period back, as the SYSTEM context: no human role can write it.
  const backdate = (id, minutes) => sys(maintPool,
    `UPDATE ticket SET contractor_window_started_at = now() - ($2 || ' minutes')::interval
      WHERE id=$1`, [id, minutes]);
  const claim = async (t) => {
    await uploadCompletion(BASE, contractor.token, t.id);
    return post(contractor.token, `/tickets/${t.id}/complete`);
  };
  const accept = async (t) => {
    await uploadInspection(BASE, overseer.token, t.id);
    return post(overseer.token, `/tickets/${t.id}/inspect`, { accepted: true });
  };

  await attempt('D4 clean case', async () => {
    // claimed promptly, but the inspection happens after the deadline
    const t = await inProgress('WC or pan');
    await claim(t);
    await sys(maintPool,
      `UPDATE ticket SET completion_deadline_at = now() - interval '1 hour' WHERE id=$1`, [t.id]);
    await accept(t);
    const row = await ticketRow(t.id);
    check('D4 a prompt claim meets the SLA even when inspection comes late',
      row.completion_met === true, JSON.stringify(row));
  });

  await attempt('D4 rework adds up', async () => {
    // 2,000 + 1,000 minutes of contractor time against a 2,880-minute SLA,
    // with the overall deadline still in the future
    const t = await inProgress('Door damaged');                    // 4,320 min SLA
    await sys(maintPool,
      `UPDATE ticket SET sla_completion_minutes = 2880 WHERE id=$1`, [t.id]);
    await backdate(t.id, 2000);
    await claim(t);
    await uploadInspection(BASE, overseer.token, t.id);
    await post(overseer.token, `/tickets/${t.id}/inspect`, { accepted: false, remark: 'Hinge loose' });
    await post(contractor.token, `/tickets/${t.id}/start`, { workmen_assigned: 'Ram Prasad' });
    await backdate(t.id, 1000);
    await claim(t);
    const r2 = await accept(t);
    const row = await ticketRow(t.id);
    check('D4 (setup) accepted after rework', r2.status === 200, `${r2.status}`);
    check('D4 contractor time across both rounds is added up',
      Math.abs(Number(row.contractor_minutes) - 3000) <= 2, JSON.stringify(row));
    check('D4 3,000 minutes against a 2,880-minute SLA is a miss',
      row.completion_met === false, JSON.stringify(row));
  });

  await attempt('D4 pause', async () => {
    // 3,000 minutes on site, 500 of them with the quarter locked
    const t = await inProgress('Window or shutter');               // 7,200 min SLA
    await sys(maintPool,
      `UPDATE ticket SET sla_completion_minutes = 2880 WHERE id=$1`, [t.id]);
    await backdate(t.id, 3000);
    await sys(maintPool,
      `INSERT INTO sla_pause (ticket_id, clock, attribution, reason, paused_at,
           resumed_at, paused_by, paused_by_role)
       VALUES ($1,'COMPLETION','OCCUPANT','Quarter locked',
               now() - interval '2500 minutes', now() - interval '2000 minutes',
               $2, 'CIVIL_OVERSEER')`,
      [t.id, devices['CIVIL_OVERSEER:A. K. Dubey'].actor_id]);
    await claim(t);
    await accept(t);
    const row = await ticketRow(t.id);
    check('D4 a recorded occupant pause is not counted against the contractor',
      Math.abs(Number(row.contractor_minutes) - 2500) <= 2, JSON.stringify(row));
    check('D4 2,500 minutes against 2,880 is met', row.completion_met === true,
      JSON.stringify(row));
  });

  await attempt('D4 field authority', async () => {
    let refused = false;
    try {
      const t = (await sys(maintPool, `SELECT id FROM ticket WHERE assigned_to = $1 LIMIT 1`,
        [devices['CONTRACTOR_SUPERVISOR:M/s Verma — Supr'].actor_id])).rows[0];
      await withScope(maintPool, { role: 'CONTRACTOR_SUPERVISOR', scope_path: 'ncl.jayant',
        actor_id: devices['CONTRACTOR_SUPERVISOR:M/s Verma — Supr'].actor_id },
        (c) => c.query(`UPDATE ticket SET contractor_minutes = contractor_minutes + 999 WHERE id=$1`, [t.id]));
    } catch (e) { refused = /may not change/.test(e.message); }
    check('D4 no human role can write contractor_minutes', refused);
  });

  /* ------------------------------------------------------------------ */
  for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n        ${d}` : ''}`);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await identityPool.end(); await maintPool.end();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
