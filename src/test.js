import fs from 'node:fs';
import { signNonce } from './auth.js';
import { uploadCompletion, uploadInspection, requirePhotos } from './testutil.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(['PASS', name, '']); }
  else { fail++; results.push(['FAIL', name, detail]); }
}

async function login(key) {
  const d = devices[key];
  if (!d) throw new Error(`no seeded device ${key}`);
  const ch = await (await fetch(`${BASE}/identity/v1/auth/challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: d.publicKey })
  })).json();
  const tok = await (await fetch(`${BASE}/identity/v1/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key: d.publicKey, nonce: ch.nonce,
      signature: signNonce(d.privateKey, ch.nonce),
      second_factor_satisfied: true, role: d.role
    })
  })).json();
  return tok;
}

const call = (token, path, method = 'GET', body) =>
  fetch(`${BASE}/maintenance/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });

const json = async (r) => { try { return await r.json(); } catch { return {}; } };

async function run() {
  await requirePhotos();   // this suite tests the photograph gate as HQ will switch it on
  /* ---------------- authentication ---------------- */
  const resident = await login('RESIDENT:R. K. Singh');
  check('resident authenticates with a signed nonce', !!resident.token, JSON.stringify(resident));
  check('token carries the premises binding', !!resident.premises_id);

  const family    = await login('RESIDENT:Mrs S. Singh');
  const overseer  = await login('CIVIL_OVERSEER:A. K. Dubey');
  const incharge  = await login('MAINTENANCE_INCHARGE:P. N. Mishra');
  const staffoff  = await login('STAFF_OFFICER_CIVIL:S. Tiwari');
  const contractor= await login('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const gm        = await login('GM_CIVIL:GM (Civil)');
  const nigahiOvr = await login('CIVIL_OVERSEER:Nigahi Overseer');
  const nigahiRes = await login('RESIDENT:Nigahi resident');

  // a bad signature must not authenticate
  const d = devices['RESIDENT:R. K. Singh'];
  const ch = await (await fetch(`${BASE}/identity/v1/auth/challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: d.publicKey })
  })).json();
  const bad = await (await fetch(`${BASE}/identity/v1/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: d.publicKey, nonce: ch.nonce,
      signature: Buffer.from('not-a-signature').toString('base64') })
  })).json();
  check('a forged signature is refused', !!bad.error);

  // second factor
  const ov = devices['CIVIL_OVERSEER:A. K. Dubey'];
  const ch2 = await (await fetch(`${BASE}/identity/v1/auth/challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: ov.publicKey })
  })).json();
  const noPin = await (await fetch(`${BASE}/identity/v1/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: ov.publicKey, nonce: ch2.nonce,
      signature: signNonce(ov.privateKey, ch2.nonce), second_factor_satisfied: false, role: 'CIVIL_OVERSEER' })
  })).json();
  check('Overseer refused a token without PIN or biometric', !!noPin.error);

  check('no token is rejected', (await (await fetch(`${BASE}/maintenance/v1/tickets`)).status) === 401);

  /* ---------------- raising ---------------- */
  const cats = await json(await call(resident.token, '/masters/categories'));
  const leak = cats.find((c) => c.name_en.startsWith('Leaking tap'));
  const nowater = cats.find((c) => c.name_en.startsWith('No water'));
  const elec = cats.find((c) => c.classification === 'EM');
  const whitewash = cats.find((c) => c.name_en.startsWith('Whitewash'));

  let r = await call(resident.token, '/tickets', 'POST',
    { sub_category_id: leak.id, description: 'Bathroom tap dripping since two days' });
  const ticket = await json(r);
  check('resident raises a complaint', r.status === 201 && ticket.ticket_no, JSON.stringify(ticket));
  check('ticket number is AREA/YEAR/NNNNN',
    /^[A-Z]{3}\/\d{4}\/\d{5}$/.test(ticket.ticket_no || ''), ticket.ticket_no);

  r = await call(resident.token, '/tickets', 'POST', { sub_category_id: leak.id });
  check('duplicate open complaint refused with the existing one', r.status === 409);

  r = await call(resident.token, '/tickets', 'POST',
    { sub_category_id: whitewash.id, is_emergency: true });
  check('whitewash cannot be reported as an emergency', r.status === 422);

  r = await call(resident.token, '/tickets', 'POST', { sub_category_id: elec.id });
  check('electrical complaint is redirected to E&M', r.status === 422);

  r = await call(resident.token, '/tickets', 'POST',
    { sub_category_id: nowater.id, is_emergency: true });
  const emergency = await json(r);
  check('eligible sub-category accepts the emergency flag', r.status === 201);

  /* ---------------- visibility ---------------- */
  let list = await json(await call(family.token, '/tickets'));
  check('family device sees the same premises complaint',
    list.items.some((t) => t.ticket_no === ticket.ticket_no));

  list = await json(await call(nigahiRes.token, '/tickets'));
  check('a Nigahi resident cannot see a Jayant complaint',
    !list.items.some((t) => t.ticket_no === ticket.ticket_no));

  list = await json(await call(nigahiOvr.token, '/tickets'));
  check('the Nigahi Overseer cannot see Jayant complaints',
    !list.items.some((t) => t.ticket_no === ticket.ticket_no));

  r = await call(nigahiOvr.token, `/tickets/${ticket.id}`);
  check('an out-of-area ticket is indistinguishable from absent (404)', r.status === 404);

  /* ---------------- lifecycle, with the wrong actor tried first ---------------- */
  r = await call(resident.token, `/tickets/${ticket.id}/verify`, 'POST');
  check('resident cannot verify their own complaint', r.status === 403);

  r = await call(contractor.token, `/tickets/${ticket.id}/verify`, 'POST');
  check('contractor cannot verify a complaint', r.status === 403);

  r = await call(overseer.token, `/tickets/${ticket.id}/verify`, 'POST');
  const verified = await json(r);
  check('Overseer verifies', r.status === 200 && verified.state === 'VERIFIED',
    JSON.stringify(verified).slice(0, 160));
  check('SLA snapshot taken at verification', !!verified.completion_deadline_at);
  check('original deadline recorded alongside', !!verified.original_completion_deadline_at);

  r = await call(overseer.token, `/tickets/${ticket.id}/assign`, 'POST',
    { supervisor_id: devices['CONTRACTOR_SUPERVISOR:M/s Verma — Supr'].actor_id });
  // decision 2026-09-30: the Overseer allots on site as well as the Incharge
  check('the Overseer may allot the job to the contractor on site', r.status === 200,
    `${r.status} ${JSON.stringify(await json(r))}`);

  const assignable = await json(await call(incharge.token, '/devices/assignable'));
  check('assignable contractors are listed with workload',
    assignable.length > 0 && 'open_jobs' in assignable[0]);

  r = await call(incharge.token, `/tickets/${ticket.id}/assign`, 'POST',
    { supervisor_id: assignable[0].actor_id });
  check('Incharge assigns to the contractor', r.status === 200, JSON.stringify(await json(r)));

  r = await call(contractor.token, `/tickets/${ticket.id}/start`, 'POST', {});
  check('contractor must name the workmen to start', r.status === 422);

  r = await call(contractor.token, `/tickets/${ticket.id}/start`, 'POST',
    { workmen_assigned: 'Ram Prasad (plumber), Sunil Kumar (helper)' });
  check('contractor starts work with workmen named', r.status === 200);

  /* ---------------- objection during work ---------------- */
  r = await call(family.token, `/tickets/${ticket.id}/objections`, 'POST',
    { note: 'Old washer refitted instead of replaced' });
  check('family member objects while work is under way', r.status === 201);

  const detailForContractor = await json(await call(contractor.token, `/tickets/${ticket.id}`));
  check('contractor sees the ticket but not the objection text',
    !JSON.stringify(detailForContractor.objections || []).includes('Old washer'),
    JSON.stringify(detailForContractor.objections));

  /* ---------------- completion and the two-key rule ---------------- */
  r = await call(contractor.token, `/tickets/${ticket.id}/complete`, 'POST');
  check('completion refused without a photograph', r.status === 422);

  await uploadCompletion(BASE, contractor.token, ticket.id);
  r = await call(contractor.token, `/tickets/${ticket.id}/complete`, 'POST');
  check('contractor claims completion with a photograph', r.status === 200);

  r = await call(contractor.token, `/tickets/${ticket.id}/inspect`, 'POST', { accepted: true });
  check('contractor cannot inspect their own work', r.status === 403 || r.status === 422);

  r = await call(contractor.token, `/tickets/${ticket.id}/close`, 'POST');
  check('contractor cannot close their own work', r.status === 403);

  r = await call(overseer.token, `/tickets/${ticket.id}/inspect`, 'POST', { accepted: true });
  check('inspection refused without a geo-tagged in-app photograph', r.status === 422);

  await uploadInspection(BASE, overseer.token, ticket.id);
  r = await call(overseer.token, `/tickets/${ticket.id}/inspect`, 'POST', { accepted: true });
  const inspected = await json(r);
  check('Overseer inspects and accepts', r.status === 200 &&
    inspected.state === 'INSPECTED_ACCEPTED', JSON.stringify(inspected).slice(0, 160));

  r = await call(overseer.token, `/tickets/${ticket.id}/close`, 'POST');
  check('Overseer closes the ticket', r.status === 200);

  r = await call(resident.token, `/tickets/${ticket.id}/reopen`, 'POST',
    { reason: 'Still dripping this morning' });
  check('resident reopens the original ticket', r.status === 200);
  const reopened = await json(await call(resident.token, `/tickets/${ticket.id}`));
  check('reopen increments the count on the same ticket',
    reopened.reopened_count === 1 && reopened.ticket_no === ticket.ticket_no);

  /* ---------------- inspection queue ordering ---------------- */
  // put the emergency through to WORK_COMPLETED so the queue has two entries
  await call(overseer.token, `/tickets/${emergency.id}/verify`, 'POST');
  await call(incharge.token, `/tickets/${emergency.id}/assign`, 'POST',
    { supervisor_id: assignable[0].actor_id });
  await call(contractor.token, `/tickets/${emergency.id}/start`, 'POST',
    { workmen_assigned: 'Ram Prasad' });
  await uploadCompletion(BASE, contractor.token, emergency.id);
  await call(contractor.token, `/tickets/${emergency.id}/complete`, 'POST');

  const queue = await json(await call(overseer.token, '/inspections/queue'));
  check('inspection queue reports backlog age', 'oldest_pending_hours' in queue);
  check('emergency sits at the top of the queue',
    queue.items[0]?.is_emergency === true, JSON.stringify(queue.items.map(i => i.ticket_no)));

  r = await call(contractor.token, `/tickets/${emergency.id}/inspection-priority`, 'PUT',
    { priority: 1 });
  check('contractor cannot set inspection priority', r.status === 403);

  r = await call(incharge.token, `/tickets/${emergency.id}/inspection-priority`, 'PUT',
    { priority: 1, note: 'Dispensary affected' });
  check('Incharge sets inspection priority', r.status === 200);

  /* ---------------- GM is read-only ---------------- */
  list = await json(await call(gm.token, '/tickets'));
  check('GM sees tickets across areas', list.items.length >= 2);
  r = await call(gm.token, `/tickets/${emergency.id}/inspection-priority`, 'PUT', { priority: 3 });
  check('GM cannot write, and is told so rather than silently ignored', r.status === 403);

  /* ---------------- dashboards ---------------- */
  const dash = await json(await call(incharge.token, '/dashboard'));
  check('Incharge dashboard returns counts', typeof dash.to_assign === 'number');
  const sodash = await json(await call(staffoff.token, '/dashboard'));
  check('Staff Officer dashboard returns counts', typeof sodash.overdue === 'number');

  /* ---------------- report ---------------- */
  console.log('');
  for (const [s, n, d] of results) {
    console.log(`  ${s === 'PASS' ? ' ok ' : 'FAIL'}  ${n}${d ? '\n         ' + d.slice(0, 200) : ''}`);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
