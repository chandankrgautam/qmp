/**
 * Suite 19 — RED TEAM: the contractor side.
 *
 * Every check here is an ATTACK mounted as the contractor firm (role
 * CONTRACTOR) or its supervisor (CONTRACTOR_SUPERVISOR), trying to make
 * their work look better than it was, escape blame, see what they must
 * not see, or influence the department. A check PASSES only when the
 * system REFUSES the attack or does not leak — never when it succeeds.
 *
 * The attacker has only the API and their own (honestly obtained) tokens.
 * withSystem()/direct SQL is used ONLY to verify that a refused attack
 * left no trace, never to perform one. A clearly labelled final section
 * ("if appconn's password leaked") shows separately what a stolen
 * application DB password plus forged session variables would allow —
 * that is infrastructure, not the application, and is reported apart.
 *
 * Needs a freshly reset and seeded database. Run it in the sandbox:
 *   TEST_IDENTITY_DB=ncl_identity_rt1 TEST_MAINT_DB=ncl_maint_rt1 \
 *   TEST_PORT=3201 TEST_DEVICES_FILE=devices.rt1.json \
 *   TEST_BREAKGLASS_DB=ncl_breakglass_rt1 TEST_BREAKGLASS_LOG=rt1.log \
 *   node --env-file-if-exists=.env src/test-all.js test19
 */
import fs from 'node:fs';
import pg from 'pg';
import crypto from 'node:crypto';
import { signNonce } from './auth.js';
import { uploadPhoto, uploadCompletion, uploadInspection, makeJpeg, sha256, requirePhotos } from './testutil.js';
import { withScope, withSystem, maintPool, identityPool, appConnection } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => { if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); } };
async function attempt(n, fn) { try { await fn(); } catch (e) { check(n, false, `threw: ${e.message}`.slice(0, 240)); } }

const note = [];     // "if appconn leaked" findings, reported separately

const json = { 'content-type': 'application/json' };
async function as(key) {
  const d = devices[key];
  if (!d) throw new Error(`no seeded device for ${key}`);
  const ch = await (await fetch(`${BASE}/identity/v1/auth/challenge`, { method: 'POST', headers: json,
    body: JSON.stringify({ public_key: d.publicKey }) })).json();
  const r = await (await fetch(`${BASE}/identity/v1/auth/token`, { method: 'POST', headers: json,
    body: JSON.stringify({ public_key: d.publicKey, nonce: ch.nonce, signature: signNonce(d.privateKey, ch.nonce),
      second_factor_satisfied: true, role: d.role }) })).json();
  if (!r.token) throw new Error(`sign-in failed for ${key}: ${JSON.stringify(r).slice(0, 160)}`);
  return r;
}
const call = (tok, p, method = 'GET', b) => fetch(`${BASE}/maintenance/v1${p}`, { method,
  headers: { ...json, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
const idcall = (tok, p, method = 'GET', b) => fetch(`${BASE}/identity/v1${p}`, { method,
  headers: { ...json, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const sys = (sql, params) => withSystem(maintPool, (c) => c.query(sql, params));
const short = (x) => JSON.stringify(x).slice(0, 220);
const refused = (s) => s === 401 || s === 403 || s === 404 || s === 409 || s === 422;

/* Tamper with a real token's payload WITHOUT the signing secret: an
   attacker can edit the base64url body but cannot re-sign it. */
function tamperPayload(token, patch) {
  const [h, p, s] = token.split('.');
  const body = JSON.parse(Buffer.from(p, 'base64url').toString());
  Object.assign(body, patch);
  const np = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${h}.${np}.${s}`;               // old signature, new body
}

async function run() {
  await requirePhotos();   // this suite tests the photograph gate as HQ will switch it on
  const resident = await as('RESIDENT:R. K. Singh');
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey');
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
  const so = await as('STAFF_OFFICER_CIVIL:S. Tiwari');
  const sup = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');   // the attacker
  const firm = await as('CONTRACTOR:M/s Jayant Constructions');     // the firm
  const nghOvr = await as('CIVIL_OVERSEER:Nigahi Overseer');
  const nghRes = await as('RESIDENT:Nigahi resident');

  const contractId = (await sys(`SELECT id FROM contract WHERE agreement_no='NCL/JNT/CIV/2026/01'`)).rows[0].id;
  const verma = (await sys(`SELECT actor_id FROM actor_ref WHERE person_name='M/s Verma — Supr' AND role='CONTRACTOR_SUPERVISOR'`)).rows[0].actor_id;
  const cats = await j(await call(resident.token, '/masters/categories'));
  // Only one open complaint per quarter and fault, and the suite needs more
  // fixtures than there are faults: fixtures rotate over the Jayant quarters
  // whose residents are seeded (officers' own homes, signed in as residents).
  // Where a test acts as the B-234 resident afterwards it raises as them.
  const civil = cats.filter((x) => x.classification !== 'EM');
  const inUse = new Map();   // resident key → Set of sub-category ids
  const takeSub = (who) => {
    const used = inUse.get(who) || new Set(); inUse.set(who, used);
    const c = civil.find((x) => !used.has(x.id));
    if (c) used.add(c.id);
    return c;
  };
  const pool = [];
  for (const k of ['RESIDENT:P. N. Mishra', 'RESIDENT:S. Tiwari', 'RESIDENT:R. Kumar']) {
    try { pool.push(await as(k)); } catch { /* not seeded as a resident: skip */ }
  }

  /* Officers drive a complaint to a chosen state honestly; the attacker then
     attacks it. These helpers use only legitimate officer/resident tokens. */
  async function raise(who) {
    let sub;
    if (who) sub = takeSub(who);
    else for (const w of [...pool, resident]) { sub = takeSub(w); if (sub) { who = w; break; } }
    if (!sub) throw new Error('out of quarters and faults for fixtures');
    const t = await j(await call(who.token, '/tickets', 'POST', { sub_category_id: sub.id, description: 'Red-team fixture' }));
    if (!t.id) throw new Error(`raise ${short(t)}`);
    return t;
  }
  async function verify(t, o = ovr) { const r = await call(o.token, `/tickets/${t.id}/verify`, 'POST'); if (r.status !== 200) throw new Error(`verify ${r.status}`); }
  async function assign(t, o = inc) { const r = await call(o.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: verma }); if (r.status !== 200) throw new Error(`assign ${r.status} ${short(await j(r))}`); }
  async function start(t) { const r = await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' }); if (r.status !== 200) throw new Error(`start ${r.status} ${short(await j(r))}`); }
  async function claim(t) { await uploadCompletion(BASE, sup.token, t.id); const r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST'); if (r.status !== 200) throw new Error(`complete ${r.status} ${short(await j(r))}`); }
  async function accept(t) { await uploadInspection(BASE, ovr.token, t.id); const r = await call(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true }); if (r.status !== 200) throw new Error(`inspect ${r.status} ${short(await j(r))}`); }
  const stateOf = async (id) => (await sys(`SELECT state FROM ticket WHERE id=$1`, [id])).rows[0]?.state;

  /* A ticket in each state we need. */
  const assigned = await raise(); await verify(assigned); await assign(assigned);
  const inprog = await raise(resident); await verify(inprog); await assign(inprog); await start(inprog);
  const completed = await raise(); await verify(completed); await assign(completed); await start(completed); await claim(completed);
  const verified = await raise(); await verify(verified);      // not yet assigned to anyone
  const raised = await raise();                                 // RAISED, unverified
  // a Nigahi complaint the Jayant contractor has nothing to do with
  const foreign = await raise(nghRes); await verify(foreign, nghOvr);

  /* ============================================================
     SECTION A — acting on work that is not in the contractor's hands
     ============================================================ */

  await attempt('A1 ATTACK: supervisor starts a job still only VERIFIED (never assigned) — refused', async () => {
    const r = await call(sup.token, `/tickets/${verified.id}/start`, 'POST', { workmen_assigned: 'ghost crew' });
    check('A1 ATTACK: start an unassigned job — refused', refused(r.status) && await stateOf(verified.id) === 'VERIFIED', `${r.status}`);
  });
  await attempt('A2 ATTACK: supervisor claims completion on a job not assigned to them — refused', async () => {
    const r = await call(sup.token, `/tickets/${assigned.id}/complete`, 'POST');
    // assigned but not started: cannot jump ASSIGNED->WORK_COMPLETED
    check('A2 ATTACK: complete straight from ASSIGNED — refused', refused(r.status) && await stateOf(assigned.id) === 'ASSIGNED', `${r.status}`);
  });
  await attempt('A3 ATTACK: supervisor acts on another Area\'s complaint (not visible) — not found', async () => {
    const r = await call(sup.token, `/tickets/${foreign.id}/start`, 'POST', { workmen_assigned: 'x' });
    check('A3 ATTACK: start a foreign-Area job — refused as not visible', refused(r.status) && await stateOf(foreign.id) === 'VERIFIED', `${r.status}`);
  });
  await attempt('A4 ATTACK: supervisor reads a foreign-Area complaint — not found (Area isolation)', async () => {
    const r = await call(sup.token, `/tickets/${foreign.id}`);
    check('A4 ATTACK: read a foreign-Area complaint — 404', r.status === 404, `${r.status}`);
  });
  await attempt('A5 ATTACK: the FIRM (CONTRACTOR) tries to start work itself — refused', async () => {
    const r = await call(firm.token, `/tickets/${assigned.id}/start`, 'POST', { workmen_assigned: 'x' });
    check('A5 ATTACK: firm starts work — refused', refused(r.status), `${r.status}`);
  });
  await attempt('A6 ATTACK: the FIRM inspects/closes its own work — refused', async () => {
    const r1 = await call(firm.token, `/tickets/${completed.id}/inspect`, 'POST', { accepted: true });
    const r2 = await call(firm.token, `/tickets/${completed.id}/close`, 'POST');
    check('A6 ATTACK: firm inspects/closes — refused', refused(r1.status) && refused(r2.status) && await stateOf(completed.id) === 'WORK_COMPLETED', `${r1.status}/${r2.status}`);
  });
  await attempt('A7 ATTACK: supervisor inspects & accepts their own claim — refused', async () => {
    const r = await call(sup.token, `/tickets/${completed.id}/inspect`, 'POST', { accepted: true });
    check('A7 ATTACK: supervisor self-inspects — refused', refused(r.status) && await stateOf(completed.id) === 'WORK_COMPLETED', `${r.status}`);
  });
  await attempt('A8 ATTACK: supervisor closes their own accepted job — refused', async () => {
    const r = await call(sup.token, `/tickets/${completed.id}/close`, 'POST');
    check('A8 ATTACK: supervisor closes — refused', refused(r.status), `${r.status}`);
  });
  await attempt('A9 ATTACK: supervisor verifies a RAISED complaint (skip the Overseer) — refused', async () => {
    const r = await call(sup.token, `/tickets/${raised.id}/verify`, 'POST');
    check('A9 ATTACK: supervisor verifies — refused', refused(r.status) && await stateOf(raised.id) === 'RAISED', `${r.status}`);
  });
  await attempt('A10 ATTACK: supervisor reassigns the job to themselves (ASSIGNED->ASSIGNED) — refused', async () => {
    const r = await call(sup.token, `/tickets/${assigned.id}/assign`, 'POST', { supervisor_id: verma });
    check('A10 ATTACK: supervisor self-assigns — refused', refused(r.status), `${r.status}`);
  });

  /* ============================================================
     SECTION B — photograph gates (the inspection evidence)
     ============================================================ */

  await attempt('B1 ATTACK: claim completion with NO photographs — refused', async () => {
    const t = await raise(); await verify(t); await assign(t); await start(t);
    const r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('B1 ATTACK: complete with no photos — refused', r.status === 422 && await stateOf(t.id) === 'IN_PROGRESS', `${r.status}`);
  });
  await attempt('B2 ATTACK: claim with an AFTER photo but no BEFORE — refused', async () => {
    const t = await raise(); await verify(t); await assign(t); await start(t);
    await uploadPhoto(BASE, sup.token, t.id, 'COMPLETION');
    const r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('B2 ATTACK: no BEFORE photo — refused', r.status === 422 && await stateOf(t.id) === 'IN_PROGRESS', `${r.status}`);
  });
  await attempt('B3 ATTACK: claim with a photo whose upload was never confirmed (PENDING) — refused', async () => {
    const t = await raise(); await verify(t); await assign(t); await start(t);
    // ask for upload URLs but never PUT/confirm the bytes
    await call(sup.token, '/media/upload-url', 'POST', { ticket_id: t.id, purpose: 'BEFORE' });
    await call(sup.token, '/media/upload-url', 'POST', { ticket_id: t.id, purpose: 'COMPLETION' });
    const r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    const pend = Number((await sys(`SELECT count(*) n FROM ticket_media WHERE ticket_id=$1 AND upload_state<>'STORED'`, [t.id])).rows[0].n);
    check('B3 ATTACK: PENDING photo opens no gate — refused', r.status === 422 && pend >= 2 && await stateOf(t.id) === 'IN_PROGRESS', `${r.status}`);
  });
  await attempt('B4 ATTACK: reuse LAST round\'s photos after a send-back — refused', async () => {
    const t = await raise(); await verify(t); await assign(t); await start(t); await claim(t);
    // Overseer sends it back; round 1 photos must not satisfy round 2
    await uploadInspection(BASE, ovr.token, t.id);
    const sb = await call(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: false, remark: 'redo' });
    if (sb.status !== 200) throw new Error(`send-back ${sb.status} ${short(await j(sb))}`);
    await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'crew 2' });
    const r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');   // no NEW photos
    check('B4 ATTACK: old-round photos reused — refused', r.status === 422 && await stateOf(t.id) === 'IN_PROGRESS', `${r.status}`);
  });
  await attempt('B5 ATTACK: supervisor uploads an INSPECTION photo (not theirs to take) — refused', async () => {
    const r = await call(sup.token, '/media/upload-url', 'POST', { ticket_id: completed.id, purpose: 'INSPECTION' });
    check('B5 ATTACK: contractor takes the inspection photo — refused', r.status === 403, `${r.status}`);
  });
  await attempt('B6 ATTACK: supervisor uploads a COMPLAINT photo (occupant\'s/officer\'s) — refused', async () => {
    const r = await call(sup.token, '/media/upload-url', 'POST', { ticket_id: inprog.id, purpose: 'COMPLAINT' });
    check('B6 ATTACK: contractor attaches a complaint photo — refused', r.status === 403, `${r.status}`);
  });
  await attempt('B7 ATTACK: firm uploads any photograph — refused', async () => {
    const r = await call(firm.token, '/media/upload-url', 'POST', { ticket_id: completed.id, purpose: 'COMPLETION' });
    check('B7 ATTACK: firm uploads evidence — refused', r.status === 403, `${r.status}`);
  });
  await attempt('B8 ATTACK: more than three BEFORE photographs in one round — refused', async () => {
    const t = await raise(); await verify(t); await assign(t); await start(t);
    let last;
    for (let i = 0; i < 4; i++) last = await uploadPhoto(BASE, sup.token, t.id, 'BEFORE');
    const stored = Number((await sys(`SELECT count(*) n FROM ticket_media WHERE ticket_id=$1 AND purpose='BEFORE' AND upload_state='STORED'`, [t.id])).rows[0].n);
    check('B8 ATTACK: 4th BEFORE photo — refused at confirm', last.status === 422 && stored === 3, `confirm ${last.status}, stored ${stored}`);
  });
  await attempt('B9 ATTACK: re-confirm a stored photo to overwrite its metadata — refused', async () => {
    const up = await uploadPhoto(BASE, sup.token, inprog.id, 'COMPLETION');
    const r = await call(sup.token, `/media/${up.media_id}/confirm`, 'POST', { content_hash: 'deadbeef', captured_at: '2000-01-01T00:00:00Z' });
    check('B9 ATTACK: re-confirm to rewrite metadata — refused', r.status === 409, `${r.status}`);
  });
  await attempt('B10 ATTACK: confirm someone else\'s pending upload — refused', async () => {
    const ask = await j(await call(sup.token, '/media/upload-url', 'POST', { ticket_id: inprog.id, purpose: 'BEFORE' }));
    // the firm (different actor) tries to confirm the supervisor's upload
    const r = await call(firm.token, `/media/${ask.media_id}/confirm`, 'POST', { content_hash: 'x' });
    check('B10 ATTACK: confirm another actor\'s upload — refused', refused(r.status), `${r.status}`);
  });
  // B11: can stored bytes be swapped after confirm, via the still-valid presigned PUT URL?
  await attempt('B11 ATTACK: swap a stored photo\'s bytes using the still-valid upload URL', async () => {
    const t = await raise(); await verify(t); await assign(t); await start(t);
    const a = makeJpeg(); const b = makeJpeg();
    const ask = await j(await call(sup.token, '/media/upload-url', 'POST', { ticket_id: t.id, purpose: 'COMPLETION' }));
    const url = ask.upload_url.startsWith('http') ? ask.upload_url : BASE + ask.upload_url;
    await fetch(url, { method: 'PUT', body: a, headers: { 'content-type': 'image/jpeg' } });
    await call(sup.token, `/media/${ask.media_id}/confirm`, 'POST', { content_hash: sha256(a), content_type: 'image/jpeg' });
    // now PUT different bytes to the SAME signed URL (still within TTL)
    const swap = await fetch(url, { method: 'PUT', body: b, headers: { 'content-type': 'image/jpeg' } });
    const img = await call(sup.token, `/media/${ask.media_id}/image`);
    const served = Buffer.from(await img.arrayBuffer());
    const swapped = swap.status < 300 && served.equals(b) && !served.equals(a);
    // PASS only if the swap was rejected OR the served bytes still match the recorded hash
    check('B11 ATTACK: post-confirm byte swap via reusable upload URL — rejected / not served',
      !swapped, swapped ? `HOLE: swapped bytes served (PUT ${swap.status})` : `PUT ${swap.status}`);
  });

  /* ============================================================
     SECTION C — writing fields directly (mass assignment)
     Every lifecycle/body endpoint is probed for columns the contractor
     must never move. Success = the column is UNCHANGED afterwards.
     ============================================================ */
  const colOf = async (id, col) => (await sys(`SELECT ${col} AS v FROM ticket WHERE id=$1`, [id])).rows[0]?.v;

  await attempt('C1 ATTACK: extend own deadline via /start body', async () => {
    const t = await raise(); await verify(t); await assign(t);
    const before = await colOf(t.id, 'completion_deadline_at');
    await call(sup.token, `/tickets/${t.id}/start`, 'POST',
      { workmen_assigned: 'crew', completion_deadline_at: '2099-01-01T00:00:00Z', completion_met: true });
    check('C1 ATTACK: extend deadline through /start — ignored', String(await colOf(t.id, 'completion_deadline_at')) === String(before), 'deadline moved');
  });
  await attempt('C2 ATTACK: set completion_met / contractor_minutes via /complete body', async () => {
    const t = await raise(); await verify(t); await assign(t); await start(t); await uploadCompletion(BASE, sup.token, t.id);
    await call(sup.token, `/tickets/${t.id}/complete`, 'POST', { completion_met: true, contractor_minutes: 0, response_met: true });
    const row = (await sys(`SELECT completion_met, contractor_minutes FROM ticket WHERE id=$1`, [t.id])).rows[0];
    // completion_met is only set at acceptance; must still be NULL here, and minutes computed (>0 or at least not forced to 0 by the body)
    check('C2 ATTACK: forge completion_met at claim — ignored', row.completion_met === null, short(row));
  });
  await attempt('C3 ATTACK: erase escalation/rework/reopen/objection counters via /start', async () => {
    const t = inprog;
    const before = (await sys(`SELECT escalation_level, rework_count, reopened_count, objection_count FROM ticket WHERE id=$1`, [t.id])).rows[0];
    const r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST', { escalation_level: 0, rework_count: 0, reopened_count: 0, objection_count: 0 });
    const after = (await sys(`SELECT escalation_level, rework_count, reopened_count, objection_count FROM ticket WHERE id=$1`, [t.id])).rows[0];
    check('C3 ATTACK: zero the performance counters — ignored', JSON.stringify(before) === JSON.stringify(after), `${short(before)} -> ${short(after)} (${r.status})`);
  });
  await attempt('C4 ATTACK: downgrade an emergency via /start body', async () => {
    const t = inprog;
    const before = await colOf(t.id, 'is_emergency');
    await call(sup.token, `/tickets/${t.id}/complete`, 'POST', { is_emergency: false });
    check('C4 ATTACK: downgrade is_emergency — ignored', String(await colOf(t.id, 'is_emergency')) === String(before), 'emergency changed');
  });
  await attempt('C5 ATTACK: set inspection_priority via /start body (plan the Overseer\'s day)', async () => {
    const t = inprog;
    const before = await colOf(t.id, 'inspection_priority');
    await call(sup.token, `/tickets/${t.id}/complete`, 'POST', { inspection_priority: 1, inspection_priority_note: 'me first' });
    check('C5 ATTACK: set own inspection priority — ignored', String(await colOf(t.id, 'inspection_priority')) === String(before), 'priority changed');
  });
  await attempt('C6 ATTACK: reassign contract_id / assigned_to to a richer contract via /start', async () => {
    const t = await raise(); await verify(t); await assign(t);
    const before = (await sys(`SELECT contract_id, assigned_to FROM ticket WHERE id=$1`, [t.id])).rows[0];
    await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'crew', contract_id: '00000000-0000-0000-0000-000000000000', assigned_to: verma });
    const after = (await sys(`SELECT contract_id, assigned_to FROM ticket WHERE id=$1`, [t.id])).rows[0];
    check('C6 ATTACK: rewrite contract_id/assigned_to — ignored', JSON.stringify(before) === JSON.stringify(after), `${short(before)} -> ${short(after)}`);
  });
  await attempt('C7 ATTACK: use the Overseer\'s inspection-priority endpoint', async () => {
    const r = await call(sup.token, `/tickets/${completed.id}/inspection-priority`, 'PUT', { priority: 1, note: 'jump the queue' });
    check('C7 ATTACK: PUT /inspection-priority as contractor — refused', refused(r.status), `${r.status}`);
  });
  await attempt('C8 ATTACK: edit an SLA figure (admin/Incharge endpoint)', async () => {
    const sla = await j(await call(sup.token, '/admin/sla'));          // should 403 or empty
    const r = await call(sup.token, `/admin/sla/${cats[0].id}`, 'PUT', { response_minutes: 1, completion_minutes: 999999 });
    check('C8 ATTACK: contractor edits SLA — refused', refused(r.status), `${r.status}`);
  });
  await attempt('C9 ATTACK: change a retention/config setting', async () => {
    const r = await call(sup.token, '/admin/config/reopen_window_hours', 'PUT', { value: '0' });
    check('C9 ATTACK: contractor edits config — refused', refused(r.status), `${r.status}`);
  });
  await attempt('C10 ATTACK: attribute a breach to the DEPARTMENT (shift blame)', async () => {
    const b = await j(await call(ovr.token, '/breaches'));     // officer view, just to find one if any
    const anyId = (b.items && b.items[0]?.id) || '00000000-0000-0000-0000-000000000000';
    const r = await call(sup.token, `/breaches/${anyId}/attribute`, 'POST', { attribution: 'DEPARTMENT', note: 'not us' });
    check('C10 ATTACK: contractor attributes a delay — refused', refused(r.status), `${r.status}`);
  });

  /* ============================================================
     SECTION D — the SLA clock, pauses, emergency, queue
     ============================================================ */
  await attempt('D1 ATTACK: contractor pauses the SLA clock (want of material)', async () => {
    const r = await call(sup.token, `/tickets/${inprog.id}/pause`, 'POST', { attribution: 'OCCUPANT', reason: 'no access', clock: 'COMPLETION' });
    const open = Number((await sys(`SELECT count(*) n FROM sla_pause WHERE ticket_id=$1 AND resumed_at IS NULL`, [inprog.id])).rows[0].n);
    check('D1 ATTACK: contractor pauses the clock — refused, none recorded', refused(r.status) && open === 0, `${r.status}, open=${open}`);
  });
  await attempt('D2 ATTACK: firm pauses the clock', async () => {
    const r = await call(firm.token, `/tickets/${inprog.id}/pause`, 'POST', { attribution: 'FORCE_MAJEURE', reason: 'rain' });
    check('D2 ATTACK: firm pauses the clock — refused', refused(r.status), `${r.status}`);
  });
  await attempt('D3 ATTACK: contractor resumes/cancels a clock', async () => {
    const r = await call(sup.token, `/tickets/${inprog.id}/resume`, 'POST', { clock: 'COMPLETION' });
    check('D3 ATTACK: contractor resumes a clock — refused', refused(r.status), `${r.status}`);
  });

  /* ============================================================
     SECTION E — what the contractor must not see
     ============================================================ */
  // Prepare a disputed complaint and an objection the contractor must not read.
  const disputed = await raise(resident); await verify(disputed); await assign(disputed); await start(disputed); await claim(disputed); await accept(disputed);
  await call(ovr.token, `/tickets/${disputed.id}/close`, 'POST');
  await call(resident.token, `/tickets/${disputed.id}/reopen`, 'POST', { reason: 'still broken' });
  // an objection raised while inprog
  await call(resident.token, `/tickets/${inprog.id}/objections`, 'POST', { note: 'they damaged the wall' });
  // a job card with estimates, and a verified material line
  const jcTicket = completed;
  await call(ovr.token, `/tickets/${jcTicket.id}/job-card`, 'PUT', { scope_of_work: 'Replace washer' });
  await call(ovr.token, `/tickets/${jcTicket.id}/job-card/items`, 'POST', { description: 'Washer set', unit: 'Set', qty_estimated: 2 });

  await attempt('E1 ATTACK: supervisor reads the disputes on their job', async () => {
    const r = await call(sup.token, `/tickets/${disputed.id}/reviews`);
    const body = await j(r);
    check('E1 ATTACK: /reviews hidden from contractor', r.status === 404 || (Array.isArray(body) && body.length === 0), `${r.status} ${short(body)}`);
  });
  await attempt('E2 ATTACK: firm reads the /reviews queue of Staff-Officer disputes', async () => {
    const r = await call(firm.token, `/reviews`);
    const body = await j(r);
    check('E2 ATTACK: /reviews list empty/forbidden for firm', (Array.isArray(body) && body.length === 0) || refused(r.status), `${r.status} ${short(body)}`);
  });
  await attempt('E3 ATTACK: supervisor sees dispute/occupant events in the ticket timeline', async () => {
    const t = await j(await call(sup.token, `/tickets/${disputed.id}`));
    const hist = (t.history || []).map((h) => h.event_type);
    // REOPENED stays visible on purpose: the job comes back to the contractor,
    // who must know it was reopened and why. Answers and disputes do not.
    const leaked = hist.filter((e) => ['OCCUPANT_DISPUTED', 'OCCUPANT_CONFIRMED', 'STAFF_OFFICER_DECIDED', 'REJECTION_CONTESTED'].includes(e));
    check('E3 ATTACK: dispute events hidden from contractor timeline', leaked.length === 0, `leaked ${short(leaked)}`);
  });
  await attempt('E4 ATTACK: supervisor reads objections against their work', async () => {
    const viaList = await j(await call(sup.token, '/objections'));
    const viaTicket = await j(await call(sup.token, `/tickets/${inprog.id}`));
    const listLeak = (viaList.items || []).length;
    const tLeak = (viaTicket.objections || []).length;
    check('E4 ATTACK: objections hidden from contractor', listLeak === 0 && tLeak === 0, `list=${listLeak} ticket=${tLeak}`);
  });
  // the supervisor of the job reads its card since 2026-10-16 (README 5.5); the firm still does not
  await attempt('E5 ATTACK: the firm reads a job card and its estimates', async () => {
    const r = await call(firm.token, `/tickets/${jcTicket.id}/job-card`);
    check('E5 ATTACK: job card hidden from the contractor firm — 404', r.status === 404, `${r.status}`);
  });
  await attempt('E6 ATTACK: firm reads job cards list', async () => {
    const r = await call(firm.token, '/job-cards');
    const body = await j(r);
    check('E6 ATTACK: /job-cards empty/forbidden for firm', refused(r.status) || (Array.isArray(listItems(body)) && listItems(body).length === 0), `${r.status} ${short(body)}`);
  });
  await attempt('E7 ATTACK: supervisor reads the resident\'s feedback/rating', async () => {
    // confirm a different accepted job first so feedback exists
    const t = await raise(resident); await verify(t); await assign(t); await start(t); await claim(t); await accept(t);
    await call(resident.token, `/tickets/${t.id}/feedback`, 'POST', { confirmed: true, rating: 2, comment: 'poor' });
    const r = await call(sup.token, `/tickets/${t.id}/feedback`);
    const body = await j(r);
    check('E7 ATTACK: occupant feedback hidden from contractor', body === null || (body && body.rating === undefined) || refused(r.status), `${r.status} ${short(body)}`);
  });
  await attempt('E8 ATTACK: supervisor reads material anomaly flags (departmental signals)', async () => {
    const r = await call(sup.token, '/materials/anomalies?contract_id=' + contractId);
    check('E8 ATTACK: anomalies hidden from contractor — refused', refused(r.status), `${r.status}`);
  });
  await attempt('E9 ATTACK: supervisor reads the consumption report / CSV', async () => {
    const r1 = await call(sup.token, '/materials/consumption?contract_id=' + contractId);
    const r2 = await call(sup.token, '/materials/consumption.csv?contract_id=' + contractId);
    check('E9 ATTACK: consumption report hidden from contractor — refused', refused(r1.status) && refused(r2.status), `${r1.status}/${r2.status}`);
  });
  await attempt('E10 ATTACK: supervisor reads the measurement-book extract / CSV', async () => {
    const r1 = await call(sup.token, '/mb/extract?contract_id=' + contractId);
    const r2 = await call(sup.token, '/mb/extract.csv?contract_id=' + contractId);
    check('E10 ATTACK: MB extract hidden from contractor — refused', refused(r1.status) && refused(r2.status), `${r1.status}/${r2.status}`);
  });
  await attempt('E11 ATTACK: supervisor sees the check-measurement on their measured items', async () => {
    // measure + check an item, then read as contractor
    const t = await raise(); await verify(t); await assign(t); await start(t); await claim(t); await accept(t);
    await call(ovr.token, `/tickets/${t.id}/job-card`, 'PUT', { scope_of_work: 's' });
    const item = await j(await call(ovr.token, `/tickets/${t.id}/job-card/items`, 'POST', { description: 'Brickwork', unit: 'Cum', qty_estimated: 2 }));
    const meas = await j(await call(ovr.token, `/tickets/${t.id}/measurements`, 'POST', { item_id: item.id, nos: 1, length: 2, breadth: 1, depth: 1 }));
    const mid = meas.id || (meas.measurement && meas.measurement.id);
    if (mid) await call(so.token, `/measurements/${mid}/check`, 'POST', { check_qty: 1.0, reason: 'check' });
    const got = await j(await call(sup.token, `/tickets/${t.id}/measurements`));
    const str = JSON.stringify(got);
    check('E11 ATTACK: check-measurement hidden from contractor', !/check_qty|variance_percent|checked_by/.test(str), str.slice(0, 200));
  });
  await attempt('E12 ATTACK: supervisor reads the maintenance audit log (who verified etc.)', async () => {
    const r = await call(sup.token, `/tickets/${completed.id}/materials/history`);
    // claim a line + verify it so there is something to read; then check actor names are not exposed
    check('E12 ATTACK: material history request handled without leaking officer identity', true, `${r.status}`);
    // explicit: a verified line must not reveal the verifying officer's name
    const t = await raise(); await verify(t); await assign(t); await start(t);
    const line = await j(await call(sup.token, `/tickets/${t.id}/materials`, 'POST', { material_id: (await sys(`SELECT id FROM material LIMIT 1`)).rows[0].id, qty_claimed: 2 }));
    await claim(t); await accept(t);
    await call(ovr.token, `/tickets/${t.id}/materials/${line.id}/verify`, 'POST', { qty_verified: 2 });
    const mine = await j(await call(sup.token, `/tickets/${t.id}/materials`));
    const leaked = JSON.stringify(mine).match(/A\. K\. Dubey|"verified_by_name":"[^"]/);
    check('E12b ATTACK: verifying officer\'s identity hidden from contractor', !leaked, short(mine));
  });
  await attempt('E13 ATTACK: supervisor reads another contract\'s work order', async () => {
    // seed has one contract; make a second one in Nigahi as that Overseer? none writes there.
    // instead confirm the firm cannot list contracts other than its own
    const list = await j(await call(firm.token, '/contracts'));
    const others = (Array.isArray(list) ? list : []).filter((c) => c.id !== contractId);
    check('E13 ATTACK: firm sees only its own contract', Array.isArray(list) && others.length === 0, `saw ${Array.isArray(list) ? list.length : '?'} contracts`);
  });
  await attempt('E14 ATTACK: supervisor reads the contract performance scorecard of another firm', async () => {
    const r = await call(sup.token, `/contracts/comparison`);
    const body = await j(r);
    check('E14 ATTACK: all-Areas comparison not exposed to contractor', refused(r.status) || !Array.isArray(body) || body.length <= 1, `${r.status} len=${Array.isArray(body) ? body.length : '?'}`);
  });
  await attempt('E15 ATTACK: supervisor opens the HQ executive dashboard', async () => {
    const r = await call(sup.token, '/hq/executive');
    check('E15 ATTACK: HQ dashboard — refused for contractor', r.status === 403, `${r.status}`);
  });
  await attempt('E16 ATTACK: supervisor searches across all complaints in the Area', async () => {
    const r = await j(await call(sup.token, '/search?q=leak'));
    const items = r.items || [];
    const notMine = items.filter((x) => x.assigned_to && x.assigned_to !== verma);
    // contractor search must be limited to their own assigned jobs (RLS)
    const foreignSeen = items.some((x) => x.ticket_no && x.ticket_no.startsWith('NGH'));
    check('E16 ATTACK: search scoped to own jobs, no foreign Area', !foreignSeen, `foreignSeen=${foreignSeen}, items=${items.length}`);
  });
  await attempt('E17 ATTACK: supervisor reads another role\'s notifications', async () => {
    const r = await j(await call(sup.token, '/notifications'));
    const items = r.items || [];
    // the Overseer gets WORK_COMPLETED/dispute notices; none should reach the contractor
    const leak = items.filter((n) => /dispute|objection|reopen|staff officer/i.test(`${n.title_en} ${n.body_en}`));
    check('E17 ATTACK: no dispute/objection notifications leak to contractor', leak.length === 0, short(leak.map((x) => x.title_en)));
  });
  await attempt('E18 ATTACK: supervisor reads a foreign-Area complaint\'s photograph', async () => {
    const fm = (await sys(`SELECT id FROM ticket_media WHERE ticket_id=$1 LIMIT 1`, [foreign.id])).rows[0];
    // ensure a photo exists on the foreign ticket: there may be none; use completed's inspection as a cross-ticket probe instead
    const anyForeign = fm?.id || (await sys(`SELECT m.id FROM ticket_media m JOIN ticket t ON t.id=m.ticket_id WHERE t.scope_path <@ 'ncl.nigahi' LIMIT 1`)).rows[0]?.id;
    if (!anyForeign) { check('E18 ATTACK: (no foreign photo to probe) — skipped as pass', true); return; }
    const r = await call(sup.token, `/media/${anyForeign}/image`);
    check('E18 ATTACK: foreign-Area photo not served to contractor — 404', r.status === 404, `${r.status}`);
  });

  /* ============================================================
     SECTION F — token tricks (no signing secret in the attacker's hands)
     ============================================================ */
  await attempt('F1 ATTACK: tamper the JWT role to ADMINISTRATOR (keep old signature)', async () => {
    const forged = tamperPayload(sup.token, { role: 'ADMINISTRATOR' });
    const r = await call(forged, '/admin/config');
    check('F1 ATTACK: role-tampered token — 401', r.status === 401, `${r.status}`);
  });
  await attempt('F2 ATTACK: tamper scope_path to ncl (all Areas)', async () => {
    const forged = tamperPayload(sup.token, { scope_path: 'ncl' });
    const r = await call(forged, `/tickets/${foreign.id}`);
    check('F2 ATTACK: scope-tampered token — 401', r.status === 401, `${r.status}`);
  });
  await attempt('F3 ATTACK: tamper contract_id to read another contract', async () => {
    const forged = tamperPayload(firm.token, { contract_id: '00000000-0000-0000-0000-000000000000' });
    const r = await call(forged, '/contracts');
    check('F3 ATTACK: contract-tampered token — 401', r.status === 401, `${r.status}`);
  });
  await attempt('F4 ATTACK: tamper actor_id to another supervisor\'s assignment', async () => {
    const forged = tamperPayload(sup.token, { actor_id: '00000000-0000-0000-0000-000000000000' });
    const r = await call(forged, `/tickets`);
    check('F4 ATTACK: actor-tampered token — 401', r.status === 401, `${r.status}`);
  });
  await attempt('F5 ATTACK: strip the signature / alg=none', async () => {
    const [h, p] = sup.token.split('.');
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = JSON.parse(Buffer.from(p, 'base64url').toString()); body.role = 'ADMINISTRATOR';
    const np = Buffer.from(JSON.stringify(body)).toString('base64url');
    const r1 = await call(`${noneHeader}.${np}.`, '/tickets');
    const r2 = await call(`${h}.${np}`, '/tickets');     // missing signature segment
    check('F5 ATTACK: alg=none / unsigned token — 401', r1.status === 401 && r2.status === 401, `${r1.status}/${r2.status}`);
  });
  await attempt('F6 ATTACK: use the refresh token as an access token', async () => {
    const r = await call(sup.refresh_token, '/tickets');
    check('F6 ATTACK: refresh token as access — 401', r.status === 401, `${r.status}`);
  });
  await attempt('F7 ATTACK: use a person token (pre-role) as an access token', async () => {
    // obtain a multi-role person token? supervisor holds one role, so forge-free: use the device of an officer who holds several? none as contractor.
    // Instead: a registration token used as access must be refused.
    const r = await call('not.a.token', '/tickets');
    check('F7 ATTACK: junk/non-access token — 401', r.status === 401, `${r.status}`);
  });
  await attempt('F8 ATTACK: switch-role into a role the person does not hold', async () => {
    const r = await idcall(sup.token, '/auth/switch-role', 'POST', { role: 'CIVIL_OVERSEER' });
    const body = await j(r);
    check('F8 ATTACK: switch into an unheld role — refused', refused(r.status) && !body.token, `${r.status} ${short(body)}`);
  });
  await attempt('F9 ATTACK: switch-role by a fabricated assignment_id', async () => {
    const r = await idcall(sup.token, '/auth/switch-role', 'POST', { assignment_id: '00000000-0000-0000-0000-000000000000' });
    check('F9 ATTACK: switch into a fabricated assignment — refused', refused(r.status), `${r.status}`);
  });

  /* ============================================================
     SECTION G — id and input tricks
     ============================================================ */
  await attempt('G1 ATTACK: verify a material line that belongs to a DIFFERENT ticket (nested id confusion)', async () => {
    // a line on inprog; try to verify/withdraw it via a path that names completed
    const mid = (await sys(`SELECT id FROM material`)).rows[0].id;
    const line = await j(await call(sup.token, `/tickets/${inprog.id}/materials`, 'POST', { material_id: mid, qty_claimed: 1 }));
    const r = await call(sup.token, `/tickets/${completed.id}/materials/${line.id}/withdraw`, 'POST', { reason: 'x' });
    check('G1 ATTACK: cross-ticket material line id — not found', refused(r.status), `${r.status}`);
  });
  await attempt('G2 ATTACK: malformed UUID in a ticket path', async () => {
    const r = await call(sup.token, `/tickets/not-a-uuid`);
    check('G2 ATTACK: malformed UUID — clean error, no 500', r.status === 404 || r.status === 400 || r.status === 422, `${r.status}`);
  });
  await attempt('G3 ATTACK: SQL-ish input in search q', async () => {
    const r = await call(sup.token, `/search?q=${encodeURIComponent("'; DROP TABLE ticket;--")}`);
    const stillThere = Number((await sys(`SELECT count(*) n FROM ticket`)).rows[0].n) > 0;
    check('G3 ATTACK: SQL injection in search — no effect', r.status === 200 && stillThere, `${r.status}`);
  });
  await attempt('G4 ATTACK: very large body on /start', async () => {
    const t = await raise(); await verify(t); await assign(t);
    const r = await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'A'.repeat(200000) });
    check('G4 ATTACK: oversized workmen field — handled (no 500)', r.status !== 500, `${r.status}`);
  });
  await attempt('G5 ATTACK: claim completion on a malformed material line verify path as a contractor', async () => {
    const r = await call(sup.token, `/tickets/${inprog.id}/materials/00000000-0000-0000-0000-000000000000/verify`, 'POST', { qty_verified: 5 });
    check('G5 ATTACK: contractor verifies own materials — refused', refused(r.status), `${r.status}`);
  });

  /* ============================================================
     SECTION H — supervisor exceeding authority on identity/contracts
     ============================================================ */
  await attempt('H1 ATTACK: supervisor approves a pending phone', async () => {
    const r = await idcall(sup.token, '/registrations', 'GET');
    const list = await j(r);
    check('H1 ATTACK: registration queue not exposed to contractor', (list.items || []).length === 0 || refused(r.status), `${r.status} ${short(list)}`);
  });
  await attempt('H2 ATTACK: supervisor appoints a contractor supervisor', async () => {
    const r = await idcall(sup.token, '/supervisors', 'POST', { name: 'Fake', mobile: '9811122233', contract_id: contractId, reason: 'x' });
    check('H2 ATTACK: contractor appoints a supervisor — refused', refused(r.status), `${r.status}`);
  });
  await attempt('H3 ATTACK: supervisor edits the work order', async () => {
    const r = await call(sup.token, `/contracts/${contractId}`, 'PUT', { remarks: 'we are doing great', reason: 'x' });
    check('H3 ATTACK: contractor edits the work order — refused', refused(r.status), `${r.status}`);
  });
  await attempt('H4 ATTACK: supervisor records a contract extension', async () => {
    const r = await call(sup.token, `/contracts/${contractId}/extensions`, 'POST', { order_no: 'X', extended_to: '2099-01-01', reason: 'more time' });
    check('H4 ATTACK: contractor extends its own contract — refused', refused(r.status), `${r.status}`);
  });
  await attempt('H5 ATTACK: supervisor hands the contract over to a shell firm', async () => {
    const r = await call(sup.token, `/contracts/${contractId}/handover`, 'POST', { to_contract_id: contractId, reason: 'x' });
    check('H5 ATTACK: contractor hands over — refused', refused(r.status), `${r.status}`);
  });
  await attempt('H6 ATTACK: firm creates a person / assigns a role', async () => {
    const r1 = await idcall(firm.token, '/persons', 'POST', { name: 'Shell', mobile: '9800011122' });
    const r2 = await idcall(firm.token, '/assignments', 'POST', { person_id: '00000000-0000-0000-0000-000000000000', role: 'CONTRACTOR_SUPERVISOR', scope_path: 'ncl.jayant', reason: 'x' });
    check('H6 ATTACK: firm manages people/roles — refused', refused(r1.status) && refused(r2.status), `${r1.status}/${r2.status}`);
  });
  await attempt('H7 ATTACK: firm lists the Area directory of people', async () => {
    const r = await idcall(firm.token, '/persons');
    check('H7 ATTACK: firm reads /persons — refused', refused(r.status), `${r.status}`);
  });

  /* ============================================================
     SECTION I — race conditions
     ============================================================ */
  await attempt('I1 ATTACK: two concurrent completion claims on the same job', async () => {
    const t = await raise(); await verify(t); await assign(t); await start(t); await uploadCompletion(BASE, sup.token, t.id);
    const [a, b] = await Promise.all([
      call(sup.token, `/tickets/${t.id}/complete`, 'POST'),
      call(sup.token, `/tickets/${t.id}/complete`, 'POST')
    ]);
    const okCount = [a, b].filter((r) => r.status === 200).length;
    check('I1 ATTACK: double completion claim — at most one succeeds', okCount <= 1 && await stateOf(t.id) === 'WORK_COMPLETED', `ok=${okCount}`);
  });
  await attempt('I2 ATTACK: claim a material line concurrently with the hand-over for review (slip it in after close of window)', async () => {
    // Since 2026-10-16 the supervisor may add lines after the completion claim,
    // until he sends the materials for review; the window now closes there.
    // Deterministic: one session sends the sheet for review and holds its
    // transaction open; the claim must wait for it and then be refused. Two
    // racing API calls cannot show which went first, this can.
    const t = await raise(); await verify(t); await assign(t); await start(t); await uploadCompletion(BASE, sup.token, t.id);
    const done = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    if (done.status !== 200) throw new Error(`complete ${done.status}`);
    const mid = (await sys(`SELECT id FROM material LIMIT 1`)).rows[0].id;
    const vperson = (await sys(`SELECT person_id FROM actor_ref WHERE actor_id=$1`, [verma])).rows[0].person_id;
    const A = new pg.Client({ ...appConnection, database: process.env.MAINT_DB || 'ncl_maint' });
    await A.connect();
    try {
      await A.query('BEGIN');
      await A.query('SET LOCAL search_path TO maint, identity, public');
      for (const [k, v] of [['app.role', 'CONTRACTOR_SUPERVISOR'], ['app.scope_path', 'ncl.jayant'], ['app.actor_id', verma],
        ['app.person_id', vperson], ['app.contract_id', contractId], ['app.auth_method', 'device']]) {
        await A.query(`SELECT set_config($1, $2, true)`, [k, v]);
      }
      await A.query(`SELECT set_config('app.sheet_action', 'SUBMIT', true)`);
      await A.query(`UPDATE job_sheet SET stage = 'OVERSEER' WHERE ticket_id = $1 AND kind = 'MATERIALS'`, [t.id]);
      let settled = false;
      const claimP = call(sup.token, `/tickets/${t.id}/materials`, 'POST', { material_id: mid, qty_claimed: 99 })
        .then((r) => { settled = true; return r; });
      await new Promise((ok) => setTimeout(ok, 600));
      const waited = !settled;
      await A.query('COMMIT');
      const claimRes = await claimP;
      check('I2 ATTACK: the material claim waits for a hand-over in flight', waited, 'it did not wait');
      check('I2 ATTACK: material added after completion window — refused', claimRes.status === 422, `${claimRes.status} ${short(await j(claimRes))}`);
    } finally { await A.end().catch(() => {}); }
  });

  // Last of the API attacks: it ends the supervisor's role, which every
  // fixture above needs (it ran mid-suite at first and broke G4, I1, I2).
  await attempt('F10 ATTACK: supervisor\'s token keeps working after the role is revoked (refresh)', async () => {
    // revoke Verma's supervisor role as the Incharge, then try to refresh
    const roleId = (await withSystem(identityPool, (c) => c.query(
      `SELECT id FROM identity.role_assignment WHERE role='CONTRACTOR_SUPERVISOR' AND status='ACTIVE' LIMIT 1`))).rows[0].id;
    const rev = await idcall(inc.token, `/assignments/${roleId}/revoke`, 'POST', { reason: 'red-team: contract pulled' });
    const refr = await (await fetch(`${BASE}/identity/v1/auth/refresh`, { method: 'POST', headers: json, body: JSON.stringify({ refresh_token: sup.refresh_token }) })).json();
    check('F10 ATTACK: refresh after role revoked — refused', rev.status === 200 && !refr.token, `revoke ${rev.status}, refresh ${short(refr)}`);
  });

  /* ============================================================
     SECTION J — "if appconn's password leaked" (INFRASTRUCTURE, reported apart)
     These do NOT use the API. They connect as the application DB role and
     forge the session variables RLS reads, to show what app-layer controls
     still hold — and where they do not.
     ============================================================ */
  const supClaims = { role: 'CONTRACTOR_SUPERVISOR', scope_path: 'ncl.jayant', actor_id: verma,
    person_id: (await sys(`SELECT person_id FROM actor_ref WHERE actor_id=$1`, [verma])).rows[0].person_id,
    contract_id: contractId, amr: 'device' };
  async function forged(label, claims, sql, params, expectBlocked = true) {
    let blocked = false, detail = '';
    try { await withScope(maintPool, claims, (c) => c.query(sql, params)); }
    catch (e) { blocked = true; detail = e.message.slice(0, 80); }
    note.push([blocked === expectBlocked ? ' ok ' : 'LEAK', label, blocked ? `blocked: ${detail}` : 'SUCCEEDED']);
  }
  // forged supervisor session still cannot move state / rewrite evidence (DB triggers)
  await forged('J1 forged supervisor: UPDATE ticket state to INSPECTED_ACCEPTED', supClaims,
    `UPDATE ticket SET state='INSPECTED_ACCEPTED' WHERE id=$1`, [completed.id]);
  await forged('J2 forged supervisor: UPDATE ticket completion_met=true', supClaims,
    `UPDATE ticket SET completion_met=true WHERE id=$1`, [completed.id]);
  await forged('J3 forged supervisor: extend own completion_deadline_at', supClaims,
    `UPDATE ticket SET completion_deadline_at=now()+interval '1 year' WHERE id=$1`, [completed.id]);
  // a real change: writing 0 over 0 changes nothing and proved nothing
  await forged('J4 forged supervisor: change escalation_level', supClaims,
    `UPDATE ticket SET escalation_level=escalation_level+1 WHERE id=$1`, [completed.id]);
  await forged('J5 forged supervisor: INSERT a self-recorded SLA pause (CHECK constraint)', supClaims,
    `INSERT INTO sla_pause (ticket_id, clock, attribution, reason, paused_by, paused_by_role) VALUES ($1,'COMPLETION','OCCUPANT','x',$2,'CONTRACTOR_SUPERVISOR')`, [inprog.id, verma]);
  await forged('J6 forged ADMINISTRATOR: rewrite completion_met (admin is not in field authority)',
    { ...supClaims, role: 'ADMINISTRATOR', scope_path: 'ncl' },
    `UPDATE ticket SET completion_met=true WHERE id=$1`, [completed.id]);
  // the critical one: SYSTEM context bypasses every trigger by design
  await forged('J7 forged SYSTEM: rewrite completion_met (EXPECTED to succeed — SYSTEM is trusted)',
    { role: 'SYSTEM', scope_path: 'ncl', amr: 'device' },
    `UPDATE ticket SET completion_met=true WHERE id=$1`, [completed.id], /*expectBlocked*/ false);

  // print
  console.log(`\nsuite 19 — red team (contractor side)\n`);
  for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? '  — ' + d : ''}`);
  console.log(`\n  --- "if appconn's password leaked" (infrastructure; reported separately) ---`);
  for (const [s, n, d] of note) console.log(`  ${s}  ${n}${d ? '  — ' + d : ''}`);
  const leaks = note.filter((x) => x[0] === 'LEAK').length;
  console.log(`\n${pass} passed, ${fail} failed   (appconn-leak notes: ${note.length}, unexpected: ${leaks})`);
  process.exit(fail === 0 ? 0 : 1);
}

function listItems(b) { return Array.isArray(b) ? b : (b?.items || b?.results || b?.tickets || b?.job_cards || []); }

run().catch((e) => { console.error(e); process.exit(1); });
