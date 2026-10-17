/**
 * Suite 11 — work orders (decision 2026-09-30, item 6).
 *
 *   W1  the Civil Incharge fills in the work order; several contractors
 *       may work in one Area; nobody below the Incharge writes one
 *   W2  every change needs a reason and is audit-logged, before and after
 *   W3  the completion date moves only by a recorded extension; the date
 *       as awarded is never lost; extensions cannot be edited
 *   W4  the Incharge names the contractor's supervisors on the work order
 *   W5  the contract copy is attached, fingerprinted and kept unaltered
 *   W6  who sees which work order
 *   W7  the Incharge creates a contractor supervisor directly, approves
 *       their phone and ends the role — that role and no other
 *
 * Needs a freshly reset and seeded database.
 */
import fs from 'node:fs';
import { signNonce, generateDeviceKeypair } from './auth.js';
import { withScope, withSystem, maintPool, identityPool } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => { if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); } };
async function attempt(n, fn) { try { await fn(); } catch (e) { check(n, false, `threw: ${e.message}`.slice(0, 220)); } }

const M = '/maintenance/v1';
const json = { 'content-type': 'application/json' };
const call = (p, tok, method = 'GET', b) => fetch(`${BASE}${M}${p}`, { method,
  headers: { ...json, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
const post = (p, b, tok) => call(p, tok, 'POST', b || {});
const put = (p, b, tok) => call(p, tok, 'PUT', b || {});
const j = async (r) => { try { return await r.json(); } catch { return {}; } };

async function as(key) {
  const d = devices[key];
  const ch = await (await fetch(`${BASE}/identity/v1/auth/challenge`, { method: 'POST', headers: json,
    body: JSON.stringify({ public_key: d.publicKey }) })).json();
  return (await fetch(`${BASE}/identity/v1/auth/token`, { method: 'POST', headers: json,
    body: JSON.stringify({ public_key: d.publicKey, nonce: ch.nonce, signature: signNonce(d.privateKey, ch.nonce),
      second_factor_satisfied: true, role: d.role }) })).json();
}
const sys = (sql, params) => withSystem(maintPool, (c) => c.query(sql, params));
const isys = (sql, params) => withSystem(identityPool, (c) => c.query(sql, params));
const ID = '/identity/v1';
const idcall = (p, tok, method = 'GET', b) => fetch(`${BASE}${ID}${p}`, { method,
  headers: { ...json, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
/* A phone registered in the app by whoever holds this mobile. */
async function registerPhone(mobile, name) {
  const o = await (await idcall('/auth/otp/request', null, 'POST', { mobile })).json();
  const v = await (await idcall('/auth/otp/verify', null, 'POST', { mobile, code: o.dev_code })).json();
  const kp = generateDeviceKeypair();
  const colonies = await (await idcall('/masters/colonies')).json();
  const r = await fetch(`${BASE}${ID}/registrations`, { method: 'POST', headers: { ...json, 'x-registration-token': v.registration_token },
    body: JSON.stringify({ public_key: kp.publicKey, name, colony_id: colonies.find((c) => c.area === 'Jayant').id }) });
  return { kp, reg: await r.json(), status: r.status };
}
async function phoneSignIn(kp, role) {
  const ch = await (await idcall('/auth/challenge', null, 'POST', { public_key: kp.publicKey })).json();
  return (await idcall('/auth/token', null, 'POST', { public_key: kp.publicKey, nonce: ch.nonce,
    signature: signNonce(kp.privateKey, ch.nonce), second_factor_satisfied: true, role })).json();
}
const asRole = (claims, fn) => withScope(maintPool, claims, fn);
const upload = (id, buf, type, tok, name = 'agreement.pdf') => fetch(
  `${BASE}${M}/contracts/${id}/documents?file_name=${encodeURIComponent(name)}&kind=CONTRACT_COPY`,
  { method: 'POST', headers: { 'content-type': type, authorization: `Bearer ${tok}` }, body: buf });
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

async function run() {
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
  const so = await as('STAFF_OFFICER_CIVIL:S. Tiwari');
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey');
  const sup = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const firm = await as('CONTRACTOR:M/s Jayant Constructions');
  const gm = await as('GM_CIVIL:GM (Civil)');
  const ngh = await as('CIVIL_OVERSEER:Nigahi Overseer');
  const incClaims = { role: 'MAINTENANCE_INCHARGE', scope_path: inc.scope_path, actor_id: inc.actor_id, person_id: inc.person_id };

  /* ================= W1 — the Incharge fills in the work order ================= */
  const wo = { contractor_name: 'M/s Singrauli Builders', contract_no: 'LOA/JNT/CIV/2026/07',
    agreement_no: 'NCL/JNT/CIV/2026/02', work_name: 'Comprehensive civil maintenance of Jayant Colony, Sector B',
    firm_address: 'Waidhan, Singrauli', awarded_on: '2026-08-01', site_handover_on: '2026-08-10',
    starts_on: '2026-08-10', expires_on: '2027-08-09' };
  let r = await post('/contracts', wo, inc.token);
  const ct = await j(r);
  check('W1 the Civil Incharge enters a work order with its details', r.status === 201 && ct.contract_no === wo.contract_no
    && ct.work_name === wo.work_name && ct.site_handover_on?.slice(0, 10) === wo.site_handover_on, `${r.status} ${JSON.stringify(ct).slice(0, 200)}`);
  check('W1 the completion date as awarded is recorded', ct.original_expires_on?.slice(0, 10) === wo.expires_on, JSON.stringify(ct.original_expires_on));
  const live = (await sys(`SELECT count(*) n FROM contract WHERE area_id=$1 AND active`, [ct.area_id])).rows[0].n;
  check('W1 an Area may have several contractors at once', Number(live) === 2, live);
  r = await post('/contracts', { ...wo, agreement_no: 'X/OVR', contract_no: null }, ovr.token);
  check('W1 the Overseer does not write work orders', r.status === 403, `${r.status}`);
  r = await post('/contracts', { ...wo, agreement_no: 'X/SUP', contract_no: null }, sup.token);
  check('W1 nor does a contractor', r.status === 403, `${r.status}`);
  r = await post('/contracts', { ...wo, agreement_no: 'X/NGH', contract_no: null, area_id: '00000000-0000-0000-0000-000000000000' }, inc.token);
  check('W1 a work order is for the Incharge\'s own Area only', r.status === 422, `${r.status}`);
  let refused = false;
  try {
    await asRole({ role: 'CIVIL_OVERSEER', scope_path: ovr.scope_path, actor_id: ovr.actor_id, person_id: ovr.person_id }, (c) => c.query(
      `INSERT INTO contract (area_id, scope_path, contractor_name, agreement_no, awarded_on, starts_on, expires_on)
       SELECT area_id, scope_path, 'M/s Direct', 'X/DIRECT', current_date, current_date, current_date + 300 FROM contract WHERE id=$1`, [ct.id]));
  } catch { refused = true; }
  check('W1 the database itself refuses a work order from the Overseer', refused);

  /* ================= W2 — reason compulsory, every change audited ================= */
  r = await put(`/contracts/${ct.id}`, { firm_address: 'Morwa, Singrauli' }, inc.token);
  check('W2 a change without a reason is refused', r.status === 422, `${r.status}`);
  r = await put(`/contracts/${ct.id}`, { firm_address: 'Morwa, Singrauli', reason: 'Firm shifted office, letter dt 12.09.2026' }, inc.token);
  check('W2 a change with a reason is made', r.status === 200, `${r.status} ${JSON.stringify(await j(r))}`);
  const log = (await sys(`SELECT before_value, after_value, reason, actor_id, event_type FROM audit_log
                           WHERE entity_type='contract' AND entity_id=$1 AND event_type='CONTRACT_CHANGED' ORDER BY id DESC LIMIT 1`, [ct.id])).rows[0];
  check('W2 the audit log holds the old value, the new one, the reason and who',
    log?.before_value?.firm_address === 'Waidhan, Singrauli' && log?.after_value?.firm_address === 'Morwa, Singrauli'
    && /letter/.test(log?.reason || '') && log?.actor_id === inc.actor_id, JSON.stringify(log));
  check('W2 the award itself is in the audit log',
    (await sys(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND event_type='CONTRACT_AWARDED'`, [ct.id])).rows[0].n === '1');
  refused = false;
  try { await asRole(incClaims, (c) => c.query(`UPDATE contract SET remarks='quiet change' WHERE id=$1`, [ct.id])); } catch { refused = true; }
  check('W2 the database refuses a change that carries no reason', refused);
  r = await put(`/contracts/${ct.id}`, { expires_on: '2028-01-01', reason: 'just moving it' }, inc.token);
  check('W2 the completion date is not edited directly', r.status === 422, `${r.status}`);
  refused = false;
  try {
    await asRole(incClaims, async (c) => {
      await c.query(`SELECT set_config('app.reason','sneaky',true)`);
      await c.query(`UPDATE contract SET expires_on = expires_on + 365 WHERE id=$1`, [ct.id]);
    });
  } catch { refused = true; }
  check('W2 the database refuses a completion date moved without an extension', refused);
  refused = false;
  try { await sys(`UPDATE contract SET original_expires_on = current_date WHERE id=$1`, [ct.id]); } catch { refused = true; }
  check('W2 the date as awarded cannot be changed by anyone, the system included', refused);
  r = await put(`/contracts/${ct.id}`, { remarks: 'x', reason: 'y' }, ovr.token);
  check('W2 the Overseer cannot change a work order', r.status === 403, `${r.status}`);
  r = await put(`/contracts/${ct.id}`, { remarks: 'x', reason: 'y' }, gm.token);
  check('W2 nor can HQ, which reads only', r.status === 403, `${r.status}`);

  /* ================= W3 — extensions ================= */
  r = await post(`/contracts/${ct.id}/extensions`, { extended_to: '2027-11-30', order_no: 'EXT/1' }, inc.token);
  check('W3 an extension needs a reason', r.status === 422, `${r.status}`);
  r = await post(`/contracts/${ct.id}/extensions`, { extended_to: '2027-06-30', reason: 'earlier date' }, inc.token);
  check('W3 an extension must be later than the current completion date', r.status === 422, `${r.status} ${JSON.stringify(await j(r))}`);
  r = await post(`/contracts/${ct.id}/extensions`, { extended_to: '2027-11-30', order_no: 'CGM/JNT/EXT/1', granted_on: '2027-07-20',
    reason: 'Tender for successor not finalised' }, inc.token);
  const e1 = await j(r);
  check('W3 Extension 1 is recorded', r.status === 201 && e1.seq === 1, `${r.status} ${JSON.stringify(e1)}`);
  r = await post(`/contracts/${ct.id}/extensions`, { extended_to: '2028-02-29', order_no: 'CGM/JNT/EXT/2', reason: 'Further delay in award' }, so.token);
  const e2 = await j(r);
  check('W3 Extension 2 follows, by the Staff Officer', r.status === 201 && e2.seq === 2, `${r.status} ${JSON.stringify(e2)}`);
  const after = (await sys(`SELECT expires_on::text, original_expires_on::text FROM contract WHERE id=$1`, [ct.id])).rows[0];
  check('W3 the completion date now runs to the latest extension, the awarded date unchanged',
    after.expires_on === '2028-02-29' && after.original_expires_on === '2027-08-09', JSON.stringify(after));
  check('W3 each extension is audit-logged with its reason',
    (await sys(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND event_type='CONTRACT_EXTENDED' AND reason IS NOT NULL`, [ct.id])).rows[0].n === '2');
  r = await post(`/contracts/${ct.id}/extensions`, { extended_to: '2029-01-01', reason: 'self' }, sup.token);
  check('W3 a contractor cannot extend a contract', r.status === 403, `${r.status}`);
  refused = false;
  try { await sys(`UPDATE contract_extension SET extended_to = '2030-01-01' WHERE contract_id=$1`, [ct.id]); } catch { refused = true; }
  check('W3 a recorded extension cannot be altered, even by the system', refused);
  refused = false;
  try { await sys(`DELETE FROM contract_extension WHERE contract_id=$1`, [ct.id]); } catch { refused = true; }
  check('W3 nor deleted', refused);

  /* ================= W4 — supervisors named on the work order ================= */
  const verma = devices['CONTRACTOR_SUPERVISOR:M/s Verma — Supr'].actor_id || sup.actor_id;
  r = await post(`/contracts/${ct.id}/supervisors`, { actor_id: verma }, inc.token);
  check('W4 naming a supervisor needs a reason', r.status === 422, `${r.status}`);
  r = await post(`/contracts/${ct.id}/supervisors`, { actor_id: verma, reason: 'Deployed by firm, letter dt 15.08.2026' }, ovr.token);
  check('W4 the Overseer does not name supervisors', r.status === 403, `${r.status}`);
  r = await post(`/contracts/${ct.id}/supervisors`, { actor_id: verma, reason: 'Deployed by firm, letter dt 15.08.2026' }, inc.token);
  check('W4 the Incharge names the supervisor on the work order', r.status === 200, `${r.status} ${JSON.stringify(await j(r))}`);
  const detail = await j(await call(`/contracts/${ct.id}`, inc.token));
  check('W4 the work order lists its supervisors, extensions and documents',
    detail.supervisors?.some((s) => s.actor_id === verma) && detail.extensions?.length === 2 && Array.isArray(detail.documents),
    JSON.stringify(detail).slice(0, 240));
  const assignable = await j(await call('/devices/assignable', inc.token));
  check('W4 work given to that supervisor now counts against this contract',
    assignable.find?.((a) => a.actor_id === verma)?.contract_id === ct.id, JSON.stringify(assignable).slice(0, 200));
  check('W4 the naming is audit-logged', (await sys(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND event_type='CONTRACT_SUPERVISOR_NAMED'`, [ct.id])).rows[0].n === '1');

  /* ================= W5 — the contract copy ================= */
  r = await upload(ct.id, PDF, 'application/pdf', inc.token);
  const doc = await j(r);
  check('W5 the Incharge attaches the contract copy', r.status === 201 && /^[0-9a-f]{64}$/.test(doc.content_hash || ''), `${r.status} ${JSON.stringify(doc)}`);
  r = await upload(ct.id, Buffer.from('not a pdf at all'), 'application/pdf', inc.token, 'fake.pdf');
  check('W5 a file that is not a PDF or a scanned image is refused', r.status === 422, `${r.status}`);
  r = await upload(ct.id, PDF, 'application/pdf', sup.token);
  check('W5 a contractor cannot attach documents to the work order', r.status === 403, `${r.status}`);
  r = await call(`/contracts/${ct.id}/documents/${doc.id}`, inc.token);
  const got = Buffer.from(await r.arrayBuffer());
  check('W5 the copy downloads byte for byte', r.status === 200 && got.equals(PDF) && /pdf/.test(r.headers.get('content-type') || ''), `${r.status} ${got.length}`);
  check('W5 attaching it is audit-logged', (await sys(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND event_type='CONTRACT_DOCUMENT_ATTACHED'`, [ct.id])).rows[0].n === '1');
  refused = false;
  try { await sys(`UPDATE contract_document SET file_name='other.pdf' WHERE id=$1`, [doc.id]); } catch { refused = true; }
  check('W5 a document record cannot be altered', refused);
  refused = false;
  try { await sys(`DELETE FROM contract_document WHERE id=$1`, [doc.id]); } catch { refused = true; }
  check('W5 nor deleted', refused);

  /* ================= W6 — who sees which work order ================= */
  const firmList = await j(await call('/contracts', firm.token));
  check('W6 a contractor sees only its own work order', Array.isArray(firmList) && firmList.length === 1
    && firmList[0].agreement_no === 'NCL/JNT/CIV/2026/01', JSON.stringify(firmList.map?.((x) => x.agreement_no)));
  r = await call(`/contracts/${ct.id}`, firm.token);
  check('W6 and cannot open a rival\'s', r.status === 404, `${r.status}`);
  r = await call(`/contracts/${ct.id}`, ngh.token);
  check('W6 another Area gets "not found"', r.status === 404, `${r.status}`);
  r = await call(`/contracts/${ct.id}/documents/${doc.id}`, ngh.token);
  check('W6 nor its documents', r.status === 404, `${r.status}`);
  r = await call(`/contracts/${ct.id}`, ovr.token);
  check('W6 the Overseer reads the work order', r.status === 200, `${r.status}`);
  const hist = await j(await call(`/contracts/${ct.id}/history`, inc.token));
  check('W6 the history shows every change with its reason',
    Array.isArray(hist) && ['CONTRACT_AWARDED', 'CONTRACT_CHANGED', 'CONTRACT_EXTENDED', 'CONTRACT_SUPERVISOR_NAMED', 'CONTRACT_DOCUMENT_ATTACHED']
      .every((e) => hist.some((h) => h.event_type === e)), JSON.stringify(hist.map?.((h) => h.event_type)));

  /* ================= W7 — the Incharge creates a supervisor directly ================= */
  const newSup = { name: 'R. Yadav', mobile: '9833344455', designation: 'Site supervisor', contract_id: ct.id };
  r = await idcall('/supervisors', inc.token, 'POST', newSup);
  check('W7 creating a supervisor needs a reason', r.status === 422, `${r.status}`);
  r = await idcall('/supervisors', ovr.token, 'POST', { ...newSup, reason: 'x' });
  check('W7 the Overseer cannot create one', r.status === 403, `${r.status}`);
  r = await idcall('/supervisors', inc.token, 'POST', { ...newSup, contract_id: '00000000-0000-0000-0000-000000000000', reason: 'x' });
  check('W7 only on a live work order the Incharge can see', r.status === 422, `${r.status}`);
  r = await idcall('/supervisors', inc.token, 'POST', { ...newSup, reason: 'Deployed by M/s Singrauli Builders, letter dt 20.08.2026' });
  const made = await j(r);
  check('W7 the Incharge creates the supervisor on the work order', r.status === 201 && made.role === 'CONTRACTOR_SUPERVISOR', `${r.status} ${JSON.stringify(made)}`);
  const assignable2 = await j(await call('/devices/assignable', inc.token));
  check('W7 work can be assigned to them at once, counting against that work order',
    assignable2.find?.((a) => a.actor_id === made.id)?.contract_id === ct.id, JSON.stringify(assignable2).slice(0, 200));
  check('W7 the creation is audit-logged with its reason', (await isys(
    `SELECT count(*) n FROM identity.audit_log WHERE entity_id=$1 AND event_type='ROLE_ASSIGNED' AND reason LIKE 'Deployed%'`, [made.id])).rows[0].n === '1');

  refused = false;
  try {
    await withScope(identityPool, { role: 'MAINTENANCE_INCHARGE', scope_path: inc.scope_path, actor_id: inc.actor_id, person_id: inc.person_id },
      (c) => c.query(`INSERT INTO identity.role_assignment (person_id, role, scope_path, status, reason)
                      VALUES ($1,'CIVIL_OVERSEER','ncl.jayant','ACTIVE','x')`, [made.person_id]));
  } catch { refused = true; }
  check('W7 the database lets the Incharge create no other role', refused);
  refused = false;
  try {
    await withScope(identityPool, { role: 'MAINTENANCE_INCHARGE', scope_path: inc.scope_path, actor_id: inc.actor_id, person_id: inc.person_id },
      (c) => c.query(`INSERT INTO identity.role_assignment (person_id, role, scope_path, status, reason, contract_id)
                      VALUES ($1,'CONTRACTOR_SUPERVISOR','ncl.nigahi','ACTIVE','x',$2)`, [made.person_id, ct.id]));
  } catch { refused = true; }
  check('W7 nor a supervisor in another Area', refused);
  refused = false;
  try {
    await withScope(identityPool, { role: 'MAINTENANCE_INCHARGE', scope_path: inc.scope_path, actor_id: inc.actor_id, person_id: inc.person_id },
      (c) => c.query(`INSERT INTO identity.role_assignment (person_id, role, scope_path, status, reason)
                      VALUES ($1,'CONTRACTOR_SUPERVISOR','ncl.jayant','ACTIVE','x')`, [made.person_id]));
  } catch { refused = true; }
  check('W7 nor a supervisor on no work order', refused);

  const nghMobile = (await isys(`SELECT mobile FROM identity.person WHERE name='Nigahi Overseer'`)).rows[0].mobile;
  r = await idcall('/supervisors', inc.token, 'POST', { ...newSup, name: 'Someone', mobile: nghMobile, reason: 'x' });
  check('W7 a mobile that belongs to someone outside the Area is refused, not taken over', r.status === 409, `${r.status}`);

  // the supervisor registers their phone; the Incharge approves it
  const phone = await registerPhone(newSup.mobile, 'R. Yadav');
  check('W7 (setup) the supervisor registers their phone', phone.status === 201, JSON.stringify(phone.reg));
  const q = await j(await idcall('/registrations', inc.token));
  check('W7 the phone reaches the Incharge\'s queue', q.items?.some((i) => i.id === phone.reg.id), JSON.stringify(q).slice(0, 200));
  r = await idcall(`/registrations/${phone.reg.id}/approve`, inc.token, 'POST', {});
  check('W7 the Incharge approves it', r.status === 200, `${r.status} ${JSON.stringify(await j(r))}`);
  const yadav = await phoneSignIn(phone.kp, 'CONTRACTOR_SUPERVISOR');
  check('W7 and the supervisor signs in on it', yadav.role === 'CONTRACTOR_SUPERVISOR' && !!yadav.token, JSON.stringify(yadav).slice(0, 160));

  // but an official's phone is still the Area administrators' to approve
  const hr = await as('AREA_HR_ADMIN:R. Kumar');
  const off = await j(await idcall('/persons', hr.token, 'POST', { name: 'New JE', personnel_no: '90227777', mobile: '9844455566', designation: 'Civil Overseer' }));
  await idcall('/assignments', hr.token, 'POST', { person_id: off.id, role: 'CIVIL_OVERSEER', scope_path: 'ncl.jayant', reason: 'Posted' });
  const offPhone = await registerPhone('9844455566', 'New JE');
  r = await idcall(`/registrations/${offPhone.reg.id}/approve`, inc.token, 'POST', {});
  check('W7 the Incharge still cannot approve an Overseer\'s phone', r.status === 403, `${r.status}`);

  /* W8 — jobs left with a supervisor whose role ends (user's finding,
     2026-10-12: two complaints sat with ended roles where nobody could
     start them). Ending the role shows the jobs first; afterwards each
     such complaint says its supervisor's role has ended. */
  const tenant = await as('RESIDENT:R. K. Singh');
  const cats = await j(await call('/masters/categories', tenant.token));
  const sub = cats.filter((c) => c.classification !== 'EM').at(-1);
  const held = await j(await call('/tickets', tenant.token, 'POST', { sub_category_id: sub.id, description: 'Held by a supervisor whose role will end' }));
  await call(`/tickets/${held.id}/verify`, ovr.token, 'POST');
  r = await call(`/tickets/${held.id}/assign`, inc.token, 'POST', { supervisor_id: made.id });
  check('W8 (setup) a complaint is assigned to the new supervisor', r.status === 200, `${r.status} ${JSON.stringify(await j(r)).slice(0, 160)}`);
  r = await call(`/actors/${made.id}/open-jobs`, inc.token);
  let jobs = await j(r);
  check('W8 before ending the role, the Incharge sees the supervisor\'s open jobs', r.status === 200 && Array.isArray(jobs) && jobs.some((x) => x.ticket_no === held.ticket_no),
    `${r.status} ${JSON.stringify(jobs).slice(0, 160)}`);
  r = await call(`/actors/${made.id}/open-jobs`, hr.token);
  check('W8 and so does the Area HR administrator, who also ends roles', r.status === 200 && (await j(r)).length >= 1, `${r.status}`);
  r = await call(`/actors/${made.id}/open-jobs`, tenant.token);
  check('W8 a resident cannot list anyone\'s jobs', r.status === 403, `${r.status}`);
  const nghInc = await as('CIVIL_OVERSEER:Nigahi Overseer');
  r = await call(`/actors/${made.id}/open-jobs`, nghInc.token);
  jobs = await j(r);
  check('W8 an officer of another Area sees none of them', r.status === 200 && Array.isArray(jobs) && jobs.length === 0, `${r.status} ${JSON.stringify(jobs).slice(0, 120)}`);

  r = await idcall(`/assignments/${made.id}/revoke`, inc.token, 'POST', {});
  check('W7 ending a supervisor role needs a reason', r.status === 422, `${r.status}`);
  r = await idcall(`/assignments/${made.id}/revoke`, inc.token, 'POST', { reason: 'Withdrawn by the firm' });
  check('W7 the Incharge ends the supervisor role', r.status === 200, `${r.status} ${JSON.stringify(await j(r))}`);
  const listed = (await j(await call('/tickets', inc.token))).items?.find((x) => x.id === held.id);
  check('W8 afterwards the queue marks the complaint: its supervisor\'s role has ended', listed?.assignee_role_ended === true, JSON.stringify(listed).slice(0, 200));
  const heldDetail = await j(await call(`/tickets/${held.id}`, inc.token));
  check('W8 and so does the complaint itself', heldDetail.assignee_role_ended === true, `${heldDetail.assignee_role_ended}`);
  const other = (await j(await call('/tickets', inc.token))).items?.find((x) => x.id !== held.id && x.state === 'ASSIGNED');
  check('W8 a complaint with a supervisor still in role is not marked', !other || other.assignee_role_ended === false, String(JSON.stringify(other)).slice(0, 160));
  const ovrRole = (await isys(`SELECT id FROM identity.role_assignment WHERE person_id=$1 AND role='CIVIL_OVERSEER'`, [off.id])).rows[0];
  r = await idcall(`/assignments/${ovrRole.id}/revoke`, inc.token, 'POST', { reason: 'x' });
  check('W7 but cannot end an Overseer\'s role', r.status === 403, `${r.status}`);
}

run().catch((e) => { check('suite ran to the end', false, e.stack); })
  .finally(async () => {
    for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n         ${d}` : ''}`);
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await maintPool.end().catch(() => {});
    const { identityPool } = await import('./db.js');
    await identityPool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
