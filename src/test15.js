/**
 * Suite 15 — measurement book (MB) entries, MB-ready extract and the Staff
 * Officer's check-measurement. Quantities only (control 9).
 *
 * Written from the specification alone, to check the implementation
 * independently of whoever built it.
 *
 *   M1  setup: a complaint taken to INSPECTED_ACCEPTED, with job-card items
 *       (one withdrawn) and a verified material line
 *   M2  reading the measurements: items, flags, who may read
 *   M3  measuring: who, when, validation, computed quantity, one per item
 *   M4  re-measuring: reason compulsory, history
 *   M5  recording in the MB: who, all-or-nothing, frozen afterwards
 *   M6  the Staff Officer's check and the variance
 *   M7  the contractor never sees check-measurement
 *   M8  the extract: who, summary, filters, jobs, materials, flags
 *   M9  the CSV
 *   M10 evidence only: no rate, price, amount or cost anywhere
 *   M11 Area isolation
 *
 * Not covered, because seed data cannot build it: "the person who measured
 * cannot check-measure, whatever role they hold". The measurer must be an
 * Overseer or Incharge and the checker the Staff Officer; no seeded person
 * holds both. A test that faked it would prove nothing.
 *
 * Needs a freshly reset and seeded database.
 */
import fs from 'node:fs';
import { signNonce } from './auth.js';
import { uploadCompletion, uploadInspection } from './testutil.js';
import { withSystem, withScope, maintPool, identityPool } from './db.js';

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
const short = (x) => JSON.stringify(x)?.slice(0, 260);
const near = (a, b) => a !== null && a !== undefined && Math.abs(Number(a) - Number(b)) < 0.0006;

/* Every key anywhere in a JSON value that looks like money. The audit
   entries' own wrapper keys (before_value, after_value) are not money. */
const MONEY = /rate|price|amount|cost|₹/i;
function moneyKeys(o, found = []) {
  if (Array.isArray(o)) o.forEach((x) => moneyKeys(x, found));
  else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (MONEY.test(k)) found.push(k);
      moneyKeys(v, found);
    }
  }
  return found;
}
/* Every key anywhere in a JSON value that belongs to check-measurement. */
const CHECK_KEYS = new Set(['check_qty', 'check_remark', 'checked_by_name', 'checked_at', 'variance_percent', 'checked_by']);
function checkKeys(o, found = []) {
  if (Array.isArray(o)) o.forEach((x) => checkKeys(x, found));
  else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (CHECK_KEYS.has(k)) found.push(k);
      checkKeys(v, found);
    }
  }
  return found;
}

const CSV_HEADER = 'ticket_no,jc_no,premises,item,description,unit,nos,length,breadth,depth,qty,measured_on,measured_by,mb_no,mb_page,check_qty,variance_percent,flagged';

async function run() {
  const resident = await as('RESIDENT:R. K. Singh');
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey');
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
  const so = await as('STAFF_OFFICER_CIVIL:S. Tiwari');
  const gm = await as('GM_CIVIL:GM (Civil)');
  const sup = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const firm = await as('CONTRACTOR:M/s Jayant Constructions');
  const ngh = await as('CIVIL_OVERSEER:Nigahi Overseer');
  const hq = await device('HQ_EXECUTIVE:CMD', { role: 'HQ_EXECUTIVE' });

  const contractId = (await sys(`SELECT id FROM contract WHERE agreement_no='NCL/JNT/CIV/2026/01'`)).rows[0].id;
  const cats = await j(await call(resident.token, '/masters/categories'));
  const sub = (p) => cats.find((c) => c.name_en.startsWith(p));
  const assignable = await j(await call(inc.token, '/devices/assignable'));
  const verma = assignable.find((a) => a.person_name === 'M/s Verma — Supr');

  async function assigned(prefix) {
    const t = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: sub(prefix).id, description: `MB test: ${prefix}` }));
    if (!t.id) throw new Error(`raise ${short(t)}`);
    await call(ovr.token, `/tickets/${t.id}/verify`, 'POST');
    const r = await call(inc.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: verma.actor_id });
    if (r.status !== 200) throw new Error(`assign ${r.status} ${short(await j(r))}`);
    return t;
  }
  const start = (t) => call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
  async function complete(t) {
    await uploadCompletion(BASE, sup.token, t.id);
    const r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    if (r.status !== 200) throw new Error(`complete ${r.status} ${short(await j(r))}`);
  }
  const stateOf = async (t) => (await sys(`SELECT state FROM ticket WHERE id=$1`, [t.id])).rows[0].state;
  async function addItem(t, description, unit, qty) {
    const r = await call(ovr.token, `/tickets/${t.id}/job-card/items`, 'POST', { description, unit, qty_estimated: qty });
    const it = await j(r);
    if (!it.id) throw new Error(`item ${r.status} ${short(it)}`);
    return it;
  }

  const tag = String(Date.now() % 1000000);
  let t1, t2, t3, i1, i2, i3, i4, i5, i2b, i3b;
  let m1, m2, m4, m5;           // the measurements of i1, i2, i4, i5
  let matLine, mat;
  const MB_NO = `T15-${tag}`;

  /* ================= M1 — setup ================= */
  await attempt('M1 setup', async () => {
    t1 = await assigned('Leaking tap');
    i1 = await addItem(t1, `Plaster to wall ${tag}`, 'Sqm', 6);
    i2 = await addItem(t1, `Floor tiles ${tag}`, 'No.', 4);
    i3 = await addItem(t1, `Cancelled item ${tag}`, 'No.', 1);
    i4 = await addItem(t1, `Pipe fitting ${tag}`, 'Rm', 10);
    i5 = await addItem(t1, `Door shutter ${tag}`, 'No.', 1);
    let r = await call(ovr.token, `/tickets/${t1.id}/job-card/items/${i3.id}/withdraw`, 'POST', { reason: 'Not needed after site visit' });
    check('M1 an item is withdrawn by the Overseer with a reason', r.status === 200, `${r.status} ${short(await j(r))}`);

    r = await start(t1);
    check('M1 the supervisor starts the job', r.status === 200, `${r.status}`);
    const mats = await j(await call(resident.token, '/materials'));
    mat = mats.find((m) => m.active !== false);
    r = await call(sup.token, `/tickets/${t1.id}/materials`, 'POST', { material_id: mat.id, qty_claimed: 2 });
    matLine = await j(r);
    check('M1 a material is claimed while the job is in progress', r.status === 201 && !!matLine.id, `${r.status} ${short(matLine)}`);
    await complete(t1);
    r = await call(ovr.token, `/tickets/${t1.id}/materials/${matLine.id}/verify`, 'POST', { qty_verified: 2 });
    check('M1 the material is verified after the completion claim', r.status === 200, `${r.status} ${short(await j(r))}`);
    await uploadInspection(BASE, ovr.token, t1.id);
    r = await call(ovr.token, `/tickets/${t1.id}/inspect`, 'POST', { accepted: true });
    const st = await stateOf(t1);
    check('M1 the Overseer accepts the job', r.status === 200 && st === 'INSPECTED_ACCEPTED', `${r.status} ${st}`);
    // the measurement sheet is the supervisor's first (2026-10-16); here he sends it up
    // unmeasured, so this suite tests the officer's measuring at the Overseer's step
    r = await call(sup.token, `/tickets/${t1.id}/sheets/measurements/submit`, 'POST');
    check('M1 the supervisor sends the measurement sheet up to the Overseer', r.status === 200, `${r.status} ${short(await j(r))}`);

    /* two more complaints that have not been accepted */
    t2 = await assigned('Internal pipe');
    i2b = await addItem(t2, `Item on a job in progress ${tag}`, 'No.', 1);
    await start(t2);
    t3 = await assigned('Roof leakage');
    i3b = await addItem(t3, `Item on a job awaiting inspection ${tag}`, 'No.', 1);
    await start(t3);
    await complete(t3);
    check('M1 (setup) a second job is in progress and a third awaits inspection',
      (await stateOf(t2)) === 'IN_PROGRESS' && (await stateOf(t3)) === 'WORK_COMPLETED', `${await stateOf(t2)} ${await stateOf(t3)}`);
  });

  /* ================= M2 — reading ================= */
  await attempt('M2 read', async () => {
    let r = await call(ovr.token, `/tickets/${t1.id}/measurements`);
    let body = await j(r);
    check('M2 the Overseer reads the measurements', r.status === 200 && Array.isArray(body.items), `${r.status} ${short(body)}`);
    check('M2 only the live items appear, in order (the withdrawn one is left out)',
      body.items?.length === 4 && body.items.map((x) => x.item_id).join() === [i1.id, i2.id, i4.id, i5.id].join(), short(body.items?.map((x) => x.item_id)));
    const seqs = (body.items || []).map((x) => x.seq);
    check('M2 the items run in increasing item order', seqs.every((s, k) => k === 0 || s > seqs[k - 1]), short(seqs));
    const f = body.items?.[0];
    check('M2 an entry carries description, unit, estimate and no measurement yet',
      f && f.description === `Plaster to wall ${tag}` && f.unit === 'Sqm' && Number(f.qty_estimated) === 6 && f.measurement === null, short(f));
    check('M2 nobody has measured anything yet', body.items?.every((x) => x.measurement === null));
    check('M2 the Overseer may measure and record, not check', body.can_measure === true && body.can_record === true && body.can_check === false, short({ m: body.can_measure, r: body.can_record, c: body.can_check }));

    check('M2 the sheet is at the Overseer\'s step, and his change needs a reason', body.stage === 'OVERSEER' && body.reason_needed === true, short({ s: body.stage, r: body.reason_needed }));
    r = await call(inc.token, `/tickets/${t1.id}/measurements`);
    body = await j(r);
    check('M2 the Incharge reads; it is not yet his step to measure; he may record, not check', r.status === 200 && body.can_measure === false && body.can_record === true && body.can_check === false, short(body));
    r = await call(so.token, `/tickets/${t1.id}/measurements`);
    body = await j(r);
    check('M2 the Staff Officer reads, may check, may not measure or record',
      r.status === 200 && body.can_check === true && body.can_measure === false && body.can_record === false, `${r.status} ${short({ m: body.can_measure, r: body.can_record, c: body.can_check })}`);
    for (const [who, tok] of [['the GM', gm], ['an HQ executive', hq]]) {
      r = await call(tok.token, `/tickets/${t1.id}/measurements`);
      body = await j(r);
      check(`M2 ${who} reads, and cannot measure`, r.status === 200 && body.can_measure === false, `${r.status} ${short(body)}`);
    }
    r = await call(sup.token, `/tickets/${t1.id}/measurements`);
    body = await j(r);
    // Since 2026-10-16 the supervisor reads the whole job card, estimates included (README 5.5).
    check('M2 the supervisor reads every live item, with its estimate', r.status === 200 && body.items?.length === 4 && Number(body.items[0].qty_estimated) === 6, `${r.status} ${short(body)}`);
    check('M2 once he has sent the sheet up he cannot measure, check or record', body.can_measure === false && body.can_check === false && body.can_record === false, short({ m: body.can_measure, r: body.can_record, c: body.can_check }));
    check('M2 the supervisor\'s list carries no check-measurement fields', checkKeys(body).length === 0, checkKeys(body).join());

    r = await call(resident.token, `/tickets/${t1.id}/measurements`);
    check('M2 the resident gets "not found"', r.status === 404, `${r.status}`);
    r = await call(ngh.token, `/tickets/${t1.id}/measurements`);
    check('M2 an Overseer of another Area gets "not found"', r.status === 404, `${r.status}`);

    r = await call(ovr.token, `/tickets/${t2.id}/measurements`);
    body = await j(r);
    check('M2 on a job still in progress the Overseer cannot measure', r.status === 200 && body.can_measure === false, `${r.status} ${short(body)}`);
  });

  /* ================= M3 — measuring ================= */
  await attempt('M3 measure', async () => {
    const url = `/tickets/${t1.id}/measurements`;
    let r;
    /* before acceptance */
    r = await call(sup.token, `/tickets/${t2.id}/measurements`, 'POST', { item_id: i2b.id, qty: 1 });
    check('M3 a job still in progress cannot be measured, even by its supervisor (422)', r.status === 422, `${r.status} ${short(await j(r))}`);
    r = await call(sup.token, `/tickets/${t3.id}/measurements`, 'POST', { item_id: i3b.id, qty: 1 });
    check('M3 nor one awaiting inspection (422)', r.status === 422, `${r.status} ${short(await j(r))}`);
    r = await call(ovr.token, `/tickets/${t3.id}/measurements`, 'POST', { item_id: i3b.id, qty: 1 });
    check('M3 nor by the Overseer, whose step it is not', r.status === 422 || r.status === 403, `${r.status}`);
    const none = (await sys(`SELECT count(*) n FROM measurement WHERE ticket_id = ANY($1)`, [[t2.id, t3.id]])).rows[0].n;
    check('M3 and nothing was recorded for them', none === '0', none);

    /* who */
    r = await call(sup.token, url, 'POST', { item_id: i4.id, qty: 10 });
    check('M3 the supervisor cannot measure once he has sent the sheet up', r.status === 403, `${r.status}`);
    r = await call(so.token, url, 'POST', { item_id: i4.id, qty: 10 });
    check('M3 nor the Staff Officer', r.status === 403, `${r.status}`);
    r = await call(firm.token, url, 'POST', { item_id: i4.id, qty: 10 });
    check('M3 nor the contractor firm', r.status === 403 || r.status === 404, `${r.status}`);
    r = await call(resident.token, url, 'POST', { item_id: i4.id, qty: 10 });
    check('M3 nor the resident', r.status === 403 || r.status === 404, `${r.status}`);
    r = await call(ngh.token, url, 'POST', { item_id: i4.id, qty: 10 });
    check('M3 nor an Overseer of another Area', r.status === 403 || r.status === 404, `${r.status}`);
    r = await call(gm.token, url, 'POST', { item_id: i4.id, qty: 10 });
    check('M3 nor the GM', r.status === 403, `${r.status}`);

    /* which item */
    r = await call(ovr.token, url, 'POST', { item_id: i3.id, qty: 1 });
    check('M3 a withdrawn item cannot be measured (422)', r.status === 422, `${r.status} ${short(await j(r))}`);
    r = await call(ovr.token, url, 'POST', { item_id: i2b.id, qty: 1 });
    check('M3 an item of another complaint is refused', r.status === 422 || r.status === 404, `${r.status}`);
    r = await call(ovr.token, url, 'POST', { item_id: '00000000-0000-4000-8000-000000000000', qty: 1 });
    check('M3 an item that does not exist is refused', r.status === 422 || r.status === 404, `${r.status}`);
    r = await call(ovr.token, url, 'POST', { qty: 1 });
    check('M3 a measurement with no item is refused (422)', r.status === 422 || r.status === 400, `${r.status}`);

    /* validation */
    r = await call(ovr.token, url, 'POST', { item_id: i4.id, remark: 'no figures' });
    check('M3 neither dimensions nor quantity is refused (422)', r.status === 422, `${r.status} ${short(await j(r))}`);
    r = await call(ovr.token, url, 'POST', { item_id: i4.id, length: 0 });
    check('M3 a zero length is refused (422)', r.status === 422, `${r.status}`);
    r = await call(ovr.token, url, 'POST', { item_id: i4.id, length: 2, breadth: -1 });
    check('M3 a negative breadth is refused (422)', r.status === 422, `${r.status}`);
    r = await call(ovr.token, url, 'POST', { item_id: i4.id, nos: 0, length: 2 });
    check('M3 a zero number of items is refused (422)', r.status === 422, `${r.status}`);
    r = await call(ovr.token, url, 'POST', { item_id: i4.id, depth: -0.5 });
    check('M3 a negative depth is refused (422)', r.status === 422, `${r.status}`);
    r = await call(ovr.token, url, 'POST', { item_id: i4.id, qty: -1 });
    check('M3 a negative quantity is refused (422)', r.status === 422, `${r.status}`);
    const stray = (await sys(`SELECT count(*) n FROM measurement WHERE item_id=$1`, [i4.id])).rows[0].n;
    check('M3 and none of the refused ones left a row', stray === '0', stray);

    /* dimensions give the quantity, whatever was sent */
    r = await call(ovr.token, url, 'POST', { item_id: i1.id, nos: 2, length: 1.5, breadth: 0.5, qty: 99, remark: 'Kitchen wall' });
    m1 = await j(r);
    check('M3 the Overseer measures with dimensions (201)', r.status === 201 && !!m1.id && m1.item_id === i1.id, `${r.status} ${short(m1)}`);
    check('M3 the database computes the quantity: 2 x 1.5 x 0.5 = 1.5, overriding the 99 sent', near(m1.qty, 1.5), short(m1));
    check('M3 the dimensions and remark are kept, with who and when',
      near(m1.nos, 2) && near(m1.length, 1.5) && near(m1.breadth, 0.5) && m1.depth === null && m1.remark === 'Kitchen wall' && !!m1.measured_by_name && !!m1.measured_at, short(m1));
    check('M3 a fresh measurement is neither in the MB nor checked', !m1.mb_no && !m1.mb_recorded_at && !m1.check_qty, short(m1));

    r = await call(inc.token, url, 'POST', { item_id: i2.id, nos: 4 });
    check('M3 the Incharge does not measure at the Overseer\'s step', r.status === 403, `${r.status}`);
    r = await call(ovr.token, url, 'POST', { item_id: i2.id, nos: 4 });
    m2 = await j(r);
    check('M3 a number of items alone is the quantity (4)', r.status === 201 && near(m2.qty, 4), `${r.status} ${short(m2)}`);

    r = await call(ovr.token, url, 'POST', { item_id: i1.id, qty: 5 });
    check('M3 a second measurement of the same item is refused (409)', r.status === 409, `${r.status} ${short(await j(r))}`);
    const cnt = (await sys(`SELECT count(*) n FROM measurement WHERE item_id=$1`, [i1.id])).rows[0].n;
    check('M3 one measurement per item stays true', cnt === '1', cnt);

    r = await call(ovr.token, url, 'POST', { item_id: i4.id, qty: 10, remark: 'Direct quantity' });
    m4 = await j(r);
    check('M3 a direct quantity is accepted when no dimension is given', r.status === 201 && near(m4.qty, 10), `${r.status} ${short(m4)}`);

    const list = await j(await call(ovr.token, url));
    const e1 = list.items?.find((x) => x.item_id === i1.id);
    check('M3 the list now shows the measurement against the item', near(e1?.measurement?.qty, 1.5) && e1.measurement.id === m1.id, short(e1));
    const e5 = list.items?.find((x) => x.item_id === i5.id);
    check('M3 an unmeasured item still shows none', e5 && e5.measurement === null, short(e5));
  });

  /* ================= M4 — re-measuring ================= */
  await attempt('M4 remeasure', async () => {
    let r = await call(ovr.token, `/measurements/${m4.id}`, 'PUT', { length: 2.5, breadth: 2, depth: 0.1 });
    check('M4 re-measuring without a reason is refused (422)', r.status === 422, `${r.status} ${short(await j(r))}`);
    let q = (await sys(`SELECT qty FROM measurement WHERE id=$1`, [m4.id])).rows[0].qty;
    check('M4 and the quantity is unchanged', near(q, 10), q);
    r = await call(sup.token, `/measurements/${m4.id}`, 'PUT', { qty: 1, reason: 'trying' });
    check('M4 the supervisor cannot re-measure', r.status === 403, `${r.status}`);
    r = await call(so.token, `/measurements/${m4.id}`, 'PUT', { qty: 1, reason: 'trying' });
    check('M4 nor the Staff Officer', r.status === 403, `${r.status}`);
    r = await call(ngh.token, `/measurements/${m4.id}`, 'PUT', { qty: 1, reason: 'trying' });
    check('M4 nor an Overseer of another Area', r.status === 403 || r.status === 404, `${r.status}`);

    r = await call(ovr.token, `/measurements/${m4.id}`, 'PUT', { length: 2.5, breadth: 2, depth: 0.1, reason: 'Re-taken with the tape' });
    const body = await j(r);
    check('M4 with a reason it is re-measured and the quantity recomputed (2.5 x 2 x 0.1 = 0.5)', r.status === 200 && near(body.qty, 0.5), `${r.status} ${short(body)}`);
    q = (await sys(`SELECT qty FROM measurement WHERE id=$1`, [m4.id])).rows[0].qty;
    check('M4 the stored quantity changed', near(q, 0.5), q);

    r = await call(ovr.token, `/tickets/${t1.id}/measurements/history`);
    const hist = await j(r);
    check('M4 the history is read by the Overseer', r.status === 200 && Array.isArray(hist), `${r.status} ${short(hist)}`);
    const types = (hist || []).map((h) => h.event_type);
    check('M4 it shows MEASURED and REMEASURED', types.includes('MEASURED') && types.includes('REMEASURED'), short(types));
    const re = (hist || []).find((h) => h.event_type === 'REMEASURED');
    check('M4 the re-measurement carries its reason, who and when',
      /Re-taken/.test(re?.reason || '') && !!re?.occurred_at && !!re?.actor_name && !!re?.actor_role, short(re));
    check('M4 and the before and after values (10 then 0.5)',
      /10/.test(JSON.stringify(re?.before_value ?? '')) && /0\.5/.test(JSON.stringify(re?.after_value ?? '')), short({ b: re?.before_value, a: re?.after_value }));
    const ts = (hist || []).map((h) => Date.parse(h.occurred_at));
    check('M4 the history is newest first', ts.every((x, k) => k === 0 || x <= ts[k - 1]), short(ts));
    r = await call(sup.token, `/tickets/${t1.id}/measurements/history`);
    check('M4 the supervisor cannot read the history (403)', r.status === 403, `${r.status}`);
    r = await call(firm.token, `/tickets/${t1.id}/measurements/history`);
    check('M4 nor the contractor firm (403)', r.status === 403, `${r.status}`);
    r = await call(resident.token, `/tickets/${t1.id}/measurements/history`);
    check('M4 nor the resident', r.status === 403 || r.status === 404, `${r.status}`);
  });

  /* ================= measuring after closure ================= */
  await attempt('M3 after closure', async () => {
    let r = await call(ovr.token, `/tickets/${t1.id}/close`, 'POST');
    const st = await stateOf(t1);
    check('M3 (setup) the complaint is closed', st === 'CLOSED', `${r.status} ${st}`);
    r = await call(ovr.token, `/tickets/${t1.id}/measurements`);
    const body = await j(r);
    check('M3 after closure the Overseer may still measure', r.status === 200 && body.can_measure === true, `${r.status} ${short(body)}`);
    r = await call(ovr.token, `/tickets/${t1.id}/measurements`, 'POST', { item_id: i5.id, qty: 7 });
    m5 = await j(r);
    check('M3 and does: measuring after closure is allowed', r.status === 201 && near(m5.qty, 7), `${r.status} ${short(m5)}`);
    r = await call(ovr.token, `/measurements/${m5.id}`, 'PUT', { qty: 8, reason: 'Door is a double leaf' });
    check('M3 re-measuring after closure is allowed too', r.status === 200 && near((await j(r)).qty, 8), `${r.status}`);
  });

  /* ================= M5 — recording in the MB ================= */
  await attempt('M5 record', async () => {
    const rec = (tok, b) => call(tok.token, '/mb/record', 'POST', b);
    let r = await rec(so, { measurement_ids: [m1.id, m2.id], mb_no: MB_NO, mb_page: '12' });
    check('M5 the Staff Officer cannot record in the MB', r.status === 403, `${r.status}`);
    r = await rec(sup, { measurement_ids: [m1.id, m2.id], mb_no: MB_NO, mb_page: '12' });
    check('M5 nor the supervisor', r.status === 403, `${r.status}`);
    r = await rec(firm, { measurement_ids: [m1.id, m2.id], mb_no: MB_NO, mb_page: '12' });
    check('M5 nor the contractor firm', r.status === 403, `${r.status}`);
    r = await rec(ngh, { measurement_ids: [m1.id], mb_no: MB_NO, mb_page: '12' });
    check('M5 an Overseer of another Area cannot see the entry to record it', r.status === 404 || r.status === 403, `${r.status}`);
    r = await rec(ovr, { measurement_ids: [m1.id, m2.id], mb_page: '12' });
    check('M5 an MB number is required (422)', r.status === 422, `${r.status} ${short(await j(r))}`);
    r = await rec(ovr, { measurement_ids: [m1.id, m2.id], mb_no: MB_NO });
    check('M5 a page is required (422)', r.status === 422, `${r.status}`);
    r = await rec(ovr, { measurement_ids: [], mb_no: MB_NO, mb_page: '12' });
    check('M5 an empty list is refused', r.status === 422 || r.status === 400, `${r.status}`);
    let recd = (await sys(`SELECT count(*) n FROM measurement WHERE ticket_id=$1 AND mb_no IS NOT NULL`, [t1.id])).rows[0].n;
    check('M5 none of the refused attempts recorded anything', recd === '0', recd);

    r = await rec(ovr, { measurement_ids: [m1.id, m2.id], mb_no: MB_NO, mb_page: '12' });
    let body = await j(r);
    check('M5 the Overseer records two entries: {recorded: 2}', (r.status === 200 || r.status === 201) && Number(body.recorded) === 2, `${r.status} ${short(body)}`);
    r = await rec(inc, { measurement_ids: [m1.id, m2.id], mb_no: `${MB_NO}-B`, mb_page: '13' });
    check('M5 recording them again is refused (409)', r.status === 409, `${r.status} ${short(await j(r))}`);
    const row = (await sys(`SELECT mb_no, mb_page FROM measurement WHERE id=$1`, [m1.id])).rows[0];
    check('M5 the first MB reference stands', row.mb_no === MB_NO && row.mb_page === '12', short(row));

    r = await rec(ovr, { measurement_ids: [m4.id, m1.id], mb_no: `${MB_NO}-C`, mb_page: '14' });
    check('M5 a batch with one new and one already-recorded entry is refused', r.status === 409 || r.status === 404, `${r.status} ${short(await j(r))}`);
    const m4row = (await sys(`SELECT mb_no FROM measurement WHERE id=$1`, [m4.id])).rows[0];
    check('M5 all or nothing: the new entry was not recorded either', m4row.mb_no === null, short(m4row));

    // Since 2026-10-16 the approval chain governs an entry, not the paper MB reference:
    // the officer at the step may still measure again, with a reason, and the MB
    // record appends the revision rather than rewriting the line.
    r = await call(ovr.token, `/measurements/${m1.id}`, 'PUT', { qty: 2, reason: 'Second thoughts' });
    check('M5 an entry noted in the paper MB may still be measured again at the step, with a reason', r.status === 200 && near((await j(r)).qty, 2), `${r.status}`);
    r = await call(ovr.token, `/measurements/${m1.id}`, 'PUT', { nos: 2, length: 1.5, breadth: 0.5, reason: 'Back to the site figures' });
    const q = (await sys(`SELECT qty FROM measurement WHERE id=$1`, [m1.id])).rows[0].qty;
    check('M5 and back again', r.status === 200 && near(q, 1.5), `${r.status} ${q}`);
    const lines = (await sys(`SELECT count(*) n FROM mb_line WHERE measurement_id=$1`, [m1.id])).rows[0].n;
    check('M5 each version took its own line of the MB record (3)', lines === '3', lines);

    const list = await j(await call(ovr.token, `/tickets/${t1.id}/measurements`));
    const e1 = list.items?.find((x) => x.item_id === i1.id)?.measurement;
    const e4 = list.items?.find((x) => x.item_id === i4.id)?.measurement;
    check('M5 the list shows the MB number, page and time', e1?.mb_no === MB_NO && String(e1.mb_page) === '12' && !!e1.mb_recorded_at, short(e1));
    check('M5 an unrecorded entry shows none', !e4?.mb_no && !e4?.mb_recorded_at, short(e4));

    let refused = false;
    try { await sys(`DELETE FROM measurement WHERE id=$1`, [m2.id]); } catch { refused = true; }
    const there = (await sys(`SELECT count(*) n FROM measurement WHERE id=$1`, [m2.id])).rows[0].n;
    check('M5 a measurement cannot be deleted, even by the system', refused && there === '1', `${refused} ${there}`);

    const aud = (await sys(`SELECT event_type, reason FROM audit_log WHERE entity_type='measurement' AND entity_id::text=$1`, [t1.id])).rows;
    const has = (e) => aud.some((x) => x.event_type === e);
    check('M5 the database logged the measurements, re-measurements and MB recording',
      has('MEASURED') && has('REMEASURED') && has('MB_RECORDED'), short(aud.map((x) => x.event_type)));
    check('M5 one MEASURED entry for each measured item (4 so far)', aud.filter((x) => x.event_type === 'MEASURED').length === 4, short(aud.map((x) => x.event_type)));
  });

  /* ================= M6 — the Staff Officer's check ================= */
  await attempt('M6 check', async () => {
    const chk = (tok, id, b) => call(tok.token, `/measurements/${id}/check`, 'POST', b);
    let r = await chk(ovr, m1.id, { check_qty: 1.8 });
    check('M6 the Overseer cannot check-measure', r.status === 403, `${r.status}`);
    r = await chk(inc, m1.id, { check_qty: 1.8 });
    check('M6 nor the Incharge', r.status === 403, `${r.status}`);
    r = await chk(sup, m1.id, { check_qty: 1.8 });
    check('M6 nor the supervisor', r.status === 403, `${r.status}`);
    r = await chk(firm, m1.id, { check_qty: 1.8 });
    check('M6 nor the contractor firm', r.status === 403 || r.status === 404, `${r.status}`);
    r = await chk(resident, m1.id, { check_qty: 1.8 });
    check('M6 nor the resident', r.status === 403 || r.status === 404, `${r.status}`);
    r = await chk(gm, m1.id, { check_qty: 1.8 });
    check('M6 nor the GM', r.status === 403, `${r.status}`);
    let c = (await sys(`SELECT check_qty FROM measurement WHERE id=$1`, [m1.id])).rows[0].check_qty;
    check('M6 and no check was recorded by any of them', c === null, c);

    /* Two keys by person. No seeded person is both a measurer and the Staff
       Officer, so act on the database directly as the measuring person in the
       Staff Officer's role: the rule is the database's, whatever route. */
    const mr = (await sys(`SELECT measured_by_person, scope_path::text FROM measurement WHERE id=$1`, [m1.id])).rows[0];
    let refused = null;
    try {
      await withScope(maintPool, { role: 'STAFF_OFFICER_CIVIL', scope_path: mr.scope_path.split('.').slice(0, 2).join('.'),
        person_id: mr.measured_by_person, actor_id: mr.measured_by_person, amr: 'device' },
      (cl) => cl.query(`UPDATE measurement SET check_qty = 1.8, checked_at = clock_timestamp() WHERE id = $1`, [m1.id]));
    } catch (e) { refused = e.message; }
    check('M6 the person who measured cannot check-measure it, whatever role they hold', /measured an entry cannot check/.test(refused || ''), refused);

    r = await chk(so, m1.id, {});
    check('M6 a check needs a quantity (422)', r.status === 422, `${r.status}`);
    r = await chk(so, m1.id, { check_qty: -1 });
    check('M6 a negative check quantity is refused (422)', r.status === 422, `${r.status}`);
    r = await chk(so, '00000000-0000-4000-8000-000000000000', { check_qty: 1 });
    check('M6 an unknown measurement is "not found"', r.status === 404, `${r.status}`);

    /* an entry already written into the MB may still be checked; so may one not yet in it */
    r = await chk(so, m1.id, { check_qty: 1.8, remark: 'Check-measured on site' });
    let body = await j(r);
    const v1 = Math.round(((1.8 - 1.5) / 1.5) * 1000) / 10;
    check('M6 the Staff Officer checks an entry already in the MB (200)', r.status === 200 && near(body.check_qty, 1.8), `${r.status} ${short(body)}`);
    check('M6 the variance is round((check - qty) / qty x 100, 1) = 20', near(body.variance_percent, v1) && near(v1, 20), `${short(body)} expected ${v1}`);
    check('M6 the check carries remark, who and when', body.check_remark === 'Check-measured on site' && !!body.checked_by_name && !!body.checked_at, short(body));
    check('M6 the measurement itself is untouched by the check', near(body.qty, 1.5) && body.mb_no === MB_NO, short(body));

    r = await chk(so, m2.id, { check_qty: 4 });
    body = await j(r);
    check('M6 a check equal to the quantity has variance 0', r.status === 200 && near(body.variance_percent, 0), `${r.status} ${short(body)}`);
    r = await chk(so, m2.id, { check_qty: 4.1 });
    check('M6 revising a check without a reason is refused (422)', r.status === 422, `${r.status} ${short(await j(r))}`);
    c = (await sys(`SELECT check_qty FROM measurement WHERE id=$1`, [m2.id])).rows[0].check_qty;
    check('M6 and the first check stands', near(c, 4), c);
    r = await chk(so, m2.id, { check_qty: 4.1, reason: 'Re-measured at the second visit' });
    body = await j(r);
    check('M6 with a reason it is revised, variance 2.5', r.status === 200 && near(body.check_qty, 4.1) && near(body.variance_percent, 2.5), `${r.status} ${short(body)}`);

    r = await chk(so, m4.id, { check_qty: 0.5 });
    check('M6 an entry not yet in the MB can be checked too', r.status === 200 && near((await j(r)).check_qty, 0.5), `${r.status}`);

    const aud = (await sys(`SELECT event_type, reason FROM audit_log WHERE entity_type='measurement' AND entity_id::text=$1`, [t1.id])).rows;
    check('M6 the database logged CHECK_MEASURED and CHECK_REVISED (with the reason)',
      aud.some((x) => x.event_type === 'CHECK_MEASURED') && aud.some((x) => x.event_type === 'CHECK_REVISED' && /second visit/.test(x.reason || '')), short(aud.map((x) => x.event_type)));
    const hist = await j(await call(so.token, `/tickets/${t1.id}/measurements/history`));
    check('M6 and the history shows them to the Staff Officer',
      Array.isArray(hist) && ['MB_RECORDED', 'CHECK_MEASURED', 'CHECK_REVISED'].every((e) => hist.some((h) => h.event_type === e)), short(hist.map?.((h) => h.event_type)));

    const list = await j(await call(so.token, `/tickets/${t1.id}/measurements`));
    const e1 = list.items?.find((x) => x.item_id === i1.id)?.measurement;
    check('M6 the departmental list shows the check and variance', near(e1?.check_qty, 1.8) && near(e1?.variance_percent, 20), short(e1));
    /* NOT TESTED: "the person who measured cannot check-measure". See the
       header: the seed has nobody who can be both measurer and checker. */
  });

  /* ================= M7 — the contractor's view ================= */
  await attempt('M7 contractor', async () => {
    for (const [who, tok] of [['the supervisor', sup], ['the contractor firm', firm]]) {
      const r = await call(tok.token, `/tickets/${t1.id}/measurements`);
      const body = await j(r);
      const e1 = body.items?.find((x) => x.item_id === i1.id)?.measurement;
      check(`M7 ${who} reads the measurements`, r.status === 200 && body.items?.length === 4, `${r.status} ${short(body)}`);
      check(`M7 ${who} sees the quantity and the MB reference`, near(e1?.qty, 1.5) && e1?.mb_no === MB_NO, short(e1));
      check(`M7 ${who} sees no check-measurement key anywhere`, checkKeys(body).length === 0, checkKeys(body).join());
      // the supervisor reads the whole job card since 2026-10-16; the firm still does not
      if (tok === firm) check(`M7 ${who} does not see the job card's estimated quantities`, (body.items || []).every((i) => !('qty_estimated' in i)), short(body.items?.[0]));
      else check(`M7 ${who} sees the job card's estimated quantities`, (body.items || []).every((i) => 'qty_estimated' in i), short(body.items?.[0]));
    }
    /* the same fields really exist for the department, so the above is not vacuous */
    const so_ = await j(await call(so.token, `/tickets/${t1.id}/measurements`));
    check('M7 (control) the same list for the Staff Officer does carry them', checkKeys(so_).length > 0);
  });

  /* ================= M8 — the extract ================= */
  const extract = async (tok, qs = '') => {
    const r = await call(tok.token, `/mb/extract${qs ? `?${qs}` : ''}`);
    return { r, body: await j(r) };
  };
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const wide = `contract_id=${contractId}&from=${day(Date.now() - 2 * 86400000)}&to=${day(Date.now() + 2 * 86400000)}`;
  let ext;
  await attempt('M8 extract', async () => {
    for (const [who, tok] of [['the contractor firm', firm], ['the supervisor', sup], ['the resident', resident]]) {
      const { r } = await extract(tok);
      check(`M8 ${who} cannot read the extract`, r.status === 403, `${r.status}`);
    }
    for (const [who, tok] of [['the Overseer', ovr], ['the Incharge', inc], ['the Staff Officer', so], ['the GM', gm], ['an HQ executive', hq]]) {
      const { r, body } = await extract(tok, wide);
      check(`M8 ${who} reads the extract`, r.status === 200 && Array.isArray(body.jobs) && !!body.summary, `${r.status} ${short(body)}`);
    }

    const { r, body } = await extract(ovr, wide);
    ext = body;
    check('M8 the extract echoes the period and names the contract',
      r.status === 200 && ext.period?.from && ext.period?.to && ext.contract?.id === contractId && !!ext.contract?.firm_name && ext.contract?.agreement_no === 'NCL/JNT/CIV/2026/01', short({ p: ext.period, c: ext.contract }));
    const s = ext.summary || {};
    check('M8 the summary carries the target (10) and tolerance (5)', Number(s.target_percent) === 10 && Number(s.tolerance_percent) === 5, short(s));
    const allEntries = (ext.jobs || []).flatMap((jb) => jb.entries || []);
    check('M8 summary.entries is the number of entries listed', Number(s.entries) === allEntries.length, `${s.entries} ${allEntries.length}`);
    const nRec = allEntries.filter((e) => e.mb_no).length;
    check('M8 recorded and unrecorded add up to the entries and match what is listed',
      Number(s.recorded) === nRec && Number(s.unrecorded) === allEntries.length - nRec, short({ s, nRec }));
    const nChk = allEntries.filter((e) => e.check_qty !== null && e.check_qty !== undefined).length;
    check('M8 checked matches the entries that carry a check', Number(s.checked) === nChk, `${s.checked} ${nChk}`);
    const pct = allEntries.length ? (nChk / allEntries.length) * 100 : 0;
    check('M8 check_percent is checked over entries (to the nearest per cent at least)', Math.abs(Number(s.check_percent) - pct) <= 0.51, `${s.check_percent} ${pct}`);
    const rule = (e) => e.check_qty !== null && e.check_qty !== undefined &&
      (Math.abs(Number(e.variance_percent)) > 5 || (Number(e.qty) === 0 && Number(e.check_qty) > 0));
    check('M8 flagged: checked and beyond the tolerance, on every entry', allEntries.every((e) => Boolean(e.flagged) === Boolean(rule(e))),
      short(allEntries.filter((e) => Boolean(e.flagged) !== Boolean(rule(e)))));
    check('M8 summary.flagged counts them', Number(s.flagged) === allEntries.filter((e) => e.flagged).length, `${s.flagged}`);

    const tn = (ext.jobs || []).map((x) => x.ticket_no);
    check('M8 jobs are ordered by ticket number', tn.every((x, k) => k === 0 || x >= tn[k - 1]), short(tn));

    const job = (ext.jobs || []).find((x) => x.ticket_id === t1.id);
    check('M8 the job appears with its numbers and premises',
      job && !!job.ticket_no && !!job.jc_no && !!job.identifier && !!job.sub_category, short(job && { ...job, entries: undefined, materials: undefined }));
    check('M8 it has the four live entries (the withdrawn item is not there)', job?.entries?.length === 4, short(job?.entries?.map((e) => e.description)));
    const seqs = (job?.entries || []).map((e) => e.seq);
    check('M8 entries run in item order', seqs.every((x, k) => k === 0 || x > seqs[k - 1]), short(seqs));
    const e1 = job?.entries?.find((e) => e.description === `Plaster to wall ${tag}`);
    check('M8 an entry carries description, unit, dimensions, quantity and estimate',
      e1 && e1.unit === 'Sqm' && near(e1.nos, 2) && near(e1.length, 1.5) && near(e1.breadth, 0.5) && near(e1.qty, 1.5) && near(e1.qty_estimated, 6) && !!e1.measured_at && !!e1.measured_by_name, short(e1));
    check('M8 it carries the MB reference and the check', e1?.mb_no === MB_NO && String(e1.mb_page) === '12' && near(e1.check_qty, 1.8) && near(e1.variance_percent, 20) && !!e1.checked_by_name, short(e1));
    check('M8 a check beyond the 5 per cent tolerance is flagged (20 per cent)', e1?.flagged === true, short(e1));
    const e2 = job?.entries?.find((e) => e.description === `Floor tiles ${tag}`);
    check('M8 a check within the tolerance is not flagged (2.5 per cent)', e2 && near(e2.variance_percent, 2.5) && e2.flagged === false, short(e2));
    const e5 = job?.entries?.find((e) => e.description === `Door shutter ${tag}`);
    check('M8 an unrecorded, unchecked entry carries neither', e5 && !e5.mb_no && (e5.check_qty === null || e5.check_qty === undefined) && !e5.flagged, short(e5));
    check('M8 the job lists its verified materials', job?.materials?.some((m) => m.code === mat.code && near(m.qty_verified, 2) && !!m.name_en && !!m.unit), short(job?.materials));

    check('M8 the contract-and-period summary includes this job\'s checks', Number(s.checked) >= 3 && Number(s.flagged) >= 1 && Number(s.recorded) >= 2 && Number(s.unrecorded) >= 2, short(s));
  });

  await attempt('M8 filters', async () => {
    let { r, body } = await extract(ovr, `${wide}&status=unrecorded`);
    let ents = (body.jobs || []).flatMap((jb) => jb.entries || []);
    check('M8 status=unrecorded lists only entries not in the MB', r.status === 200 && ents.length > 0 && ents.every((e) => !e.mb_no), `${r.status} ${short(ents.filter((e) => e.mb_no))}`);
    check('M8 it includes this job\'s two unrecorded entries and not the recorded ones',
      ents.some((e) => e.description === `Pipe fitting ${tag}`) && ents.some((e) => e.description === `Door shutter ${tag}`) && !ents.some((e) => e.description === `Plaster to wall ${tag}`), short(ents.map((e) => e.description)));
    check('M8 its summary agrees', Number(body.summary?.entries) === ents.length && Number(body.summary?.unrecorded) === ents.length, short(body.summary));

    ({ r, body } = await extract(ovr, `${wide}&status=recorded`));
    ents = (body.jobs || []).flatMap((jb) => jb.entries || []);
    check('M8 status=recorded lists only entries in the MB', r.status === 200 && ents.length > 0 && ents.every((e) => !!e.mb_no), `${r.status}`);
    check('M8 it includes this job\'s two recorded entries and not the unrecorded',
      ents.some((e) => e.description === `Plaster to wall ${tag}`) && ents.some((e) => e.description === `Floor tiles ${tag}`) && !ents.some((e) => e.description === `Door shutter ${tag}`), short(ents.map((e) => e.description)));

    ({ r, body } = await extract(ovr, `contract_id=${contractId}&from=2999-01-01`));
    ents = (body.jobs || []).flatMap((jb) => jb.entries || []);
    check('M8 a period in the future has no entries', r.status === 200 && ents.length === 0 && Number(body.summary?.entries) === 0, `${r.status} ${short(body.summary)}`);
    check('M8 and echoes the period', body.period?.from === '2999-01-01', short(body.period));
    ({ r, body } = await extract(ovr, `contract_id=${contractId}&to=2000-01-01`));
    ents = (body.jobs || []).flatMap((jb) => jb.entries || []);
    check('M8 a period wholly in the past has none (dates filter the measurement time)', r.status === 200 && ents.length === 0, `${r.status}`);
    ({ r, body } = await extract(ovr, `contract_id=${contractId}&from=2000-01-01&to=2999-12-31`));
    check('M8 a wide period includes this job', r.status === 200 && (body.jobs || []).some((x) => x.ticket_id === t1.id), `${r.status}`);
  });

  /* ================= M9 — CSV ================= */
  await attempt('M9 csv', async () => {
    for (const [who, tok] of [['the contractor firm', firm], ['the supervisor', sup], ['the resident', resident]]) {
      const r = await call(tok.token, '/mb/extract.csv');
      check(`M9 ${who} cannot download the CSV`, r.status === 403, `${r.status}`);
    }
    const r = await call(ovr.token, `/mb/extract.csv?${wide}`);
    const csv = await r.text();
    const lines = csv.split(/\r?\n/).filter(Boolean);
    check('M9 the Overseer downloads the CSV, served as text/csv', r.status === 200 && /text\/csv/i.test(r.headers.get('content-type') || ''), `${r.status} ${r.headers.get('content-type')}`);
    check('M9 the header row is exactly as specified', lines[0]?.trim() === CSV_HEADER, lines[0]);
    const { body } = await extract(ovr, wide);
    const n = (body.jobs || []).reduce((a, jb) => a + (jb.entries || []).length, 0);
    check('M9 one row for each entry of the extract', lines.length - 1 === n && n > 0, `${lines.length - 1} rows vs ${n} entries`);
    const job = (body.jobs || []).find((x) => x.ticket_id === t1.id);
    const mine = lines.slice(1).filter((l) => l.startsWith(`${job?.ticket_no},`));
    check('M9 four rows for this job', mine.length === 4, `${mine.length}`);
    const row = mine.find((l) => l.includes(`Plaster to wall ${tag}`)) || '';
    check('M9 a row carries the quantity, MB reference, check, variance and flag',
      row.includes(MB_NO) && /(^|,)1\.5(,|$)/.test(row) && /(^|,)1\.8(,|$)/.test(row) && /(^|,)20(\.0)?(,|$)/.test(row) && /(^|,)(true|TRUE|yes|Yes|Y|1)\s*$/.test(row), row);
    const disp = r.headers.get('content-disposition') || '';
    check('M9 it is offered as a download file', disp === '' || /\.csv/i.test(disp), disp);
    const s = await call(so.token, `/mb/extract.csv?status=unrecorded&${wide}`);
    const sl = (await s.text()).split(/\r?\n/).filter(Boolean);
    check('M9 the status filter applies to the CSV', s.status === 200 && sl.length > 1 && !sl.some((l) => l.includes(`Plaster to wall ${tag}`)) && sl.some((l) => l.includes(`Door shutter ${tag}`)), `${s.status} ${sl.length}`);
  });

  /* ================= M10 — evidence only ================= */
  await attempt('M10 money', async () => {
    const shapes = [];
    shapes.push(['a new measurement', m1]);
    shapes.push(['the list for the Overseer', await j(await call(ovr.token, `/tickets/${t1.id}/measurements`))]);
    shapes.push(['the list for the Staff Officer', await j(await call(so.token, `/tickets/${t1.id}/measurements`))]);
    shapes.push(['the list for the supervisor', await j(await call(sup.token, `/tickets/${t1.id}/measurements`))]);
    shapes.push(['the history', await j(await call(ovr.token, `/tickets/${t1.id}/measurements/history`))]);
    shapes.push(['the extract', ext]);
    for (const [what, body] of shapes) {
      const bad = moneyKeys(body);
      check(`M10 ${what} carries no rate, price, amount or cost`, bad.length === 0, bad.join(','));
    }
    const hist = shapes[4][1];
    const inner = (Array.isArray(hist) ? hist : []).flatMap((h) => [h.before_value, h.after_value]);
    check('M10 nor does anything inside the history entries', moneyKeys(inner).length === 0, moneyKeys(inner).join(','));
    const csvHead = (await (await call(ovr.token, `/mb/extract.csv?${wide}`)).text()).split(/\r?\n/)[0];
    check('M10 nor the CSV header', !MONEY.test(csvHead), csvHead);
    const cols = (await sys(`SELECT table_name, column_name FROM information_schema.columns
                              WHERE table_name = 'measurement' AND column_name ~* '(rate|price|amount|cost|rupee)'`)).rows;
    check('M10 the measurement table has no money column', cols.length === 0, short(cols));
  });

  /* ================= M11 — Area isolation ================= */
  await attempt('M11 isolation', async () => {
    const jayantIds = new Set([m1.id, m2.id, m4.id, m5.id]);
    let r = await call(ngh.token, '/mb/extract');
    const body = await j(r);
    const ents = (body.jobs || []).flatMap((jb) => jb.entries || []);
    check('M11 an Overseer of another Area reads an extract of their own', r.status === 200 && Array.isArray(body.jobs), `${r.status} ${short(body)}`);
    check('M11 it holds none of Jayant\'s jobs or entries',
      !(body.jobs || []).some((x) => [t1.id, t2.id, t3.id].includes(x.ticket_id)) && !ents.some((e) => jayantIds.has(e.id)), short(body.summary));
    r = await call(ngh.token, `/mb/extract?contract_id=${contractId}&${wide}`);
    const b2 = await j(r);
    check('M11 asking for Jayant\'s contract by number gives nothing', r.status === 200 || r.status === 404 || r.status === 403, `${r.status}`);
    check('M11 and no Jayant entry even then', !(b2.jobs || []).some((x) => x.ticket_id === t1.id), short(b2.summary));
    r = await call(ngh.token, '/mb/extract.csv');
    const csv = await r.text();
    check('M11 nor does the CSV', r.status === 200 && !csv.includes(`Plaster to wall ${tag}`) && !csv.includes(`Pipe fitting ${tag}`), `${r.status}`);
    const seen = (await sys(`SELECT count(*) n FROM measurement WHERE ticket_id=$1`, [t1.id])).rows[0].n;
    check('M11 (control) the measurements do exist', Number(seen) === 4, seen);
  });
}

run().catch((e) => { check('suite ran to the end', false, e.stack); })
  .finally(async () => {
    for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n         ${d}` : ''}`);
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await maintPool.end().catch(() => {}); await identityPool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
