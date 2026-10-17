/**
 * Suite 26 — the job card for the supervisor, his measurement sheet and its
 * approval chain, and the MB reference record (user's decisions, 2026-10-16;
 * README §5.5 "Materials and measurements after the work").
 *
 * Written before the code.
 *
 *   J   the supervisor the job is assigned to reads the whole job card and
 *       changes or adds to the scope, site notes and items, every change
 *       recorded; it no longer locks at closure but when the MB is approved;
 *       the contractor sees roles, never officers' names
 *   M   the measurement sheet is the supervisor's own, from when the Overseer
 *       has accepted the work; it goes up the same chain as the materials
 *   B   the MB reference record: one MB number per contract, given at the
 *       first entry; every version of a measurement takes the next line, on
 *       fixed pages of 25 lines; a revision is appended, the old line kept
 *       and marked superseded; read per job and per contract
 *   L   the MB approval locks the job: measurements, materials and the job
 *       card change afterwards only by the Staff Officer, with a reason
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
  const cats = await j(await call(resident.token, '/masters/categories'));
  const sub = cats.find((c) => c.classification !== 'EM' && !c.emergency_eligible) || cats[0];
  const verma = (await j(await call(inc.token, '/devices/assignable'))).find((a) => a.person_name === 'M/s Verma — Supr');
  const step = async (tok, id, p, body) => {
    const r = await call(tok, `/tickets/${id}/${p}`, 'POST', body);
    if (r.status !== 200) throw new Error(`${p} ${r.status} ${short(await j(r))}`);
  };
  const sheet = async (tok, id, k = 'measurements') => (await j(await call(tok, `/tickets/${id}/sheets`)))[k];
  const act = (tok, id, action, body, k = 'measurements') => call(tok, `/tickets/${id}/sheets/${k}/${action}`, 'POST', body || {});
  const card = async (tok, id) => j(await call(tok, `/tickets/${id}/job-card`));

  let t, item1, item2, m1, contractId;
  await attempt('J the job card for the supervisor', async () => {
    t = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: sub.id, description: 'Suite 26: bathroom wall tiles' }));
    await step(ovr.token, t.id, 'verify');
    await step(inc.token, t.id, 'assign', { supervisor_id: verma.actor_id });
    let r = await call(sup.token, `/tickets/${t.id}/job-card`);
    const c = await j(r);
    check('J the supervisor reads the job card of his job', r.status === 200 && !!c.jc_no, `${r.status} ${short(c)}`);
    contractId = c.ticket?.contract_id;
    r = await call(sup.token, `/tickets/${t.id}/job-card`, 'PUT', { scope_of_work: 'Remove loose tiles, refix with adhesive, grout' });
    check('J he fills in the scope of work', r.status === 200, `${r.status} ${short(await j(r))}`);
    r = await call(sup.token, `/tickets/${t.id}/job-card/items`, 'POST', { description: 'Refixing wall tiles', unit: 'Sqm', qty_estimated: 3 });
    item1 = await j(r);
    check('J he adds an item', [200, 201].includes(r.status) && !!item1.id, `${r.status} ${short(item1)}`);
    r = await call(ovr.token, `/tickets/${t.id}/job-card/items`, 'POST', { description: 'Grouting', unit: 'Sqm', qty_estimated: 3 });
    item2 = await j(r);
    check('J the Overseer adds an item too, as before', [200, 201].includes(r.status) && !!item2.id, `${r.status} ${short(item2)}`);
    r = await call(sup.token, `/tickets/${t.id}/job-card`, 'PUT', { scope_of_work: 'Remove loose tiles, refix, grout and clean' });
    check('J correcting what is written needs a reason, for him as for officers', r.status === 422, `${r.status}`);
    r = await call(sup.token, `/tickets/${t.id}/job-card`, 'PUT', { scope_of_work: 'Remove loose tiles, refix, grout and clean', reason: 'Cleaning added' });
    check('J with a reason he corrects it', r.status === 200, `${r.status} ${short(await j(r))}`);
    const h = await j(await call(sup.token, `/tickets/${t.id}/job-card/history`));
    const rows = Array.isArray(h) ? h : h.items || [];
    check('J the card’s history shows his changes', rows.some((x) => x.actor_role === 'CONTRACTOR_SUPERVISOR'), short(rows.map((x) => x.actor_role)));
    check('J and the Overseer’s by role, never by name, to him', rows.filter((x) => x.actor_role === 'CIVIL_OVERSEER').every((x) => !x.actor_name), short(rows));
    const oh = await j(await call(ovr.token, `/tickets/${t.id}/job-card/history`));
    check('J officers see the names', (Array.isArray(oh) ? oh : oh.items || []).some((x) => !!x.actor_name), '');
  });

  await attempt('M the supervisor’s measurement sheet', async () => {
    let r = await call(sup.token, `/tickets/${t.id}/measurements`, 'POST', { item_id: item1.id, nos: 1, length: 2, breadth: 1.5 });
    check('M nothing is measured before the Overseer accepts the work', r.status === 422, `${r.status} ${short(await j(r))}`);
    await step(sup.token, t.id, 'start', { workmen_assigned: 'Ram Prasad' });
    await step(sup.token, t.id, 'complete');
    await step(ovr.token, t.id, 'inspect', { accepted: true });
    await step(ovr.token, t.id, 'close');
    r = await call(sup.token, `/tickets/${t.id}/job-card/items`, 'POST', { description: 'Cleaning', unit: 'Job', qty_estimated: 1 });
    check('J after closure the card is not locked: the supervisor adds an item', [200, 201].includes(r.status), `${r.status} ${short(await j(r))}`);
    r = await call(ovr.token, `/tickets/${t.id}/measurements`, 'POST', { item_id: item1.id, qty: 3 });
    check('M the Overseer does not measure first: the sheet is the supervisor’s', r.status === 403, `${r.status} ${short(await j(r))}`);
    r = await call(sup.token, `/tickets/${t.id}/measurements`, 'POST', { item_id: item1.id, nos: 1, length: 2, breadth: 1.5 });
    m1 = await j(r);
    check('M the supervisor measures an item (Nos × L × B)', [200, 201].includes(r.status) && Number(m1.qty) === 3, `${r.status} ${short(m1)}`);
    r = await call(sup.token, `/tickets/${t.id}/measurements`, 'POST', { item_id: item2.id, qty: 3 });
    check('M and another by quantity', [200, 201].includes(r.status), `${r.status}`);
    r = await act(sup.token, t.id, 'submit');
    check('M he sends the measurements for review', r.status === 200 && (await sheet(ovr.token, t.id))?.stage === 'OVERSEER', `${r.status} ${short(await j(r))}`);
    r = await call(sup.token, `/measurements/${m1.id}`, 'PUT', { nos: 1, length: 2, breadth: 2, reason: 'late' });
    check('M after that he measures nothing', r.status >= 400, `${r.status}`);
    r = await call(ovr.token, `/measurements/${m1.id}`, 'PUT', { nos: 1, length: 2, breadth: 1.4 });
    check('M the Overseer’s change needs a reason', r.status === 422, `${r.status}`);
    r = await call(ovr.token, `/measurements/${m1.id}`, 'PUT', { nos: 1, length: 2, breadth: 1.4, reason: 'Measured on site: 1.4 m' });
    check('M with a reason the Overseer measures again', r.status === 200 && Number((await j(r)).qty) === 2.8, `${r.status}`);
    r = await act(ovr.token, t.id, 'pass');
    check('M he passes it to the Incharge', r.status === 200, `${r.status}`);
    r = await act(inc.token, t.id, 'pass-no-change');
    check('M the Incharge reviews it — no change', r.status === 200, `${r.status}`);
    r = await act(so.token, t.id, 'approve');
    check('M the Staff Officer approves the MB', r.status === 200 && (await sheet(so.token, t.id))?.stage === 'APPROVED', `${r.status} ${short(await j(r))}`);
  });

  await attempt('B the MB reference record', async () => {
    let r = await call(ovr.token, `/tickets/${t.id}/mb`);
    const mb = await j(r);
    check('B the job’s MB record is read', r.status === 200 && !!mb.mb_no, `${r.status} ${short(mb)}`);
    check('B one MB number for the contract', /MB/.test(mb.mb_no || ''), short(mb.mb_no));
    const lines = mb.lines || [];
    check('B every version took a line: two measured, one measured again', lines.length === 3, short(lines.map((l) => [l.line_no, l.qty, l.superseded])));
    check('B lines are numbered in order, with their page', lines.every((l, i) => i === 0 || l.line_no > lines[i - 1].line_no) && lines.every((l) => l.page === Math.ceil(l.line_no / 25)), short(lines.map((l) => [l.line_no, l.page])));
    check('B the revision is appended; the old line stays, marked superseded', lines.filter((l) => l.superseded).length === 1 && lines.some((l) => !l.superseded && Number(l.qty) === 2.8), short(lines));
    check('B and says who measured, by role', lines.every((l) => !!l.by_role), short(lines.map((l) => l.by_role)));
    const sr = await j(await call(sup.token, `/tickets/${t.id}/mb`));
    check('B the supervisor reads it, without officers’ names', (sr.lines || []).length === 3 && (sr.lines || []).filter((l) => l.by_role !== 'CONTRACTOR_SUPERVISOR').every((l) => !l.by_name), short(sr.lines));
    r = await call(ovr.token, `/contracts/${contractId}/mb`);
    const book = await j(r);
    check('B the whole contract’s MB is read, indexed by job', r.status === 200 && book.mb_no === mb.mb_no && (book.jobs || []).some((x) => x.ticket_no === t.ticket_no), `${r.status} ${short(book)}`);
    const rr = await call(resident.token, `/tickets/${t.id}/mb`);
    check('B never by the occupant', rr.status === 404, `${rr.status}`);
  });

  await attempt('L the MB approval locks the job', async () => {
    let r = await call(ovr.token, `/measurements/${m1.id}`, 'PUT', { nos: 1, length: 2, breadth: 1.5, reason: 'after approval' });
    check('L after approval the Overseer measures nothing', r.status >= 400, `${r.status}`);
    r = await call(so.token, `/measurements/${m1.id}`, 'PUT', { nos: 1, length: 2, breadth: 1.5 });
    check('L the Staff Officer’s correction needs a reason', r.status === 422, `${r.status}`);
    r = await call(so.token, `/measurements/${m1.id}`, 'PUT', { nos: 1, length: 2, breadth: 1.5, reason: 'Correction after re-check on site' });
    check('L with a reason he corrects it', r.status === 200, `${r.status} ${short(await j(r))}`);
    const mb = await j(await call(so.token, `/tickets/${t.id}/mb`));
    const last = (mb.lines || []).at(-1);
    check('L the correction is appended as a correction, with its reason', last?.correction === true && /re-check/.test(last?.reason || ''), short(last));
    r = await call(sup.token, `/tickets/${t.id}/job-card/items`, 'POST', { description: 'Late item', unit: 'No', qty_estimated: 1 });
    check('L the job card is locked for the supervisor', r.status >= 400, `${r.status}`);
    r = await call(ovr.token, `/tickets/${t.id}/job-card`, 'PUT', { site_notes: 'late note' });
    check('L and for the Overseer', r.status >= 400, `${r.status}`);
    // materials: approve them, then try to send them back after the MB approval
    await act(sup.token, t.id, 'submit', {}, 'materials');
    await act(ovr.token, t.id, 'pass-no-change', {}, 'materials');
    await act(inc.token, t.id, 'pass-no-change', {}, 'materials');
    await act(so.token, t.id, 'approve', {}, 'materials');
    r = await act(so.token, t.id, 'reopen', { remark: 'after the MB' }, 'materials');
    check('L approved materials cannot be sent back once the MB is approved', r.status === 422, `${r.status} ${short(await j(r))}`);
  });
}

run().catch((e) => check('suite ran to the end', false, e.stack))
  .finally(async () => {
    for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n         ${d}` : ''}`);
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await maintPool.end().catch(() => {}); await identityPool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
