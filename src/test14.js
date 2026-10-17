/**
 * Suite 14 — disputes, before/after photographs, repeat complaints, search
 * (user's findings of 2026-10-07).
 *
 * Written from the specification alone, to check the implementation
 * independently of whoever built it.
 *
 *   D1  contesting a rejection: once, by the occupant; the Overseer or
 *       Incharge reviews, then the Staff Officer decides in writing; after
 *       that, no further dispute; reviews are never edited or deleted
 *   D2  a dispute before closure reopens the complaint; the Overseer can no
 *       longer close it
 *   D3  the third reopening goes to the Staff Officer (REWORK / CLOSE /
 *       SPECIAL_REPAIR); nobody reassigns meanwhile; no reopening afterwards
 *   D4  before and after photographs: one of each to claim, three at most
 *       per round, fresh ones for each round, counted on the job card
 *   D5  the repeat complaints card counts every report, not only complaints
 *   D6  search by words of category, sub-category, premises, description and
 *       number, and by word beginnings; Area isolation
 *   D7  contractors never see reviews; no money anywhere
 *
 * Needs a freshly reset and seeded database.
 */
import fs from 'node:fs';
import { signNonce } from './auth.js';
import { uploadPhoto, uploadCompletion, uploadInspection } from './testutil.js';
import { withSystem, withScope, maintPool, identityPool } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => { if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); } };
async function attempt(n, fn) { try { await fn(); } catch (e) { check(n, false, `threw: ${e.message}`.slice(0, 220)); } }

const json = { 'content-type': 'application/json' };
async function as(key) {
  const d = devices[key];
  const ch = await (await fetch(`${BASE}/identity/v1/auth/challenge`, { method: 'POST', headers: json,
    body: JSON.stringify({ public_key: d.publicKey }) })).json();
  return (await fetch(`${BASE}/identity/v1/auth/token`, { method: 'POST', headers: json,
    body: JSON.stringify({ public_key: d.publicKey, nonce: ch.nonce, signature: signNonce(d.privateKey, ch.nonce),
      second_factor_satisfied: true, role: d.role }) })).json();
}
const call = (tok, p, method = 'GET', b) => fetch(`${BASE}/maintenance/v1${p}`, { method,
  headers: { ...json, authorization: `Bearer ${tok}` }, body: b ? JSON.stringify(b) : undefined });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const sys = (sql, params) => withSystem(maintPool, (c) => c.query(sql, params));
const short = (x) => JSON.stringify(x).slice(0, 240);
const listOf = (b) => (Array.isArray(b) ? b : (b?.items || b?.results || b?.tickets || b?.reviews || []));
const idsOf = (b) => listOf(b).map((x) => x.id || x.ticket_id);
const MONEY_KEY = /rate|price|amount|cost|₹/i;
function moneyKeys(o, found = []) {
  if (Array.isArray(o)) o.forEach((x) => moneyKeys(x, found));
  else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) { if (MONEY_KEY.test(k)) found.push(k); moneyKeys(v, found); }
  }
  return found;
}

async function run() {
  const resident = await as('RESIDENT:R. K. Singh');
  const mrs = await as('RESIDENT:Mrs S. Singh');
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey');
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
  const so = await as('STAFF_OFFICER_CIVIL:S. Tiwari');
  const gm = await as('GM_CIVIL:GM (Civil)');
  const sup = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const firm = await as('CONTRACTOR:M/s Jayant Constructions');
  const ngh = await as('CIVIL_OVERSEER:Nigahi Overseer');

  const contractId = (await sys(`SELECT id FROM contract WHERE agreement_no='NCL/JNT/CIV/2026/01'`)).rows[0].id;
  const cats = await j(await call(resident.token, '/masters/categories'));
  const assignable = await j(await call(inc.token, '/devices/assignable'));
  const verma = assignable.find((a) => a.person_name === 'M/s Verma — Supr');

  /* One open complaint per premises per sub-category: hand out sub-categories
     one at a time, and take them back when a complaint is finished. Three
     are kept back for the search section. */
  const RESERVED = ['Leaking tap', 'WC or pan blocked', 'No water supply'];
  const reserved = (c) => RESERVED.some((p) => c.name_en.startsWith(p));
  const inUse = new Set();
  const takeSub = () => {
    const c = cats.find((x) => !reserved(x) && !inUse.has(x.id));
    if (!c) throw new Error('ran out of sub-categories for concurrent complaints');
    inUse.add(c.id); return c;
  };
  const release = (t) => inUse.delete(t.sub?.id);

  const stateOf = async (t) => (await sys(`SELECT state, reopened_count FROM ticket WHERE id=$1`, [t.id])).rows[0];
  async function raise(desc) {
    const sub = takeSub();
    const t = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: sub.id, description: desc }));
    if (!t.id) throw new Error(`raise ${short(t)}`);
    t.sub = sub; return t;
  }
  async function rejected(desc, reason = 'Not a civil matter, as the form is filled') {
    const t = await raise(desc);
    const r = await call(ovr.token, `/tickets/${t.id}/reject`, 'POST', { reason });
    if (r.status !== 200) throw new Error(`reject ${r.status} ${short(await j(r))}`);
    return t;
  }
  async function assigned(desc) {
    const t = await raise(desc);
    await call(ovr.token, `/tickets/${t.id}/verify`, 'POST');
    const r = await call(inc.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: verma.actor_id });
    if (r.status !== 200) throw new Error(`assign ${r.status} ${short(await j(r))}`);
    return t;
  }
  async function claimed(t, workmen = 'Ram Prasad') {
    let r = await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: workmen });
    if (r.status !== 200) throw new Error(`start ${r.status} ${short(await j(r))}`);
    await uploadCompletion(BASE, sup.token, t.id);
    r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    if (r.status !== 200) throw new Error(`complete ${r.status} ${short(await j(r))}`);
  }
  async function accepted(t) {
    await uploadInspection(BASE, ovr.token, t.id);
    const r = await call(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true });
    if (r.status !== 200) throw new Error(`inspect ${r.status} ${short(await j(r))}`);
  }
  async function closed(t) {
    const r = await call(ovr.token, `/tickets/${t.id}/close`, 'POST');
    if (r.status !== 200) throw new Error(`close ${r.status} ${short(await j(r))}`);
  }
  async function reopen(t, reason = 'The fault has come back') {
    const r = await call(resident.token, `/tickets/${t.id}/reopen`, 'POST', { reason });
    if (r.status !== 200 && r.status !== 201) throw new Error(`reopen ${r.status} ${short(await j(r))}`);
  }
  /* A complaint at the moment of its third reopening. */
  async function atThirdReopen(desc) {
    const t = await assigned(desc);
    for (let n = 1; n <= 3; n++) {
      if (n > 1) {
        const a = await call(ovr.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: verma.actor_id });
        if (a.status !== 200) throw new Error(`reassign ${n} ${a.status} ${short(await j(a))}`);
      }
      await claimed(t, `Round ${n} crew`); await accepted(t); await closed(t); await reopen(t, `Dispute number ${n}`);
    }
    return t;
  }
  const reviewsOf = async (tok, t) => listOf(await j(await call(tok, `/tickets/${t.id}/reviews`)));
  const assign = (tok, t) => call(tok, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: verma.actor_id });

  /* ================= D1 — contesting a rejection ================= */
  const t1 = await rejected('Dispute 1: wash basin tap dripping');
  await attempt('D1 contest', async () => {
    // contest before it is rejected
    const early = await raise('Dispute 1b: not yet rejected');
    let r = await call(resident.token, `/tickets/${early.id}/contest`, 'POST', { reason: 'Should not be possible' });
    check('D1 a complaint that is not rejected cannot be contested', r.status === 409 || r.status === 422, `${r.status}`);
    // leave `early` rejected, to free it
    await call(ovr.token, `/tickets/${early.id}/reject`, 'POST', { reason: 'Duplicate of another complaint' });
    release(early);

    r = await call(resident.token, `/tickets/${t1.id}/contest`, 'POST', {});
    check('D1 a contest without a reason is refused', r.status === 422, `${r.status}`);
    r = await call(resident.token, `/tickets/${t1.id}/contest`, 'POST', { reason: '   ' });
    check('D1 nor a blank reason', r.status === 422, `${r.status}`);
    for (const [who, tok] of [['the Overseer', ovr], ['the Staff Officer', so], ['the GM (Civil)', gm]]) {
      r = await call(tok.token, `/tickets/${t1.id}/contest`, 'POST', { reason: 'Not mine to contest' });
      check(`D1 ${who} cannot contest`, r.status === 403, `${r.status}`);
    }
    r = await call(sup.token, `/tickets/${t1.id}/contest`, 'POST', { reason: 'Not mine to contest' });
    check('D1 the contractor cannot contest', r.status === 403 || r.status === 404, `${r.status}`);
    let st = await stateOf(t1);
    check('D1 refused contests leave the complaint rejected', st.state === 'REJECTED', st.state);

    const view0 = await j(await call(resident.token, `/tickets/${t1.id}`));
    check('D1 the occupant is told she can contest', view0.can_contest === true && view0.final_decision === false, short({ c: view0.can_contest, f: view0.final_decision }));

    r = await call(resident.token, `/tickets/${t1.id}/contest`, 'POST', { reason: 'The tap really does leak; please come and see' });
    const rv = await j(r);
    check('D1 the occupant contests the rejection', r.status === 201 && !!rv.id && rv.kind === 'REJECTION_CONTEST' && rv.stage === 'WITH_OFFICERS', `${r.status} ${short(rv)}`);
    t1.reviewId = rv.id;
    check('D1 the contest keeps the occupant\'s reason', /tap really does leak/.test(rv.raised_reason || ''), short(rv));

    r = await call(resident.token, `/tickets/${t1.id}/contest`, 'POST', { reason: 'Contesting again' });
    const again = await j(r);
    check('D1 a second contest is refused, pointing to the Area Civil Office', r.status === 409 && /Civil Office|written|write/i.test(`${again.detail} ${again.title}`), `${r.status} ${short(again)}`);
    const view1 = await j(await call(resident.token, `/tickets/${t1.id}`));
    check('D1 once contested, can_contest is false', view1.can_contest === false, short(view1.can_contest));

    r = await call(mrs.token, `/tickets/${t1.id}/reviews`);
    const mrsRev = listOf(await j(r));
    check('D1 another occupant of the quarter reads the review', r.status === 200 && mrsRev.length === 1 && mrsRev[0].stage === 'WITH_OFFICERS', `${r.status} ${short(mrsRev)}`);

    // the Staff Officer is not yet in the matter
    r = await call(so.token, `/reviews/${t1.reviewId}/officer`, 'POST', { outcome: 'UPHOLD', note: 'Staff Officer jumping in' });
    check('D1 the Staff Officer cannot act at the officers\' stage', r.status === 403, `${r.status}`);
    r = await call(so.token, `/reviews/${t1.reviewId}/decide`, 'POST', { outcome: 'UPHOLD', decision: 'Too early' });
    check('D1 nor decide before the officers have', r.status === 403 || r.status === 409, `${r.status}`);
    for (const [who, tok] of [['the resident', resident], ['the GM (Civil)', gm], ['the contractor', sup]]) {
      r = await call(tok.token, `/reviews/${t1.reviewId}/officer`, 'POST', { outcome: 'UPHOLD', note: 'Not mine' });
      check(`D1 ${who} cannot review it`, r.status === 403 || r.status === 404, `${r.status}`);
    }
    r = await call(sup.token, `/tickets/${t1.id}/reviews`);
    check('D1 the contractor supervisor gets "not found" on its reviews', r.status === 404, `${r.status}`);

    const pendO = listOf(await j(await call(ovr.token, '/reviews?pending=true')));
    const pendS = listOf(await j(await call(so.token, '/reviews?pending=true')));
    check('D1 the Overseer\'s pending list shows it, with the complaint\'s details',
      pendO.some((x) => x.id === t1.reviewId && x.ticket_id === t1.id && !!x.ticket_no && !!x.identifier && !!x.sub_category), short(pendO));
    check('D1 the Staff Officer\'s pending list does not yet', !pendS.some((x) => x.id === t1.reviewId), short(pendS));

    r = await call(ovr.token, `/reviews/${t1.reviewId}/officer`, 'POST', { outcome: 'UPHOLD' });
    check('D1 upholding without a note is refused', r.status === 422, `${r.status}`);
    r = await call(ovr.token, `/reviews/${t1.reviewId}/officer`, 'POST', { outcome: 'MAYBE', note: 'Unsure' });
    check('D1 an unknown outcome is refused', r.status === 400 || r.status === 422, `${r.status}`);
    r = await call(ovr.token, `/reviews/${t1.reviewId}/officer`, 'POST', { outcome: 'UPHOLD', note: 'Rejection stands: the tap is the resident\'s own fitting' });
    check('D1 the Overseer upholds the rejection with a note', r.ok, `${r.status} ${short(await j(r))}`);
    const revs = await reviewsOf(resident.token, t1);
    check('D1 it goes automatically to the Staff Officer, with the officer\'s note kept',
      revs.length === 1 && revs[0].stage === 'WITH_STAFF_OFFICER' && revs[0].officer_outcome === 'UPHOLD'
      // the occupant reads no officer's record (policy actor_ref_scope): the role stands in for the name
      && /own fitting/.test(revs[0].officer_note || '') && !!(revs[0].officer_by_name || revs[0].officer_by_role) && !!revs[0].officer_at, short(revs));
    st = await stateOf(t1);
    check('D1 the complaint is still rejected', st.state === 'REJECTED', st.state);

    r = await call(ovr.token, `/reviews/${t1.reviewId}/officer`, 'POST', { outcome: 'REINSTATE', note: 'Changed my mind' });
    check('D1 the Overseer cannot act on it again', r.status === 409 || r.status === 403, `${r.status}`);
    r = await call(inc.token, `/reviews/${t1.reviewId}/decide`, 'POST', { outcome: 'REINSTATE', decision: 'Incharge deciding' });
    check('D1 the Incharge cannot decide at the Staff Officer\'s stage', r.status === 403, `${r.status}`);
    r = await call(ovr.token, `/reviews/${t1.reviewId}/decide`, 'POST', { outcome: 'REINSTATE', decision: 'Overseer deciding' });
    check('D1 nor the Overseer', r.status === 403, `${r.status}`);

    const pendO2 = listOf(await j(await call(ovr.token, '/reviews?pending=true')));
    const pendS2 = listOf(await j(await call(so.token, '/reviews?pending=true')));
    check('D1 it has left the Overseer\'s pending list and reached the Staff Officer\'s',
      !pendO2.some((x) => x.id === t1.reviewId) && pendS2.some((x) => x.id === t1.reviewId && x.ticket_id === t1.id), short({ o: pendO2, s: pendS2 }));

    r = await call(so.token, `/reviews/${t1.reviewId}/decide`, 'POST', { outcome: 'UPHOLD' });
    check('D1 the Staff Officer must give a written decision', r.status === 422, `${r.status}`);
    r = await call(so.token, `/reviews/${t1.reviewId}/decide`, 'POST', { decision: 'No outcome given' });
    check('D1 and an outcome', r.status === 422 || r.status === 400, `${r.status}`);
    r = await call(so.token, `/reviews/${t1.reviewId}/decide`, 'POST', { outcome: 'UPHOLD', decision: 'Rejection upheld; the fitting belongs to the allottee, not the department' });
    check('D1 the Staff Officer upholds, in writing', r.ok, `${r.status} ${short(await j(r))}`);

    const revs2 = await reviewsOf(resident.token, t1);
    check('D1 the decision is DECIDED and its text is visible to the occupant',
      revs2[0]?.stage === 'DECIDED' && revs2[0].so_outcome === 'UPHOLD' && /belongs to the allottee/.test(revs2[0].so_decision || '')
      && !!(revs2[0].so_by_name || revs2[0].so_by_role) && !!revs2[0].so_at, short(revs2));
    const view2 = await j(await call(resident.token, `/tickets/${t1.id}`));
    check('D1 the complaint view carries the same, as final', view2.state === 'REJECTED' && view2.final_decision === true && view2.can_contest === false
      && /belongs to the allottee/.test(view2.reviews?.[0]?.so_decision || ''), short({ s: view2.state, f: view2.final_decision, c: view2.can_contest, r: view2.reviews }));
    check('D1 the complaint is still rejected after the decision', (await stateOf(t1)).state === 'REJECTED');
    r = await call(so.token, `/reviews/${t1.reviewId}/decide`, 'POST', { outcome: 'REINSTATE', decision: 'Second thoughts' });
    check('D1 a decided review cannot be decided again', r.status === 409 || r.status === 403, `${r.status}`);

    r = await call(resident.token, `/tickets/${t1.id}/contest`, 'POST', { reason: 'One more try' });
    const fin = await j(r);
    check('D1 after the Staff Officer\'s decision the occupant cannot contest again', r.status === 409 && /Civil Office|written|write/i.test(`${fin.detail} ${fin.title}`), `${r.status} ${short(fin)}`);
    r = await call(mrs.token, `/tickets/${t1.id}/contest`, 'POST', { reason: 'Another occupant tries' });
    check('D1 nor can another occupant of the quarter', r.status === 409, `${r.status}`);
    r = await call(resident.token, `/tickets/${t1.id}/reopen`, 'POST', { reason: 'Reopen it' });
    check('D1 nor reopen it', r.status === 409, `${r.status}`);

    const hist = (await sys(`SELECT event_type, reason FROM ticket_event WHERE ticket_id=$1 ORDER BY id`, [t1.id])).rows;
    const ev = (t) => hist.find((h) => h.event_type === t);
    check('D1 history keeps the contest with the occupant\'s words', /tap really does leak/.test(ev('REJECTION_CONTESTED')?.reason || ''), short(hist));
    check('D1 history keeps the officer\'s upholding with the note', /own fitting/.test(ev('CONTEST_UPHELD')?.reason || ''), short(hist));
    check('D1 history keeps the referral to the Staff Officer', !!ev('REFERRED_TO_STAFF_OFFICER'), short(hist));
    check('D1 history keeps the Staff Officer\'s written decision', /belongs to the allottee/.test(ev('STAFF_OFFICER_DECIDED')?.reason || ''), short(hist));
    const apiHist = JSON.stringify(view2.history || []);
    check('D1 the occupant sees these on the complaint timeline',
      /REJECTION_CONTESTED/.test(apiHist) && /STAFF_OFFICER_DECIDED/.test(apiHist) && /belongs to the allottee/.test(apiHist), apiHist.slice(0, 240));
    release(t1);
  });

  await attempt('D1 reviews cannot be altered', async () => {
    const tbl = (await sys(`SELECT c.table_name FROM information_schema.columns c
                             WHERE c.table_schema IN ('public','maint') AND c.table_name ~ 'review' AND c.column_name='so_decision' LIMIT 1`)).rows[0]
      || (await sys(`SELECT c.table_name FROM information_schema.columns c
                      WHERE c.table_schema IN ('public','maint') AND c.table_name ~ 'review' AND c.column_name='id' LIMIT 1`)).rows[0];
    if (!tbl) throw new Error('could not find the reviews table');
    const cols = (await sys(`SELECT column_name FROM information_schema.columns WHERE table_schema IN ('public','maint') AND table_name=$1
                              AND data_type IN ('text','character varying') AND column_name ~ '(reason|note|decision)'`, [tbl.table_name])).rows.map((x) => x.column_name);
    if (!cols.length) throw new Error(`no text column in ${tbl.table_name}`);
    const col = cols.includes('so_decision') ? 'so_decision' : cols[0];
    const T = tbl.table_name;
    const before = (await sys(`SELECT ${col} v FROM ${T} WHERE id=$1`, [t1.reviewId])).rows[0]?.v;
    let refused = false;
    try { await sys(`UPDATE ${T} SET ${col}='tampered' WHERE id=$1`, [t1.reviewId]); } catch { refused = true; }
    const after = (await sys(`SELECT ${col} v FROM ${T} WHERE id=$1`, [t1.reviewId])).rows[0]?.v;
    check('D1 a decided review cannot be edited, even by the system', !!before && after === before && after !== 'tampered', `${refused} ${before} -> ${after}`);
    refused = false;
    try { await sys(`DELETE FROM ${T} WHERE id=$1`, [t1.reviewId]); } catch { refused = true; }
    const n = (await sys(`SELECT count(*) n FROM ${T} WHERE id=$1`, [t1.reviewId])).rows[0].n;
    check('D1 nor deleted', n === '1', `${refused} ${n}`);
  });

  await attempt('D1 reinstated by the Incharge', async () => {
    const t = await rejected('Dispute 2: bathroom door latch broken');
    let r = await call(resident.token, `/tickets/${t.id}/contest`, 'POST', { reason: 'The door cannot be locked at all' });
    const rv = await j(r);
    check('D1 (second complaint) contested', r.status === 201, `${r.status}`);
    r = await call(inc.token, `/reviews/${rv.id}/officer`, 'POST', { outcome: 'REINSTATE' });
    check('D1 reinstating without a note is refused', r.status === 422, `${r.status}`);
    r = await call(inc.token, `/reviews/${rv.id}/officer`, 'POST', { outcome: 'REINSTATE', note: 'On reading it again, the fault is genuine' });
    check('D1 the Incharge reinstates the complaint', r.ok, `${r.status} ${short(await j(r))}`);
    const revs = await reviewsOf(resident.token, t);
    check('D1 the review is decided by the officer, not sent to the Staff Officer',
      revs[0]?.stage === 'DECIDED' && revs[0].officer_outcome === 'REINSTATE' && !revs[0].so_decision, short(revs));
    check('D1 the complaint is back to RAISED', (await stateOf(t)).state === 'RAISED');
    check('D1 an officer\'s reinstatement is not a Staff Officer decision',
      (await j(await call(resident.token, `/tickets/${t.id}`))).final_decision === false);
    r = await call(ovr.token, `/tickets/${t.id}/verify`, 'POST');
    check('D1 the Overseer then verifies it as usual', r.status === 200 && (await stateOf(t)).state === 'VERIFIED', `${r.status}`);
    const hist = (await sys(`SELECT event_type, reason FROM ticket_event WHERE ticket_id=$1`, [t.id])).rows;
    check('D1 the reinstatement is in the history with the note', hist.some((h) => h.event_type === 'CONTEST_REINSTATED' && /fault is genuine/.test(h.reason || '')), short(hist));
  });

  await attempt('D1 reinstated by the Staff Officer', async () => {
    const t = await rejected('Dispute 3: ceiling fan hook loose');
    let r = await call(resident.token, `/tickets/${t.id}/contest`, 'POST', { reason: 'The hook may fall on us' });
    const rv = await j(r);
    await call(ovr.token, `/reviews/${rv.id}/officer`, 'POST', { outcome: 'UPHOLD', note: 'Cosmetic matter' });
    r = await call(so.token, `/reviews/${rv.id}/decide`, 'POST', { outcome: 'REINSTATE', decision: 'A loose hook is a safety matter; to be attended' });
    check('D1 the Staff Officer reinstates in writing', r.ok, `${r.status} ${short(await j(r))}`);
    check('D1 the complaint is back to RAISED', (await stateOf(t)).state === 'RAISED');
    const revs = await reviewsOf(resident.token, t);
    check('D1 the decision text is on the review', revs[0]?.stage === 'DECIDED' && /safety matter/.test(revs[0].so_decision || ''), short(revs));
    r = await call(ovr.token, `/tickets/${t.id}/verify`, 'POST');
    check('D1 the Overseer then verifies it', r.status === 200, `${r.status}`);
  });

  /* ================= D2 — dispute before closure ================= */
  await attempt('D2 dispute before closure', async () => {
    const t = await assigned('Dispute before closure: pantry shelf cracked');
    await claimed(t); await accepted(t);
    let st = await stateOf(t);
    check('D2 (setup) the work is accepted, not yet closed', st.state === 'INSPECTED_ACCEPTED', st.state);
    const n0 = st.reopened_count;
    let r = await call(resident.token, `/tickets/${t.id}/feedback`, 'POST', { confirmed: false });
    check('D2 saying "not fixed" without a comment is refused', r.status === 422, `${r.status}`);
    check('D2 and nothing changed', (await stateOf(t)).state === 'INSPECTED_ACCEPTED');
    r = await call(resident.token, `/tickets/${t.id}/feedback`, 'POST', { confirmed: false, comment: 'The shelf still wobbles' });
    check('D2 "not fixed" before closure is accepted', r.ok, `${r.status} ${short(await j(r))}`);
    st = await stateOf(t);
    check('D2 it reopens the complaint', st.state === 'REOPENED', st.state);
    check('D2 and counts as one more reopening', st.reopened_count === n0 + 1, `${n0} -> ${st.reopened_count}`);
    const ev = (await sys(`SELECT reason FROM ticket_event WHERE ticket_id=$1 AND to_state='REOPENED'`, [t.id])).rows;
    check('D2 the comment became the reason for reopening', ev.some((e) => /still wobbles/.test(e.reason || '')), short(ev));
    r = await call(ovr.token, `/tickets/${t.id}/close`, 'POST');
    check('D2 the Overseer can no longer close it', !r.ok, `${r.status}`);
    check('D2 still reopened', (await stateOf(t)).state === 'REOPENED');
    r = await call(ovr.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: verma.actor_id });
    check('D2 it goes back for reassignment as usual', r.status === 200, `${r.status} ${short(await j(r))}`);
  });

  await attempt('D2 reopen from accepted', async () => {
    const t = await assigned('Dispute before closure: window latch');
    await claimed(t); await accepted(t);
    const n0 = (await stateOf(t)).reopened_count;
    let r = await call(resident.token, `/tickets/${t.id}/reopen`, 'POST', { reason: 'The latch does not hold' });
    check('D2 the reopen route works from "inspected and accepted"', r.ok, `${r.status} ${short(await j(r))}`);
    const st = await stateOf(t);
    check('D2 the complaint is REOPENED with one more reopening', st.state === 'REOPENED' && st.reopened_count === n0 + 1, short(st));
    r = await call(ovr.token, `/tickets/${t.id}/close`, 'POST');
    check('D2 and cannot be closed', !r.ok, `${r.status}`);
  });

  /* ================= D3 — repeated disputes ================= */
  let A;
  await attempt('D3 third reopening, REWORK', async () => {
    A = await assigned('Repeat dispute A: bedroom wall seepage');
    for (let n = 1; n <= 2; n++) {
      if (n > 1) await assign(ovr.token, A);
      await claimed(A, `Round ${n} crew`); await accepted(A); await closed(A); await reopen(A, `Dispute number ${n}`);
    }
    check('D3 after two reopenings there is no review yet', (await reviewsOf(so.token, A)).length === 0);
    check('D3 and it can still be reassigned', (await assign(ovr.token, A)).status === 200);
    await claimed(A, 'Round 3 crew'); await accepted(A); await closed(A); await reopen(A, 'Dispute number 3');
    let st = await stateOf(A);
    check('D3 the third reopening is counted', st.state === 'REOPENED' && st.reopened_count === 3, short(st));
    const revs = await reviewsOf(so.token, A);
    const rd = revs.find((x) => x.kind === 'REPEAT_DISPUTE');
    check('D3 the system refers it to the Staff Officer', revs.length === 1 && rd?.stage === 'WITH_STAFF_OFFICER', short(revs));
    A.reviewId = rd?.id;

    const hist = (await sys(`SELECT event_type FROM ticket_event WHERE ticket_id=$1`, [A.id])).rows.map((h) => h.event_type);
    check('D3 the referral is in the history', hist.includes('REFERRED_TO_STAFF_OFFICER'), short(hist));

    let r = await assign(ovr.token, A);
    check('D3 the Overseer cannot reassign while it waits', !r.ok && (r.status === 409 || r.status === 422), `${r.status}`);
    r = await assign(inc.token, A);
    check('D3 nor the Incharge', !r.ok && (r.status === 409 || r.status === 422), `${r.status}`);
    check('D3 the complaint stays REOPENED', (await stateOf(A)).state === 'REOPENED');

    const pendS = listOf(await j(await call(so.token, '/reviews?pending=true')));
    const pendO = listOf(await j(await call(ovr.token, '/reviews?pending=true')));
    check('D3 the Staff Officer\'s pending list shows it', pendS.some((x) => x.id === A.reviewId && x.ticket_id === A.id), short(pendS));
    check('D3 the Overseer\'s does not', !pendO.some((x) => x.id === A.reviewId), short(pendO));

    // D5 while the decision is pending
    const perf = await j(await call(so.token, `/contracts/${contractId}/performance`));
    const rows = perf.repeat_complaints || [];
    const row = rows.find((x) => x.identifier === 'B-234' && JSON.stringify(x.sub_category).includes(A.sub.name_en.slice(0, 12)));
    check('D5 the repeat card lists the quarter and fault', !!row, short(rows));
    check('D5 it counts every report: the complaint plus three reopenings', row?.reports >= 4 && row?.reopenings >= 3 && row?.complaints >= 1
      && row.reports === row.complaints + row.reopenings, short(row));
    check('D5 it flags the Staff Officer\'s decision as pending', !!row?.pending_staff_officer, short(row));

    for (const [who, tok] of [['the Overseer', ovr], ['the Incharge', inc], ['the resident', resident], ['the GM (Civil)', gm]]) {
      r = await call(tok.token, `/reviews/${A.reviewId}/decide`, 'POST', { outcome: 'REWORK', decision: 'Not for me to decide' });
      check(`D3 ${who} cannot decide a repeat dispute`, r.status === 403 || r.status === 404, `${r.status}`);
    }
    r = await call(ovr.token, `/reviews/${A.reviewId}/officer`, 'POST', { outcome: 'REINSTATE', note: 'Try the officer route' });
    check('D3 the officer route does not apply to a repeat dispute', r.status === 403 || r.status === 409 || r.status === 422, `${r.status}`);

    r = await call(so.token, `/reviews/${A.reviewId}/decide`, 'POST', { outcome: 'REWORK' });
    check('D3 the Staff Officer must give a written decision', r.status === 422, `${r.status}`);
    r = await call(so.token, `/reviews/${A.reviewId}/decide`, 'POST', { outcome: 'DEMOLISH', decision: 'Pull the wall down' });
    check('D3 only REWORK, CLOSE or SPECIAL_REPAIR are accepted', r.status === 400 || r.status === 422, `${r.status}`);
    r = await call(so.token, `/reviews/${A.reviewId}/decide`, 'POST', { outcome: 'REWORK', decision: 'Strip the plaster, treat the damp course, then replaster' });
    check('D3 the Staff Officer orders rework, in writing', r.ok, `${r.status} ${short(await j(r))}`);
    const after = await reviewsOf(resident.token, A);
    check('D3 the review is decided and its text visible to the occupant',
      after[0]?.stage === 'DECIDED' && after[0].so_outcome === 'REWORK' && /damp course/.test(after[0].so_decision || ''), short(after));
    const view = await j(await call(resident.token, `/tickets/${A.id}`));
    check('D3 the complaint is final: no more disputes', view.final_decision === true && view.can_contest === false, short({ f: view.final_decision, c: view.can_contest }));
    check('D3 it is still REOPENED, awaiting assignment', (await stateOf(A)).state === 'REOPENED');

    r = await assign(ovr.token, A);
    check('D3 after the decision it can be assigned once more', r.status === 200, `${r.status} ${short(await j(r))}`);
    await claimed(A, 'Rework crew'); await accepted(A); await closed(A);
    check('D3 (setup) and closed again', (await stateOf(A)).state === 'CLOSED');
    r = await call(resident.token, `/tickets/${A.id}/reopen`, 'POST', { reason: 'Damp is back' });
    const fin = await j(r);
    check('D3 after the decision the resident cannot reopen it', r.status === 409 && /Civil Office|written|write/i.test(`${fin.detail} ${fin.title}`), `${r.status} ${short(fin)}`);
    check('D3 and it stays closed', (await stateOf(A)).state === 'CLOSED');
    r = await call(resident.token, `/tickets/${A.id}/feedback`, 'POST', { confirmed: false, comment: 'Still damp' });
    check('D3 nor dispute it by feedback', !r.ok || (await stateOf(A)).state === 'CLOSED', `${r.status}`);
    check('D3 the state did not move', (await stateOf(A)).state === 'CLOSED');

    const perf2 = await j(await call(so.token, `/contracts/${contractId}/performance`));
    const row2 = (perf2.repeat_complaints || []).find((x) => x.identifier === 'B-234' && JSON.stringify(x.sub_category).includes(A.sub.name_en.slice(0, 12)));
    check('D5 once decided, the card no longer says a decision is pending', !!row2 && !row2.pending_staff_officer, short(row2));
    release(A);
  });

  await attempt('D3 third reopening, CLOSE', async () => {
    const B = await atThirdReopen('Repeat dispute B: kitchen platform tiles');
    const revs = await reviewsOf(so.token, B);
    check('D3 (CLOSE) the repeat dispute is waiting for the Staff Officer', revs[0]?.kind === 'REPEAT_DISPUTE' && revs[0].stage === 'WITH_STAFF_OFFICER', short(revs));
    let r = await call(so.token, `/reviews/${revs[0].id}/decide`, 'POST', { outcome: 'CLOSE', decision: 'The tiles are cosmetic; the work meets the specification' });
    check('D3 the Staff Officer closes the complaint', r.ok, `${r.status} ${short(await j(r))}`);
    check('D3 the complaint is CLOSED', (await stateOf(B)).state === 'CLOSED');
    r = await call(resident.token, `/tickets/${B.id}/reopen`, 'POST', { reason: 'Not happy' });
    check('D3 no further reopening after a close decision', r.status === 409, `${r.status}`);
    release(B);
  });

  await attempt('D3 third reopening, SPECIAL_REPAIR', async () => {
    const C = await atThirdReopen('Repeat dispute C: bathroom floor sinking');
    const revs = await reviewsOf(so.token, C);
    let r = await call(so.token, `/reviews/${revs[0].id}/decide`, 'POST', { outcome: 'SPECIAL_REPAIR', decision: 'Subsidence; beyond the contract, to be estimated' });
    check('D3 the Staff Officer refers it for special repair', r.ok, `${r.status} ${short(await j(r))}`);
    check('D3 the complaint is REFERRED_SPECIAL_REPAIR', (await stateOf(C)).state === 'REFERRED_SPECIAL_REPAIR');
    r = await call(resident.token, `/tickets/${C.id}/reopen`, 'POST', { reason: 'Not happy' });
    check('D3 and it cannot be reopened', r.status === 409 || r.status === 422, `${r.status}`);
  });

  /* ================= D4c — photographs optional until HQ requires them =================
     User's decision, 2026-10-12: to ease adoption, neither the supervisor's
     before/after photographs nor the Overseer's inspection photograph is
     compulsory, until the HQ System Administrator switches each setting on.
     A photograph that is attached is still held to every rule. */
  const admin = await as('ADMINISTRATOR:System Admin');
  await attempt('D4c photographs optional by default', async () => {
    const cfg = await j(await call(admin.token, '/admin/config'));
    const val = (k) => (Array.isArray(cfg) ? cfg : []).find((x) => x.key === k)?.value;
    check('D4c both settings exist and start off', val('completion_photos_required') === 'false' && val('inspection_photo_required') === 'false',
      short([val('completion_photos_required'), val('inspection_photo_required')]));
    const t = await assigned('Optional photographs: none taken');
    await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
    let r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('D4c the supervisor claims completion without photographs', r.status === 200, `${r.status} ${short(await j(r))}`);
    r = await call(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true });
    check('D4c the Overseer accepts without an inspection photograph (from the app)', r.status === 200, `${r.status} ${short(await j(r))}`);
    const u = await uploadPhoto(BASE, ovr.token, t.id, 'INSPECTION', { capture_verified: false });
    check('D4c an inspection photograph that is attached must still be taken in the app', !u.ok && u.status === 422, `${u.status}`);
    release(t);
  });
  await attempt('D4c HQ switches them on', async () => {
    let r = await call(inc.token, '/admin/config/completion_photos_required', 'PUT', { value: 'true' });
    check('D4c the Incharge cannot switch a photograph setting', r.status === 403, `${r.status}`);
    let dbRefused = false;
    try {
      await withScope(maintPool, { role: 'MAINTENANCE_INCHARGE', scope_path: 'ncl.jayant', actor_id: inc.actor_id, person_id: inc.person_id },
        (c) => c.query(`UPDATE maint_config SET value = 'true' WHERE key = 'inspection_photo_required'`));
    } catch (e) { dbRefused = /HQ System Administrator/.test(e.message); }
    check('D4c nor can anyone but the HQ System Administrator change a setting in the database', dbRefused);
    for (const k of ['completion_photos_required', 'inspection_photo_required']) {
      r = await call(admin.token, `/admin/config/${k}`, 'PUT', { value: 'true' });
      check(`D4c the HQ System Administrator switches ${k} on`, r.status === 200, `${r.status} ${short(await j(r))}`);
    }
    const logged = (await sys(`SELECT before_value, after_value, actor_role FROM audit_log WHERE event_type = 'CONFIG_CHANGED' AND after_value->>'key' = 'inspection_photo_required'`)).rows;
    check('D4c the change is in the audit log with the old and new value and who', logged.length === 1 && logged[0].before_value?.value === 'false'
      && logged[0].after_value?.value === 'true' && logged[0].actor_role === 'ADMINISTRATOR', short(logged));
    const t = await assigned('Required photographs: none taken');
    await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
    r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('D4c once required, a claim without photographs is refused', r.status === 422, `${r.status}`);
    await uploadCompletion(BASE, sup.token, t.id);
    r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('D4c (setup) with them it goes through', r.status === 200, `${r.status}`);
    r = await call(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true });
    check('D4c once required, acceptance without an inspection photograph is refused', r.status === 422, `${r.status}`);
    release(t);
  });

  /* ================= L4 — closing a complaint that reached the GM =================
     User's finding, 2026-10-12: a level-4 complaint could never be closed —
     the database asks for the Area Civil Staff Officer's remark, but nothing
     let the Staff Officer write it, and the refusal showed as "Unexpected
     error". */
  await attempt('L4 level-4 remark', async () => {
    const t = await assigned('Level 4: needs the Staff Officer\'s remark');
    await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
    await uploadCompletion(BASE, sup.token, t.id);   // photographs are required by now in this suite (D4c)
    await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    await uploadInspection(BASE, ovr.token, t.id);
    let r = await call(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true });
    check('L4 (setup) the work is accepted', r.status === 200, `${r.status} ${short(await j(r))}`);
    // the SLA sweep's doing, as the system
    await sys(`UPDATE ticket SET escalation_level = 4 WHERE id = $1`, [t.id]);
    await sys(`INSERT INTO escalation_event (ticket_id, level) VALUES ($1, 4)`, [t.id]);

    let d = await j(await call(ovr.token, `/tickets/${t.id}`));
    check('L4 the complaint says it needs the Staff Officer\'s level-4 remark', d.l4_remark_needed === true, `${d.l4_remark_needed}`);
    const listed = (await j(await call(ovr.token, '/tickets'))).items?.find((x) => x.id === t.id);
    check('L4 and so does its line in the queue', listed?.l4_remark_needed === true, short(listed));
    r = await call(ovr.token, `/tickets/${t.id}/close`, 'POST');
    const body = await j(r);
    check('L4 closing before the remark is refused with the reason, not an unexpected error', r.status === 422 && /Staff Officer/.test(body.detail || ''), `${r.status} ${short(body)}`);
    r = await call(ovr.token, `/tickets/${t.id}/escalation-remark`, 'POST', { remark: 'Overseer tries' });
    check('L4 the Overseer cannot write the Staff Officer\'s remark', r.status === 403, `${r.status}`);
    let dbRefused = false;
    try {
      await withScope(maintPool, { role: 'CIVIL_OVERSEER', scope_path: 'ncl.jayant', actor_id: ovr.actor_id, person_id: ovr.person_id },
        (c) => c.query(`UPDATE escalation_event SET remark = 'forged' WHERE ticket_id = $1`, [t.id]));
    } catch (e) { dbRefused = /Staff Officer/.test(e.message); }
    check('L4 nor can the database be made to take it from anyone else', dbRefused);
    r = await call(so.token, `/tickets/${t.id}/escalation-remark`, 'POST', {});
    check('L4 the remark must say something', r.status === 422, `${r.status}`);
    r = await call(so.token, `/tickets/${t.id}/escalation-remark`, 'POST', { remark: 'Delay was the department\'s; contractor not at fault. Close.' });
    check('L4 the Area Civil Staff Officer records the remark', r.status === 200, `${r.status} ${short(await j(r))}`);
    r = await call(so.token, `/tickets/${t.id}/escalation-remark`, 'POST', { remark: 'Second thoughts' });
    check('L4 the remark is written once, never changed', r.status === 409, `${r.status}`);
    const esc = (await sys(`SELECT remark, acknowledged_by, acknowledged_at FROM escalation_event WHERE ticket_id = $1 AND level = 4`, [t.id])).rows[0];
    check('L4 who and when are recorded by the database', /department/.test(esc?.remark || '') && esc?.acknowledged_by === so.actor_id && !!esc?.acknowledged_at, short(esc));
    d = await j(await call(ovr.token, `/tickets/${t.id}`));
    check('L4 the remark is in the complaint\'s history', (d.history || []).some((h) => h.event_type === 'L4_REMARK_RECORDED'), short((d.history || []).map((h) => h.event_type)));
    // "SLA breached — needs decision" on the queue (user's request, 2026-10-12):
    // a breach nobody has attributed yet, or a level-4 complaint awaiting the
    // Staff Officer's remark — both carried on each complaint in the list
    const br = (await sys(`INSERT INTO sla_breach (ticket_id, clock) VALUES ($1, 'COMPLETION') RETURNING id`, [t.id])).rows[0];
    let row = (await j(await call(ovr.token, '/tickets'))).items?.find((x) => x.id === t.id);
    check('L4 the list says a breach is waiting to be attributed', row?.breach_unattributed === true, short(row));
    check('L4 and no longer that the level-4 remark is needed', row?.l4_remark_needed === false, short(row));
    r = await call(ovr.token, `/breaches/${br.id}/attribute`, 'POST', { attribution: 'DEPARTMENT', note: 'Inspection was late' });
    row = (await j(await call(ovr.token, '/tickets'))).items?.find((x) => x.id === t.id);
    check('L4 once attributed, the complaint needs no decision', r.status === 200 && row?.breach_unattributed === false, `${r.status} ${short(row)}`);
    r = await call(ovr.token, `/tickets/${t.id}/close`, 'POST');
    check('L4 then the Overseer closes it', r.status === 200, `${r.status} ${short(await j(r))}`);
    let deleted = false;
    try { await sys(`DELETE FROM escalation_event WHERE ticket_id = $1`, [t.id]); deleted = true; } catch { /* refused */ }
    check('L4 an escalation record is never deleted, not even by the system', !deleted);
    release(t);
  });

  /* ================= D4 — before and after photographs (required from here on) ================= */
  await attempt('D4 photographs needed to claim', async () => {
    const t = await assigned('Photographs: only an after photograph');
    await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
    let u = await uploadPhoto(BASE, sup.token, t.id, 'COMPLETION');
    check('D4 (setup) an after photograph is accepted', u.ok, `${u.status} ${short(u.body)}`);
    let r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('D4 claiming with only an after photograph is refused', r.status === 422, `${r.status} ${short(await j(r))}`);
    check('D4 the job stays in progress', (await stateOf(t)).state === 'IN_PROGRESS');
    u = await uploadPhoto(BASE, sup.token, t.id, 'BEFORE');
    check('D4 a before photograph is accepted', u.ok, `${u.status} ${short(u.body)}`);
    r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('D4 with one of each the claim is accepted', r.status === 200, `${r.status} ${short(await j(r))}`);
    check('D4 the job is WORK_COMPLETED', (await stateOf(t)).state === 'WORK_COMPLETED');
    u = await uploadPhoto(BASE, ovr.token, t.id, 'BEFORE');
    check('D4 the Overseer cannot upload a before photograph', !u.ok && u.status === 403, `${u.status} ${short(u.body)}`);
    release(t);
  });

  await attempt('D4 only before', async () => {
    const t = await assigned('Photographs: only a before photograph');
    await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
    await uploadPhoto(BASE, sup.token, t.id, 'BEFORE');
    let r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('D4 claiming with only a before photograph is refused', r.status === 422, `${r.status} ${short(await j(r))}`);
    r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('D4 and refused again, nothing slipped through', r.status === 422 && (await stateOf(t)).state === 'IN_PROGRESS', `${r.status}`);
    await uploadPhoto(BASE, sup.token, t.id, 'COMPLETION');
    r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('D4 adding the after photograph lets it through', r.status === 200, `${r.status} ${short(await j(r))}`);
    release(t);
  });

  await attempt('D4 limit and rounds', async () => {
    const t = await assigned('Photographs: three at most, fresh each round');
    await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
    for (const p of ['BEFORE', 'COMPLETION']) {
      for (let n = 1; n <= 3; n++) {
        const u = await uploadPhoto(BASE, sup.token, t.id, p);
        check(`D4 ${p === 'BEFORE' ? 'before' : 'after'} photograph ${n} of 3 is accepted`, u.ok, `${u.status} ${short(u.body)}`);
      }
      const u4 = await uploadPhoto(BASE, sup.token, t.id, p);
      check(`D4 the fourth ${p === 'BEFORE' ? 'before' : 'after'} photograph in a round is refused`, !u4.ok && u4.status === 422, `${u4.status} ${short(u4.body)}`);
    }
    let r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('D4 the claim still goes through with three of each', r.status === 200, `${r.status} ${short(await j(r))}`);

    await uploadInspection(BASE, ovr.token, t.id);
    r = await call(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: false, remark: 'Photographs show the crack is still there' });
    check('D4 (setup) the Overseer sends it back', r.status === 200 && (await stateOf(t)).state === 'REWORK', `${r.status}`);

    r = await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Shyam Lal' });
    check('D4 (setup) the contractor starts the new round', r.status === 200, `${r.status} ${short(await j(r))}`);
    r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('D4 the new round cannot be claimed on the old photographs', r.status === 422, `${r.status}`);
    await uploadPhoto(BASE, sup.token, t.id, 'BEFORE');
    r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('D4 nor with a fresh before photograph alone', r.status === 422, `${r.status}`);
    const b = await uploadPhoto(BASE, sup.token, t.id, 'BEFORE');
    check('D4 the count restarts in the new round (a second before photograph is fine)', b.ok, `${b.status} ${short(b.body)}`);
    await uploadPhoto(BASE, sup.token, t.id, 'COMPLETION');
    r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    check('D4 with fresh photographs of both kinds the new round is claimed', r.status === 200, `${r.status} ${short(await j(r))}`);

    const card = await j(await call(ovr.token, `/tickets/${t.id}/job-card`));
    const R = card.lifecycle?.rounds || [];
    check('D4 the job card counts round 1\'s photographs: 3 before, 3 after', R[0]?.photos?.before === 3 && R[0]?.photos?.after === 3, short(R.map((x) => x.photos)));
    check('D4 and round 2\'s: 2 before, 1 after', R[1]?.photos?.before === 2 && R[1]?.photos?.after === 1, short(R.map((x) => x.photos)));
    release(t);
  });

  /* D4b — the occupant's photographs (user's finding, 2026-10-10): up to
     three at each step, as the contractor's; and an objection's photograph
     never reaches the contractor (README §2: they cannot see objections). */
  await attempt('D4b occupant photographs', async () => {
    const t = await raise('Photographs: the occupant takes three');
    for (let n = 1; n <= 3; n++) {
      // where the phone was is recorded with every photograph (user's request, 2026-10-12)
      const u = await uploadPhoto(BASE, resident.token, t.id, 'COMPLAINT', { latitude: 24.1102 + n / 1e4, longitude: 82.6531, gps_accuracy_m: 4 + n });
      check(`D4b complaint photograph ${n} of 3 at raising is accepted`, u.ok, `${u.status} ${short(u.body)}`);
    }
    let u = await uploadPhoto(BASE, resident.token, t.id, 'COMPLAINT');
    check('D4b a fourth photograph at raising is refused', !u.ok && u.status === 422, `${u.status} ${short(u.body)}`);
    // where it was taken is compulsory on every photograph (user's decision, 2026-10-12)
    const t2 = await raise('Photographs: no location, no photograph');
    u = await uploadPhoto(BASE, resident.token, t2.id, 'COMPLAINT', { latitude: null, longitude: null });
    check("D4b an occupant's photograph without a location is refused", !u.ok && u.status === 422, `${u.status} ${short(u.body)}`);
    u = await uploadPhoto(BASE, resident.token, t2.id, 'COMPLAINT', { latitude: 24.11, longitude: null });
    check('D4b nor with half a location', !u.ok && u.status === 422, `${u.status}`);
    release(t2);

    await call(ovr.token, `/tickets/${t.id}/verify`, 'POST');
    await call(inc.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: verma.actor_id });
    await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
    u = await uploadPhoto(BASE, sup.token, t.id, 'BEFORE', { latitude: null, longitude: null });
    check('D4b the contractor\'s "before" photograph without a location is refused', !u.ok && u.status === 422, `${u.status} ${short(u.body)}`);
    const objPhotos = [];
    for (let n = 1; n <= 3; n++) {
      u = await uploadPhoto(BASE, resident.token, t.id, 'OBJECTION');
      if (u.media_id) objPhotos.push(u.media_id);
      check(`D4b objection photograph ${n} of 3 while work is under way is accepted`, u.ok, `${u.status} ${short(u.body)}`);
    }
    u = await uploadPhoto(BASE, resident.token, t.id, 'OBJECTION');
    check('D4b a fourth objection photograph at this step is refused', !u.ok && u.status === 422, `${u.status} ${short(u.body)}`);
    await call(resident.token, `/tickets/${t.id}/objections`, 'POST', { note: 'Workmen left the tap half fitted' });

    const asContractor = await j(await call(sup.token, `/tickets/${t.id}`));
    const seen = (asContractor.media || []).filter((m) => m.purpose === 'OBJECTION');
    check('D4b the contractor\'s view of the complaint lists no objection photograph', Array.isArray(asContractor.media) && seen.length === 0, short(asContractor.media));
    const img = await call(sup.token, `/media/${objPhotos[0]}/image`);
    check('D4b nor can the contractor open one by its id', img.status === 404, `${img.status}`);
    const ovrImg = await call(ovr.token, `/media/${objPhotos[0]}/image`);
    check('D4b the Overseer can open it', ovrImg.status === 200, `${ovrImg.status}`);
    const asOccupant = await j(await call(resident.token, `/tickets/${t.id}`));
    check('D4b the occupant sees their own photographs on the complaint',
      (asOccupant.media || []).filter((m) => m.purpose === 'COMPLAINT').length === 3 && (asOccupant.media || []).filter((m) => m.purpose === 'OBJECTION').length === 3,
      short((asOccupant.media || []).map((m) => m.purpose)));
    const placed = (asOccupant.media || []).filter((m) => m.purpose === 'COMPLAINT');
    check('D4b each occupant photograph carries where it was taken, as numbers, with its accuracy',
      placed.length === 3 && placed.every((m) => typeof m.latitude === 'number' && typeof m.longitude === 'number' && typeof m.gps_accuracy_m === 'number')
        && placed.some((m) => Math.abs(m.latitude - 24.1103) < 1e-6 && m.gps_accuracy_m === 5),
      short(placed.map((m) => [m.latitude, m.longitude, m.gps_accuracy_m])));
    release(t);
  });

  /* ================= D7 — reviews are never shown to the contractor ================= */
  await attempt('D7 contractor and money', async () => {
    if (!A) throw new Error('no repeat-dispute complaint from D3');
    // A was assigned to the supervisor, so the supervisor sees the complaint itself
    let r = await call(sup.token, `/tickets/${A.id}`);
    const sv = await j(r);
    check('D7 the supervisor can see the complaint it worked on', r.status === 200 && sv.id === A.id, `${r.status}`);
    check('D7 but its reviews are empty or absent', !sv.reviews || sv.reviews.length === 0, short(sv.reviews));
    r = await call(sup.token, `/tickets/${A.id}/reviews`);
    check('D7 the supervisor gets "not found" on the complaint\'s reviews', r.status === 404, `${r.status}`);
    r = await call(firm.token, `/tickets/${A.id}/reviews`);
    check('D7 the contractor firm too', r.status === 404, `${r.status}`);
    const sp = listOf(await j(await call(sup.token, '/reviews?pending=true')));
    const fp = listOf(await j(await call(firm.token, '/reviews?pending=true')));
    check('D7 neither has a pending list', sp.length === 0 && fp.length === 0, short({ sp, fp }));
    r = await call(sup.token, `/reviews/${A.reviewId}/decide`, 'POST', { outcome: 'CLOSE', decision: 'Contractor deciding' });
    check('D7 the contractor cannot decide a review', r.status === 403 || r.status === 404, `${r.status}`);
    const cview = JSON.stringify(sv);
    check('D7 the supervisor\'s view does not carry the Staff Officer\'s text', !/damp course/.test(cview), cview.slice(0, 200));

    const bodies = [
      await j(await call(resident.token, `/tickets/${A.id}/reviews`)),
      await j(await call(so.token, `/tickets/${A.id}/reviews`)),
      await j(await call(resident.token, `/tickets/${t1.id}/reviews`)),
      await j(await call(so.token, '/reviews?pending=true')),
      (await j(await call(so.token, `/contracts/${contractId}/performance`))).repeat_complaints || []
    ];
    const bad = moneyKeys(bodies);
    check('D7 no review or repeat-complaint row carries a rate, price, amount or cost', bad.length === 0, bad.join(','));
    check('D7 (setup) there was something to inspect', JSON.stringify(bodies).length > 200, JSON.stringify(bodies).slice(0, 100));
  });

  /* ================= D6 — search ================= */
  await attempt('D6 search', async () => {
    const water = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: cats.find((c) => c.name_en.startsWith('No water supply')).id, description: 'Gurgling noise and no flow since morning' }));
    const leak = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: cats.find((c) => c.name_en.startsWith('Leaking tap')).id, description: 'Bucket fills every night' }));
    const wc = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: cats.find((c) => c.name_en.startsWith('WC or pan blocked')).id, description: 'Flushing is slow' }));
    if (!water.id || !leak.id || !wc.id) throw new Error(`raise ${short([water, leak, wc])}`);
    const find = async (tok, q) => { const r = await call(tok, `/search?q=${encodeURIComponent(q)}`); return { status: r.status, ids: idsOf(await j(r)) }; };

    let s = await find(ovr.token, 'water');
    check('D6 "water" finds the "No water supply" complaint', s.status === 200 && s.ids.includes(water.id), `${s.status} ${s.ids.length}`);
    s = await find(ovr.token, 'wat');
    check('D6 a word beginning finds it too', s.ids.includes(water.id), `${s.ids.length}`);
    s = await find(ovr.token, 'leak');
    check('D6 "leak" finds the "Leaking tap" complaint', s.ids.includes(leak.id), `${s.ids.length}`);
    s = await find(ovr.token, 'B-234');
    check('D6 the premises identifier finds that quarter\'s complaints', s.ids.includes(water.id) && s.ids.includes(leak.id) && s.ids.includes(wc.id), `${s.ids.length}`);
    s = await find(ovr.token, 'WC');
    check('D6 "WC" finds the blocked WC complaint', s.ids.includes(wc.id), `${s.ids.length}`);
    s = await find(ovr.token, 'gurgling');
    check('D6 a word of the description finds it', s.ids.includes(water.id) && !s.ids.includes(wc.id), `${s.ids.length}`);
    s = await find(ovr.token, water.ticket_no);
    check('D6 the complaint number finds it', s.ids.includes(water.id), `${s.ids.length}`);
    s = await find(ovr.token, 'plumbing');
    check('D6 a word of the category name finds its complaints', s.ids.includes(water.id), `${s.ids.length}`);
    s = await find(resident.token, 'water');
    check('D6 the occupant finds her own complaint', s.ids.includes(water.id), `${s.status} ${s.ids.length}`);

    const other = await call(ngh.token, '/search?q=water');
    const otherBody = await j(other);
    const otherIds = idsOf(otherBody);
    check('D6 the Overseer of another Area finds none of Jayant\'s complaints', other.status === 200 && !otherIds.includes(water.id) && !/B-234/.test(JSON.stringify(otherBody)), `${other.status} ${otherIds.length}`);
    s = await find(ngh.token, 'B-234');
    check('D6 nor by its premises identifier', !s.ids.includes(water.id) && !s.ids.includes(leak.id), `${s.ids.length}`);
    s = await find(ngh.token, water.ticket_no);
    check('D6 nor by its complaint number', !s.ids.includes(water.id), `${s.ids.length}`);
  });
}

run().catch((e) => { check('suite ran to the end', false, e.stack); })
  .finally(async () => {
    for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n         ${d}` : ''}`);
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await maintPool.end().catch(() => {}); await identityPool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
