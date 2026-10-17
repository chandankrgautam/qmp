/**
 * Suite 13 — materials, record only (decision 2026-09-30, item 9).
 *
 * Written from the specification alone, to check the implementation
 * independently of whoever built it.
 *
 *   M1  the master: written only by the HQ System Administrator, never
 *       deleted, changes audited with a reason, code fixed, inactive
 *       materials cannot be claimed
 *   M2  claim lines: only the assigned supervisor, only while the job is in
 *       their hands; lines never edited or deleted, only withdrawn
 *   M3  verification: Overseer or Incharge, after the completion claim and
 *       before closure; two-key by person; re-verifying needs a reason;
 *       every step audited
 *   M4  reports: totals match what was claimed and verified; the four
 *       anomaly flags; who may read; Area isolation; CSV
 *   M5  evidence only: no rate, price, amount or money anywhere (control 9)
 *
 * Needs a freshly reset and seeded database.
 */
import fs from 'node:fs';
import { signNonce } from './auth.js';
import { uploadCompletion, uploadInspection } from './testutil.js';
import { withScope, withSystem, maintPool, identityPool } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => { if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); } };
async function attempt(n, fn) { try { await fn(); } catch (e) { check(n, false, `threw: ${e.message}`.slice(0, 220)); } }

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
const call = (tok, p, method = 'GET', b) => fetch(`${BASE}/maintenance/v1${p}`, { method,
  headers: { ...json, authorization: `Bearer ${tok}` }, body: b ? JSON.stringify(b) : undefined });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const sys = (sql, params) => withSystem(maintPool, (c) => c.query(sql, params));
const short = (x) => JSON.stringify(x).slice(0, 220);

/* Every key anywhere in a JSON value that looks like money. The audit
   entries' own wrapper keys (before_value, after_value) are not money. */
const MONEY = /rate|price|amount|cost|value|₹/i;
function moneyKeys(o, found = []) {
  if (Array.isArray(o)) o.forEach((x) => moneyKeys(x, found));
  else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (MONEY.test(k) && k !== 'before_value' && k !== 'after_value') found.push(k);
      moneyKeys(v, found);
    }
  }
  return found;
}

async function run() {
  const resident = await as('RESIDENT:R. K. Singh');
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey');
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
  const so = await as('STAFF_OFFICER_CIVIL:S. Tiwari');
  const gm = await as('GM_CIVIL:GM (Civil)');
  const sup = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const firm = await as('CONTRACTOR:M/s Jayant Constructions');
  const ngh = await as('CIVIL_OVERSEER:Nigahi Overseer');
  const adm = await as('ADMINISTRATOR:System Admin');
  const hr = await as('AREA_HR_ADMIN:R. Kumar');
  const hq = await device('HQ_EXECUTIVE:CMD', { role: 'HQ_EXECUTIVE' });

  const contractId = (await sys(`SELECT id FROM contract WHERE agreement_no='NCL/JNT/CIV/2026/01'`)).rows[0].id;
  const claims = (t, role, extra = {}) => ({ role, scope_path: t.scope_path, actor_id: t.actor_id, person_id: t.person_id, ...extra });
  const cats = await j(await call(resident.token, '/masters/categories'));
  const sub = (p) => cats.find((c) => c.name_en.startsWith(p));
  const assignable = await j(await call(inc.token, '/devices/assignable'));
  const verma = assignable.find((a) => a.person_name === 'M/s Verma — Supr');

  /* A complaint raised, verified and assigned to the given supervisor role. */
  async function assigned(prefix, supActorId) {
    const t = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: sub(prefix).id, description: `Materials test: ${prefix}` }));
    if (!t.id) throw new Error(`raise ${short(t)}`);
    await call(ovr.token, `/tickets/${t.id}/verify`, 'POST');
    const r = await call(inc.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: supActorId });
    if (r.status !== 200) throw new Error(`assign ${r.status} ${short(await j(r))}`);
    return t;
  }
  const start = (t, tok) => call(tok, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
  async function complete(t, tok) {
    await uploadCompletion(BASE, tok, t.id);
    const r = await call(tok, `/tickets/${t.id}/complete`, 'POST');
    if (r.status !== 200) throw new Error(`complete ${r.status} ${short(await j(r))}`);
  }
  const stateOf = async (t) => (await sys(`SELECT state FROM ticket WHERE id=$1`, [t.id])).rows[0].state;

  const tag = String(Date.now() % 1000000);
  const codeA = `T13A${tag}`, codeB = `T13B${tag}`, codeC = `T13C${tag}`, codeD = `T13D${tag}`;
  const nameA = `Test norm item ${tag}`, nameB = `Test plain item ${tag}`;
  let matA, matB, matC, matD;

  /* ================= M1 — the master ================= */
  await attempt('M1 setup', async () => {
    let r = await call(adm.token, '/materials', 'POST', { code: codeA, name_en: nameA, name_hi: 'परीक्षण', unit: 'No.', category: 'Plumbing', norm_max_per_job: 2 });
    matA = await j(r);
    check('M1 the HQ System Administrator adds a material', r.status === 201 && matA.code === codeA && !!matA.id && matA.active === true, `${r.status} ${short(matA)}`);
    check('M1 the new material carries its unit and norm', matA.unit === 'No.' && Number(matA.norm_max_per_job) === 2, short(matA));
    matB = await j(await call(adm.token, '/materials', 'POST', { code: codeB, name_en: nameB, name_hi: 'परीक्षण दो', unit: 'Kg', category: 'Civil' }));
    matC = await j(await call(adm.token, '/materials', 'POST', { code: codeC, name_en: `Test retired item ${tag}`, name_hi: 'परीक्षण तीन', unit: 'Set' }));
    matD = await j(await call(adm.token, '/materials', 'POST', { code: codeD, name_en: `Test item D ${tag}`, name_hi: 'परीक्षण चार', unit: 'Rm' }));
    check('M1 a material with no norm is allowed', !!matB.id && (matB.norm_max_per_job === null || matB.norm_max_per_job === undefined), short(matB));

    const body = { code: `X${codeA}`, name_en: 'x', name_hi: 'x', unit: 'No.' };
    for (const [who, tok] of [['the Civil Incharge', inc], ['the contractor', firm], ['the supervisor', sup], ['the Staff Officer', so], ['the resident', resident]]) {
      r = await call(tok.token, '/materials', 'POST', body);
      check(`M1 ${who} cannot add a material`, r.status === 403, `${r.status}`);
    }
    r = await call(adm.token, '/materials', 'POST', { code: codeA, name_en: 'dup', name_hi: 'dup', unit: 'No.' });
    check('M1 a duplicate code is refused with 409', r.status === 409, `${r.status}`);
    r = await call(adm.token, '/materials', 'POST', { code: `Z${codeA}`, unit: 'No.' });
    check('M1 missing fields are refused with 422', r.status === 422, `${r.status}`);
    r = await call(adm.token, '/materials', 'POST', { code: `Y${codeA}`, name_en: 'y', name_hi: 'y', unit: 'No.', norm_max_per_job: 0 });
    check('M1 a norm of zero is refused with 422', r.status === 422, `${r.status}`);
    r = await call(adm.token, '/materials', 'POST', { code: `W${codeA}`, name_en: 'w', name_hi: 'w', unit: 'No.', norm_max_per_job: -3 });
    check('M1 a negative norm is refused with 422', r.status === 422, `${r.status}`);

    r = await call(resident.token, '/materials');
    const list = await j(r);
    check('M1 a resident can read the master', r.status === 200 && Array.isArray(list) && list.some((m) => m.code === codeA), `${r.status}`);
    check('M1 the seeded common materials are there (cement among them)',
      list.length >= 10 && list.some((m) => /cement/i.test(m.name_en)), `${list.length}`);
    for (const [who, tok] of [['the contractor firm', firm], ['the supervisor', sup], ['the GM', gm]]) {
      r = await call(tok.token, '/materials');
      check(`M1 ${who} can read the master`, r.status === 200, `${r.status}`);
    }

    r = await call(adm.token, `/materials/${matA.id}`, 'PUT', { norm_max_per_job: 3 });
    check('M1 changing a material needs a reason', r.status === 422, `${r.status}`);
    r = await call(adm.token, `/materials/${matA.id}`, 'PUT', { norm_max_per_job: 3, reason: 'Norm widened after review' });
    let upd = await j(r);
    check('M1 with a reason it is changed', r.status === 200 && Number(upd.norm_max_per_job) === 3, `${r.status} ${short(upd)}`);
    r = await call(adm.token, `/materials/${matA.id}`, 'PUT', { norm_max_per_job: 2, reason: 'Norm restored' });
    check('M1 (setup) the norm is put back to 2', r.status === 200 && Number((await j(r)).norm_max_per_job) === 2, `${r.status}`);
    const aud = (await sys(`SELECT reason FROM audit_log WHERE entity_id::text=$1 AND reason IS NOT NULL`, [matA.id])).rows;
    check('M1 the change is audit-logged with its reason', aud.some((a) => /Norm widened/.test(a.reason || '')), short(aud));
    r = await call(adm.token, `/materials/${matA.id}`, 'PUT', { code: `${codeA}2`, reason: 'rename' });
    check('M1 the code can never be changed', r.status === 422, `${r.status}`);
    const stillCode = (await sys(`SELECT code FROM material WHERE id=$1`, [matA.id])).rows[0].code;
    check('M1 and the stored code is unchanged', stillCode === codeA, stillCode);
    for (const [who, tok] of [['the Civil Incharge', inc], ['the contractor', firm]]) {
      r = await call(tok.token, `/materials/${matA.id}`, 'PUT', { norm_max_per_job: 9, reason: 'trying' });
      check(`M1 ${who} cannot change a material`, r.status === 403, `${r.status}`);
    }

    let refused = false;
    try {
      await withScope(maintPool, claims(inc, 'MAINTENANCE_INCHARGE'), async (c) => {
        await c.query(`SELECT set_config('app.reason','sneaky',true)`);
        const x = await c.query(`INSERT INTO material(code,name_en,name_hi,unit,category) VALUES ($1,'s','s','No.','Civil')`, [`DB${codeA}`]);
        if (!x.rowCount) throw new Error('no row');
      });
    } catch { refused = true; }
    const slipped = (await sys(`SELECT count(*) n FROM material WHERE code=$1`, [`DB${codeA}`])).rows[0].n;
    check('M1 the database refuses an insert by the Incharge', refused && slipped === '0', `${refused} ${slipped}`);
    refused = false;
    try {
      await withScope(maintPool, claims(inc, 'MAINTENANCE_INCHARGE'), async (c) => {
        await c.query(`SELECT set_config('app.reason','sneaky',true)`);
        const x = await c.query(`UPDATE material SET norm_max_per_job=99 WHERE id=$1`, [matA.id]);
        if (!x.rowCount) throw new Error('no row');
      });
    } catch { refused = true; }
    const norm = (await sys(`SELECT norm_max_per_job n FROM material WHERE id=$1`, [matA.id])).rows[0].n;
    check('M1 nor an update by the Incharge', refused && Number(norm) === 2, `${refused} ${norm}`);
    refused = false;
    try { await sys(`DELETE FROM material WHERE id=$1`, [matD.id]); } catch { refused = true; }
    const kept = (await sys(`SELECT count(*) n FROM material WHERE id=$1`, [matD.id])).rows[0].n;
    check('M1 a material cannot be deleted, even by the system', refused && kept === '1', `${refused} ${kept}`);

    r = await call(adm.token, `/materials/${matC.id}`, 'PUT', { active: false, reason: 'No longer supplied' });
    check('M1 the Administrator deactivates a material', r.status === 200 && (await j(r)).active === false, `${r.status}`);
    const act = await j(await call(resident.token, '/materials'));
    check('M1 an inactive material is left out of the normal list', Array.isArray(act) && !act.some((m) => m.id === matC.id));
    const all = await j(await call(adm.token, '/materials?all=true'));
    check('M1 but listed with all=true', Array.isArray(all) && all.some((m) => m.id === matC.id && m.active === false));
  });

  /* ================= complaints used by M2 – M4 ================= */
  let t1, t2, t3, dubeySup, dubeyAssign;
  await attempt('M2 setup', async () => {
    t1 = await assigned('Leaking tap', verma.actor_id);
  });
  const lineT1 = {};

  /* ================= M2 — claim lines ================= */
  await attempt('M2 claims', async () => {
    let r = await call(sup.token, `/tickets/${t1.id}/materials`, 'POST', { material_id: matA.id, qty_claimed: 1 });
    check('M2 nothing can be claimed while the job is only assigned', r.status === 422, `${r.status} ${short(await j(r))}`);
    r = await call(sup.token, `/tickets/${t1.id}/materials`);
    let body = await j(r);
    check('M2 the supervisor reads the (empty) list before starting, and may not yet claim',
      r.status === 200 && Array.isArray(body.items) && body.items.length === 0 && body.can_claim === false, `${r.status} ${short(body)}`);
    await start(t1, sup.token);

    r = await call(sup.token, `/tickets/${t1.id}/materials`);
    body = await j(r);
    check('M2 once started the supervisor may claim and may not verify', body.can_claim === true && body.can_verify === false, short(body));

    r = await call(sup.token, `/tickets/${t1.id}/materials`, 'POST', { material_id: matA.id, qty_claimed: 5 });
    let l = await j(r);
    lineT1.a = l;
    check('M2 the supervisor claims a material (line 1)', r.status === 201 && l.seq === 1 && Number(l.qty_claimed) === 5 && l.material_id === matA.id, `${r.status} ${short(l)}`);
    r = await call(sup.token, `/tickets/${t1.id}/materials`, 'POST', { material_id: matB.id, qty_claimed: 10 });
    l = await j(r);
    lineT1.b = l;
    check('M2 and another (line 2)', r.status === 201 && l.seq === 2, `${r.status} ${short(l)}`);
    r = await call(sup.token, `/tickets/${t1.id}/materials`, 'POST', { material_id: matB.id, qty_claimed: 3 });
    l = await j(r);
    lineT1.mistake = l;
    check('M2 the same material may be claimed again as a new line (line 3)', r.status === 201 && l.seq === 3, `${r.status} ${short(l)}`);

    r = await call(sup.token, `/tickets/${t1.id}/materials`, 'POST', { material_id: matB.id, qty_claimed: 0 });
    check('M2 a quantity of zero is refused', r.status === 422, `${r.status}`);
    r = await call(sup.token, `/tickets/${t1.id}/materials`, 'POST', { material_id: matB.id, qty_claimed: -2 });
    check('M2 a negative quantity is refused', r.status === 422, `${r.status}`);
    r = await call(sup.token, `/tickets/${t1.id}/materials`, 'POST', { material_id: matC.id, qty_claimed: 1 });
    check('M2 a deactivated material cannot be claimed', r.status === 422, `${r.status} ${short(await j(r))}`);
    r = await call(sup.token, `/tickets/${t1.id}/materials`, 'POST', { qty_claimed: 1 });
    check('M2 a claim with no material is refused', r.status === 422 || r.status === 400, `${r.status}`);

    for (const [who, tok] of [['the Overseer', ovr], ['the Civil Incharge', inc], ['the contractor firm', firm], ['the resident', resident]]) {
      r = await call(tok.token, `/tickets/${t1.id}/materials`, 'POST', { material_id: matB.id, qty_claimed: 1 });
      check(`M2 ${who} cannot claim`, r.status === 403 || r.status === 404, `${r.status}`);
    }
  });

  /* the Overseer is made a supervisor too, for the two-key test */
  await attempt('M2 other supervisor setup', async () => {
    const r = await fetch(`${BASE}/identity/v1/assignments`, { method: 'POST',
      headers: { ...json, authorization: `Bearer ${hr.token}` },
      body: JSON.stringify({ person_id: devices['CIVIL_OVERSEER:A. K. Dubey'].person_id, role: 'CONTRACTOR_SUPERVISOR',
        scope_path: 'ncl.jayant', contract_id: contractId, reason: 'test of two-key on materials' }) });
    dubeyAssign = await j(r);
    dubeySup = await device('CIVIL_OVERSEER:A. K. Dubey', { assignment_id: dubeyAssign.id });
    check('M2 (setup) the Overseer also signs in as a contractor supervisor', dubeySup.role === 'CONTRACTOR_SUPERVISOR' && !!dubeySup.token, `${r.status} ${short(dubeyAssign)} ${short(dubeySup)}`);
  });

  await attempt('M2 more', async () => {
    let r = await call(dubeySup.token, `/tickets/${t1.id}/materials`, 'POST', { material_id: matB.id, qty_claimed: 1 });
    check('M2 a supervisor the job is not assigned to cannot claim on it', r.status === 403 || r.status === 404, `${r.status}`);

    r = await call(resident.token, `/tickets/${t1.id}/materials`);
    check('M2 the resident cannot see the lines (404)', r.status === 404, `${r.status}`);
    r = await call(resident.token, `/tickets/${t1.id}/materials/history`);
    check('M2 nor their history', r.status === 404, `${r.status}`);
    r = await call(ngh.token, `/tickets/${t1.id}/materials`);
    check('M2 an Overseer of another Area gets "not found"', r.status === 404, `${r.status}`);
    r = await call(firm.token, `/tickets/${t1.id}/materials`);
    let body = await j(r);
    check('M2 the contractor firm sees its own contract\'s lines', r.status === 200 && body.items?.length === 3, `${r.status} ${short(body)}`);
    r = await call(sup.token, `/tickets/${t1.id}/materials`);
    body = await j(r);
    const first = body.items?.find((i) => i.seq === 1);
    check('M2 a line shows the code, name, unit and claimant',
      first && first.code === codeA && first.name_en === nameA && first.unit === 'No.' && !!first.claimed_by_name && !!first.claimed_at, short(first));

    /* the database, not the screen */
    const claimsSup = claims(sup, 'CONTRACTOR_SUPERVISOR', { contract_id: contractId });
    let refused = false;
    try {
      await withScope(maintPool, claimsSup, async (c) => {
        await c.query(`SELECT set_config('app.reason','correcting','true')`);
        const x = await c.query(`UPDATE material_claim SET qty_claimed=99 WHERE id=$1`, [lineT1.a.id]);
        if (!x.rowCount) throw new Error('no row');
      });
    } catch { refused = true; }
    let q = (await sys(`SELECT qty_claimed q FROM material_claim WHERE id=$1`, [lineT1.a.id])).rows[0].q;
    check('M2 the database refuses a changed quantity, even by the supervisor who claimed it', refused && Number(q) === 5, `${refused} ${q}`);
    refused = false;
    try {
      await withScope(maintPool, claimsSup, async (c) => {
        await c.query(`SELECT set_config('app.reason','swap','true')`);
        const x = await c.query(`UPDATE material_claim SET material_id=$2 WHERE id=$1`, [lineT1.a.id, matD.id]);
        if (!x.rowCount) throw new Error('no row');
      });
    } catch { refused = true; }
    const mid = (await sys(`SELECT material_id m FROM material_claim WHERE id=$1`, [lineT1.a.id])).rows[0].m;
    check('M2 nor a changed material', refused && mid === matA.id, `${refused} ${mid}`);
    refused = false;
    try { await sys(`DELETE FROM material_claim WHERE id=$1`, [lineT1.mistake.id]); } catch { refused = true; }
    const there = (await sys(`SELECT count(*) n FROM material_claim WHERE id=$1`, [lineT1.mistake.id])).rows[0].n;
    check('M2 a line cannot be deleted, even by the system', refused && there === '1', `${refused} ${there}`);
    refused = false;
    try {
      await withScope(maintPool, claimsSup, async (c) => {
        const x = await c.query(`UPDATE material_claim SET qty_verified=1, verified_at=now() WHERE id=$1`, [lineT1.a.id]);
        if (!x.rowCount) throw new Error('no row');
      });
    } catch { refused = true; }
    q = (await sys(`SELECT qty_verified q FROM material_claim WHERE id=$1`, [lineT1.a.id])).rows[0].q;
    check('M2 the database refuses a supervisor verifying their own claim', refused && q === null, `${refused} ${q}`);
    const seen = (await withScope(maintPool, claims(resident, 'RESIDENT', { premises_id: resident.premises_id }), (c) => c.query(
      `SELECT count(*) n FROM material_claim WHERE ticket_id=$1`, [t1.id]))).rows[0].n;
    check('M2 the database itself hides the lines from the resident', seen === '0', seen);

    /* withdrawal */
    r = await call(sup.token, `/tickets/${t1.id}/materials/${lineT1.mistake.id}/withdraw`, 'POST', {});
    check('M2 withdrawing a line needs a reason', r.status === 422, `${r.status}`);
    r = await call(ovr.token, `/tickets/${t1.id}/materials/${lineT1.mistake.id}/withdraw`, 'POST', { reason: 'not mine' });
    check('M2 the Overseer cannot withdraw a supervisor\'s line', r.status === 403 || r.status === 404, `${r.status}`);
    r = await call(sup.token, `/tickets/${t1.id}/materials/${lineT1.mistake.id}/withdraw`, 'POST', { reason: 'Entered by mistake, quantity was 1' });
    body = await j(r);
    check('M2 with a reason the supervisor withdraws it', r.status === 200 && !!body.withdrawn_at, `${r.status} ${short(body)}`);
    r = await call(sup.token, `/tickets/${t1.id}/materials`);
    body = await j(r);
    const kept = body.items?.find((i) => i.id === lineT1.mistake.id);
    check('M2 the withdrawn line stays, marked, with the reason',
      body.items?.length === 3 && kept?.withdrawn_at && /by mistake/.test(kept?.withdrawal_reason || ''), short(kept));
    r = await call(sup.token, `/tickets/${t1.id}/materials/${lineT1.mistake.id}/withdraw`, 'POST', { reason: 'again' });
    check('M2 a withdrawn line cannot be withdrawn twice', r.status === 422 || r.status === 409, `${r.status}`);
  });

  /* ================= M3 — verification ================= */
  await attempt('M3 verify', async () => {
    let r = await call(ovr.token, `/tickets/${t1.id}/materials/${lineT1.b.id}/verify`, 'POST', { qty_verified: 8 });
    check('M3 nothing can be verified before the completion claim', r.status === 422, `${r.status} ${short(await j(r))}`);
    r = await call(ovr.token, `/tickets/${t1.id}/materials`);
    let body = await j(r);
    check('M3 the Overseer reads the lines but may not yet verify', r.status === 200 && body.can_verify === false && body.can_claim === false, `${r.status} ${short(body)}`);

    await complete(t1, sup.token);
    // since 2026-10-16 the supervisor may still add lines after the claim, until he
    // sends the materials for review (suite 25 drives the chain); asked, not done,
    // so the totals below stay as they were
    r = await call(sup.token, `/tickets/${t1.id}/materials`);
    body = await j(r);
    check('M3 after the completion claim the supervisor may still add a line, until he sends it for review', r.status === 200 && body.can_claim === true && body.stage === 'SUPERVISOR', `${r.status} ${short(body)}`);

    r = await call(sup.token, `/tickets/${t1.id}/materials/${lineT1.b.id}/verify`, 'POST', { qty_verified: 10 });
    check('M3 the supervisor cannot verify', r.status === 403, `${r.status}`);
    r = await call(firm.token, `/tickets/${t1.id}/materials/${lineT1.b.id}/verify`, 'POST', { qty_verified: 10 });
    check('M3 nor the contractor firm', r.status === 403 || r.status === 404, `${r.status}`);
    r = await call(resident.token, `/tickets/${t1.id}/materials/${lineT1.b.id}/verify`, 'POST', { qty_verified: 10 });
    check('M3 nor the resident', r.status === 403 || r.status === 404, `${r.status}`);
    r = await call(ngh.token, `/tickets/${t1.id}/materials/${lineT1.b.id}/verify`, 'POST', { qty_verified: 10 });
    check('M3 nor an Overseer of another Area', r.status === 404 || r.status === 403, `${r.status}`);
    r = await call(so.token, `/tickets/${t1.id}/materials/${lineT1.b.id}/verify`, 'POST', { qty_verified: 10 });
    check('M3 nor the Staff Officer', r.status === 403, `${r.status}`);

    r = await call(ovr.token, `/tickets/${t1.id}/materials`);
    body = await j(r);
    check('M3 after the completion claim the Overseer may verify', body.can_verify === true && body.can_claim === false, short(body));

    r = await call(ovr.token, `/tickets/${t1.id}/materials/${lineT1.b.id}/verify`, 'POST', { qty_verified: -1 });
    check('M3 a negative verified quantity is refused', r.status === 422, `${r.status}`);
    r = await call(ovr.token, `/tickets/${t1.id}/materials/${lineT1.b.id}/verify`, 'POST', { qty_verified: 8, remark: 'Two kg short on site' });
    body = await j(r);
    check('M3 the Overseer verifies a line with less than was claimed',
      r.status === 200 && Number(body.qty_verified) === 8 && /short/.test(body.verification_remark || ''), `${r.status} ${short(body)}`);
    r = await call(ovr.token, `/tickets/${t1.id}/materials/${lineT1.mistake.id}/verify`, 'POST', { qty_verified: 3 });
    check('M3 a withdrawn line cannot be verified', r.status === 422, `${r.status}`);
    r = await call(ovr.token, `/tickets/${t1.id}/materials/${lineT1.b.id}/verify`, 'POST', { qty_verified: 9 });
    check('M3 re-verifying a line needs a reason', r.status === 422, `${r.status}`);
    r = await call(ovr.token, `/tickets/${t1.id}/materials/${lineT1.b.id}/verify`, 'POST', { qty_verified: 9, reason: 'Recount at the store' });
    body = await j(r);
    check('M3 with a reason it is re-verified', r.status === 200 && Number(body.qty_verified) === 9, `${r.status} ${short(body)}`);

    r = await call(sup.token, `/tickets/${t1.id}/materials`);
    body = await j(r);
    const b = body.items?.find((i) => i.id === lineT1.b.id);
    // the contractor sees what was verified and when, but not the officer's
    // identity: contractors read no officer's record (policy actor_ref_scope)
    check('M3 the supervisor sees the verified quantity and when, not the officer’s identity',
      Number(b?.qty_verified) === 9 && !!b?.verified_at && !b?.verified_by_name, short(b));
    r = await call(sup.token, `/tickets/${t1.id}/materials/${lineT1.b.id}/withdraw`, 'POST', { reason: 'hiding' });
    check('M3 a verified line cannot be withdrawn', r.status === 422 || r.status === 403, `${r.status}`);

    /* the line left unverified (A) is what UNVERIFIED will be about; the job is accepted */
    await uploadInspection(BASE, ovr.token, t1.id);
    r = await call(ovr.token, `/tickets/${t1.id}/inspect`, 'POST', { accepted: true });
    check('M3 (setup) the Overseer accepts the job with line A still unverified', r.status === 200 && (await stateOf(t1)) === 'INSPECTED_ACCEPTED', `${r.status} ${await stateOf(t1)}`);
    r = await call(inc.token, `/tickets/${t1.id}/materials/${lineT1.b.id}/verify`, 'POST', { qty_verified: 9, reason: 'Incharge confirms the recount' });
    check('M3 after acceptance, before closure, the Incharge can still verify', r.status === 200, `${r.status} ${short(await j(r))}`);
  });

  /* second complaint on the same premises, for REPEAT_AT_PREMISES and totals */
  await attempt('M4 setup second complaint', async () => {
    t2 = await assigned('Internal pipe', verma.actor_id);
    await start(t2, sup.token);
    const r = await call(sup.token, `/tickets/${t2.id}/materials`, 'POST', { material_id: matB.id, qty_claimed: 4 });
    check('M4 (setup) the same material is claimed on another complaint at the premises', r.status === 201, `${r.status} ${short(await j(r))}`);
  });

  /* two-key by person */
  await attempt('M3 two-key', async () => {
    t3 = await assigned('Roof leakage', dubeyAssign.id);
    let r = await start(t3, dubeySup.token);
    check('M3 (setup) the Overseer, as supervisor, starts a job assigned to that role', r.status === 200, `${r.status} ${short(await j(r))}`);
    r = await call(dubeySup.token, `/tickets/${t3.id}/materials`, 'POST', { material_id: matD.id, qty_claimed: 1 });
    const l = await j(r);
    check('M3 (setup) the Overseer, as supervisor, claims a material', r.status === 201, `${r.status} ${short(l)}`);
    await complete(t3, dubeySup.token);
    r = await call(ovr.token, `/tickets/${t3.id}/materials/${l.id}/verify`, 'POST', { qty_verified: 1 });
    check('M3 the person who claimed cannot verify, in another role', r.status === 422 || r.status === 403, `${r.status} ${short(await j(r))}`);
    const q = (await sys(`SELECT qty_verified q FROM material_claim WHERE id=$1`, [l.id])).rows[0].q;
    check('M3 and nothing was recorded', q === null, q);
    let refused = false;
    try {
      await withScope(maintPool, claims(ovr, 'CIVIL_OVERSEER'), async (c) => {
        const x = await c.query(`UPDATE material_claim SET qty_verified=1, verified_at=now() WHERE id=$1`, [l.id]);
        if (!x.rowCount) throw new Error('no row');
      });
    } catch { refused = true; }
    const q2 = (await sys(`SELECT qty_verified q FROM material_claim WHERE id=$1`, [l.id])).rows[0].q;
    check('M3 the database refuses it too', refused && q2 === null, `${refused} ${q2}`);
    r = await call(inc.token, `/tickets/${t3.id}/materials/${l.id}/verify`, 'POST', { qty_verified: 1 });
    check('M3 a different person (the Incharge) can verify it', r.status === 200, `${r.status} ${short(await j(r))}`);
  });

  /* closure locks the lines */
  await attempt('M3 closure', async () => {
    let r = await call(ovr.token, `/tickets/${t1.id}/close`, 'POST');
    const st = await stateOf(t1);
    check('M3 (setup) the complaint is closed', st === 'CLOSED', `${r.status} ${st}`);
    r = await call(ovr.token, `/tickets/${t1.id}/materials/${lineT1.a.id}/verify`, 'POST', { qty_verified: 5 });
    check('M3 after closure a line cannot be verified', r.status === 422, `${r.status} ${short(await j(r))}`);
    r = await call(ovr.token, `/tickets/${t1.id}/materials/${lineT1.b.id}/verify`, 'POST', { qty_verified: 7, reason: 'late' });
    check('M3 nor re-verified', r.status === 422, `${r.status}`);
    // a line added after closure goes into the approval chain (2026-10-16; suite 25):
    // the supervisor may still add one until he sends the materials for review
    r = await call(sup.token, `/tickets/${t1.id}/materials`);
    const after = await j(r);
    check('M3 after closure the supervisor may still add a line, for the approval chain', after.can_claim === true && after.stage === 'SUPERVISOR', short(after));
    let refused = false;
    try {
      await withScope(maintPool, claims(ovr, 'CIVIL_OVERSEER'), async (c) => {
        await c.query(`SELECT set_config('app.reason','late','true')`);
        const x = await c.query(`UPDATE material_claim SET qty_verified=1 WHERE id=$1`, [lineT1.a.id]);
        if (!x.rowCount) throw new Error('no row');
      });
    } catch { refused = true; }
    const q = (await sys(`SELECT qty_verified q FROM material_claim WHERE id=$1`, [lineT1.a.id])).rows[0].q;
    check('M3 the database refuses it too', refused && q === null, `${refused} ${q}`);
    r = await call(ovr.token, `/tickets/${t1.id}/materials`);
    const body = await j(r);
    check('M3 and the lines are still read after closure', r.status === 200 && body.items?.length === 3 && body.can_verify === false && body.can_claim === false, short(body));
  });

  /* audit and history */
  await attempt('M3 audit', async () => {
    const rows = (await sys(`SELECT event_type, reason, actor_id FROM audit_log WHERE entity_type='material_claim' AND entity_id::text=$1`, [t1.id])).rows;
    const has = (e) => rows.some((x) => x.event_type === e);
    check('M3 the database logged each claim', rows.filter((x) => x.event_type === 'MATERIAL_CLAIMED').length === 3, short(rows.map((x) => x.event_type)));
    check('M3 the withdrawal, with its reason', rows.some((x) => x.event_type === 'MATERIAL_CLAIM_WITHDRAWN' && /by mistake/.test(x.reason || '')));
    check('M3 each verification', has('MATERIAL_VERIFIED'));
    check('M3 and each re-verification, with its reason', rows.some((x) => x.event_type === 'MATERIAL_REVERIFIED' && /Recount/.test(x.reason || '')));
    let refused = false;
    try { await sys(`DELETE FROM audit_log WHERE entity_type='material_claim' AND entity_id::text=$1`, [t1.id]); } catch { refused = true; }
    const left = (await sys(`SELECT count(*) n FROM audit_log WHERE entity_type='material_claim' AND entity_id::text=$1`, [t1.id])).rows[0].n;
    check('M3 the log cannot be deleted', refused && Number(left) === rows.length, `${refused} ${left}`);

    let r = await call(so.token, `/tickets/${t1.id}/materials/history`);
    const hist = await j(r);
    check('M3 the history endpoint returns them, to officers',
      r.status === 200 && Array.isArray(hist) && ['MATERIAL_CLAIMED', 'MATERIAL_CLAIM_WITHDRAWN', 'MATERIAL_VERIFIED', 'MATERIAL_REVERIFIED']
        .every((e) => hist.some((h) => h.event_type === e)), `${r.status} ${short(hist.map?.((h) => h.event_type))}`);
    check('M3 each entry says who and when', Array.isArray(hist) && hist.length > 0 && hist.every((h) => h.occurred_at && h.actor_name), short(hist[0]));
    const w = hist.find?.((h) => h.event_type === 'MATERIAL_CLAIM_WITHDRAWN');
    check('M3 the withdrawal entry carries the reason', /by mistake/.test(w?.reason || ''), short(w));
    r = await call(ngh.token, `/tickets/${t1.id}/materials/history`);
    check('M3 another Area cannot read the history', r.status === 404, `${r.status}`);
  });

  /* ================= M4 — reports ================= */
  await attempt('M4 consumption', async () => {
    let r = await call(ovr.token, `/materials/consumption?contract_id=${contractId}`);
    let rep = await j(r);
    const row = (code) => rep.rows?.find((x) => x.code === code);
    check('M4 the Overseer reads the consumption report', r.status === 200 && Array.isArray(rep.rows) && !!rep.period, `${r.status} ${short(rep)}`);
    const a = row(codeA), b = row(codeB);
    check('M4 material A: one job, 5 claimed, none verified, 5 unverified, no variance',
      a && Number(a.jobs) === 1 && Number(a.qty_claimed) === 5 && Number(a.qty_verified || 0) === 0 && Number(a.qty_unverified) === 5 && Number(a.variance || 0) === 0, short(a));
    check('M4 material B: two jobs, 14 claimed (the withdrawn 3 left out), 9 verified, 4 unverified',
      b && Number(b.jobs) === 2 && Number(b.qty_claimed) === 14 && Number(b.qty_verified) === 9 && Number(b.qty_unverified) === 4, short(b));
    check('M4 variance is claimed less verified over verified lines only (10 - 9 = 1)', b && Number(b.variance) === 1, short(b));
    check('M4 a row carries code, name and unit', b && b.name_en === nameB && b.unit === 'Kg' && !!b.material_id, short(b));
    const d = row(codeD);
    check('M4 a material used on another job (D) is counted there', d && Number(d.jobs) === 1 && Number(d.qty_claimed) === 1 && Number(d.qty_verified) === 1 && Number(d.qty_unverified) === 0, short(d));
    check('M4 a material never claimed (C) does not appear', !row(codeC));

    r = await call(ovr.token, `/materials/consumption?contract_id=${contractId}&from=2999-01-01`);
    rep = await j(r);
    check('M4 a period in the future has none of them', r.status === 200 && !(rep.rows || []).some((x) => x.code === codeB), `${r.status} ${short(rep)}`);
    check('M4 and echoes the period', rep.period?.from === '2999-01-01', short(rep.period));
    r = await call(ovr.token, `/materials/consumption?contract_id=${contractId}&from=2000-01-01&to=2999-12-31`);
    rep = await j(r);
    check('M4 a wide period includes them', r.status === 200 && !!rep.rows?.find((x) => x.code === codeB), `${r.status}`);
    r = await call(ovr.token, `/materials/consumption?to=2000-01-01`);
    rep = await j(r);
    check('M4 a period wholly in the past has none (dates are on the claim)', r.status === 200 && !(rep.rows || []).some((x) => x.code === codeB), `${r.status}`);

    r = await call(ngh.token, `/materials/consumption`);
    rep = await j(r);
    check('M4 an Overseer of another Area sees none of Jayant\'s rows', r.status === 200 && !(rep.rows || []).some((x) => [codeA, codeB, codeD].includes(x.code)), `${r.status} ${short(rep)}`);

    for (const [who, tok] of [['the Civil Incharge', inc], ['the Staff Officer', so], ['the GM (Civil)', gm], ['an HQ executive', hq], ['the Administrator', adm]]) {
      r = await call(tok.token, `/materials/consumption`);
      rep = await j(r);
      check(`M4 ${who} can read the consumption report`, r.status === 200 && Array.isArray(rep.rows), `${r.status}`);
    }
    for (const [who, tok] of [['the supervisor', sup], ['the contractor firm', firm], ['the resident', resident]]) {
      r = await call(tok.token, `/materials/consumption`);
      check(`M4 ${who} cannot read the consumption report`, r.status === 403, `${r.status}`);
      r = await call(tok.token, `/materials/consumption.csv`);
      check(`M4 nor its CSV (${who})`, r.status === 403, `${r.status}`);
    }

    r = await call(ovr.token, `/materials/consumption.csv?contract_id=${contractId}`);
    const csv = await r.text();
    const lines = csv.split(/\r?\n/).filter(Boolean);
    check('M4 the CSV opens with the header row', r.status === 200 && lines[0].trim() === 'code,name_en,unit,jobs,qty_claimed,qty_verified,qty_unverified,variance', `${r.status} ${lines[0]}`);
    check('M4 it is served as CSV', /csv/i.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
    const bl = lines.find((x) => x.startsWith(`${codeB},`));
    const f = bl ? bl.split(',') : [];
    check('M4 the CSV row for B matches the report',
      f.length === 8 && f[1] === nameB && f[2] === 'Kg' && Number(f[3]) === 2 && Number(f[4]) === 14 && Number(f[5]) === 9 && Number(f[6]) === 4 && Number(f[7]) === 1, bl);
  });

  await attempt('M4 anomalies', async () => {
    let r = await call(ovr.token, `/materials/anomalies?contract_id=${contractId}`);
    let body = await j(r);
    const items = body.items || [];
    check('M4 the Overseer reads the anomalies', r.status === 200 && Array.isArray(body.items), `${r.status} ${short(body)}`);
    const of = (flag, code) => items.filter((x) => x.flag === flag && x.code === code);
    const over = of('OVER_CLAIM', codeB);
    check('M4 OVER_CLAIM: B verified at 9 against 10 claimed',
      over.length === 1 && over[0].line_id === lineT1.b.id && Number(over[0].qty_claimed) === 10 && Number(over[0].qty_verified) === 9 && over[0].ticket_id === t1.id, short(over));
    const norm = of('ABOVE_NORM', codeA);
    check('M4 ABOVE_NORM: A claimed 5 against a norm of 2', norm.length >= 1 && norm.some((x) => x.ticket_id === t1.id && Number(x.qty_claimed) === 5), short(norm));
    check('M4 a material with no norm is never above it', of('ABOVE_NORM', codeB).length === 0 && of('ABOVE_NORM', codeD).length === 0);
    const rep = of('REPEAT_AT_PREMISES', codeB);
    check('M4 REPEAT_AT_PREMISES: B claimed on two complaints at B-234',
      rep.length >= 1 && rep.every((x) => [t1.id, t2.id].includes(x.ticket_id)), short(rep));
    check('M4 the repeat is not raised for material claimed once (A)', of('REPEAT_AT_PREMISES', codeA).length === 0);
    const unv = of('UNVERIFIED', codeA);
    check('M4 UNVERIFIED: A passed inspection without being verified', unv.length === 1 && unv[0].ticket_id === t1.id && unv[0].line_id === lineT1.a.id, short(unv));
    check('M4 a verified line is not UNVERIFIED', of('UNVERIFIED', codeB).length === 0, short(of('UNVERIFIED', codeB)));
    check('M4 a withdrawn line raises nothing at all', !items.some((x) => x.line_id === lineT1.mistake.id), short(items.filter((x) => x.line_id === lineT1.mistake.id)));
    check('M4 an anomaly names the complaint and premises',
      !!items[0]?.ticket_no && !!items[0]?.identifier && !!items[0]?.detail && items.every((x) => x.unit && x.name_en), short(items[0]));
    check('M4 a line on a job still in progress is not UNVERIFIED', !items.some((x) => x.flag === 'UNVERIFIED' && x.ticket_id === t2.id));

    for (const [who, tok] of [['the Civil Incharge', inc], ['the Staff Officer', so], ['the GM (Civil)', gm], ['an HQ executive', hq], ['the Administrator', adm]]) {
      r = await call(tok.token, `/materials/anomalies`);
      body = await j(r);
      check(`M4 ${who} can read the anomalies`, r.status === 200 && Array.isArray(body.items), `${r.status}`);
    }
    for (const [who, tok] of [['the supervisor', sup], ['the contractor firm', firm], ['the resident', resident]]) {
      r = await call(tok.token, `/materials/anomalies`);
      check(`M4 ${who} cannot read the anomalies`, r.status === 403, `${r.status}`);
    }
    r = await call(ngh.token, `/materials/anomalies`);
    body = await j(r);
    check('M4 an Overseer of another Area sees none of Jayant\'s anomalies', r.status === 200 && (body.items || []).length === 0, `${r.status} ${short(body)}`);
    r = await call(ovr.token, `/materials/anomalies?from=2999-01-01`);
    body = await j(r);
    check('M4 anomalies honour the period', r.status === 200 && !(body.items || []).some((x) => x.code === codeB), `${r.status}`);
  });

  /* ================= M5 — evidence only ================= */
  await attempt('M5 money', async () => {
    const shapes = [];
    shapes.push(['the master', await j(await call(adm.token, '/materials?all=true'))]);
    shapes.push(['a new material', matA]);
    shapes.push(['a claim line list', await j(await call(ovr.token, `/tickets/${t1.id}/materials`))]);
    shapes.push(['the consumption report', await j(await call(ovr.token, '/materials/consumption'))]);
    shapes.push(['the anomalies', await j(await call(ovr.token, '/materials/anomalies'))]);
    shapes.push(['the history', await j(await call(ovr.token, `/tickets/${t1.id}/materials/history`))]);
    for (const [what, body] of shapes) {
      const bad = moneyKeys(body);
      check(`M5 ${what} carries no rate, price, amount or cost`, bad.length === 0, bad.join(','));
    }
    const hist = shapes[5][1];
    const inner = (Array.isArray(hist) ? hist : []).flatMap((h) => [h.before_value, h.after_value]);
    check('M5 nor does anything inside the history entries', moneyKeys(inner).length === 0, moneyKeys(inner).join(','));
    const csvHead = (await (await call(ovr.token, '/materials/consumption.csv')).text()).split(/\r?\n/)[0];
    check('M5 nor the CSV header', !MONEY.test(csvHead), csvHead);
    const cols = (await sys(`SELECT table_name, column_name FROM information_schema.columns
                              WHERE table_name IN ('material','material_claim') AND column_name ~* '(rate|price|amount|cost|value|rupee)'`)).rows;
    check('M5 the tables have no money column', cols.length === 0, short(cols));
  });
}

run().catch((e) => { check('suite ran to the end', false, e.stack); })
  .finally(async () => {
    for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n         ${d}` : ''}`);
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await maintPool.end().catch(() => {}); await identityPool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
