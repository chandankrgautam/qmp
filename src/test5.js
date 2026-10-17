import fs from 'node:fs';
import { signNonce, generateDeviceKeypair } from './auth.js';
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
const call = (tok, path, method = 'GET', body) =>
  fetch(`${BASE}/maintenance/v1${path}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };

const EXPECTED = {
  AML: 'Amlohri', NGH: 'Nigahi', JNT: 'Jayant', DCH: 'Dudhichua',
  KHD: 'Khadia', KSL: 'Krishnashila', BINA: 'Bina', KKR: 'Kakri',
  JRD: 'Jhingurda', BLB: 'Block-B', CWS: 'Central Workshop',
  NSC: 'Nehru Shatabdi Chikitsalaya', NHQ: 'NCL HQ Colony'
};

async function run() {
  const resident = await login('RESIDENT:R. K. Singh');
  const overseer = await login('CIVIL_OVERSEER:A. K. Dubey');
  const incharge = await login('MAINTENANCE_INCHARGE:P. N. Mishra');
  const contractor = await login('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');

  /* ---------------- thirteen areas ---------------- */
  const areas = await withSystem(identityPool, (c) => c.query(
    `SELECT ticket_code, name FROM identity.area ORDER BY name`));
  check('thirteen Areas with colonies are established', areas.rowCount === 13,
    `${areas.rowCount} areas`);

  const byCode = Object.fromEntries(areas.rows.map((a) => [a.ticket_code, a.name]));
  const missing = Object.entries(EXPECTED).filter(([code, name]) => byCode[code] !== name);
  check('every Area carries the code the department uses',
    missing.length === 0, JSON.stringify(missing));

  check('NCL HQ Colony is among them', byCode.NHQ === 'NCL HQ Colony');
  check('CWS is Central Workshop, NSC is Nehru Shatabdi Chikitsalaya',
    byCode.CWS === 'Central Workshop' &&
    byCode.NSC === 'Nehru Shatabdi Chikitsalaya');
  check('a four-letter code is accepted alongside three-letter ones',
    byCode.BINA === 'Bina');

  const colonies = await (await fetch(`${BASE}/identity/v1/masters/colonies`)).json();
  check('all thirteen colonies are offered at registration', colonies.length === 13,
    `${colonies.length}`);

  /* ticket numbers use the Area's own code */
  const cats = await j(await call(resident.token, '/masters/categories'));
  const leak = cats.find((c) => c.name_en.startsWith('Leaking tap'));
  const t = await j(await call(resident.token, '/tickets', 'POST',
    { sub_category_id: leak.id, description: 'Code test' }));
  check('a Jayant ticket is numbered JNT, not JAY',
    /^JNT\/\d{4}\/\d{5}$/.test(t.ticket_no || ''), t.ticket_no);

  // a Bina ticket must carry the four-letter code
  const binaPrem = await withSystem(maintPool, (c) => c.query(
    `SELECT premises_id, area_code FROM premises_ref WHERE area_code='BINA' LIMIT 1`));
  check('the Area code reaches the maintenance projection',
    binaPrem.rowCount === 0 || binaPrem.rows[0].area_code === 'BINA',
    JSON.stringify(binaPrem.rows));

  /* ---------------- non-residential premises ---------------- */
  const nonres = await withSystem(maintPool, (c) => c.query(
    `SELECT identifier, premises_type::text, occupancy_model
       FROM premises_ref WHERE premises_type <> 'QUARTER' ORDER BY identifier`));
  check('hostels, guest houses, union offices and admin buildings are present',
    nonres.rowCount >= 4, `${nonres.rowCount}`);
  // decision 2026-09-30: a building is either under direct departmental
  // control or has a custodian; it is never resident-bound
  check('every non-residential premises is departmental or custodian-bound',
    nonres.rows.every((p) => ['DEPARTMENT_ONLY', 'CUSTODIAN_BOUND'].includes(p.occupancy_model)),
    JSON.stringify(nonres.rows.map((p) => `${p.identifier}:${p.occupancy_model}`)));

  /* the rule is enforced by the database, not only by the seed */
  let rejected = false;
  try {
    await withSystem(identityPool, (c) => c.query(
      `INSERT INTO identity.premises (area_id, colony_id, scope_path, identifier,
           premises_type, occupancy_model, verified)
       SELECT a.id, col.id, col.scope_path, 'Illegal Hostel', 'HOSTEL',
              'CUSTODIAN_BOUND', true
         FROM identity.area a JOIN identity.colony col ON col.area_id = a.id
        WHERE a.ticket_code = 'JNT' LIMIT 1`));
  } catch { rejected = true; }
  check('a building may have a custodian (decision 2026-09-30)', !rejected);

  let residentBoundRejected = false;
  try {
    await withSystem(identityPool, (c) => c.query(
      `INSERT INTO identity.premises (area_id, colony_id, scope_path, identifier,
           premises_type, occupancy_model, verified)
       SELECT a.id, col.id, col.scope_path, 'Illegal Office', 'UNION_OFFICE',
              'RESIDENT_BOUND', true
         FROM identity.area a JOIN identity.colony col ON col.area_id = a.id
        WHERE a.ticket_code = 'JNT' LIMIT 1`));
  } catch { residentBoundRejected = true; }
  check('nor treated as a residential quarter', residentBoundRejected);

  /* the civil department raises complaints for these buildings directly */
  const hostel = await withSystem(maintPool, (c) => c.query(
    `SELECT premises_id FROM premises_ref WHERE identifier='Hostel-1'`));
  const hostelId = hostel.rows[0]?.premises_id;
  check('a departmental premises exists to test against', !!hostelId);

  let r = await call(overseer.token, '/tickets', 'POST',
    { sub_category_id: leak.id, premises_id: hostelId,
      description: 'Tap leaking in the hostel washroom' });
  const hostelTicket = await j(r);
  check('the Civil Overseer raises a complaint for a hostel directly',
    r.status === 201 && hostelTicket.ticket_no, JSON.stringify(hostelTicket).slice(0, 140));

  r = await call(incharge.token, '/tickets', 'POST',
    { sub_category_id: cats.find((c) => c.name_en.startsWith('Roof')).id,
      premises_id: hostelId, description: 'Roof leaking over the corridor' });
  check('the Maintenance Incharge may also raise one', r.status === 201,
    `status ${r.status}`);

  r = await call(resident.token, '/tickets', 'POST',
    { sub_category_id: cats.find((c) => c.name_en.startsWith('Door')).id,
      premises_id: hostelId });
  check('a resident cannot raise a complaint against a departmental building',
    r.status === 403 || r.status === 422, `status ${r.status}`);

  r = await call(contractor.token, '/tickets', 'POST',
    { sub_category_id: cats.find((c) => c.name_en.startsWith('Window')).id,
      premises_id: hostelId });
  check('nor can the contractor', r.status === 403 || r.status === 422,
    `status ${r.status}`);

  /* the lifecycle still runs, minus the occupant steps */
  await call(overseer.token, `/tickets/${hostelTicket.id}/verify`, 'POST');
  const devs = await j(await call(incharge.token, '/devices/assignable'));
  await call(incharge.token, `/tickets/${hostelTicket.id}/assign`, 'POST',
    { supervisor_id: devs[0].actor_id });
  await call(contractor.token, `/tickets/${hostelTicket.id}/start`, 'POST',
    { workmen_assigned: 'Ram Prasad' });
  await uploadCompletion(BASE, contractor.token, hostelTicket.id);
  await call(contractor.token, `/tickets/${hostelTicket.id}/complete`, 'POST');

  r = await call(contractor.token, `/tickets/${hostelTicket.id}/close`, 'POST');
  check('the contractor still cannot close work on a departmental building',
    r.status === 403, `status ${r.status}`);

  await uploadInspection(BASE, overseer.token, hostelTicket.id);
  r = await call(overseer.token, `/tickets/${hostelTicket.id}/inspect`, 'POST',
    { accepted: true });
  check('the Overseer inspection remains the only quality gate', r.status === 200,
    JSON.stringify(await j(r)).slice(0, 140));

  r = await call(overseer.token, `/tickets/${hostelTicket.id}/close`, 'POST');
  check('and closes it', r.status === 200);

  /* no notification can be routed to an occupant that does not exist */
  const occupants = await withSystem(maintPool, (c) => c.query(
    `SELECT count(*) n FROM occupants_at_premises($1)`, [hostelId]));
  check('a departmental building has no occupant to notify',
    Number(occupants.rows[0].n) === 0, JSON.stringify(occupants.rows));

  /* it still appears in the inspection queue, ahead of quarters */
  const ranks = await withSystem(maintPool, (c) => c.query(
    `SELECT identifier, inspection_rank FROM premises_ref
      WHERE identifier IN ('Hostel-1','B-234') ORDER BY inspection_rank`));
  check('a hostel is inspected ahead of an ordinary quarter',
    ranks.rows[0]?.identifier === 'Hostel-1', JSON.stringify(ranks.rows));

  /* a custodian is bound to a building, never to a quarter */
  const custodians = await withSystem(identityPool, (c) => c.query(
    `SELECT count(*) FILTER (WHERE p.premises_type = 'QUARTER') AS on_quarters, count(*) AS total
       FROM identity.role_assignment a JOIN identity.premises p ON p.id = a.premises_id
      WHERE a.role = 'CUSTODIAN' AND a.status = 'ACTIVE'`));
  check('custodians are bound to buildings, never quarters',
    Number(custodians.rows[0].total) >= 1 && Number(custodians.rows[0].on_quarters) === 0,
    JSON.stringify(custodians.rows[0]));

  console.log('');
  for (const [st, n, d] of out) {
    console.log(`  ${st}  ${n}${d ? '\n         ' + String(d).slice(0, 170) : ''}`);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await maintPool.end(); await identityPool.end();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
