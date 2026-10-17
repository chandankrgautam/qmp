/**
 * Suite 25 — the approval chain for a job's materials (user's decisions,
 * 2026-10-16; README §5.5 "Materials and measurements after the work").
 *
 * Written before the code.
 *
 *   S1  every job gets a materials sheet when first assigned, at the
 *       supervisor's step; read by the officers and the contractor, never by
 *       an occupant or another Area
 *   S2  up to closure nothing changes: lines claimed while the work is under
 *       way, verified by the Overseer or Incharge before closure
 *   S3  after the work the supervisor may still add lines, until he sends the
 *       sheet for review; after that he changes nothing unless it comes back
 *   S4  the Overseer and the Incharge, each at their own step: change a
 *       quantity (with a reason), add a missed line, pass it up (or "reviewed
 *       — no change"), or send it back one step with a remark; never out of
 *       turn; the person who claimed a line never verifies it
 *   S5  the Staff Officer approves, or changes (with a reason) and approves,
 *       or sends it back; after approval only he changes, always with a
 *       reason; until the MB is approved he may send approved materials back
 *   S6  every hand-over is recorded: action, step, role, remark; officers see
 *       names, the contractor sees roles only
 *
 * Needs a freshly reset and seeded database.
 */
import fs from 'node:fs';
import { signNonce } from './auth.js';
import { withSystem, maintPool, identityPool } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => { if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); } };
async function attempt(n, fn) { try { await fn(); } catch (e) { check(n, false, `threw: ${e.message}`.slice(0, 240)); } }

const json = { 'content-type': 'application/json' };
const call = (tok, p, method = 'GET', b) => fetch(`${BASE}/maintenance/v1${p}`, { method,
  headers: { ...json, authorization: `Bearer ${tok}` }, body: b ? JSON.stringify(b) : undefined });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const short = (x) => String(JSON.stringify(x)).slice(0, 260);
const sysM = (sql, p) => withSystem(maintPool, (c) => c.query(sql, p));

async function as(key, role) {
  const d = devices[key];
  const post = (p, b) => fetch(`${BASE}/identity/v1${p}`, { method: 'POST', headers: json, body: JSON.stringify(b) });
  const ch = await (await post('/auth/challenge', { public_key: d.publicKey })).json();
  return (await post('/auth/token', { public_key: d.publicKey, nonce: ch.nonce,
    signature: signNonce(d.privateKey, ch.nonce), second_factor_satisfied: true, role: role || d.role })).json();
}

async function run() {
  const resident = await as('RESIDENT:R. K. Singh');
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey', 'CIVIL_OVERSEER');
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra', 'MAINTENANCE_INCHARGE');
  const so = await as('STAFF_OFFICER_CIVIL:S. Tiwari', 'STAFF_OFFICER_CIVIL');
  const sup = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const firm = await as('CONTRACTOR:M/s Jayant Constructions');
  const ngh = await as('CIVIL_OVERSEER:Nigahi Overseer');
  const cats = await j(await call(resident.token, '/masters/categories'));
  const sub = cats.find((c) => c.classification !== 'EM' && !c.emergency_eligible) || cats[0];
  const mats = await j(await call(sup.token, '/materials'));
  const verma = (await j(await call(inc.token, '/devices/assignable'))).find((a) => a.person_name === 'M/s Verma — Supr');
  const step = async (tok, id, p, body) => {
    const r = await call(tok, `/tickets/${id}/${p}`, 'POST', body);
    if (r.status !== 200) throw new Error(`${p} ${r.status} ${short(await j(r))}`);
  };
  async function job(desc) {
    const t = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: sub.id, description: desc }));
    if (!t.id) throw new Error(`raise ${short(t)}`);
    await step(ovr.token, t.id, 'verify');
    await step(inc.token, t.id, 'assign', { supervisor_id: verma.actor_id });
    return t;
  }
  const sheet = async (tok, id) => (await j(await call(tok, `/tickets/${id}/sheets`))).materials;
  const act = (tok, id, action, body) => call(tok, `/tickets/${id}/sheets/materials/${action}`, 'POST', body || {});
  const claim = (tok, id, qty) => call(tok, `/tickets/${id}/materials`, 'POST', { material_id: mats[0].id, qty_claimed: qty });
  const verify = (tok, id, line, qty, reason) => call(tok, `/tickets/${id}/materials/${line}/verify`, 'POST', { qty_verified: qty, reason });

  /* ------------------------------------------------------------ S1 */
  let t;
  await attempt('S1 the sheet', async () => {
    t = await job('Suite 25: tiles loose in the bathroom');
    const s = await sheet(ovr.token, t.id);
    check('S1 a materials sheet exists once the job is assigned', !!s, short(s));
    check('S1 and it starts at the supervisor’s step', s?.stage === 'SUPERVISOR', short(s));
    check('S1 the supervisor reads it', (await sheet(sup.token, t.id))?.stage === 'SUPERVISOR', '');
    check('S1 the firm reads it', (await sheet(firm.token, t.id))?.stage === 'SUPERVISOR', '');
    const r = await call(resident.token, `/tickets/${t.id}/sheets`);
    check('S1 the occupant does not', r.status === 404, `${r.status}`);
    const n = await call(ngh.token, `/tickets/${t.id}/sheets`);
    check('S1 nor another Area', n.status === 404, `${n.status}`);
  });

  /* ------------------------------------------------------------ S2, S3 */
  let line1, line2;
  await attempt('S2 S3 before and after the work', async () => {
    await step(sup.token, t.id, 'start', { workmen_assigned: 'Ram Prasad' });
    line1 = await j(await claim(sup.token, t.id, 4));
    check('S2 a line is claimed while the work is under way, as before', !!line1.id, short(line1));
    let r = await act(sup.token, t.id, 'submit');
    check('S3 it cannot be sent for review before the completion claim', r.status === 422, `${r.status} ${short(await j(r))}`);
    await step(sup.token, t.id, 'complete');
    await step(ovr.token, t.id, 'inspect', { accepted: true });
    await step(ovr.token, t.id, 'close');
    r = await claim(sup.token, t.id, 2);
    line2 = await j(r);
    check('S3 after closure the supervisor still adds a line', [200, 201].includes(r.status) && !!line2.id, `${r.status} ${short(line2)}`);
    r = await verify(ovr.token, t.id, line1.id, 4);
    check('S3 the Overseer does not verify before the sheet reaches him (after closure)', r.status >= 400, `${r.status}`);
    r = await act(inc.token, t.id, 'submit');
    check('S3 only the supervisor sends it for review', r.status === 403, `${r.status}`);
    r = await act(sup.token, t.id, 'submit');
    check('S3 the supervisor sends it for review', r.status === 200, `${r.status} ${short(await j(r))}`);
    check('S3 it is now at the Overseer’s step', (await sheet(ovr.token, t.id))?.stage === 'OVERSEER', '');
    r = await claim(sup.token, t.id, 1);
    check('S3 after that the supervisor adds nothing', r.status >= 400, `${r.status}`);
    r = await call(sup.token, `/tickets/${t.id}/materials/${line2.id}/withdraw`, 'POST', { reason: 'Entered twice' });
    check('S3 nor withdraws', r.status >= 400, `${r.status}`);
  });

  /* ------------------------------------------------------------ S4 */
  let added;
  await attempt('S4 the Overseer and the Incharge', async () => {
    let r = await act(inc.token, t.id, 'pass');
    check('S4 the Incharge cannot act out of turn', r.status === 403, `${r.status}`);
    r = await verify(inc.token, t.id, line1.id, 3, 'Counted');
    check('S4 nor change a quantity out of turn', r.status >= 400, `${r.status}`);
    r = await verify(ovr.token, t.id, line1.id, 3);
    check('S4 the Overseer’s change needs a reason', r.status === 422, `${r.status} ${short(await j(r))}`);
    r = await verify(ovr.token, t.id, line1.id, 3, 'Four bags were not used; three counted on site');
    check('S4 with a reason, the Overseer changes the quantity', r.status === 200, `${r.status} ${short(await j(r))}`);
    r = await claim(ovr.token, t.id, 1);
    added = await j(r);
    check('S4 the Overseer adds a missed line', [200, 201].includes(r.status) && !!added.id, `${r.status} ${short(added)}`);
    r = await verify(ovr.token, t.id, added.id, 1, 'mine');
    check('S4 but does not verify the line he added himself', r.status === 403, `${r.status}`);
    r = await act(ovr.token, t.id, 'return');
    check('S4 sending back needs a remark', r.status === 422, `${r.status}`);
    r = await act(ovr.token, t.id, 'return', { remark: 'Line 2: which material? Check and send again' });
    check('S4 the Overseer sends it back to the supervisor', r.status === 200 && (await sheet(sup.token, t.id))?.stage === 'SUPERVISOR', `${r.status}`);
    r = await claim(sup.token, t.id, 1);
    check('S4 sent back, the supervisor may add again', [200, 201].includes(r.status), `${r.status} ${short(await j(r))}`);
    await act(sup.token, t.id, 'submit');
    r = await act(ovr.token, t.id, 'pass-no-change');
    check('S4 "reviewed — no change" passes it to the Incharge', r.status === 200 && (await sheet(inc.token, t.id))?.stage === 'INCHARGE', `${r.status} ${short(await j(r))}`);
    r = await verify(ovr.token, t.id, line1.id, 2, 'late');
    check('S4 the Overseer changes nothing once it has gone up', r.status >= 400, `${r.status}`);
    r = await verify(inc.token, t.id, added.id, 1, 'Seen on site');
    check('S4 the Incharge verifies the Overseer’s added line', r.status === 200, `${r.status} ${short(await j(r))}`);
    r = await act(inc.token, t.id, 'pass');
    check('S4 the Incharge passes it to the Staff Officer', r.status === 200 && (await sheet(so.token, t.id))?.stage === 'STAFF_OFFICER', `${r.status}`);
  });

  /* ------------------------------------------------------------ S5 */
  await attempt('S5 the Staff Officer', async () => {
    let r = await act(ovr.token, t.id, 'approve');
    check('S5 only the Staff Officer approves', r.status === 403, `${r.status}`);
    r = await verify(so.token, t.id, line2.id, 2, 'As claimed');
    check('S5 the Staff Officer may change a quantity at his step', r.status === 200, `${r.status} ${short(await j(r))}`);
    r = await act(so.token, t.id, 'approve');
    check('S5 and approves', r.status === 200 && (await sheet(so.token, t.id))?.stage === 'APPROVED', `${r.status} ${short(await j(r))}`);
    r = await verify(inc.token, t.id, line1.id, 2, 'after approval');
    check('S5 after approval the Incharge changes nothing', r.status >= 400, `${r.status}`);
    r = await claim(sup.token, t.id, 1);
    check('S5 nor the supervisor', r.status >= 400, `${r.status}`);
    r = await verify(so.token, t.id, line1.id, 2);
    check('S5 the Staff Officer’s change after approval needs a reason', r.status === 422, `${r.status}`);
    r = await verify(so.token, t.id, line1.id, 2, 'Correction: two bags, as per the store issue slip');
    check('S5 with a reason he changes it after approval', r.status === 200, `${r.status} ${short(await j(r))}`);
    r = await act(so.token, t.id, 'reopen');
    check('S5 sending approved materials back needs a remark', r.status === 422, `${r.status}`);
    r = await act(so.token, t.id, 'reopen', { remark: 'The measurements show more tiles laid; recheck the adhesive' });
    check('S5 until the MB is approved he may send approved materials back down', r.status === 200 && (await sheet(inc.token, t.id))?.stage === 'INCHARGE', `${r.status} ${short(await j(r))}`);
  });

  /* ------------------------------------------------------------ S6 */
  await attempt('S6 the record', async () => {
    const s = await sheet(ovr.token, t.id);
    const acts = (s.events || []).map((e) => e.action);
    check('S6 every hand-over is recorded, in order', short(acts) === short(['SUBMIT', 'RETURN', 'SUBMIT', 'PASS_NO_CHANGE', 'PASS', 'APPROVE', 'REOPEN']), short(acts));
    const ret = (s.events || []).find((e) => e.action === 'RETURN');
    check('S6 with the step, role and remark', ret?.from_stage === 'OVERSEER' && ret?.to_stage === 'SUPERVISOR' && ret?.actor_role === 'CIVIL_OVERSEER' && /which material/.test(ret?.remark || ''), short(ret));
    check('S6 officers see who', !!ret?.actor_name, short(ret));
    const cs = await sheet(sup.token, t.id);
    const cret = (cs.events || []).find((e) => e.action === 'RETURN');
    check('S6 the contractor sees the role and the remark', cret?.actor_role === 'CIVIL_OVERSEER' && /which material/.test(cret?.remark || ''), short(cret));
    check('S6 but not the officer’s name', !cret?.actor_name, short(cret));
    check('S6 the sheet says how long it has waited at this step', !!s.stage_since, short(s));
    const h = await j(await call(ovr.token, `/tickets/${t.id}/materials/history`));
    const kinds = (Array.isArray(h) ? h : h.items || []).map((x) => x.event_type);
    check('S6 every change of quantity is in the materials history', kinds.filter((k) => /VERIFIED/.test(k)).length >= 4, short(kinds));
    const nob = await sysM(`SELECT count(*)::int n FROM job_sheet_event`);
    let refused = false;
    try { await sysM(`DELETE FROM job_sheet_event`); } catch { refused = true; }
    check('S6 the record cannot be deleted', refused && (await sysM(`SELECT count(*)::int n FROM job_sheet_event`)).rows[0].n === nob.rows[0].n, '');
  });

  /* ------------------------------------------------------------ S2 again */
  await attempt('S2 verification before closure is as before', async () => {
    const t2 = await job('Suite 25: a door hinge');
    await step(sup.token, t2.id, 'start', { workmen_assigned: 'Sunil' });
    const l = await j(await claim(sup.token, t2.id, 2));
    await step(sup.token, t2.id, 'complete');
    const r = await verify(ovr.token, t2.id, l.id, 2);
    check('S2 the Overseer verifies after the claim and before closure, as before', r.status === 200, `${r.status} ${short(await j(r))}`);
    const r2 = await verify(sup.token, t2.id, l.id, 2);
    check('S2 the supervisor never verifies', r2.status === 403, `${r2.status}`);
  });
}

run().catch((e) => check('suite ran to the end', false, e.stack))
  .finally(async () => {
    for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n         ${d}` : ''}`);
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await maintPool.end().catch(() => {}); await identityPool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
