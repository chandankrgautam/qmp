/**
 * Suite 27 — working through a month's MB, and finding it later (user's
 * decisions, 2026-10-16; README §5.5 "Working through a month's MB; finding
 * it years later").
 *
 * Written before the code.
 *
 *   W   the worklist: for a contract and month, each officer of the chain sees
 *       what waits at their own step, what is still below them, sent back,
 *       approved; one row per job with both sheets' steps, the days at the
 *       step and the changes made in the chain; nobody else reads it
 *   F   the flag: a sheet waiting longer than the setting at one step
 *   S   the sample check: jobs of the month per contract, how many the Staff
 *       Officer has check-measured, how many 1 in 10 needs, the shortfall
 *   Q   the MB search: by words of an item, complaint number, stage, approval
 *       dates and MB page; each result says where in the MB it is
 *   P   the contract's MB opens by month and by page, never all at once
 *   R   the portal's Search carries a closed job's MB reference and filters
 *       to approved or pending MBs
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
const short = (x) => String(JSON.stringify(x)).slice(0, 300);
const sys = (sql, p) => withSystem(maintPool, (c) => c.query(sql, p));

async function as(key, role) {
  const d = devices[key];
  const post = (p, b) => fetch(`${BASE}/identity/v1${p}`, { method: 'POST', headers: json, body: JSON.stringify(b) });
  const ch = await (await post('/auth/challenge', { public_key: d.publicKey })).json();
  return (await post('/auth/token', { public_key: d.publicKey, nonce: ch.nonce,
    signature: signNonce(d.privateKey, ch.nonce), second_factor_satisfied: true, role: role || d.role })).json();
}

// the month as the portal counts it: India time
const monthIST = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 7);
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

async function run() {
  const resident = await as('RESIDENT:R. K. Singh');
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey', 'CIVIL_OVERSEER');
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra', 'MAINTENANCE_INCHARGE');
  const so = await as('STAFF_OFFICER_CIVIL:S. Tiwari', 'STAFF_OFFICER_CIVIL');
  const sup = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const firm = await as('CONTRACTOR:M/s Jayant Constructions');
  const ngh = await as('CIVIL_OVERSEER:Nigahi Overseer');
  const cats = (await j(await call(resident.token, '/masters/categories'))).filter((c) => !c.emergency_eligible);
  const verma = (await j(await call(inc.token, '/devices/assignable'))).find((a) => a.person_name === 'M/s Verma — Supr');
  const tag = `zq${Date.now() % 100000}`;
  const step = async (tok, id, p, body) => {
    const r = await call(tok, `/tickets/${id}/${p}`, 'POST', body);
    if (r.status !== 200 && r.status !== 201) throw new Error(`${p} ${r.status} ${short(await j(r))}`);
    return j(r);
  };
  const act = (tok, id, action, body) => step(tok, id, `sheets/measurements/${action}`, body || {});

  /* six jobs of this month, accepted, left at every step of the chain */
  const jobs = {};
  let contractId;
  await attempt('setup', async () => {
    for (const [k, n] of [['A', 0], ['B', 1], ['C', 2], ['D', 3], ['E', 4], ['F', 5]]) {
      const t = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: cats[n].id, description: `Suite 27 job ${k}` }));
      if (!t.id) throw new Error(`raise ${k} ${short(t)}`);
      await step(ovr.token, t.id, 'verify');
      await step(inc.token, t.id, 'assign', { supervisor_id: verma.actor_id });
      const item = await step(sup.token, t.id, 'job-card/items', { description: `${tag} plastering ${k}`, unit: 'Sqm', qty_estimated: 2 });
      await step(sup.token, t.id, 'start', { workmen_assigned: 'Ram Prasad' });
      await step(sup.token, t.id, 'complete');
      await step(ovr.token, t.id, 'inspect', { accepted: true });
      const m = await step(sup.token, t.id, 'measurements', { item_id: item.id, nos: 1, length: 2, breadth: 1 });
      jobs[k] = { ...t, item, m };
    }
    contractId = (await j(await call(ovr.token, `/tickets/${jobs.A.id}/job-card`))).ticket?.contract_id;
    // B up to the Overseer; C to the Incharge, the Overseer having changed it
    await act(sup.token, jobs.B.id, 'submit');
    await act(sup.token, jobs.C.id, 'submit');
    let r = await call(ovr.token, `/measurements/${jobs.C.m.id}`, 'PUT', { qty: 1.8, reason: 'Re-taped' });
    if (r.status !== 200) throw new Error(`remeasure C ${r.status}`);
    await act(ovr.token, jobs.C.id, 'pass');
    // D up to the Staff Officer and sent back to the Incharge; E waits at the Staff Officer
    for (const k of ['D', 'E', 'F']) {
      await act(sup.token, jobs[k].id, 'submit');
      await act(ovr.token, jobs[k].id, 'pass-no-change');
      await act(inc.token, jobs[k].id, 'pass-no-change');
    }
    await act(so.token, jobs.D.id, 'return', { remark: 'Check the breadth again' });
    // F approved, and the Staff Officer check-measures it on site
    await act(so.token, jobs.F.id, 'approve');
    r = await call(so.token, `/measurements/${jobs.F.m.id}/check`, 'POST', { check_qty: 2 });
    if (r.status !== 200) throw new Error(`check F ${r.status} ${short(await j(r))}`);
    // A stays with the supervisor; he measures it again and again, so the MB runs onto page 2
    for (let i = 0; i < 25; i++) {
      r = await call(sup.token, `/measurements/${jobs.A.m.id}`, 'PUT', { qty: 2 + (i + 1) / 100, reason: `Re-measured ${i + 1}` });
      if (r.status !== 200) throw new Error(`remeasure A ${i} ${r.status} ${short(await j(r))}`);
    }
    check('setup: six accepted jobs at every step of the chain, one approved and checked', true);
  });

  const month = monthIST();
  const wl = async (tok, qs = '') => { const r = await call(tok, `/mb/worklist?contract_id=${contractId}&month=${month}${qs}`); return { r, b: await j(r) }; };
  const row = (b, k) => (b.rows || []).find((x) => x.ticket_id === jobs[k].id);

  await attempt('W the worklist', async () => {
    let { r, b } = await wl(so.token);
    check('W the Staff Officer reads the month’s worklist', r.status === 200 && Array.isArray(b.rows), `${r.status} ${short(b)}`);
    check('W it holds the six jobs of the month', ['A', 'B', 'C', 'D', 'E', 'F'].every((k) => row(b, k)), short(b.rows?.map((x) => x.ticket_no)));
    check('W one waits at his step (E)', b.tiles?.mine === 1 && row(b, 'E')?.mine === true, short(b.tiles));
    check('W four are still below him (A, B, C and D sent back)', b.tiles?.below === 4, short(b.tiles));
    check('W one is approved (F)', b.tiles?.approved === 1, short(b.tiles));
    check('W one was sent back (D)', b.tiles?.sent_back === 1 && row(b, 'D')?.sent_back === true, short(b.tiles));
    check('W a row gives both sheets’ steps and the days at the step',
      row(b, 'C')?.measurements_stage === 'INCHARGE' && row(b, 'C')?.materials_stage === 'SUPERVISOR' && typeof row(b, 'C')?.days_at_step === 'number', short(row(b, 'C')));
    check('W a job changed in the chain says so (C)', row(b, 'C')?.changes >= 1 && row(b, 'B')?.changes === 0, short({ c: row(b, 'C')?.changes, b: row(b, 'B')?.changes }));
    check('W a row carries what the list needs: number, quarter, fault', !!row(b, 'A')?.ticket_no && !!row(b, 'A')?.identifier && !!row(b, 'A')?.sub_category, short(row(b, 'A')));

    ({ b } = await wl(inc.token));
    check('W for the Incharge two wait at his step (C, and D sent back)', b.tiles?.mine === 2, short(b.tiles));
    check('W and two are below him (A, B)', b.tiles?.below === 2, short(b.tiles));
    ({ b } = await wl(ovr.token));
    check('W for the Overseer one waits (B) and one is below (A)', b.tiles?.mine === 1 && b.tiles?.below === 1, short(b.tiles));

    ({ b } = await wl(so.token, '&kind=materials'));
    check('W the materials are counted on their own: all six still with the supervisor', b.tiles?.mine === 0 && b.tiles?.below === 6, short(b.tiles));

    for (const [who, tok] of [['the supervisor', sup], ['the firm', firm], ['the resident', resident]]) {
      ({ r } = await wl(tok.token));
      check(`W ${who} does not read the worklist`, r.status === 403 || r.status === 404, `${r.status}`);
    }
    r = await call(ngh.token, `/mb/worklist?month=${month}`);
    b = await j(r);
    check('W an Overseer of another Area sees none of these jobs', r.status === 200 && !(b.rows || []).some((x) => Object.values(jobs).some((t) => t.id === x.ticket_id)), short(b.tiles));
    ({ b } = await (async () => { const rr = await call(so.token, `/mb/worklist?contract_id=${contractId}&month=2000-01`); return { b: await j(rr) }; })());
    check('W another month holds none of them', (b.rows || []).length === 0, short(b.tiles));
  });

  await attempt('F the waiting flag', async () => {
    let { b } = await wl(so.token);
    check('F nothing has waited 7 days yet', b.tiles?.waiting_long === 0 && b.wait_days === 7, short({ t: b.tiles, w: b.wait_days }));
    await sys(`UPDATE maint_config SET value = '0' WHERE key = 'sheet_waiting_days'`);
    ({ b } = await wl(so.token));
    check('F with the setting at 0 days every unapproved sheet is flagged (5)', b.tiles?.waiting_long === 5 && row(b, 'E')?.waiting_long === true && row(b, 'F')?.waiting_long === false, short(b.tiles));
    const r = await call(so.token, '/sheets/waiting');
    const w = await j(r);
    const mine = (w.items || []).filter((x) => Object.values(jobs).some((t) => t.id === x.ticket_id) && x.kind === 'MEASUREMENTS');
    check('F the waiting list names each such sheet with its step and days', r.status === 200 && mine.length === 5 && mine.every((x) => !!x.stage && typeof x.days === 'number' && !!x.ticket_no), short(w));
    check('F and counts them by step', w.by_stage?.STAFF_OFFICER >= 1 && w.by_stage?.SUPERVISOR >= 1, short(w.by_stage));
    const rs = await call(sup.token, '/sheets/waiting');
    check('F the contractor does not read the waiting list', rs.status === 403 || rs.status === 404, `${rs.status}`);
    await sys(`UPDATE maint_config SET value = '7' WHERE key = 'sheet_waiting_days'`);
  });

  await attempt('S the sample check', async () => {
    const { b } = await wl(so.token);
    const s = (b.sample || []).find((x) => x.contract_id === contractId);
    check('S the month’s sample for the contract: six jobs, one checked', s?.jobs === 6 && s?.checked === 1, short(b.sample));
    check('S 1 in 10 of six needs one; no shortfall', s?.required === 1 && s?.shortfall === 0 && s?.target_percent === 10, short(s));
    check('S the checked job is marked in the list', row(b, 'F')?.checked === true && row(b, 'E')?.checked === false, short({ f: row(b, 'F')?.checked }));
    await sys(`UPDATE maint_config SET value = '50' WHERE key = 'check_measure_target_percent'`);
    const b2 = (await wl(so.token)).b;
    const s2 = (b2.sample || []).find((x) => x.contract_id === contractId);
    check('S at a 50 per cent aim three are needed: a shortfall of two', s2?.required === 3 && s2?.shortfall === 2, short(s2));
    await sys(`UPDATE maint_config SET value = '10' WHERE key = 'check_measure_target_percent'`);
  });

  const srch = async (tok, qs) => { const r = await call(tok, `/mb/search?${qs}`); return { r, b: await j(r) }; };
  const has = (b, k) => (b.items || []).some((x) => x.ticket_id === jobs[k].id);
  await attempt('Q the MB search', async () => {
    let { r, b } = await srch(so.token, `q=${tag}`);
    check('Q words of an item find the jobs', r.status === 200 && ['A', 'B', 'C', 'D', 'E', 'F'].every((k) => has(b, k)), `${r.status} ${short(b)}`);
    const f = (b.items || []).find((x) => x.ticket_id === jobs.F.id);
    check('Q a result says where it is: MB number, pages, lines, its step and approval', !!f?.mb_no && Array.isArray(f?.pages) && f.pages.length > 0 && typeof f?.first_line === 'number' && f?.stage === 'APPROVED' && !!f?.approved_at, short(f));
    check('Q a result carries the quarter and the fault', !!f?.identifier && !!f?.sub_category, short(f));
    ({ b } = await srch(so.token, `q=${tag.slice(0, 4)}`));
    check('Q a word beginning is enough', has(b, 'A') && has(b, 'F'), short(b.total));
    ({ b } = await srch(so.token, `q=${encodeURIComponent(jobs.C.ticket_no)}`));
    check('Q the complaint number finds its job', has(b, 'C') && !has(b, 'B'), short(b.items?.map((x) => x.ticket_no)));
    ({ b } = await srch(so.token, `q=${tag}&stage=APPROVED`));
    check('Q by stage: approved only', has(b, 'F') && !has(b, 'E'), short(b.items?.map((x) => x.ticket_no)));
    ({ b } = await srch(so.token, `q=${tag}&approved_from=${today()}&approved_to=${today()}`));
    check('Q by approval date: approved today', has(b, 'F') && !has(b, 'A'), short(b.items?.map((x) => x.ticket_no)));
    ({ b } = await srch(so.token, `q=${tag}&approved_from=2999-01-01`));
    check('Q a future approval date finds nothing', (b.items || []).length === 0, short(b.total));
    ({ b } = await srch(so.token, `contract_id=${contractId}&page_no=2`));
    check('Q by MB page: page 2 holds job A', has(b, 'A'), short(b.items?.map((x) => [x.ticket_no, x.pages])));
    ({ r, b } = await srch(sup.token, `q=${tag}`));
    check('Q the supervisor searches his jobs’ MB too', r.status === 200 && has(b, 'A'), `${r.status}`);
    ({ r } = await srch(resident.token, `q=${tag}`));
    check('Q never the resident', r.status === 403 || r.status === 404, `${r.status}`);
    ({ b } = await srch(ngh.token, `q=${tag}`));
    check('Q never another Area', (b.items || []).length === 0, short(b.total));
  });

  await attempt('P the contract’s MB by month and page', async () => {
    let r = await call(so.token, `/contracts/${contractId}/mb`);
    let b = await j(r);
    const m = (b.months || []).find((x) => x.month === month);
    check('P the book lists its months with their pages', r.status === 200 && m && m.first_page === 1 && m.last_page >= 2, short(b.months));
    check('P and says how many pages it has', b.pages >= 2, short(b.pages));
    check('P without a choice it opens on the latest month', (b.lines || []).length > 0 && b.lines.every((l) => l.at && monthIST(new Date(l.at)) === month), short(b.lines?.length));
    r = await call(so.token, `/contracts/${contractId}/mb?page_from=2&page_to=2`);
    b = await j(r);
    check('P a page range gives only those pages', (b.lines || []).length > 0 && b.lines.every((l) => l.page === 2), short(b.lines?.map((l) => l.page)));
    check('P the index of jobs follows the pages shown', (b.jobs || []).some((x) => x.ticket_id === jobs.A.id), short(b.jobs));
    r = await call(so.token, `/contracts/${contractId}/mb?month=2000-01`);
    b = await j(r);
    check('P a month with nothing gives no lines', r.status === 200 && (b.lines || []).length === 0 && b.pages >= 2, short(b));
  });

  await attempt('R the portal’s Search', async () => {
    let r = await call(so.token, `/search?q=${encodeURIComponent(jobs.F.ticket_no)}`);
    let b = await j(r);
    const f = (b.items || []).find((x) => x.id === jobs.F.id);
    check('R a job found in Search carries its MB reference', !!f?.mb_no && Array.isArray(f?.mb_pages) && f.mb_pages.length > 0 && f?.mb_stage === 'APPROVED', short(f));
    r = await call(so.token, '/search?mb=approved&page_size=200');
    b = await j(r);
    check('R "MB approved" finds the approved job and none still in the chain',
      (b.items || []).some((x) => x.id === jobs.F.id) && !(b.items || []).some((x) => x.id === jobs.E.id), short(b.items?.map((x) => x.ticket_no)));
    r = await call(so.token, '/search?mb=pending&page_size=200');
    b = await j(r);
    check('R "MB pending" finds those still in the chain', ['A', 'B', 'C', 'D', 'E'].every((k) => (b.items || []).some((x) => x.id === jobs[k].id)) && !(b.items || []).some((x) => x.id === jobs.F.id), short(b.items?.map((x) => x.ticket_no)));
  });
}

run().catch((e) => { check('suite ran to the end', false, e.stack); })
  .finally(async () => {
    for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n         ${d}` : ''}`);
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await maintPool.end().catch(() => {}); await identityPool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
