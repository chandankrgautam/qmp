/**
 * Suite 12 — the job card (decision 2026-09-30, item 5).
 *
 *   J1  prepared automatically when a complaint is assigned
 *   J2  read by the Overseer and everyone above; not by the resident or
 *       the contractor; not across Areas
 *   J3  changed only by the Overseer or the Civil Incharge
 *   J4  every change audited; a correction needs a reason; items are
 *       withdrawn, never deleted
 *   J5  the same card through rework; locked once the complaint is closed
 *   J6  lists
 *   J7  every round of the job from the first (rework, dispute, reopening)
 *       until the complainant is satisfied (user's finding, 2026-10-07)
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

async function run() {
  const resident = await as('RESIDENT:R. K. Singh');
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey');
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
  const so = await as('STAFF_OFFICER_CIVIL:S. Tiwari');
  const gm = await as('GM_CIVIL:GM (Civil)');
  const sup = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const firm = await as('CONTRACTOR:M/s Jayant Constructions');
  const ngh = await as('CIVIL_OVERSEER:Nigahi Overseer');
  const claims = (t, role) => ({ role, scope_path: t.scope_path, actor_id: t.actor_id, person_id: t.person_id });

  const cats = await j(await call(resident.token, '/masters/categories'));
  const sub = cats.find((c) => c.name_en.startsWith('Leaking tap'));
  const t = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: sub.id, description: 'Kitchen tap leaking since Monday' }));
  await call(ovr.token, `/tickets/${t.id}/verify`, 'POST');

  /* ================= J1 — prepared at assignment ================= */
  let r = await call(ovr.token, `/tickets/${t.id}/job-card`);
  check('J1 no job card before the complaint is assigned', r.status === 404, `${r.status}`);
  const assignable = await j(await call(inc.token, '/devices/assignable'));
  const verma = assignable.find((a) => a.person_name === 'M/s Verma — Supr');
  await call(inc.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: verma.actor_id });
  r = await call(ovr.token, `/tickets/${t.id}/job-card`);
  const jc = await j(r);
  check('J1 assigning the complaint prepares its job card', r.status === 200 && jc.jc_no === `JC/${t.ticket_no}`, `${r.status} ${JSON.stringify(jc).slice(0, 200)}`);
  check('J1 the card carries the complaint, premises and assignment',
    jc.ticket?.description === 'Kitchen tap leaking since Monday' && jc.ticket?.identifier === 'B-234'
    && jc.ticket?.supervisor_name === 'M/s Verma — Supr' && !!jc.ticket?.contractor_name && !!jc.ticket?.assigned_at,
    JSON.stringify(jc.ticket).slice(0, 300));
  check('J1 and starts with no work items', Array.isArray(jc.items) && jc.items.length === 0);

  /* ================= J2 — who reads it ================= */
  for (const [who, tok] of [['the Civil Incharge', inc], ['the Staff Officer', so], ['the GM (Civil)', gm]]) {
    r = await call(tok.token, `/tickets/${t.id}/job-card`);
    check(`J2 ${who} reads the job card`, r.status === 200, `${r.status}`);
  }
  // the supervisor the job is assigned to reads its card since 2026-10-16 (README 5.5)
  r = await call(sup.token, `/tickets/${t.id}/job-card`);
  check('J2 the supervisor of the job reads it', r.status === 200, `${r.status}`);
  for (const [who, tok] of [['the resident', resident], ['the contractor firm', firm], ['an Overseer of another Area', ngh]]) {
    r = await call(tok.token, `/tickets/${t.id}/job-card`);
    check(`J2 ${who} does not`, r.status === 404, `${r.status}`);
  }
  const seen = (await withScope(maintPool, claims(firm, 'CONTRACTOR'), (c) => c.query(
    `SELECT count(*) n FROM job_card WHERE ticket_id=$1`, [t.id]))).rows[0].n;
  check('J2 the database itself hides it from the contractor firm', seen === '0', seen);

  /* ================= J3 — who changes it ================= */
  r = await call(ovr.token, `/tickets/${t.id}/job-card`, 'PUT', { scope_of_work: 'Replace washer and spindle of kitchen pillar cock' });
  check('J3 the Overseer fills in the scope of work', r.status === 200, `${r.status} ${JSON.stringify(await j(r))}`);
  r = await call(inc.token, `/tickets/${t.id}/job-card/items`, 'POST', { description: 'Pillar cock spindle, brass', unit: 'No.', qty_estimated: 1 });
  const item = await j(r);
  check('J3 the Incharge adds a work item', r.status === 201 && item.seq === 1, `${r.status} ${JSON.stringify(item)}`);
  r = await call(ovr.token, `/tickets/${t.id}/job-card/items`, 'POST', { description: 'Rubber washer', unit: 'No.', qty_estimated: 2 });
  const item2 = await j(r);
  check('J3 and the Overseer another', r.status === 201 && item2.seq === 2, `${r.status}`);
  for (const [who, tok] of [['the Staff Officer', so], ['the GM (Civil)', gm], ['the contractor firm', firm]]) {
    r = await call(tok.token, `/tickets/${t.id}/job-card`, 'PUT', { site_notes: 'x' });
    check(`J3 ${who} cannot change it`, r.status === 403 || r.status === 404, `${r.status}`);
  }
  r = await call(sup.token, `/tickets/${t.id}/job-card`, 'PUT', { site_notes: 'Seat worn; spindle loose' });
  check('J3 the supervisor of the job fills in a blank (2026-10-16)', r.status === 200, `${r.status} ${JSON.stringify(await j(r)).slice(0, 160)}`);
  let refused = false;
  try {
    await withScope(maintPool, claims(so, 'STAFF_OFFICER_CIVIL'), async (c) => {
      const u = await c.query(`UPDATE job_card SET site_notes='quiet' WHERE ticket_id=$1`, [t.id]);
      if (!u.rowCount) throw new Error('no row');
    });
  } catch { refused = true; }
  check('J3 the database refuses a change from the Staff Officer', refused);
  r = await call(ovr.token, `/tickets/${t.id}/job-card/items`, 'POST', { description: 'Something', unit: 'No.', qty_estimated: -1 });
  check('J3 a negative quantity is refused', r.status === 422, `${r.status}`);

  /* ================= J4 — audited ================= */
  r = await call(ovr.token, `/tickets/${t.id}/job-card`, 'PUT', { scope_of_work: 'Replace the whole pillar cock' });
  check('J4 correcting what is already written needs a reason', r.status === 422, `${r.status}`);
  r = await call(ovr.token, `/tickets/${t.id}/job-card`, 'PUT', { scope_of_work: 'Replace the whole pillar cock', reason: 'Body cracked, seen on site' });
  check('J4 with a reason it is corrected', r.status === 200, `${r.status}`);
  const log = (await sys(`SELECT before_value, after_value, reason, actor_id FROM audit_log
                           WHERE entity_type='job_card' AND entity_id=$1 AND event_type='JOB_CARD_CHANGED' ORDER BY id DESC LIMIT 1`, [t.id])).rows[0];
  check('J4 the log holds the old text, the new, the reason and who',
    /washer and spindle/.test(log?.before_value?.scope_of_work || '') && /whole pillar cock/.test(log?.after_value?.scope_of_work || '')
    && /cracked/.test(log?.reason || '') && log?.actor_id === ovr.actor_id, JSON.stringify(log));
  check('J4 its preparation is in the log too',
    (await sys(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND event_type='JOB_CARD_PREPARED'`, [t.id])).rows[0].n === '1');
  refused = false;
  try {
    await withScope(maintPool, claims(ovr, 'CIVIL_OVERSEER'), (c) => c.query(
      `UPDATE job_card SET scope_of_work='quiet rewrite' WHERE ticket_id=$1`, [t.id]));
  } catch { refused = true; }
  check('J4 the database refuses a correction without a reason', refused);

  r = await call(inc.token, `/tickets/${t.id}/job-card/items/${item.id}`, 'PUT', { qty_estimated: 2 });
  check('J4 changing an item needs a reason', r.status === 422, `${r.status}`);
  r = await call(inc.token, `/tickets/${t.id}/job-card/items/${item.id}`, 'PUT', { description: 'Pillar cock, brass, 15 mm', qty_estimated: 1, reason: 'Whole cock to be replaced' });
  check('J4 with a reason it is changed', r.status === 200, `${r.status} ${JSON.stringify(await j(r))}`);
  r = await call(ovr.token, `/tickets/${t.id}/job-card/items/${item2.id}/withdraw`, 'POST', {});
  check('J4 withdrawing an item needs a reason', r.status === 422, `${r.status}`);
  r = await call(ovr.token, `/tickets/${t.id}/job-card/items/${item2.id}/withdraw`, 'POST', { reason: 'Not needed with the new cock' });
  check('J4 with a reason it is withdrawn', r.status === 200, `${r.status}`);
  const card = await j(await call(inc.token, `/tickets/${t.id}/job-card`));
  check('J4 a withdrawn item stays on the card, marked withdrawn',
    card.items?.length === 2 && card.items.find((i) => i.id === item2.id)?.withdrawn_at && /Not needed/.test(card.items.find((i) => i.id === item2.id)?.withdrawal_reason || ''),
    JSON.stringify(card.items));
  refused = false;
  try { await sys(`DELETE FROM job_card_item WHERE id=$1`, [item2.id]); } catch { refused = true; }
  check('J4 an item cannot be deleted, even by the system', refused);
  refused = false;
  try { await sys(`DELETE FROM job_card WHERE ticket_id=$1`, [t.id]); } catch { refused = true; }
  check('J4 nor the card', refused);
  try { await sys(`UPDATE job_card SET jc_no='JC/other' WHERE ticket_id=$1`, [t.id]); } catch { /* refused */ }
  refused = false;
  try {
    await withScope(maintPool, claims(ovr, 'CIVIL_OVERSEER'), async (c) => {
      await c.query(`SELECT set_config('app.reason','renumber',true)`);
      await c.query(`UPDATE job_card SET jc_no='JC/other' WHERE ticket_id=$1`, [t.id]);
    });
  } catch { refused = true; }
  const no = (await sys(`SELECT jc_no FROM job_card WHERE ticket_id=$1`, [t.id])).rows[0].jc_no;
  check('J4 its number never changes, by the Overseer or the system', refused && no === `JC/${t.ticket_no}`, `${refused} ${no}`);
  const hist = await j(await call(so.token, `/tickets/${t.id}/job-card/history`));
  check('J4 the history shows each change with its reason, to those above too',
    Array.isArray(hist) && ['JOB_CARD_PREPARED', 'JOB_CARD_CHANGED', 'JOB_CARD_ITEM_ADDED', 'JOB_CARD_ITEM_CHANGED', 'JOB_CARD_ITEM_WITHDRAWN']
      .every((e) => hist.some((h) => h.event_type === e)), JSON.stringify(hist.map?.((h) => h.event_type)));

  /* ================= J5 — rework keeps the card; closure locks it ================= */
  await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
  await uploadCompletion(BASE, sup.token, t.id);
  await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
  await uploadInspection(BASE, ovr.token, t.id);
  await call(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: false, remark: 'Still dripping' });
  const cards = (await sys(`SELECT count(*) n FROM job_card WHERE ticket_id=$1`, [t.id])).rows[0].n;
  check('J5 rework keeps the same job card', cards === '1', cards);
  r = await call(ovr.token, `/tickets/${t.id}/job-card`, 'PUT', { site_notes: 'Rework: check the seat as well', reason: 'Rework found more' });
  check('J5 and it can still be added to during rework', r.status === 200, `${r.status}`);
  await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
  await uploadCompletion(BASE, sup.token, t.id);
  await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
  await uploadInspection(BASE, ovr.token, t.id);
  await call(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true });
  r = await call(ovr.token, `/tickets/${t.id}/close`, 'POST');
  const state = (await sys(`SELECT state FROM ticket WHERE id=$1`, [t.id])).rows[0].state;
  check('J5 (setup) the complaint is closed', state === 'CLOSED', `${r.status} ${state}`);
  r = await call(ovr.token, `/tickets/${t.id}/job-card`, 'PUT', { site_notes: 'after the event', reason: 'late note' });
  check('J5 a closed complaint\'s job card cannot be changed', r.status === 422, `${r.status}`);
  r = await call(inc.token, `/tickets/${t.id}/job-card/items`, 'POST', { description: 'x', unit: 'No.', qty_estimated: 1 });
  check('J5 nor an item added', r.status === 422, `${r.status}`);
  refused = false;
  try {
    await withScope(maintPool, claims(inc, 'MAINTENANCE_INCHARGE'), async (c) => {
      await c.query(`SELECT set_config('app.reason','late',true)`);
      await c.query(`UPDATE job_card SET site_notes='late' WHERE ticket_id=$1`, [t.id]);
    });
  } catch { refused = true; }
  check('J5 the database refuses it too', refused);
  r = await call(gm.token, `/tickets/${t.id}/job-card`);
  check('J5 it is still read after closure', r.status === 200, `${r.status}`);

  const list = await j(await call(so.token, '/job-cards?open=false'));
  check('J6 the Staff Officer lists the Area\'s job cards', Array.isArray(list.items) && list.items.some((x) => x.ticket_id === t.id), JSON.stringify(list).slice(0, 160));
  r = await call(sup.token, '/job-cards');
  const supList = await j(r);
  check('J6 the contractor lists none', (supList.items || []).length === 0, `${r.status} ${JSON.stringify(supList).slice(0, 100)}`);

  /* ================= J7 — the whole life of the job, every round =================
     User's finding (2026-10-07): after a resident's dispute and reopening,
     the job card showed only the latest round. Round 1 is sent back by the
     Overseer; round 2 is accepted and closed; the resident disputes and
     reopens; round 3 is accepted, closed, and the resident is satisfied. */
  const sub2 = cats.find((c) => c.name_en.startsWith('Internal pipe'));
  const t2 = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: sub2.id, description: 'Pipe under the sink leaking' }));
  const mats = await j(await call(sup.token, '/materials'));
  const washer = mats.find((m) => m.code === 'PLM-WASHER'), pipe = mats.find((m) => m.code === 'PLM-PVC20');
  const round = async (workmen, material, qty) => {
    await call(sup.token, `/tickets/${t2.id}/start`, 'POST', { workmen_assigned: workmen });
    await call(sup.token, `/tickets/${t2.id}/materials`, 'POST', { material_id: material.id, qty_claimed: qty });
    await uploadCompletion(BASE, sup.token, t2.id);
    await call(sup.token, `/tickets/${t2.id}/complete`, 'POST');
  };
  await call(ovr.token, `/tickets/${t2.id}/verify`, 'POST');
  await call(inc.token, `/tickets/${t2.id}/assign`, 'POST', { supervisor_id: verma.actor_id });
  await round('Ram Prasad', washer, 2);                                          // round 1
  await uploadInspection(BASE, ovr.token, t2.id);
  await call(ovr.token, `/tickets/${t2.id}/inspect`, 'POST', { accepted: false, remark: 'Joint still weeping' });
  await round('Shyam Lal, Mohan', pipe, 3);                                      // round 2
  const lines2 = (await j(await call(ovr.token, `/tickets/${t2.id}/materials`))).items || [];
  await call(ovr.token, `/tickets/${t2.id}/materials/${lines2.find((l) => l.code === 'PLM-PVC20')?.id}/verify`, 'POST', { qty_verified: 3 });
  await uploadInspection(BASE, ovr.token, t2.id);
  await call(ovr.token, `/tickets/${t2.id}/inspect`, 'POST', { accepted: true });
  await call(ovr.token, `/tickets/${t2.id}/close`, 'POST');
  r = await call(resident.token, `/tickets/${t2.id}/feedback`, 'POST', { confirmed: false, rating: 1, comment: 'Leaking again the next morning' });
  check('J7 (setup) the resident disputes the closed job', r.status === 200, `${r.status} ${JSON.stringify(await j(r))}`);
  r = await call(resident.token, `/tickets/${t2.id}/reopen`, 'POST', { reason: 'Water still dripping under the sink' });
  check('J7 (setup) and reopens it', r.status === 200, `${r.status} ${JSON.stringify(await j(r))}`);
  let card7 = await j(await call(ovr.token, `/tickets/${t2.id}/job-card`));
  check('J7 while reopened the card says the complainant is not satisfied', card7.lifecycle?.status === 'DISPUTED', JSON.stringify(card7.lifecycle?.status));
  await call(ovr.token, `/tickets/${t2.id}/assign`, 'POST', { supervisor_id: verma.actor_id });
  await round('Ram Prasad, Gopal', washer, 1);                                   // round 3
  await uploadInspection(BASE, ovr.token, t2.id);
  await call(ovr.token, `/tickets/${t2.id}/inspect`, 'POST', { accepted: true });
  await call(ovr.token, `/tickets/${t2.id}/close`, 'POST');
  card7 = await j(await call(ovr.token, `/tickets/${t2.id}/job-card`));
  check('J7 after the third closure, before the resident answers, it awaits the complainant',
    card7.lifecycle?.status === 'AWAITING_CONFIRMATION', JSON.stringify(card7.lifecycle?.status));
  r = await call(resident.token, `/tickets/${t2.id}/feedback`, 'POST', { confirmed: true, rating: 4, comment: 'Fixed now' });
  check('J7 (setup) the resident is satisfied', r.status === 200, `${r.status}`);

  card7 = await j(await call(so.token, `/tickets/${t2.id}/job-card`));
  const R = card7.lifecycle?.rounds || [];
  check('J7 the job card is still one card', card7.jc_no === `JC/${t2.ticket_no}`, card7.jc_no);
  check('J7 it records all three rounds from the first', R.length === 3, JSON.stringify(R).slice(0, 300));
  check('J7 each round keeps its own workmen',
    R[0]?.workmen === 'Ram Prasad' && R[1]?.workmen === 'Shyam Lal, Mohan' && R[2]?.workmen === 'Ram Prasad, Gopal',
    JSON.stringify(R.map((x) => x.workmen)));
  check('J7 each round keeps its own supervisor', R.length === 3 && R.every((x) => x.supervisor_name === 'M/s Verma — Supr'), JSON.stringify(R.map((x) => x.supervisor_name)));
  check('J7 each round keeps its own materials',
    R[0]?.materials?.some((m) => m.code === 'PLM-WASHER' && m.qty_claimed === 2)
    && R[1]?.materials?.some((m) => m.code === 'PLM-PVC20' && m.qty_claimed === 3 && m.qty_verified === 3)
    && R[2]?.materials?.some((m) => m.code === 'PLM-WASHER' && m.qty_claimed === 1)
    && R[0].materials.length === 1 && R[1].materials.length === 1 && R[2].materials.length === 1,
    JSON.stringify(R.map((x) => x.materials)));
  check('J7 each round has its start and completion claim', R.length === 3 && R.every((x) => x.started_at && x.claimed_at), JSON.stringify(R.map((x) => [x.started_at, x.claimed_at])));
  check('J7 round 1 ended with the Overseer sending it back, with the remark',
    R[0]?.inspection?.result === 'SENT_BACK' && /weeping/.test(R[0]?.inspection?.remark || ''), JSON.stringify(R[0]?.inspection));
  check('J7 round 2 was accepted and closed', R[1]?.inspection?.result === 'ACCEPTED' && !!R[1]?.closed_at, JSON.stringify([R[1]?.inspection, R[1]?.closed_at]));
  check('J7 round 2 keeps the resident’s dispute, with their words and rating',
    !!R[1]?.feedback?.some((f) => f.confirmed === false && /next morning/.test(f.comment || '') && f.rating === 1), JSON.stringify(R[1]?.feedback));
  check('J7 round 2 was begun by the send-back', R[1]?.cause?.type === 'SENT_BACK', JSON.stringify(R[1]?.cause));
  check('J7 round 3 was begun by the reopening, with the resident’s reason',
    R[2]?.cause?.type === 'REOPENED' && /dripping/.test(R[2]?.cause?.reason || ''), JSON.stringify(R[2]?.cause));
  check('J7 round 3 keeps the resident’s satisfaction', !!R[2]?.feedback?.some((f) => f.confirmed === true && f.rating === 4), JSON.stringify(R[2]?.feedback));
  check('J7 the card ends only now: the complainant is satisfied', card7.lifecycle?.status === 'SATISFIED', JSON.stringify(card7.lifecycle?.status));

  // the record itself, not only the screen: the first dispute survives the later satisfaction
  const fb = (await sys(`SELECT event_type, reason, detail FROM ticket_event WHERE ticket_id=$1 AND event_type LIKE 'OCCUPANT_%' ORDER BY id`, [t2.id])).rows;
  check('J7 the history keeps both the dispute and the later satisfaction',
    fb.length === 2 && fb[0].event_type === 'OCCUPANT_DISPUTED' && fb[1].event_type === 'OCCUPANT_CONFIRMED'
    && fb[0].detail?.rating === 1, JSON.stringify(fb));
  const starts = (await sys(`SELECT detail->>'workmen_assigned' w FROM ticket_event WHERE ticket_id=$1 AND to_state='IN_PROGRESS' ORDER BY id`, [t2.id])).rows.map((x) => x.w);
  check('J7 the history keeps every round’s workmen', JSON.stringify(starts) === JSON.stringify(['Ram Prasad', 'Shyam Lal, Mohan', 'Ram Prasad, Gopal']), JSON.stringify(starts));
  let evRefused = false;
  try { await sys(`UPDATE ticket_event SET detail = '{}' WHERE ticket_id=$1`, [t2.id]); } catch { evRefused = true; }
  check('J7 those details can never be edited', evRefused);
  r = await call(sup.token, `/tickets/${t2.id}/job-card`);
  check('J7 the supervisor of the job reads the card (2026-10-16)', r.status === 200, `${r.status}`);
}

run().catch((e) => { check('suite ran to the end', false, e.stack); })
  .finally(async () => {
    for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n         ${d}` : ''}`);
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await maintPool.end().catch(() => {}); await identityPool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
