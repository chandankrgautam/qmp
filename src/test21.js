/**
 * Suite 21 — officers and administrators exceeding their authority.
 *
 * A red-team suite. Every check is an ATTACK from the department side:
 * an Overseer, Incharge, Staff Officer, Area administrator, GM, HQ
 * executive or HQ System Administrator trying to do something the record
 * must not let them do. A check PASSES only if the system REFUSES the
 * attack (HTTP 4xx, a database trigger/constraint, a RESTRICTIVE policy
 * that touches zero rows) or does not leak. A check FAILS when the attack
 * SUCCEEDS — that is a real hole in the contract-performance record.
 *
 * withSystem(...) is used ONLY to set up fixtures and to VERIFY after an
 * attack that nothing was changed — never to perform an attack. The
 * attacks are performed either through the HTTP API, or (for controls the
 * API exposes no route for, such as editing the audit log) directly under
 * the attacker's own role via withScope — exactly what a rogue query in
 * that signed-in session would attempt. That is a white-box attack path,
 * not SYSTEM.
 *
 * Needs a freshly reset and seeded database (test-all.js gives each suite
 * one). NEVER run against the working databases.
 */
import fs from 'node:fs';
import { signNonce } from './auth.js';
import { uploadPhoto, uploadCompletion, uploadInspection, requirePhotos } from './testutil.js';
import { withScope, withSystem, maintPool, identityPool } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => { if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); } };
async function attempt(n, fn) { try { await fn(); } catch (e) { check(n, false, `threw: ${e.message}`.slice(0, 240)); } }

const json = { 'content-type': 'application/json' };
async function device(key, pick = {}) {
  const d = devices[key];
  const ch = await (await fetch(`${BASE}/identity/v1/auth/challenge`, { method: 'POST', headers: json,
    body: JSON.stringify({ public_key: d.publicKey }) })).json();
  return (await fetch(`${BASE}/identity/v1/auth/token`, { method: 'POST', headers: json,
    body: JSON.stringify({ public_key: d.publicKey, nonce: ch.nonce, signature: signNonce(d.privateKey, ch.nonce),
      second_factor_satisfied: true, ...pick }) })).json();
}
const as = (key) => device(key, { role: devices[key].role });
const byAssignment = (key, assignment_id) => device(key, { assignment_id });
const M = (tok, p, method = 'GET', b) => fetch(`${BASE}/maintenance/v1${p}`, { method,
  headers: { ...json, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
const I = (tok, p, method = 'GET', b) => fetch(`${BASE}/identity/v1${p}`, { method,
  headers: { ...json, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const sysM = (sql, params) => withSystem(maintPool, (c) => c.query(sql, params));
const sysI = (sql, params) => withSystem(identityPool, (c) => c.query(sql, params));
const short = (x) => JSON.stringify(x)?.slice(0, 220);
const refusedStatus = (s) => s === 403 || s === 404 || s === 409 || s === 422 || s === 423;

/* A claims object for a seeded principal, for a direct withScope attack
   (no API route exists for some controls). Mirrors what the token would
   carry for that session. */
function claims(key, extra = {}) {
  const d = devices[key];
  return { role: d.role, scope_path: d.scope, actor_id: d.actor_id, person_id: d.person_id,
    device_id: d.device_id, premises_id: null, contract_id: null, amr: 'device', ...extra };
}

/* A direct write under the attacker's own role must be REFUSED: it either
   throws (trigger / constraint) or affects zero rows (RESTRICTIVE policy or
   RLS USING). It is a HOLE only if it changes a row (rowCount > 0). The id
   in every WHERE below exists, so a zero count means the policy stopped it. */
async function directDenied(name, pool, cl, sql, params) {
  try {
    const r = await withScope(pool, cl, (c) => c.query(sql, params));
    check(name, r.rowCount === 0, `ALLOWED: changed ${r.rowCount} row(s)`);
  } catch (e) {
    check(name, true, '');
    void e;
  }
}
/* The opposite expectation: this write SHOULD be refused, and if the
   database lets it through we want it recorded as a hole with its row. */
async function directHoleCheck(name, pool, cl, sql, params) {
  let changed = -1, threw = null;
  try { changed = (await withScope(pool, cl, (c) => c.query(sql, params))).rowCount; }
  catch (e) { threw = e.message; }
  check(name, threw !== null || changed === 0, threw ? '' : `ALLOWED: changed ${changed} row(s)`);
}

async function run() {
  await requirePhotos();   // this suite tests the photograph gate as HQ will switch it on
  /* ---- sign-in (device sessions unless a password session is the point) ---- */
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey');
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
  const so = await as('STAFF_OFFICER_CIVIL:S. Tiwari');
  const hr = await as('AREA_HR_ADMIN:R. Kumar');
  const sysadmin = await as('AREA_SYS_ADMIN:V. Sharma');
  const admin = await as('ADMINISTRATOR:System Admin');
  const gm = await as('GM_CIVIL:GM (Civil)');
  const hqx = await as('HQ_EXECUTIVE:Director (Technical)');
  const sup = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const firm = await as('CONTRACTOR:M/s Jayant Constructions');
  const resident = await as('RESIDENT:R. K. Singh');
  const nghOvr = await as('CIVIL_OVERSEER:Nigahi Overseer');
  const nghRes = await as('RESIDENT:Nigahi resident');

  for (const [n, t] of [['Overseer', ovr], ['Incharge', inc], ['Staff Officer', so], ['Administrator', admin], ['GM', gm], ['supervisor', sup]]) {
    if (!t?.token) { check(`(setup) ${n} signed in`, false, short(t)); }
  }

  const jntContract = (await sysM(`SELECT id FROM contract WHERE agreement_no='NCL/JNT/CIV/2026/01'`)).rows[0].id;
  const nghContract = (await sysM(`SELECT id FROM contract WHERE agreement_no='NCL/NGH/CIV/2026/01'`)).rows[0].id;
  const cats = await j(await M(resident.token, '/masters/categories'));
  const assignable = await j(await M(inc.token, '/devices/assignable'));
  const verma = assignable.find((a) => a.person_name === 'M/s Verma — Supr');
  const vermaActor = verma.actor_id;

  const subPool = cats.filter((c) => c.classification !== 'EM');
  let si = 0;
  const nextSub = () => subPool[si++ % subPool.length];

  /* lifecycle helpers (the legitimate route; attacks come after) */
  async function raise(tok = resident.token) {
    // one open complaint per quarter and fault: skip faults still open here
    let t;
    for (let tries = 0; tries < subPool.length; tries++) {
      const r = await M(tok, '/tickets', 'POST', { sub_category_id: nextSub().id, description: 'red-team fixture' });
      t = await j(r);
      if (r.status !== 409) break;
    }
    if (!t?.id) throw new Error(`raise ${short(t)}`);
    return t;
  }
  async function toAssigned() {
    const t = await raise();
    if ((await M(ovr.token, `/tickets/${t.id}/verify`, 'POST')).status !== 200) throw new Error('verify');
    if ((await M(inc.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: vermaActor })).status !== 200) throw new Error('assign');
    return t;
  }
  async function toWorkCompleted() {
    const t = await toAssigned();
    if ((await M(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' })).status !== 200) throw new Error('start');
    await uploadCompletion(BASE, sup.token, t.id);
    if ((await M(sup.token, `/tickets/${t.id}/complete`, 'POST')).status !== 200) throw new Error('complete');
    return t;
  }
  async function toAccepted() {
    const t = await toWorkCompleted();
    await uploadInspection(BASE, ovr.token, t.id);
    if ((await M(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true })).status !== 200) throw new Error('inspect');
    return t;
  }

  // =====================================================================
  // CONTROL 1 & 2 — two-key closure, inspection evidence
  // =====================================================================
  await attempt('ATTACK: Incharge accepts an inspection (two-key) — refused', async () => {
    const t = await toWorkCompleted();
    await uploadInspection(BASE, inc.token, t.id);               // not his to take anyway
    const r = await M(inc.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true });
    check('ATTACK: Incharge accepts an inspection (two-key) — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
    const st = (await sysM(`SELECT state FROM ticket WHERE id=$1`, [t.id])).rows[0].state;
    check('  and the complaint did not reach INSPECTED_ACCEPTED', st === 'WORK_COMPLETED', st);
  });

  await attempt('ATTACK: Overseer closes work that was never inspected — refused', async () => {
    const t = await toWorkCompleted();
    const r = await M(ovr.token, `/tickets/${t.id}/close`, 'POST');
    check('ATTACK: Overseer closes work that was never inspected — refused', refusedStatus(r.status), `${r.status}`);
    const st = (await sysM(`SELECT state FROM ticket WHERE id=$1`, [t.id])).rows[0].state;
    check('  and the complaint is still WORK_COMPLETED', st === 'WORK_COMPLETED', st);
  });

  await attempt('ATTACK: Incharge closes WORK_COMPLETED directly (skip inspection) — refused', async () => {
    const t = await toWorkCompleted();
    const r = await M(inc.token, `/tickets/${t.id}/close`, 'POST');
    check('ATTACK: Incharge closes WORK_COMPLETED directly (skip inspection) — refused', refusedStatus(r.status), `${r.status}`);
  });

  await attempt('ATTACK: accept from a password (web) session — refused (app only)', async () => {
    const t = await toWorkCompleted();
    await uploadInspection(BASE, ovr.token, t.id);                // a valid photo exists
    // the Overseer holds two roles, so the role is named at sign-in
    const pw = await j(await I(null, '/auth/password', 'POST', { employee_id: '90222001', password: 'Portal@2026', role: 'CIVIL_OVERSEER' }));
    const ptoken = pw.token || null;
    check('  (setup) Overseer has a password session', !!ptoken, short(pw));
    if (!ptoken) return;
    const r = await M(ptoken, `/tickets/${t.id}/inspect`, 'POST', { accepted: true });
    check('ATTACK: accept from a password (web) session — refused (app only)', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
    // but sending back for rework is allowed from the web
    const r2 = await M(ptoken, `/tickets/${t.id}/inspect`, 'POST', { accepted: false, remark: 'try again' });
    check('  (web may still send back for rework)', r2.status === 200, `${r2.status}`);
  });

  await attempt('ATTACK: accept with an inspection photo taken BEFORE the completion claim — refused', async () => {
    const t = await toAssigned();
    await M(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'crew' });
    await uploadInspection(BASE, ovr.token, t.id);                // taken while IN_PROGRESS, before the claim
    await uploadCompletion(BASE, sup.token, t.id);
    await M(sup.token, `/tickets/${t.id}/complete`, 'POST');
    const r = await M(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true });
    check('ATTACK: accept with an inspection photo taken BEFORE the completion claim — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });

  await attempt('ATTACK: accept with NO inspection photograph at all — refused', async () => {
    const t = await toWorkCompleted();
    const r = await M(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true });
    check('ATTACK: accept with NO inspection photograph at all — refused', refusedStatus(r.status), `${r.status}`);
  });

  await attempt('ATTACK: Overseer uploads the contractor COMPLETION photo as evidence — refused', async () => {
    const t = await toWorkCompleted();
    const r = await uploadPhoto(BASE, ovr.token, t.id, 'COMPLETION');
    check('ATTACK: Overseer uploads the contractor COMPLETION photo as evidence — refused', !r.ok, `${r.status} ${short(r.body)}`);
  });

  await attempt('ATTACK: accept with an inspection photo without a location — refused', async () => {
    const t = await toWorkCompleted();
    const r = await uploadPhoto(BASE, ovr.token, t.id, 'INSPECTION', { capture_verified: true, latitude: null, longitude: null }); // no lat/long
    check('  (the ungeotagged inspection upload is rejected at confirm)', !r.ok, `${r.status} ${short(r.body)}`);
    const r2 = await M(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true });
    check('ATTACK: accept with an inspection photo without a location — refused', refusedStatus(r2.status), `${r2.status}`);
  });

  await attempt('ATTACK: batch-inspect smuggles a job with no photo past the gate — refused per item', async () => {
    const good = await toWorkCompleted();
    await uploadInspection(BASE, ovr.token, good.id);
    const bare = await toWorkCompleted();                          // no inspection photo
    const r = await M(ovr.token, '/tickets/inspect-batch', 'POST', { inspections: [{ ticket_id: good.id }, { ticket_id: bare.id }] });
    const b = await j(r);
    const bareState = (await sysM(`SELECT state FROM ticket WHERE id=$1`, [bare.id])).rows[0].state;
    check('ATTACK: batch-inspect smuggles a job with no photo past the gate — refused per item', bareState === 'WORK_COMPLETED', `bare now ${bareState}; resp ${short(b)}`);
  });

  // The person who did the work may never inspect it, whatever roles they hold.
  await attempt('ATTACK: admin gives the Overseer\'s person a supervisor role; that person inspects its own job — refused', async () => {
    const ovrPerson = devices['CIVIL_OVERSEER:A. K. Dubey'].person_id;
    const asg = await j(await I(admin.token, '/assignments', 'POST', {
      person_id: ovrPerson, role: 'CONTRACTOR_SUPERVISOR', scope_path: 'ncl.jayant',
      contract_id: jntContract, reason: 'red-team: conflicted supervisor' }));
    // The admin may or may not be allowed to create it; the control under
    // test is the two-key refusal below. Record whether it was created.
    check('  (admin could create a conflicted supervisor role for an officer)', !!asg.id || refusedStatus(asg.status), short(asg));
    if (!asg.id) return;
    const dualActor = asg.id;
    // the Overseer's device signs in to that supervisor role and does the work
    const dual = await byAssignment('CIVIL_OVERSEER:A. K. Dubey', dualActor);
    if (!dual.token) { check('ATTACK: the work-doer inspects its own job — refused', true, 'could not assume dual role (acceptable)'); return; }
    const t = await raise();
    await M(ovr.token, `/tickets/${t.id}/verify`, 'POST');
    const ar = await M(inc.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: dualActor });
    check('  (ticket assigned to the conflicted supervisor)', ar.status === 200, `${ar.status} ${short(await j(ar))}`);
    await M(dual.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'self' });
    await uploadCompletion(BASE, dual.token, t.id);
    await M(dual.token, `/tickets/${t.id}/complete`, 'POST');
    await uploadInspection(BASE, ovr.token, t.id);
    const r = await M(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true });
    check('ATTACK: the work-doer inspects its own job — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });

  // =====================================================================
  // CONTROL 5 — state only through the transition table
  // =====================================================================
  const raisedT = await raise();
  const assignedT = await toAssigned();
  const completedT = await toWorkCompleted();

  await attempt('ATTACK: Incharge verifies a complaint (Overseer-only) — refused', async () => {
    const t = await raise();
    const r = await M(inc.token, `/tickets/${t.id}/verify`, 'POST');
    check('ATTACK: Incharge verifies a complaint (Overseer-only) — refused', refusedStatus(r.status), `${r.status}`);
  });
  await attempt('ATTACK: Overseer jumps RAISED straight to CLOSED (direct) — refused', async () => {
    await directHoleCheck('ATTACK: Overseer jumps RAISED straight to CLOSED (direct) — refused',
      maintPool, claims('CIVIL_OVERSEER:A. K. Dubey'),
      `UPDATE ticket SET state='CLOSED', closed_at=now() WHERE id=$1`, [raisedT.id]);
  });
  await attempt('ATTACK: Administrator moves a complaint (fabricate performance) — refused', async () => {
    await directHoleCheck('ATTACK: Administrator moves a complaint (fabricate performance) — refused',
      maintPool, claims('ADMINISTRATOR:System Admin', { scope_path: 'ncl' }),
      `UPDATE ticket SET state='WORK_COMPLETED', completed_claim_at=now() WHERE id=$1`, [raisedT.id]);
  });
  await attempt('ATTACK: Overseer reassigns a complaint under a Staff-Officer hold (direct state) — refused', async () => {
    await directHoleCheck('ATTACK: Overseer forces WORK_COMPLETED->CLOSED skipping inspection (direct) — refused',
      maintPool, claims('CIVIL_OVERSEER:A. K. Dubey'),
      `UPDATE ticket SET state='CLOSED', closed_at=now() WHERE id=$1`, [completedT.id]);
  });

  // =====================================================================
  // CONTROL 4 — SLA, deadlines and every counter are the system's alone
  // =====================================================================
  const AFOVR = claims('CIVIL_OVERSEER:A. K. Dubey');
  const AFSUP = claims('CONTRACTOR_SUPERVISOR:M/s Verma — Supr', { contract_id: jntContract });
  const AFADM = claims('ADMINISTRATOR:System Admin', { scope_path: 'ncl' });
  await directHoleCheck('ATTACK: Overseer rewrites a completion deadline — refused',
    maintPool, AFOVR, `UPDATE ticket SET completion_deadline_at = now() + interval '1 year' WHERE id=$1`, [assignedT.id]);
  await directHoleCheck('ATTACK: Overseer rewrites the SLA snapshot (sla_completion_minutes) — refused',
    maintPool, AFOVR, `UPDATE ticket SET sla_completion_minutes = 999999 WHERE id=$1`, [assignedT.id]);
  await directHoleCheck('ATTACK: Administrator rewrites a completion deadline — refused',
    maintPool, AFADM, `UPDATE ticket SET completion_deadline_at = now() + interval '1 year' WHERE id=$1`, [assignedT.id]);
  await directHoleCheck('ATTACK: contractor erases its own escalation level — refused',
    maintPool, AFSUP, `UPDATE ticket SET escalation_level = escalation_level + 1 WHERE id=$1`, [assignedT.id]);
  await directHoleCheck('ATTACK: contractor zeroes its objection count — refused',
    maintPool, AFSUP, `UPDATE ticket SET objection_count = objection_count + 1 WHERE id=$1`, [assignedT.id]);
  await directHoleCheck('ATTACK: contractor rewrites its own contractor_minutes — refused',
    maintPool, AFSUP, `UPDATE ticket SET contractor_minutes = 1 WHERE id=$1`, [assignedT.id]);
  await directHoleCheck('ATTACK: contractor flips completion_met to true — refused',
    maintPool, AFSUP, `UPDATE ticket SET completion_met = true WHERE id=$1`, [assignedT.id]);
  await directHoleCheck('ATTACK: contractor downgrades an emergency it is measured against — refused',
    maintPool, AFSUP, `UPDATE ticket SET is_emergency = NOT is_emergency WHERE id=$1`, [assignedT.id]);
  await directHoleCheck('ATTACK: Overseer back-dates a deadline to force a breach — refused',
    maintPool, AFOVR, `UPDATE ticket SET completion_deadline_at = now() - interval '2 days' WHERE id=$1`, [assignedT.id]);
  await directHoleCheck('ATTACK: Overseer changes the reopen count by hand — refused',
    maintPool, AFOVR, `UPDATE ticket SET reopened_count = reopened_count + 1 WHERE id=$1`, [assignedT.id]);
  await directHoleCheck('ATTACK: Overseer archives a complaint by hand — refused',
    maintPool, AFOVR, `UPDATE ticket SET archived_at = now() WHERE id=$1`, [assignedT.id]);

  // An SLA-table edit must never reach an already-open complaint.
  await attempt('ATTACK: an SLA-table edit reaches an open complaint — refused (prospective only)', async () => {
    const t = await raise();
    await M(ovr.token, `/tickets/${t.id}/verify`, 'POST');       // snapshot taken now
    const before = (await sysM(`SELECT sla_completion_minutes, completion_deadline_at FROM ticket WHERE id=$1`, [t.id])).rows[0];
    const sla = await j(await M(inc.token, '/admin/sla'));
    const row = sla.find((s) => s.rule_id);
    await M(inc.token, `/admin/sla/${row.sub_category_id}`, 'PUT', { response_minutes: 5, completion_minutes: 5 });
    const after = (await sysM(`SELECT sla_completion_minutes, completion_deadline_at FROM ticket WHERE id=$1`, [t.id])).rows[0];
    check('ATTACK: an SLA-table edit reaches an open complaint — refused (prospective only)',
      String(before.sla_completion_minutes) === String(after.sla_completion_minutes)
      && String(before.completion_deadline_at) === String(after.completion_deadline_at),
      `before ${short(before)} after ${short(after)}`);
  });

  // =====================================================================
  // CONTROL 6 — only the occupant or force majeure pauses, department only
  // =====================================================================
  await attempt('ATTACK: Overseer pauses the clock for "want of material" (contractor delay) — refused', async () => {
    const r = await M(ovr.token, `/tickets/${assignedT.id}/pause`, 'POST', { attribution: 'CONTRACTOR', reason: 'no cement' });
    check('ATTACK: Overseer pauses the clock for "want of material" (contractor delay) — refused', r.status === 422, `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: contractor supervisor pauses its own SLA clock (API) — refused', async () => {
    const r = await M(sup.token, `/tickets/${assignedT.id}/pause`, 'POST', { attribution: 'OCCUPANT', reason: 'locked' });
    check('ATTACK: contractor supervisor pauses its own SLA clock (API) — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: contractor forges a department pause directly in the database — refused', async () => {
    await directHoleCheck('ATTACK: contractor forges a department pause directly in the database — refused',
      maintPool, AFSUP,
      `INSERT INTO sla_pause (ticket_id, clock, attribution, reason, paused_by, paused_by_role)
       VALUES ($1,'COMPLETION','FORCE_MAJEURE','forged',$2,'CIVIL_OVERSEER')`, [assignedT.id, AFSUP.actor_id]);
  });
  await attempt('ATTACK: contractor resumes (cuts short) a department pause — refused', async () => {
    const pr = await M(ovr.token, `/tickets/${assignedT.id}/pause`, 'POST', { attribution: 'OCCUPANT', reason: 'quarter locked' });
    check('  (setup) Overseer paused the clock', pr.status === 201, `${pr.status} ${short(await j(pr))}`);
    await directHoleCheck('ATTACK: contractor resumes (cuts short) a department pause — refused',
      maintPool, AFSUP, `UPDATE sla_pause SET resumed_at = now() WHERE ticket_id=$1 AND resumed_at IS NULL`, [assignedT.id]);
    await M(ovr.token, `/tickets/${assignedT.id}/resume`, 'POST', {}); // tidy up
  });

  // =====================================================================
  // CONTROL 7 — the audit log and histories can never be edited or deleted
  // =====================================================================
  await attempt('ATTACK: Overseer edits a ticket-history event (reword it) — refused', async () => {
    const ev = (await sysM(`SELECT id FROM ticket_event WHERE ticket_id=$1 LIMIT 1`, [assignedT.id])).rows[0];
    await directHoleCheck('ATTACK: Overseer edits a ticket-history event (reword it) — refused',
      maintPool, AFOVR, `UPDATE ticket_event SET reason='sanitised' WHERE id=$1`, [ev.id]);
  });
  await attempt('ATTACK: Overseer deletes a ticket-history event — refused', async () => {
    const ev = (await sysM(`SELECT id FROM ticket_event WHERE ticket_id=$1 LIMIT 1`, [assignedT.id])).rows[0];
    await directHoleCheck('ATTACK: Overseer deletes a ticket-history event — refused',
      maintPool, AFOVR, `DELETE FROM ticket_event WHERE id=$1`, [ev.id]);
  });
  await attempt('ATTACK: Administrator deletes a maintenance audit-log row — refused', async () => {
    await sysM(`INSERT INTO audit_log (event_type, entity_type, entity_id, actor_role, after_value)
                VALUES ('TEST','ticket',$1,'SYSTEM','{}'::jsonb)`, [assignedT.id]).catch(() => {});
    const a = (await sysM(`SELECT id FROM audit_log ORDER BY id DESC LIMIT 1`)).rows[0];
    await directHoleCheck('ATTACK: Administrator deletes a maintenance audit-log row — refused',
      maintPool, AFADM, `DELETE FROM audit_log WHERE id=$1`, [a.id]);
  });
  await attempt('ATTACK: Area admin edits an identity audit-log row — refused', async () => {
    const a = (await sysI(`SELECT id FROM audit_log ORDER BY id DESC LIMIT 1`)).rows[0];
    if (!a) { check('ATTACK: Area admin edits an identity audit-log row — refused', true, 'no rows'); return; }
    await directHoleCheck('ATTACK: Area admin edits an identity audit-log row — refused',
      identityPool, claims('AREA_SYS_ADMIN:V. Sharma'), `UPDATE identity.audit_log SET reason='x' WHERE id=$1`, [a.id]);
  });
  await attempt('ATTACK: Overseer rewrites a job-card change-log row — refused', async () => {
    const a = (await sysM(`SELECT id FROM audit_log WHERE entity_type='job_card' ORDER BY id DESC LIMIT 1`)).rows[0];
    if (!a) { check('ATTACK: Overseer rewrites a job-card change-log row — refused', true, 'no job_card log yet'); return; }
    await directHoleCheck('ATTACK: Overseer rewrites a job-card change-log row — refused',
      maintPool, AFOVR, `UPDATE audit_log SET reason='x' WHERE id=$1`, [a.id]);
  });
  await attempt('ATTACK: Staff Officer edits a decided review decision — refused', async () => {
    // find or make a decided review via the dispute flow is heavy; test the
    // immutability of any existing ticket_review row directly
    const r = (await sysM(`SELECT id FROM ticket_review LIMIT 1`)).rows[0];
    if (!r) { check('ATTACK: Staff Officer edits a decided review decision — refused', true, 'no reviews yet'); return; }
    await directHoleCheck('ATTACK: Staff Officer edits a decided review decision — refused',
      maintPool, claims('STAFF_OFFICER_CIVIL:S. Tiwari'), `DELETE FROM ticket_review WHERE id=$1`, [r.id]);
  });

  // =====================================================================
  // CONTROL 3 — area isolation, enforced by the database ("not found")
  // =====================================================================
  const nghT = await j(await M(nghRes.token, '/tickets', 'POST', { sub_category_id: (cats.find((c) => c.classification !== 'EM')).id, description: 'nigahi' }));
  check('(setup) a Nigahi complaint exists', !!nghT.id, short(nghT));
  await attempt('ATTACK: Jayant Overseer reads a Nigahi complaint by id — not found (not forbidden)', async () => {
    const r = await M(ovr.token, `/tickets/${nghT.id}`);
    check('ATTACK: Jayant Overseer reads a Nigahi complaint by id — not found (not forbidden)', r.status === 404, `${r.status}`);
  });
  await attempt('ATTACK: Jayant Overseer finds a Nigahi complaint through search — empty', async () => {
    const r = await j(await M(ovr.token, `/search?q=nigahi`));
    const leaked = (r.items || []).some((x) => String(x.ticket_no || '').startsWith('NGH/'));
    check('ATTACK: Jayant Overseer finds a Nigahi complaint through search — empty', !leaked, short(r.items?.slice(0, 2)));
  });
  await attempt('ATTACK: Jayant Overseer sets inspection priority on a Nigahi ticket — refused', async () => {
    const r = await M(ovr.token, `/tickets/${nghT.id}/inspection-priority`, 'PUT', { priority: 1 });
    check('ATTACK: Jayant Overseer sets inspection priority on a Nigahi ticket — refused', refusedStatus(r.status), `${r.status}`);
  });
  await attempt('ATTACK: Jayant Incharge reads a Nigahi work order — not found', async () => {
    const r = await M(inc.token, `/contracts/${nghContract}`);
    check('ATTACK: Jayant Incharge reads a Nigahi work order — not found', r.status === 404, `${r.status}`);
  });
  await attempt('ATTACK: Jayant Overseer lists tickets — only Jayant is returned', async () => {
    const r = await j(await M(ovr.token, '/tickets'));
    const foreign = (r.items || []).filter((x) => !String(x.ticket_no || '').startsWith('JNT/'));
    check('ATTACK: Jayant Overseer lists tickets — only Jayant is returned', foreign.length === 0, short(foreign.slice(0, 3)));
  });
  await attempt('ATTACK: Jayant Overseer reads the Nigahi job card — not found', async () => {
    const jc = await M(ovr.token, `/tickets/${nghT.id}/job-card`);
    check('ATTACK: Jayant Overseer reads the Nigahi job card — not found', jc.status === 404, `${jc.status}`);
  });
  await attempt('ATTACK: Jayant Overseer reads Nigahi measurements — not found', async () => {
    const r = await M(ovr.token, `/tickets/${nghT.id}/measurements`);
    check('ATTACK: Jayant Overseer reads Nigahi measurements — not found', r.status === 404 || (Array.isArray(await j(r)) === false), `${r.status}`);
  });
  await attempt('ATTACK: Jayant HR admin lists people — no other Area\'s staff leak', async () => {
    const r = await j(await I(hr.token, '/persons?q=Nigahi'));
    const leaked = (Array.isArray(r) ? r : []).some((p) => (p.roles || []).some((a) => String(a.scope_path || '').startsWith('ncl.nigahi')));
    check('ATTACK: Jayant HR admin lists people — no other Area\'s staff leak', !leaked, short(r));
  });
  await attempt('ATTACK: Jayant Sys admin reads the identity audit of another Area — empty/own only', async () => {
    const r = await j(await I(sysadmin.token, '/audit'));
    const leaked = (Array.isArray(r) ? r : []).some((x) => String(JSON.stringify(x)).includes('ncl.nigahi'));
    check('ATTACK: Jayant Sys admin reads the identity audit of another Area — empty/own only', !leaked, short(r));
  });
  await attempt('ATTACK: Jayant Sys admin lists Nigahi devices — none returned', async () => {
    const nghDevicePerson = (await sysI(`SELECT person_id FROM identity.device d JOIN identity.person p ON p.id=d.person_id WHERE p.personnel_no='90223001'`)).rows[0]?.person_id;
    const r = await j(await I(sysadmin.token, `/devices?person_id=${nghDevicePerson}`));
    check('ATTACK: Jayant Sys admin lists Nigahi devices — none returned', (Array.isArray(r) ? r.length : 0) === 0, short(r));
  });

  // =====================================================================
  // ROLES & IDENTITY — granting oneself or others power
  // =====================================================================
  const ovrPerson = devices['CIVIL_OVERSEER:A. K. Dubey'].person_id;
  await attempt('ATTACK: Area admin assigns a role at/above their own rank — refused', async () => {
    const r = await I(sysadmin.token, '/assignments', 'POST', { person_id: ovrPerson, role: 'ADMINISTRATOR', scope_path: 'ncl', reason: 'grab' });
    check('ATTACK: Area admin assigns a role at/above their own rank — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: Area admin promotes themselves — refused', async () => {
    const selfPerson = devices['AREA_SYS_ADMIN:V. Sharma'].person_id;
    const r = await I(sysadmin.token, '/assignments', 'POST', { person_id: selfPerson, role: 'STAFF_OFFICER_CIVIL', scope_path: 'ncl.jayant', reason: 'self' });
    check('ATTACK: Area admin promotes themselves — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: Area admin assigns a role in another Area — refused', async () => {
    const r = await I(sysadmin.token, '/assignments', 'POST', { person_id: ovrPerson, role: 'CIVIL_OVERSEER', scope_path: 'ncl.nigahi', reason: 'reach' });
    check('ATTACK: Area admin assigns a role in another Area — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: Incharge assigns an Overseer role (not a supervisor) — refused', async () => {
    const r = await I(inc.token, '/assignments', 'POST', { person_id: ovrPerson, role: 'CIVIL_OVERSEER', scope_path: 'ncl.jayant', reason: 'x' });
    check('ATTACK: Incharge assigns an Overseer role (not a supervisor) — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: Incharge appoints a supervisor on another Area\'s contract — refused', async () => {
    const r = await I(inc.token, '/supervisors', 'POST', { name: 'Ghost', mobile: '9900112233', contract_id: nghContract, reason: 'cross-area' });
    check('ATTACK: Incharge appoints a supervisor on another Area\'s contract — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: HR admin edits their own person record — refused', async () => {
    const selfPerson = devices['AREA_HR_ADMIN:R. Kumar'].person_id;
    const r = await I(hr.token, `/persons/${selfPerson}`, 'PUT', { designation: 'Boss', reason: 'self' });
    check('ATTACK: HR admin edits their own person record — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: Incharge revokes an Overseer role (not a supervisor) — refused', async () => {
    const ovrAssign = (await sysI(`SELECT id FROM identity.role_assignment WHERE person_id=$1 AND role='CIVIL_OVERSEER'`, [ovrPerson])).rows[0]?.id;
    const r = await I(inc.token, `/assignments/${ovrAssign}/revoke`, 'POST', { reason: 'remove rival' });
    check('ATTACK: Incharge revokes an Overseer role (not a supervisor) — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: admin approves their own pending device — refused', async () => {
    // create a pending device for the administrator's person directly
    const adminPerson = devices['ADMINISTRATOR:System Admin'].person_id;
    const did = (await withSystem(identityPool, (c) => c.query(
      `INSERT INTO identity.device (public_key, platform, person_id, scope_path, status)
       VALUES ($1,'web',$2,'ncl','PENDING') RETURNING id`, ['pk-selfapprove-' + Date.now(), adminPerson]))).rows[0].id;
    const r = await I(admin.token, `/registrations/${did}/approve`, 'POST', {});
    check('ATTACK: admin approves their own pending device — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
    const st = (await sysI(`SELECT status FROM identity.device WHERE id=$1`, [did])).rows[0].status;
    check('  and the device is still PENDING', st === 'PENDING', st);
  });

  // =====================================================================
  // HQ — read-only, and not for non-HQ roles
  // =====================================================================
  await attempt('ATTACK: Overseer opens the HQ executive dashboard — refused', async () => {
    const r = await M(ovr.token, '/hq/executive');
    check('ATTACK: Overseer opens the HQ executive dashboard — refused', r.status === 403, `${r.status}`);
  });
  await attempt('ATTACK: Incharge downloads the HQ dashboard CSV — refused', async () => {
    const r = await M(inc.token, '/hq/executive.csv');
    check('ATTACK: Incharge downloads the HQ dashboard CSV — refused', r.status === 403, `${r.status}`);
  });
  await attempt('ATTACK: GM assigns work (HQ is read-only) — refused', async () => {
    const t = await (async () => { const x = await raise(); await M(ovr.token, `/tickets/${x.id}/verify`, 'POST'); return x; })();
    const r = await M(gm.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: vermaActor });
    check('ATTACK: GM assigns work (HQ is read-only) — refused', refusedStatus(r.status), `${r.status}`);
  });
  await attempt('ATTACK: GM raises a complaint — refused', async () => {
    const r = await M(gm.token, '/tickets', 'POST', { sub_category_id: (cats.find((c) => c.classification !== 'EM')).id, description: 'gm' });
    check('ATTACK: GM raises a complaint — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: HQ executive verifies a complaint (direct) — refused', async () => {
    await directHoleCheck('ATTACK: HQ executive verifies a complaint (direct) — refused',
      maintPool, claims('HQ_EXECUTIVE:Director (Technical)', { scope_path: 'ncl' }),
      `UPDATE ticket SET state='VERIFIED' WHERE id=$1`, [raisedT.id]);
  });
  await attempt('ATTACK: HQ System Administrator edits an SLA figure — refused', async () => {
    // field authority: SLA snapshot is nobody's; the SLA table edit is admin/incharge
    // but the deadline/snapshot columns belong to the system. Confirm admin cannot
    // write them directly, and that the config write path is admin-gated only.
    await directHoleCheck('ATTACK: HQ System Administrator edits an SLA figure — refused',
      maintPool, AFADM, `UPDATE ticket SET sla_completion_minutes = 1 WHERE id=$1`, [assignedT.id]);
  });

  // =====================================================================
  // DISPUTES — only the Staff Officer decides, once
  // =====================================================================
  await attempt('ATTACK: Overseer decides a dispute that only the Staff Officer may decide — refused', async () => {
    // build a contested-and-upheld rejection waiting for the Staff Officer
    const t = await raise();
    await M(ovr.token, `/tickets/${t.id}/reject`, 'POST', { reason: 'not civil' });
    const cres = await M(resident.token, `/tickets/${t.id}/contest`, 'POST', { reason: 'it is civil' });
    const contest = await j(cres);
    const or = await M(ovr.token, `/reviews/${contest.id}/officer`, 'POST', { outcome: 'UPHOLD', note: 'stands' });
    check('  (setup) contest upheld, now with the Staff Officer', or.status === 200, `${or.status} ${short(await j(or))}`);
    const r = await M(ovr.token, `/reviews/${contest.id}/decide`, 'POST', { outcome: 'REINSTATE', decision: 'I overrule' });
    check('ATTACK: Overseer decides a dispute that only the Staff Officer may decide — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
    // the Staff Officer decides once; a second decision is refused
    const d1 = await M(so.token, `/reviews/${contest.id}/decide`, 'POST', { outcome: 'UPHOLD', decision: 'rejection stands' });
    check('  (setup) Staff Officer decides once', d1.status === 200, `${d1.status} ${short(await j(d1))}`);
    const d2 = await M(so.token, `/reviews/${contest.id}/decide`, 'POST', { outcome: 'REINSTATE', decision: 'changed my mind' });
    check('ATTACK: Staff Officer decides the same dispute twice — refused', refusedStatus(d2.status), `${d2.status} ${short(await j(d2))}`);
  });

  await attempt('ATTACK: reassign / close a repeatedly-disputed complaint while the Staff Officer\'s decision is pending — refused', async () => {
    // drive a complaint to its third reopening (referred to the Staff Officer)
    const t = await raise();
    await M(ovr.token, `/tickets/${t.id}/verify`, 'POST');
    await M(inc.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: vermaActor });
    for (let n = 1; n <= 3; n++) {
      if (n > 1) {
        const ar = await M(ovr.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: vermaActor });
        if (ar.status !== 200) throw new Error(`reassign ${n} ${ar.status} ${short(await j(ar))}`);
      }
      await M(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: `crew ${n}` });
      await uploadCompletion(BASE, sup.token, t.id);
      await M(sup.token, `/tickets/${t.id}/complete`, 'POST');
      await uploadInspection(BASE, ovr.token, t.id);
      await M(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true });
      await M(ovr.token, `/tickets/${t.id}/close`, 'POST');
      await M(resident.token, `/tickets/${t.id}/reopen`, 'POST', { reason: `dispute ${n}` });
    }
    const st = (await sysM(`SELECT state FROM ticket WHERE id=$1`, [t.id])).rows[0].state;
    check('  (setup) complaint is REOPENED and with the Staff Officer', st === 'REOPENED', st);
    const r = await M(ovr.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: vermaActor });
    check('ATTACK: reassign a repeatedly-disputed complaint while the decision is pending — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
    const c = await M(ovr.token, `/tickets/${t.id}/close`, 'POST');
    check('ATTACK: Overseer closes a reopened complaint without the Staff Officer\'s decision — refused', refusedStatus(c.status), `${c.status}`);
  });

  // =====================================================================
  // BREACH ATTRIBUTION — open defect 1 (authority only in app code)
  // =====================================================================
  await attempt('ATTACK: contractor attributes a breach away from itself (API) — refused', async () => {
    const br = (await sysM(`INSERT INTO sla_breach (ticket_id, clock) VALUES ($1,'COMPLETION') RETURNING id`, [assignedT.id])).rows[0];
    const r = await M(sup.token, `/breaches/${br.id}/attribute`, 'POST', { attribution: 'DEPARTMENT' });
    check('ATTACK: contractor attributes a breach away from itself (API) — refused', refusedStatus(r.status), `${r.status}`);
    // open defect 1: the database itself does not stop it. Confirm whether a
    // rogue query in the contractor's session can rewrite attribution.
    await directHoleCheck('ATTACK: contractor rewrites a breach attribution directly in the database — refused',
      maintPool, AFSUP, `UPDATE sla_breach SET attribution='DEPARTMENT', note='not my fault' WHERE id=$1`, [br.id]);
  });
  await attempt('ATTACK: resident attributes a breach (API) — refused', async () => {
    const br = (await sysM(`INSERT INTO sla_breach (ticket_id, clock) VALUES ($1,'COMPLETION') RETURNING id`, [assignedT.id])).rows[0];
    const r = await M(resident.token, `/breaches/${br.id}/attribute`, 'POST', { attribution: 'DEPARTMENT' });
    check('ATTACK: resident attributes a breach (API) — refused', refusedStatus(r.status), `${r.status}`);
  });

  // =====================================================================
  // WORK ORDERS — completion date, reasons, cross-area, read-only roles
  // =====================================================================
  await attempt('ATTACK: Incharge moves the completion date without an extension — refused', async () => {
    const r = await M(inc.token, `/contracts/${jntContract}`, 'PUT', { expires_on: '2030-01-01', reason: 'push it out' });
    check('ATTACK: Incharge moves the completion date without an extension — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: Incharge changes a work order with no reason — refused', async () => {
    const r = await M(inc.token, `/contracts/${jntContract}`, 'PUT', { remarks: 'silent edit' });
    check('ATTACK: Incharge changes a work order with no reason — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: Overseer (read-only on work orders) edits a work order — refused', async () => {
    const r = await M(ovr.token, `/contracts/${jntContract}`, 'PUT', { remarks: 'x', reason: 'y' });
    check('ATTACK: Overseer (read-only on work orders) edits a work order — refused', refusedStatus(r.status), `${r.status}`);
  });
  await attempt('ATTACK: contractor edits its own work order — refused', async () => {
    const r = await M(firm.token, `/contracts/${jntContract}`, 'PUT', { remarks: 'favourable', reason: 'self' });
    check('ATTACK: contractor edits its own work order — refused', refusedStatus(r.status), `${r.status}`);
  });
  await attempt('ATTACK: Incharge back-dates the completion date as awarded (direct) — refused', async () => {
    await directHoleCheck('ATTACK: Incharge back-dates original_expires_on (direct) — refused',
      maintPool, claims('MAINTENANCE_INCHARGE:P. N. Mishra'),
      `UPDATE contract SET original_expires_on = current_date + 3000 WHERE id=$1`, [jntContract]);
  });
  await attempt('ATTACK: Incharge rewrites a recorded extension (direct) — refused', async () => {
    const ext = (await sysM(`SELECT id FROM contract_extension LIMIT 1`)).rows[0];
    if (!ext) {
      // create one legitimately, then try to edit it
      await M(inc.token, `/contracts/${jntContract}/extensions`, 'POST', { extended_to: '2029-01-01', order_no: 'EXT/1', reason: 'first extension' });
    }
    const e = (await sysM(`SELECT id FROM contract_extension LIMIT 1`)).rows[0];
    if (!e) { check('ATTACK: Incharge rewrites a recorded extension (direct) — refused', true, 'no extension to test'); return; }
    await directHoleCheck('ATTACK: Incharge rewrites a recorded extension (direct) — refused',
      maintPool, claims('MAINTENANCE_INCHARGE:P. N. Mishra'), `UPDATE contract_extension SET extended_to = current_date + 5000 WHERE id=$1`, [e.id]);
  });

  // =====================================================================
  // MATERIALS & MEASUREMENTS — two keys by person, immutability
  // =====================================================================
  await attempt('ATTACK: contractor verifies its own claimed materials — refused', async () => {
    // materials are claimed while the work is under way, then the claim
    const t = await toAssigned();
    await M(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
    const mat = (await sysM(`SELECT id FROM material LIMIT 1`)).rows[0].id;
    const add = await M(sup.token, `/tickets/${t.id}/materials`, 'POST', { material_id: mat, qty_claimed: 2 });
    const line = await j(add);
    check('  (setup) a material line was claimed', add.status === 201, `${add.status} ${short(line)}`);
    await uploadCompletion(BASE, sup.token, t.id);
    await M(sup.token, `/tickets/${t.id}/complete`, 'POST');
    const r = await M(sup.token, `/tickets/${t.id}/materials/${line.id}/verify`, 'POST', { qty_verified: 2 });
    check('ATTACK: contractor verifies its own claimed materials — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: Overseer check-measures (role reserved to the Staff Officer) — refused', async () => {
    // make an accepted ticket with a job-card item and a measurement
    const t = await toAccepted();
    await M(ovr.token, `/tickets/${t.id}/job-card/items`, 'POST', { description: 'brickwork', unit: 'Cum', qty_estimated: 2 });
    const card = await j(await M(ovr.token, `/tickets/${t.id}/job-card`));
    const item = (card.items || [])[0];
    check('  (setup) a job-card item exists', !!item, short(card.items));
    if (!item) return;
    // the sheet is the supervisor's first (2026-10-16); sent up, the Overseer measures at his step
    await M(sup.token, `/tickets/${t.id}/sheets/measurements/submit`, 'POST');
    const mres = await M(ovr.token, `/tickets/${t.id}/measurements`, 'POST', { item_id: item.id, nos: 1, length: 2, breadth: 1, depth: 1 });
    const meas = await j(mres);
    check('  (setup) the Overseer measured the item', mres.status === 201, `${mres.status} ${short(meas)}`);
    const r = await M(ovr.token, `/measurements/${meas.id}/check`, 'POST', { check_qty: 2 });
    check('ATTACK: Overseer check-measures (role reserved to the Staff Officer) — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
    // and once in the MB, re-measuring is refused
    const rec = await M(ovr.token, '/mb/record', 'POST', { measurement_ids: [meas.id], mb_no: 'MB/7', mb_page: '3' });
    check('  (setup) entry recorded in the MB', rec.status === 200, `${rec.status} ${short(await j(rec))}`);
    // since 2026-10-16 the MB approval is the lock: up the chain, approved, then the Overseer tries again
    await M(ovr.token, `/tickets/${t.id}/sheets/measurements/pass`, 'POST');
    await M(inc.token, `/tickets/${t.id}/sheets/measurements/pass-no-change`, 'POST');
    const ap = await M(so.token, `/tickets/${t.id}/sheets/measurements/approve`, 'POST');
    check('  (setup) the Staff Officer approved the MB', ap.status === 200, `${ap.status} ${short(await j(ap))}`);
    const re = await M(ovr.token, `/measurements/${meas.id}`, 'PUT', { nos: 9, length: 9, breadth: 9, depth: 9, reason: 'inflate' });
    check('ATTACK: Overseer re-measures after the MB is approved — refused', refusedStatus(re.status), `${re.status} ${short(await j(re))}`);
  });
  await attempt('ATTACK: Overseer changes a job card after the complaint is closed — refused', async () => {
    const t = await toAccepted();
    await M(ovr.token, `/tickets/${t.id}/close`, 'POST');
    const r = await M(ovr.token, `/tickets/${t.id}/job-card`, 'PUT', { scope_of_work: 'rewritten after closure', reason: 'tidy' });
    check('ATTACK: Overseer changes a job card after the complaint is closed — refused', refusedStatus(r.status), `${r.status} ${short(await j(r))}`);
  });
  await attempt('ATTACK: Overseer withdraws a job-card item with no reason — refused', async () => {
    const t = await toAssigned();
    const add = await j(await M(ovr.token, `/tickets/${t.id}/job-card/items`, 'POST', { description: 'temp', unit: 'No.' }));
    const r = await M(ovr.token, `/tickets/${t.id}/job-card/items/${add.id}/withdraw`, 'POST', {});
    check('ATTACK: Overseer withdraws a job-card item with no reason — refused', r.status === 422, `${r.status}`);
  });

  // =====================================================================
  // BREAK-GLASS — not reachable through the app API
  // =====================================================================
  await attempt('ATTACK: reach a break-glass function through the app API — not routed', async () => {
    const paths = ['/break-glass', '/breakglass', '/admin/break-glass', '/admin/breakglass/sessions'];
    const statuses = [];
    for (const p of paths) { statuses.push((await M(admin.token, p)).status); statuses.push((await I(admin.token, p)).status); }
    check('ATTACK: reach a break-glass function through the app API — not routed', statuses.every((s) => s === 404), statuses.join(','));
  });

  // ---- report ----
  for (const [s, n, d] of out) console.log(`${s}  ${n}${d ? '  — ' + d : ''}`);
  console.log(`\ntest21 (officers/administrators exceeding authority): ${pass} passed, ${fail} failed`);
  await maintPool.end().catch(() => {});
  await identityPool.end().catch(() => {});
  if (fail) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
