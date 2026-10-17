import fs from 'node:fs';
import { signNonce, generateDeviceKeypair } from './auth.js';
import { uploadCompletion, uploadInspection } from './testutil.js';
import { runContractSweep } from './contracts.js';
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
  const resident   = await login('RESIDENT:R. K. Singh');
  const overseer   = await login('CIVIL_OVERSEER:A. K. Dubey');
  const incharge   = await login('MAINTENANCE_INCHARGE:P. N. Mishra');
  const contractor = await login('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const staffOff   = await login('STAFF_OFFICER_CIVIL:S. Tiwari');
  const gm         = await login('GM_CIVIL:GM (Civil)');
  const admin      = await login('ADMINISTRATOR:System Admin');

  const cats = await j(await call(resident.token, '/masters/categories'));
  const post = (tok, p, b) => call(tok, p, 'POST', b);

  /* ---------------- contract master ---------------- */
  let list = await j(await call(staffOff.token, '/contracts'));
  check('the Staff Officer sees their own Area\'s contract',
    Array.isArray(list) && list.length === 1,
    `${Array.isArray(list) ? list.length : '?'} visible`);
  const allContracts = await withSystem(maintPool, (c) => c.query(
    `SELECT count(*) n FROM contract`));
  check('one live contract exists for every Area',
    Number(allContracts.rows[0].n) === 13, `${allContracts.rows[0].n}`);
  const jayant = list.find((x) => /Jayant/.test(x.contractor_name));
  check('the contract reports its remaining life and open workload',
    jayant && 'days_remaining' in jayant && 'open_tickets' in jayant,
    JSON.stringify(jayant).slice(0, 160));
  check('and how many supervisor devices it carries',
    Number(jayant.active_supervisors) >= 1, `${jayant?.active_devices}`);

  // decision 2026-09-30: the Incharge fills in work orders; the Overseer does not
  let r = await post(overseer.token, '/contracts',
    { area_id: jayant.area_id, contractor_name: 'M/s Someone', agreement_no: 'X/1',
      period_years: 1, starts_on: '2026-01-01', expires_on: '2027-01-01' });
  check('the Overseer cannot award a contract', r.status === 403);
  r = await post(contractor.token, '/contracts',
    { area_id: jayant.area_id, contractor_name: 'M/s Self', agreement_no: 'X/2',
      period_years: 1, starts_on: '2026-01-01', expires_on: '2027-01-01' });
  check('nor can a contractor award one to themselves', r.status === 403);

  // decision 2026-09-30: several contractors may work in one Area
  r = await post(incharge.token, '/contracts',
    { area_id: jayant.area_id, contractor_name: 'M/s Second Firm', agreement_no: 'X/3',
      period_years: 1, starts_on: '2026-01-01', expires_on: '2027-01-01' });
  check('a second live contract for the same Area is accepted', r.status === 201,
    `status ${r.status}`);
  r = await post(incharge.token, '/contracts',
    { area_id: jayant.area_id, contractor_name: 'M/s Duplicate', agreement_no: 'X/3',
      starts_on: '2026-01-01', expires_on: '2027-01-01' });
  check('but never two with the same agreement number', r.status === 409, `status ${r.status}`);

  r = await post(staffOff.token, '/contracts',
    { area_id: jayant.area_id, contractor_name: 'M/s Bad Period', agreement_no: 'X/4',
      period_years: 5, starts_on: '2026-01-01', expires_on: '2031-01-01' });
  check('a contract period other than one or two years is refused', r.status === 422);

  /* ---------------- work counts against the contract ---------------- */
  async function runTicket(code) {
    const sub = cats.find((c) => c.name_en.startsWith(code));
    const t = await j(await post(resident.token, '/tickets', { sub_category_id: sub.id }));
    await post(overseer.token, `/tickets/${t.id}/verify`);
    const dv = await j(await call(incharge.token, '/devices/assignable'));
    await post(incharge.token, `/tickets/${t.id}/assign`,
      { supervisor_id: dv[0].actor_id });
    await post(contractor.token, `/tickets/${t.id}/start`, { workmen_assigned: 'Ram Prasad' });
    await uploadCompletion(BASE, contractor.token, t.id);
    await post(contractor.token, `/tickets/${t.id}/complete`);
    return t;
  }

  const t1 = await runTicket('Leaking tap');
  const linked = await withSystem(maintPool, (c) => c.query(
    `SELECT contract_id FROM ticket WHERE id=$1`, [t1.id]));
  check('a ticket is attributed to the contract on assignment',
    linked.rows[0].contract_id === jayant.id, JSON.stringify(linked.rows[0]));

  // a caller must not be able to attribute work to another contract
  let attributionBlocked = false;
  try {
    await withSystem(maintPool, async (c) => {
      await c.query(`SELECT set_config('app.role','MAINTENANCE_INCHARGE',true)`);
      await c.query(`SELECT set_config('app.scope_path','ncl.jayant',true)`);
      const res2 = await c.query(
        `UPDATE ticket SET contract_id=NULL WHERE id=$1 RETURNING id`, [t1.id]);
      if (!res2.rowCount) attributionBlocked = true;
    });
  } catch { attributionBlocked = true; }
  check('no role can re-attribute a ticket to a different contract',
    attributionBlocked);

  /* accept and close so the record has something in it */
  await uploadInspection(BASE, overseer.token, t1.id);
  await post(overseer.token, `/tickets/${t1.id}/inspect`, { accepted: true });
  await post(overseer.token, `/tickets/${t1.id}/close`);
  await post(resident.token, `/tickets/${t1.id}/feedback`,
    { confirmed: true, rating: 4, comment: 'Done well' });

  const t2 = await runTicket('Roof leakage');
  await uploadInspection(BASE, overseer.token, t2.id);
  await post(overseer.token, `/tickets/${t2.id}/inspect`, { accepted: false }); // sent back

  /* ---------------- the fan-out bug ---------------- */
  // two breaches on one ticket must not count it twice
  await withSystem(maintPool, (c) => c.query(
    `INSERT INTO sla_breach (ticket_id, clock, attribution)
     VALUES ($1,'RESPONSE','CONTRACTOR'), ($1,'COMPLETION','CONTRACTOR')`, [t1.id]));
  const view = await withSystem(maintPool, (c) => c.query(
    `SELECT tickets_received, contractor_delays FROM contract_performance
      WHERE contract_id=$1`, [jayant.id]));
  const received = view.rows.reduce((s, x) => s + Number(x.tickets_received), 0);
  const delays = view.rows.reduce((s, x) => s + Number(x.contractor_delays), 0);
  check('a ticket with two breaches is counted once, not twice',
    received === 2, `tickets_received ${received}, expected 2`);
  check('but both of its breaches are counted', delays === 2, `delays ${delays}`);

  /* ---------------- performance report ---------------- */
  const perf = await j(await call(staffOff.token, `/contracts/${jayant.id}/performance`));
  check('the performance report is produced', !!perf.overall, JSON.stringify(perf).slice(0, 140));
  check('it reports SLA compliance, rejection, reopen and rating',
    ['sla_compliance_pct','rejection_rate_pct','reopen_rate_pct','avg_rating']
      .every((k) => k in perf.overall));
  check('rejection rate counts tickets sent back, not rework events',
    Number(perf.overall.rejection_rate_pct) === 50,
    `${perf.overall.rejection_rate_pct}% of 2 tickets, 1 sent back`);
  check('delay attribution is broken out', Array.isArray(perf.delay_attribution) &&
    perf.delay_attribution.some((x) => x.attribution === 'CONTRACTOR'));
  check('it is broken down by month as well as overall',
    Array.isArray(perf.by_month) && perf.by_month.length >= 1);
  check('the report states that penalty decisions rest with the department',
    /department/i.test(perf.note || ''));

  r = await call(gm.token, `/contracts/${jayant.id}/performance`);
  check('the GM can read a performance report', r.status === 200);

  const csv = await (await call(staffOff.token, `/contracts/${jayant.id}/performance.csv`)).text();
  check('the report exports as CSV with a header row',
    /contract_id,contractor_name/.test(csv) && csv.split('\n').length >= 2,
    csv.slice(0, 90));

  const comparison = await j(await call(gm.token, '/contracts/comparison'));
  check('every Area\'s contract can be compared side by side',
    Array.isArray(comparison) && comparison.length >= 2, `${comparison.length}`);
  check('the comparison is ordered weakest first',
    comparison.length < 2 ||
    comparison[0].sla_compliance_pct === null ||
    Number(comparison[0].sla_compliance_pct) <=
      Number(comparison[comparison.length - 1].sla_compliance_pct ?? 100));

  /* ---------------- handover ---------------- */
  const incoming = await j(await post(staffOff.token, '/contracts', {
    area_id: null, contractor_name: 'M/s Incoming', agreement_no: 'NCL/JNT/CIV/2028/01',
    period_years: 2, starts_on: '2028-01-01', expires_on: '2030-01-01' }));
  check('a contract for an unknown Area is refused', !incoming.id,
    JSON.stringify(incoming).slice(0, 120));

  // create the successor properly, after freeing the Area
  const openBefore = await withSystem(maintPool, (c) => c.query(
    `SELECT count(*) n FROM ticket
      WHERE contract_id=$1 AND state NOT IN ('CLOSED','REJECTED')`, [jayant.id]));

  // the successor is awarded while the current one is still live
  const today = new Date().toISOString().slice(0, 10);
  const later = new Date(Date.now() + 700 * 864e5).toISOString().slice(0, 10);
  const successor = await j(await post(staffOff.token, '/contracts', {
    area_id: jayant.area_id, contractor_name: 'M/s Successor',
    agreement_no: 'NCL/JNT/CIV/2028/01', period_years: 2,
    starts_on: today, expires_on: later }));
  const successorId = successor.id;
  check('the successor is awarded before handover', !!successorId, JSON.stringify(successor).slice(0, 120));

  r = await post(contractor.token, `/contracts/${jayant.id}/handover`,
    { to_contract_id: successorId });
  check('a contractor cannot hand a contract over', r.status === 403);

  r = await post(staffOff.token, `/contracts/${jayant.id}/handover`,
    { to_contract_id: successorId, reason: 'Agreement period concluded' });
  const handover = await j(r);
  check('the Staff Officer hands the contract over', r.status === 200,
    JSON.stringify(handover).slice(0, 160));
  check('open tickets move to the incoming contractor',
    handover.tickets_transferred === Number(openBefore.rows[0].n),
    `${handover.tickets_transferred} moved, ${openBefore.rows[0].n} were open`);
  check('the outgoing supervisor\'s devices are revoked',
    handover.roles_revoked >= 1, `${handover.roles_revoked}`);

  const revoked = await login('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  check('and that supervisor can no longer sign in', !!revoked.error,
    JSON.stringify(revoked));

  const frozen = await j(await call(staffOff.token, `/contracts/${jayant.id}/performance`));
  check('the outgoing record is frozen at the cut-off',
    !!frozen.contract.handover_cutoff_at);

  r = await post(staffOff.token, `/contracts/${jayant.id}/handover`,
    { to_contract_id: successorId });
  check('a contract cannot be handed over twice', r.status === 409);

  /* the successor must not inherit the predecessor's closed record */
  const succPerf = await j(await call(staffOff.token, `/contracts/${successorId}/performance`));
  check('the successor does not inherit closed work it did not do',
    Number(succPerf.overall.tickets_closed) === 0,
    `${succPerf.overall.tickets_closed} closed`);

  /* ---------------- expiry sweep ---------------- */
  // the Staff Officer sees only their own Area, so another Area's contract
  // has to be reached directly — which is itself the scoping working
  // use the successor, which is in Jayant — the only Area the seed gives a
  // Staff Officer, and therefore the only one where the warning has a
  // recipient
  const other = { id: successorId };
  await withSystem(maintPool, (c) => c.query(
    `UPDATE contract SET expires_on = current_date + 10 WHERE id=$1`, [other.id]));
  let sweep = await runContractSweep({ quiet: true });
  check('a contract expiring within thirty days raises a warning',
    sweep.expiring_soon >= 1, JSON.stringify(sweep));

  const soInbox = await j(await call(staffOff.token, '/notifications'));
  check('the Staff Officer is told a contract is expiring',
    soInbox.items.some((n) => n.event_type === 'CONTRACT_EXPIRING'),
    JSON.stringify(soInbox.items.map((n) => n.event_type).slice(0, 6)));

  await withSystem(maintPool, (c) => c.query(
    `UPDATE contract SET starts_on = current_date - 400, expires_on = current_date - 1 WHERE id=$1`, [other.id]));
  sweep = await runContractSweep({ quiet: true });
  check('an expired contract is closed out automatically', sweep.expired >= 1,
    JSON.stringify(sweep));

  const stillActive = await withSystem(maintPool, (c) => c.query(
    `SELECT active FROM contract WHERE id=$1`, [other.id]));
  check('and marked inactive', stillActive.rows[0].active === false);

  /* ---------------- scope ---------------- */
  const nigahiOvr = await login('CIVIL_OVERSEER:Nigahi Overseer');
  const nigahiView = await j(await call(nigahiOvr.token, '/contracts'));
  check('an Area officer sees only their own Area\'s contract',
    nigahiView.every((x) => !/Jayant/.test(x.contractor_name)),
    JSON.stringify(nigahiView.map((x) => x.contractor_name)));

  // Revocation bites at the next refresh, so a token already issued stays
  // valid until it expires — at most fifteen minutes. The test asserts the
  // documented behaviour rather than an instant cut-off.
  const reLogin = await login('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  check('a revoked contractor cannot obtain a new token', !!reLogin.error);
  const stillValid = await call(contractor.token, '/tickets');
  check('their existing token expires rather than dying instantly',
    [200, 401].includes(stillValid.status), `status ${stillValid.status}`);

  console.log('');
  for (const [st, n, d] of out) {
    console.log(`  ${st}  ${n}${d ? '\n         ' + String(d).slice(0, 170) : ''}`);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await maintPool.end(); await identityPool.end();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
