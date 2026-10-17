/**
 * Suite 10 — users, roles and sign-in (decision 2026-09-30).
 *
 *   R1  one person, one phone, several roles; the role switcher
 *   R2  Employee ID + password on the web; lockout; Non-NCL app only
 *   R3  only Area administrators assign roles, within their Area, below
 *       their own rank; never to themselves; every change audit-logged
 *   R4  inspection accepted only from the app (device-key session)
 *   R5  two-key by PERSON, not by role
 *   R6  resident pages for officials; custodians; the contractor firm
 *
 * Needs a freshly reset and seeded database.
 */
import fs from 'node:fs';
import { signNonce, generateDeviceKeypair } from './auth.js';
import { uploadCompletion, uploadInspection } from './testutil.js';
import { withScope, withSystem, maintPool, identityPool } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => { if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); } };
async function attempt(n, fn) { try { await fn(); } catch (e) { check(n, false, `threw: ${e.message}`.slice(0, 220)); } }

const json = { 'content-type': 'application/json' };
const post = (p, b, tok) => fetch(`${BASE}${p}`, { method: 'POST',
  headers: { ...json, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(b || {}) });
const get = (p, tok) => fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${tok}` } });
const put = (p, b, tok) => fetch(`${BASE}${p}`, { method: 'PUT', headers: { ...json, authorization: `Bearer ${tok}` }, body: JSON.stringify(b || {}) });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };

/* Device sign-in, optionally choosing a role. */
async function device(key, pick = {}) {
  const d = devices[key];
  const ch = await j(await post('/identity/v1/auth/challenge', { public_key: d.publicKey }));
  return j(await post('/identity/v1/auth/token', { public_key: d.publicKey, nonce: ch.nonce,
    signature: signNonce(d.privateKey, ch.nonce), second_factor_satisfied: true, ...pick }));
}
const as = (key) => device(key, { role: devices[key].role });
const sys = (pool, sql, params) => withSystem(pool, (c) => c.query(sql, params));

async function run() {
  /* ================= R1 — one phone, several roles ================= */
  let r = await device('CIVIL_OVERSEER:A. K. Dubey');
  check('R1 a person with several roles gets the role list, not a guessed role',
    !r.token && r.person_token && r.assignments?.length === 2, JSON.stringify(r).slice(0, 200));
  const roles = (r.assignments || []).map((a) => a.role).sort();
  check('R1 the Overseer also has his resident role', JSON.stringify(roles) === '["CIVIL_OVERSEER","RESIDENT"]', JSON.stringify(roles));

  const asRes = await j(await post('/identity/v1/auth/select-role',
    { person_token: r.person_token, assignment_id: r.assignments.find((a) => a.role === 'RESIDENT').id }));
  check('R1 he picks his resident role on the same phone', asRes.role === 'RESIDENT' && !!asRes.token, JSON.stringify(asRes).slice(0, 160));
  const me = await j(await get('/identity/v1/me', asRes.token));
  check('R1 as resident he sees his own quarter', me.identifier === 'D-12' && me.resident_page === 'available', JSON.stringify(me).slice(0, 200));

  const sw = await j(await post('/identity/v1/auth/switch-role',
    { assignment_id: r.assignments.find((a) => a.role === 'CIVIL_OVERSEER').id, second_factor_satisfied: true }, asRes.token));
  check('R1 he switches to Overseer without signing in again', sw.role === 'CIVIL_OVERSEER' && !!sw.token, JSON.stringify(sw).slice(0, 160));

  const other = devices['MAINTENANCE_INCHARGE:P. N. Mishra'].actor_id;
  const steal = await post('/identity/v1/auth/switch-role', { assignment_id: other, second_factor_satisfied: true }, asRes.token);
  check('R1 nobody can switch into someone else\'s role', steal.status === 403, `${steal.status}`);

  const noPin = await j(await post('/identity/v1/auth/switch-role',
    { assignment_id: r.assignments.find((a) => a.role === 'CIVIL_OVERSEER').id }, asRes.token));
  check('R1 switching into an official role needs the PIN or biometric', !noPin.token, JSON.stringify(noPin).slice(0, 120));

  const resOnly = await as('RESIDENT:R. K. Singh');
  let x = await get('/identity/v1/persons', resOnly.token);
  check('R1 a resident reaches no administrative page', x.status === 403, `${x.status}`);
  x = await get('/identity/v1/registrations', resOnly.token);
  check('R1 a resident sees no registration queue', (await j(x)).items?.length === 0);

  /* ================= R2 — Employee ID + password ================= */
  const pw = await j(await post('/identity/v1/auth/password', { employee_id: '90222002', password: 'Portal@2026', role: 'MAINTENANCE_INCHARGE' }));
  check('R2 the Incharge signs in on the web with Employee ID and password', pw.role === 'MAINTENANCE_INCHARGE' && !!pw.token, JSON.stringify(pw).slice(0, 160));
  const bad = await post('/identity/v1/auth/password', { employee_id: '90222002', password: 'wrong-one' });
  check('R2 a wrong password is refused', bad.status === 401);
  for (let i = 0; i < 5; i++) await post('/identity/v1/auth/password', { employee_id: '90223002', password: 'wrong-again' });
  const locked = await j(await post('/identity/v1/auth/password', { employee_id: '90223002', password: 'Portal@2026' }));
  check('R2 five wrong passwords lock the account, even against the right one', !locked.token && /Too many attempts/.test(locked.error || ''), JSON.stringify(locked));
  const signins = (await sys(identityPool, `SELECT count(*) n FROM identity.sign_in_log WHERE success = false AND method='password'`)).rows[0].n;
  check('R2 every refused sign-in is logged', Number(signins) >= 6, signins);

  // setting a password needs the OTP to the mobile on record
  const empMobile = (await sys(identityPool, `SELECT mobile FROM identity.person WHERE personnel_no='90222005'`)).rows[0].mobile;
  const otp = await j(await post('/identity/v1/auth/otp/request', { mobile: empMobile }));
  const ver = await j(await post('/identity/v1/auth/otp/verify', { mobile: empMobile, code: otp.dev_code }));
  r = await post('/identity/v1/auth/password/set', { employee_id: '90222005', registration_token: ver.registration_token, password: 'short' });
  check('R2 a short password is refused', r.status === 422);
  r = await post('/identity/v1/auth/password/set', { employee_id: '90222005', registration_token: ver.registration_token, password: 'A-longer-password-1' });
  check('R2 a password is set with the OTP to the mobile on record', r.status === 200, `${r.status}`);
  const other2 = await j(await post('/identity/v1/auth/otp/request', { mobile: '9800000077' }));
  const ver2 = await j(await post('/identity/v1/auth/otp/verify', { mobile: '9800000077', code: other2.dev_code }));
  r = await post('/identity/v1/auth/password/set', { employee_id: '90222004', registration_token: ver2.registration_token, password: 'Takeover-attempt-1' });
  check('R2 someone else\'s mobile cannot set an employee\'s password', r.status === 422, `${r.status}`);
  // the Employee ID is NCL's 8-digit number, nothing else (decision 2026-09-30)
  r = await j(await post('/identity/v1/auth/password', { employee_id: '9022200', password: 'Portal@2026' }));
  check('R2 an Employee ID that is not 8 digits is refused at sign-in', !r.token && /8 digits/.test(r.error || ''), JSON.stringify(r));
  let badId = false;
  try { await sys(identityPool, `UPDATE identity.person SET personnel_no='NCL/EMP/2002' WHERE personnel_no='90222002'`); } catch { badId = true; }
  check('R2 the database refuses an Employee ID that is not 8 digits', badId);
  let nonNcl = false;
  try { await sys(identityPool, `UPDATE identity.person SET password_hash='x' WHERE name='M/s Verma — Supr'`); } catch { nonNcl = true; }
  check('R2 a person without an Employee ID can never hold a web password (app only)', nonNcl);

  /* ================= R3 — who assigns roles ================= */
  const hr = await as('AREA_HR_ADMIN:R. Kumar');
  const newbie = await j(await post('/identity/v1/persons', { name: 'New Overseer', personnel_no: '90225555',
    mobile: '9811112222', designation: 'Civil Overseer' }, hr.token));
  check('R3 the Area HR administrator enters a person', !!newbie.id, JSON.stringify(newbie));
  r = await post('/identity/v1/persons', { name: 'Bad ID', personnel_no: 'E/5501', mobile: '9811113333' }, hr.token);
  check('R3 a person with an Employee ID that is not 8 digits is refused', r.status === 422, `${r.status}`);
  const seen = (await j(await get('/identity/v1/persons', hr.token))).map?.((p) => p.name) || [];
  check('R3 he sees the person he has just entered, before any role', seen.includes('New Overseer'), seen.join(', '));
  check('R3 but nobody from another Area or HQ (control 3)',
    !seen.some((n) => ['Nigahi Overseer', 'Nigahi resident', 'GM (Civil)', 'CMD', 'System Admin'].includes(n)), seen.join(', '));
  const leak = (await withScope(identityPool, { role: 'AREA_HR_ADMIN', scope_path: 'ncl.jayant', actor_id: hr.actor_id, person_id: hr.person_id },
    (c) => c.query(`SELECT count(*) n FROM identity.person WHERE name IN ('Nigahi Overseer','GM (Civil)')`))).rows[0].n;
  check('R3 the database itself hides them from a Jayant administrator', Number(leak) === 0, leak);
  r = await post('/identity/v1/assignments', { person_id: newbie.id, role: 'CIVIL_OVERSEER', scope_path: 'ncl.jayant',
    designation: 'Civil Overseer', reason: 'Posted to Jayant' }, hr.token);
  const asg = await j(r);
  check('R3 and assigns an Overseer role in his Area', r.status === 201, `${r.status} ${JSON.stringify(asg)}`);
  r = await post('/identity/v1/assignments', { person_id: newbie.id, role: 'CIVIL_OVERSEER', scope_path: 'ncl.nigahi', reason: 'x' }, hr.token);
  check('R3 but not in another Area', r.status === 403, `${r.status} ${JSON.stringify(await j(r))}`);
  r = await post('/identity/v1/assignments', { person_id: newbie.id, role: 'AREA_SYS_ADMIN', scope_path: 'ncl.jayant', reason: 'x' }, hr.token);
  check('R3 nor a role of his own rank', r.status === 403, `${r.status}`);
  r = await post('/identity/v1/assignments', { person_id: devices['AREA_HR_ADMIN:R. Kumar'].person_id, role: 'STAFF_OFFICER_CIVIL', scope_path: 'ncl.jayant', reason: 'x' }, hr.token);
  check('R3 nobody grants a role to themselves', r.status === 403, `${r.status} ${JSON.stringify(await j(r))}`);
  r = await post('/identity/v1/assignments', { person_id: newbie.id, role: 'CIVIL_OVERSEER', scope_path: 'ncl.jayant' }, hr.token);
  check('R3 an assignment needs a reason', r.status === 422);
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
  r = await post('/identity/v1/assignments', { person_id: newbie.id, role: 'CIVIL_OVERSEER', scope_path: 'ncl.jayant', reason: 'x' }, inc.token);
  check('R3 the Incharge does not assign roles', r.status === 403);
  let dbRefused = false;
  try {
    await withScope(identityPool, { role: 'MAINTENANCE_INCHARGE', scope_path: 'ncl.jayant', actor_id: inc.actor_id, person_id: inc.person_id },
      (c) => c.query(`INSERT INTO identity.role_assignment (person_id, role, scope_path, status) VALUES ($1,'CIVIL_OVERSEER','ncl.jayant','ACTIVE')`, [newbie.id]));
  } catch (e) { dbRefused = /Area administrators|Incharge/.test(e.message); }
  check('R3 and the database refuses it too', dbRefused);
  r = await put(`/identity/v1/assignments/${asg.id}`, { valid_to: '2027-03-31' }, hr.token);
  check('R3 a change without a reason is refused', r.status === 422);
  r = await put(`/identity/v1/assignments/${asg.id}`, { valid_to: '2027-03-31', reason: 'Tenure to year end' }, hr.token);
  check('R3 a change with a reason is made', r.status === 200, `${r.status}`);
  r = await post(`/identity/v1/assignments/${asg.id}/revoke`, { reason: 'Transferred' }, hr.token);
  check('R3 a role is revoked with a reason', r.status === 200, `${r.status}`);
  const trail = (await sys(identityPool, `SELECT event_type FROM identity.audit_log WHERE entity_id = $1 ORDER BY id`, [asg.id])).rows.map((x) => x.event_type);
  check('R3 grant, change and revocation are all in the audit log',
    JSON.stringify(trail) === '["ROLE_ASSIGNED","ROLE_CHANGED","ROLE_REVOKED"]', JSON.stringify(trail));
  const admin = await as('ADMINISTRATOR:System Admin');
  r = await post('/identity/v1/assignments', { person_id: newbie.id, role: 'AREA_SYS_ADMIN', scope_path: 'ncl.jayant', reason: 'Systems cover' }, admin.token);
  check('R3 the HQ portal administrator assigns Area administrators', r.status === 201, `${r.status} ${JSON.stringify(await j(r))}`);

  /* R3b — an Area role is held in one Area (control 3). Found on the user's
     data 2026-10-09: the HQ portal administrator assigned an Incharge with
     no Area chosen, and the role took the administrator's own scope, all of
     NCL — an Incharge of every Area. */
  r = await post('/identity/v1/assignments', { person_id: newbie.id, role: 'MAINTENANCE_INCHARGE', reason: 'No Area chosen' }, admin.token);
  check('R3b an Area role with no Area chosen is refused', r.status === 422, `${r.status} ${JSON.stringify(await j(r))}`);
  r = await post('/identity/v1/assignments', { person_id: newbie.id, role: 'MAINTENANCE_INCHARGE', scope_path: 'ncl', reason: 'All of NCL' }, admin.token);
  check('R3b an Area role scoped to all of NCL is refused', r.status === 422 || r.status === 403, `${r.status}`);
  r = await post('/identity/v1/assignments', { person_id: newbie.id, role: 'MAINTENANCE_INCHARGE', scope_path: 'ncl.nowhere', reason: 'No such Area' }, admin.token);
  check('R3b an Area that does not exist is refused', r.status === 422 || r.status === 403, `${r.status}`);
  let ncLevel = false;
  try {
    await withScope(identityPool, { role: 'ADMINISTRATOR', scope_path: 'ncl', actor_id: admin.actor_id, person_id: admin.person_id },
      (c) => c.query(`INSERT INTO identity.role_assignment (person_id, role, scope_path, status) VALUES ($1,'MAINTENANCE_INCHARGE','ncl','ACTIVE')`, [newbie.id]));
  } catch (e) { ncLevel = /Area/.test(e.message); }
  check('R3b the database refuses an Area role across all Areas, whoever writes it', ncLevel);
  r = await post('/identity/v1/assignments', { person_id: newbie.id, role: 'MAINTENANCE_INCHARGE', scope_path: 'ncl.nigahi', reason: 'Incharge for Nigahi' }, admin.token);
  const nghInc = await j(r);
  check('R3b with the Area chosen, the role is held in that Area', r.status === 201 && nghInc.scope_path === 'ncl.nigahi', `${r.status} ${JSON.stringify(nghInc)}`);
  const areas = await j(await get('/identity/v1/masters/areas', admin.token));
  check('R3b the Area master lists the thirteen Areas with their scopes',
    Array.isArray(areas) && areas.length === 13 && areas.some((a) => a.code === 'jayant' && a.scope_path === 'ncl.jayant' && a.ticket_code === 'JNT'),
    JSON.stringify(areas).slice(0, 200));

  /* ================= shared: a ticket at WORK_COMPLETED ================= */
  const resident = await as('RESIDENT:R. K. Singh');
  const overseer = await as('CIVIL_OVERSEER:A. K. Dubey');
  const contractor = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const cats = await j(await get('/maintenance/v1/masters/categories', resident.token));
  const sup = (await j(await get('/maintenance/v1/devices/assignable', inc.token)))[0];
  async function claimed(code, supervisorTok, supervisorId) {
    const sub = cats.find((c) => c.name_en.startsWith(code));
    const t = await j(await post('/maintenance/v1/tickets', { sub_category_id: sub.id }, resident.token));
    await post(`/maintenance/v1/tickets/${t.id}/verify`, {}, overseer.token);
    r = await post(`/maintenance/v1/tickets/${t.id}/assign`, { supervisor_id: supervisorId }, inc.token);
    if (r.status !== 200) throw new Error(`assign ${r.status} ${JSON.stringify(await j(r))}`);
    await post(`/maintenance/v1/tickets/${t.id}/start`, { workmen_assigned: 'Ram Prasad' }, supervisorTok);
    await uploadCompletion(BASE, supervisorTok, t.id);
    r = await post(`/maintenance/v1/tickets/${t.id}/complete`, {}, supervisorTok);
    if (r.status !== 200) throw new Error(`complete ${r.status} ${JSON.stringify(await j(r))}`);
    return t;
  }

  /* ================= R4 — inspection acceptance only from the app ================= */
  await attempt('R4 setup', async () => {
    const t = await claimed('Leaking tap', contractor.token, sup.actor_id);
    const web = await j(await post('/identity/v1/auth/password', { employee_id: '90222001', password: 'Portal@2026', role: 'CIVIL_OVERSEER' }));
    await uploadInspection(BASE, web.token, t.id);
    r = await post(`/maintenance/v1/tickets/${t.id}/inspect`, { accepted: true }, web.token);
    check('R4 an Overseer signed in by password cannot accept an inspection', r.status === 403, `${r.status} ${JSON.stringify(await j(r))}`);
    await uploadInspection(BASE, overseer.token, t.id);
    r = await post(`/maintenance/v1/tickets/${t.id}/inspect`, { accepted: true }, overseer.token);
    check('R4 the same Overseer on his phone can', r.status === 200, `${r.status} ${JSON.stringify(await j(r))}`);
  });

  /* ================= R5 — two-key by person ================= */
  await attempt('R5 setup', async () => {
    // the HR office makes the Overseer a contractor supervisor too (odd, but
    // it is exactly the case a device- or role-level check would miss)
    const contractId = (await sys(maintPool, `SELECT id FROM contract WHERE agreement_no='NCL/JNT/CIV/2026/01'`)).rows[0].id;
    const a = await j(await post('/identity/v1/assignments', { person_id: devices['CIVIL_OVERSEER:A. K. Dubey'].person_id,
      role: 'CONTRACTOR_SUPERVISOR', scope_path: 'ncl.jayant', contract_id: contractId, reason: 'test of two-key' }, hr.token));
    const dubeySup = await device('CIVIL_OVERSEER:A. K. Dubey', { assignment_id: a.id });
    check('R5 (setup) the same person signs in as a supervisor', dubeySup.role === 'CONTRACTOR_SUPERVISOR', JSON.stringify(dubeySup).slice(0, 160));
    const t = await claimed('Internal pipe', dubeySup.token, a.id);
    await uploadInspection(BASE, overseer.token, t.id);
    r = await post(`/maintenance/v1/tickets/${t.id}/inspect`, { accepted: true }, overseer.token);
    check('R5 the person who did the work cannot inspect it in another role', r.status === 422, `${r.status} ${JSON.stringify(await j(r))}`);
  });

  /* ================= R6 — resident pages, custodians, the firm ================= */
  const sysAdm = await as('AREA_SYS_ADMIN:V. Sharma');
  const sm = await j(await get('/identity/v1/me', sysAdm.token));
  check('R6 an official with no quarter recorded is told who can fix it', /Area HR/.test(sm.resident_page || ''), JSON.stringify(sm).slice(0, 200));
  const hq = await device('HQ_EXECUTIVE:CMD', { role: 'HQ_EXECUTIVE' });
  x = await get('/maintenance/v1/search', hq.token);
  check('R6 the CMD reads every Area', x.status === 200);
  x = await post('/maintenance/v1/tickets', { sub_category_id: cats[0].id, premises_id: (await sys(maintPool, `SELECT premises_id FROM premises_ref LIMIT 1`)).rows[0].premises_id }, hq.token);
  check('R6 but HQ changes nothing', x.status >= 400, `${x.status}`);

  await attempt('R6 custodian', async () => {
    const cust = await as('CUSTODIAN:Guest House Custodian');
    const sub = cats.find((c) => c.name_en.startsWith('Door'));
    x = await post('/maintenance/v1/tickets', { sub_category_id: sub.id }, cust.token);
    const t = await j(x);
    check('R6 the guest-house custodian raises a complaint for the building', x.status === 201, `${x.status} ${JSON.stringify(t)}`);
  });

  await attempt('R6 firm', async () => {
    const firm = await as('CONTRACTOR:M/s Jayant Constructions');
    const list = await j(await get('/maintenance/v1/tickets', firm.token));
    const all = await j(await get('/maintenance/v1/tickets', inc.token));
    const mine = all.items.filter((t) => t.state !== 'RAISED' && t.state !== 'VERIFIED');
    check('R6 the contractor firm sees the jobs under its contract', list.items?.length >= 1 && list.items.length <= all.items.length,
      `${list.items?.length} of ${all.items.length} (${mine.length} assigned)`);
    x = await post(`/maintenance/v1/tickets/${list.items[0].id}/close`, {}, firm.token);
    check('R6 and can change none of them', x.status >= 400, `${x.status}`);
  });

  /* A phone registered with a mobile that already belongs to someone joins
     that person, whatever name was typed — the OTP proved the mobile. The
     answer must say so, in the person's real name (user's finding,
     2026-10-12: a phone typed in as "mohan" was shyam's, and every screen
     called it "mohan"). */
  await attempt('R6 registration to an existing person', async () => {
    const owner = (await sys(identityPool, `SELECT name, mobile FROM identity.person WHERE name = 'R. K. Singh'`)).rows[0];
    const o = await j(await post('/identity/v1/auth/otp/request', { mobile: owner.mobile }));
    const v = await j(await post('/identity/v1/auth/otp/verify', { mobile: owner.mobile, code: o.dev_code }));
    const kp = generateDeviceKeypair();
    const colonies = await j(await fetch(`${BASE}/identity/v1/masters/colonies`));
    const jay = colonies.find((c) => c.area === 'Jayant');
    const x2 = await fetch(`${BASE}/identity/v1/registrations`, { method: 'POST', headers: { ...json, 'x-registration-token': v.registration_token },
      body: JSON.stringify({ public_key: kp.publicKey, name: 'Somebody Else', colony_id: jay.id }) });
    const reg = await j(x2);
    check('R6 a phone registered with an existing person\'s mobile is answered in that person\'s name, and says so',
      x2.status === 201 && reg.name === owner.name && reg.existing_person === true, `${x2.status} ${JSON.stringify(reg).slice(0, 200)}`);
  });

  // a new resident's registration still goes to the Incharge (FRS 4.4)
  await attempt('R6 registration', async () => {
    const m = '9822223333';
    const o = await j(await post('/identity/v1/auth/otp/request', { mobile: m }));
    const v = await j(await post('/identity/v1/auth/otp/verify', { mobile: m, code: o.dev_code }));
    const kp = generateDeviceKeypair();
    const colonies = await j(await fetch(`${BASE}/identity/v1/masters/colonies`));
    const jay = colonies.find((c) => c.area === 'Jayant');
    x = await fetch(`${BASE}/identity/v1/registrations`, { method: 'POST', headers: { ...json, 'x-registration-token': v.registration_token },
      body: JSON.stringify({ public_key: kp.publicKey, name: 'Non-NCL tenant', colony_id: jay.id, identifier: 'D-40', role: 'RESIDENT' }) });
    const reg = await j(x);
    check('R6 a Non-NCL resident registers a device in the app', x.status === 201, `${x.status} ${JSON.stringify(reg)}`);
    x = await post('/identity/v1/registrations', {}, inc.token);
    const q = await j(await get('/identity/v1/registrations', inc.token));
    check('R6 the Incharge sees it with the role asked for', q.items?.some((i) => i.id === reg.id && i.role === 'RESIDENT'), JSON.stringify(q).slice(0, 200));
    x = await post(`/identity/v1/registrations/${reg.id}/approve`, { corrected_identifier: 'D-40', quarter_type: 'D' }, inc.token);
    check('R6 the Incharge verifies and approves the device', x.status === 200, `${x.status} ${JSON.stringify(await j(x))}`);
    const cat = (await sys(identityPool, `SELECT resident_category FROM identity.person WHERE name='Non-NCL tenant'`)).rows[0];
    check('R6 a person with no Employee ID is recorded as Non-NCL', cat?.resident_category === 'NON_NCL', JSON.stringify(cat));
  });

  /* ================= H — adding a home to a person already signed in =================
     (user's request, 2026-10-13): a contractor supervisor of one Area who
     lives, as a Non-NCL resident, in another. His phone is approved already;
     he asks from it for the quarter, and that Area's Incharge approves the
     role only. Area isolation holds both ways. */
  await attempt('H add a home', async () => {
    const colonies = await j(await fetch(`${BASE}/identity/v1/masters/colonies`));
    const ngh = colonies.find((c) => c.area === 'Nigahi');
    // a Nigahi Incharge to approve: the Nigahi Overseer also given that role
    await sys(identityPool, `INSERT INTO identity.role_assignment (person_id, role, scope_path, status, reason)
      SELECT person_id, 'MAINTENANCE_INCHARGE', 'ncl.nigahi', 'ACTIVE', 'test: Nigahi Incharge'
        FROM identity.role_assignment WHERE id = $1`, [devices['CIVIL_OVERSEER:Nigahi Overseer'].actor_id]);
    const ngInc = await j(await post('/identity/v1/auth/password', { employee_id: '90223001', password: 'Portal@2026', role: 'MAINTENANCE_INCHARGE' }));
    if (!ngInc.token) throw new Error(`Nigahi Incharge sign-in ${JSON.stringify(ngInc).slice(0, 160)}`);
    const jInc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
    const S = 'CONTRACTOR_SUPERVISOR:M/s Verma — Supr';
    const sup = await as(S);
    const supPerson = (await sys(identityPool, `SELECT person_id FROM identity.role_assignment WHERE id = $1`, [devices[S].actor_id])).rows[0].person_id;
    const phones = async () => Number((await sys(identityPool, `SELECT count(*) FROM identity.device WHERE person_id = $1`, [supPerson])).rows[0].count);
    const before = await phones();

    x = await post('/identity/v1/me/homes', { colony_id: ngh.id, role: 'CIVIL_OVERSEER', identifier: 'C-120' }, sup.token);
    check('H an official role cannot be asked for this way', x.status === 422, `${x.status}`);
    x = await post('/identity/v1/me/homes', { colony_id: ngh.id, role: 'RESIDENT' }, sup.token);
    check('H the quarter is required', x.status === 422, `${x.status}`);
    x = await post('/identity/v1/me/homes', { colony_id: '00000000-0000-0000-0000-000000000000', role: 'RESIDENT', identifier: 'C-120' }, sup.token);
    check('H an unknown colony is refused', x.status === 422, `${x.status}`);
    x = await post('/identity/v1/me/homes', { colony_id: ngh.id, role: 'RESIDENT', identifier: 'C-120' });
    check('H only someone signed in can ask', x.status === 401, `${x.status}`);

    x = await post('/identity/v1/me/homes', { colony_id: ngh.id, role: 'RESIDENT', identifier: 'C-120' }, sup.token);
    const req = await j(x);
    check('H a supervisor of Jayant asks from his phone for a quarter in Nigahi', x.status === 201 && req.status === 'PENDING' && !!req.id, `${x.status} ${JSON.stringify(req)}`);
    check('H no new phone is created — his phone is approved already', (await phones()) === before);
    x = await post('/identity/v1/me/homes', { colony_id: ngh.id, role: 'RESIDENT', identifier: 'C-121' }, sup.token);
    check('H one request at a time', x.status === 409, `${x.status}`);
    const mine = await j(await get('/identity/v1/me/homes', sup.token));
    check('H he sees his request as waiting', mine.items?.some((h) => h.id === req.id && h.status === 'PENDING' && h.identifier === 'C-120' && h.colony), JSON.stringify(mine).slice(0, 200));

    const jq = await j(await get('/identity/v1/home-requests', jInc.token));
    check('H the Jayant Incharge does not see a Nigahi request', !jq.items?.some((h) => h.id === req.id), JSON.stringify(jq).slice(0, 160));
    x = await post(`/identity/v1/home-requests/${req.id}/approve`, { quarter_type: 'C' }, jInc.token);
    check('H … and cannot approve it', [403, 404].includes(x.status), `${x.status}`);
    x = await get('/identity/v1/home-requests', sup.token);
    check('H a supervisor has no approval queue', (await j(x)).items?.length === 0);

    const nq = await j(await get('/identity/v1/home-requests', ngInc.token));
    const item = nq.items?.find((h) => h.id === req.id);
    check('H the Nigahi Incharge sees it, with the person and the quarter', item?.name === 'M/s Verma — Supr' && item?.identifier === 'C-120' && item?.role === 'RESIDENT', JSON.stringify(nq).slice(0, 240));
    check('H … but nothing of his roles in Jayant (control 3)', !String(item?.existing_roles || '').includes('CONTRACTOR_SUPERVISOR'), JSON.stringify(item?.existing_roles));
    x = await post(`/identity/v1/home-requests/${req.id}/approve`, {}, ngInc.token);
    check('H approving a quarter needs its type', x.status === 422, `${x.status}`);
    x = await post(`/identity/v1/home-requests/${req.id}/approve`, { quarter_type: 'C' }, ngInc.token);
    const ok = await j(x);
    check('H the Nigahi Incharge approves the role', x.status === 200 && ok.premises?.identifier === 'C-120', `${x.status} ${JSON.stringify(ok)}`);
    x = await post(`/identity/v1/home-requests/${req.id}/approve`, { quarter_type: 'C' }, ngInc.token);
    check('H it cannot be approved twice', [403, 404, 409].includes(x.status), `${x.status}`);
    const row = (await sys(identityPool, `SELECT status::text, premises_id, approved_by FROM identity.role_assignment WHERE id = $1`, [req.id])).rows[0];
    check('H the role is active, bound to the quarter, with who approved it', row?.status === 'ACTIVE' && !!row.premises_id && !!row.approved_by, JSON.stringify(row));
    const aud = (await sys(identityPool, `SELECT count(*) FROM identity.audit_log WHERE entity_id = $1 AND event_type = 'HOME_APPROVED'`, [req.id])).rows[0];
    check('H the approval is audit-logged', Number(aud?.count) === 1, JSON.stringify(aud));

    const again = await device(S);
    const rs = (again.assignments || []).map((a) => a.role).sort();
    check('H on the same phone he now chooses between both roles', JSON.stringify(rs) === '["CONTRACTOR_SUPERVISOR","RESIDENT"]', JSON.stringify(again).slice(0, 200));
    const home = await j(await post('/identity/v1/auth/select-role',
      { person_token: again.person_token, assignment_id: again.assignments?.find((a) => a.role === 'RESIDENT')?.id }));
    const meH = await j(await get('/identity/v1/me', home.token));
    check('H as resident he sees his Nigahi quarter', meH.identifier === 'C-120' && /nigahi/i.test(`${meH.area} ${meH.colony}`), JSON.stringify(meH).slice(0, 200));

    // refused, with the reason shown to the person
    const res = await as('RESIDENT:R. K. Singh');
    const r2 = await j(await post('/identity/v1/me/homes', { colony_id: ngh.id, role: 'RESIDENT', identifier: 'C-130' }, res.token));
    x = await post(`/identity/v1/home-requests/${r2.id}/reject`, {}, ngInc.token);
    check('H refusing needs a reason', x.status === 422, `${x.status}`);
    x = await post(`/identity/v1/home-requests/${r2.id}/reject`, { reason: 'C-130 is allotted to someone else' }, ngInc.token);
    check('H the Nigahi Incharge refuses another request', x.status === 200, `${x.status}`);
    const m2 = await j(await get('/identity/v1/me/homes', res.token));
    check('H the person sees it refused, with the reason', m2.items?.some((h) => h.id === r2.id && h.status === 'REJECTED' && /allotted/.test(h.rejected_reason || '')), JSON.stringify(m2).slice(0, 200));

    // nobody approves their own
    const own = await j(await post('/identity/v1/me/homes', { colony_id: ngh.id, role: 'RESIDENT', identifier: 'C-140' }, ngInc.token));
    x = await post(`/identity/v1/home-requests/${own.id}/approve`, { quarter_type: 'C' }, ngInc.token);
    check('H nobody approves their own request', x.status === 403, `${x.status} ${JSON.stringify(own).slice(0, 80)}`);
  });

  /* P — a person's phones, told apart, in People and roles (user's finding,
     2026-10-13: two phones of one person and no way to see which to revoke) */
  await attempt('P phones', async () => {
    const adm = await as('AREA_SYS_ADMIN:V. Sharma');
    const S = 'CONTRACTOR_SUPERVISOR:M/s Verma — Supr';
    const pid = (await sys(identityPool, `SELECT person_id FROM identity.role_assignment WHERE id = $1`, [devices[S].actor_id])).rows[0].person_id;
    const list = await j(await get(`/identity/v1/devices?person_id=${pid}`, adm.token));
    const d = Array.isArray(list) ? list[0] : null;
    check('P the administrator lists one person’s phones', Array.isArray(list) && list.length >= 1 && list.every((x) => x.person_id === pid), JSON.stringify(list).slice(0, 200));
    check('P each phone says when it was registered and approved, and the person’s roles', !!d?.created_at && 'approved_at' in (d || {}) && /CONTRACTOR_SUPERVISOR/.test(d?.roles || ''), JSON.stringify(d).slice(0, 240));
  });

  /* E — a phone registered in another Area (user's decision, 2026-10-13):
     the administrator here learns that it exists, nothing more, and cannot
     revoke it; the Area it was registered in, and HQ, manage it. */
  await attempt('E phones elsewhere', async () => {
    const adm = await as('AREA_SYS_ADMIN:V. Sharma');
    const N = 'RESIDENT:Nigahi resident';
    const pid = (await sys(identityPool, `SELECT person_id FROM identity.role_assignment WHERE id = $1`, [devices[N].actor_id])).rows[0].person_id;
    // the Nigahi resident also asks for a home in Jayant: Jayant now sees the person
    await sys(identityPool, `INSERT INTO identity.role_assignment (person_id, role, scope_path, status, submitted_colony_id, submitted_identifier)
      SELECT $1, 'RESIDENT', c.scope_path, 'PENDING', c.id, 'E-99' FROM identity.colony c WHERE c.scope_path <@ 'ncl.jayant' LIMIT 1`, [pid]);
    const list = await j(await get('/identity/v1/persons?q=Nigahi%20resident', adm.token));
    const pr = Array.isArray(list) ? list.find((x) => x.id === pid) : null;
    check('E the Jayant administrator sees the person', !!pr, JSON.stringify(list).slice(0, 160));
    check('E … no phone of Jayant, and one phone registered in another Area', Number(pr?.devices) === 0 && Number(pr?.phones_elsewhere) === 1, JSON.stringify(pr).slice(0, 240));
    const ph = await j(await get(`/identity/v1/devices?person_id=${pid}`, adm.token));
    check('E … but none of that phone\u2019s details', Array.isArray(ph) && ph.length === 0, JSON.stringify(ph).slice(0, 160));
    const dev = (await sys(identityPool, `SELECT id FROM identity.device WHERE person_id = $1`, [pid])).rows[0].id;
    x = await post(`/identity/v1/devices/${dev}/revoke`, { reason: 'test' }, adm.token);
    const still = (await sys(identityPool, `SELECT status::text FROM identity.device WHERE id = $1`, [dev])).rows[0].status;
    check('E … and cannot revoke it', x.status >= 400 && still === 'ACTIVE', `${x.status} ${still}`);
    const own = (Array.isArray(list) ? list : []).find((x) => x.name === 'R. Kumar');
    const jam = await j(await get('/identity/v1/persons?q=R.%20Kumar', adm.token));
    const rk = Array.isArray(jam) ? jam[0] : null;
    check('E a person whose phone is in this Area shows none elsewhere', Number(rk?.devices) === 1 && Number(rk?.phones_elsewhere) === 0, JSON.stringify(rk).slice(0, 200));
    void own;
  });

  for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n        ${d}` : ''}`);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await identityPool.end(); await maintPool.end();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
