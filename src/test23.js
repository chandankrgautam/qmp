/**
 * Suite 23 — what the V2 screens read (experiment branch, 2026-10-13).
 *
 * Written before the code. Three read-only additions and one new record:
 *
 *   V1  the complaint list says whose time it is: an open pause (and why),
 *       the contractor's own minutes, the SLA window and the response
 *       deadline, the category and premises type — so the officer's inbox
 *       can show "Contractor: 6 h of 8", "Paused — quarter locked" (O2)
 *   V2  the complaint page carries its escalation path, from the database's
 *       own rules: four levels, the role at each, when it is reached (the
 *       deadline plus the rule's interval), which levels are reached — the
 *       resident's "if it is not fixed in time" ladder (R1)
 *   V3  colony notices (R4): the Overseer or Incharge posts one for a colony
 *       in their own Area; residents of that colony see it, nobody else's
 *       residents and no other Area do; contractors and residents cannot
 *       post; a notice is ended with a reason, never edited or deleted;
 *       the database logs it
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
const short = (x) => String(JSON.stringify(x)).slice(0, 240);
const list = (b) => (Array.isArray(b) ? b : b?.items || []);

async function run() {
  const resident = await as('RESIDENT:R. K. Singh');
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey');
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
  const sup = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const ngh = await as('CIVIL_OVERSEER:Nigahi Overseer');
  const nghRes = await as('RESIDENT:Nigahi resident');
  const gm = await as('GM_CIVIL:GM (Civil)');

  const cats = await j(await call(resident.token, '/masters/categories'));
  const assignable = await j(await call(inc.token, '/devices/assignable'));
  const verma = assignable.find((a) => a.person_name === 'M/s Verma — Supr');
  const plain = cats.filter((c) => c.classification !== 'EM');
  const normalSub = plain.find((c) => !c.emergency_eligible) || plain[0];
  const emSub = plain.find((c) => c.emergency_eligible && c.id !== normalSub.id);

  async function raise(sub, extra = {}) {
    const t = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: sub.id, description: 'V2 suite', ...extra }));
    if (!t.id) throw new Error(`raise ${short(t)}`);
    return t;
  }
  async function assigned(sub, extra) {
    const t = await raise(sub, extra);
    let r = await call(ovr.token, `/tickets/${t.id}/verify`, 'POST');
    if (r.status !== 200) throw new Error(`verify ${r.status} ${short(await j(r))}`);
    r = await call(inc.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: verma.actor_id });
    if (r.status !== 200) throw new Error(`assign ${r.status} ${short(await j(r))}`);
    return t;
  }

  /* ---------------------------------------------------------------- V4 */
  // completed work in the list (user's request, 2026-10-15): the Completed tabs
  // of the Inbox and the apps say when each step happened and whether the
  // contractor was within their time, from the list alone
  await attempt('V4 completed work in the list', async () => {
    const t = await assigned(normalSub);
    const step = async (tok, p, body) => {
      const r = await call(tok, `/tickets/${t.id}/${p}`, 'POST', body);
      if (r.status !== 200) throw new Error(`${p} ${r.status} ${short(await j(r))}`);
    };
    await step(sup.token, 'start', { workmen_assigned: 'Ram Prasad' });
    await step(sup.token, 'complete');
    await step(ovr.token, 'inspect', { accepted: true });
    await step(ovr.token, 'close');
    for (const who of [['Overseer', ovr], ['supervisor', sup]]) {
      const row = list(await j(await call(who[1].token, '/tickets'))).find((x) => x.id === t.id);
      for (const k of ['verified_at', 'assigned_at', 'started_at', 'completed_claim_at', 'inspected_at', 'closed_at'])
        check(`V4 the ${who[0]}'s list says when: ${k}`, !!row?.[k] && !Number.isNaN(Date.parse(row[k])), short(row));
      check(`V4 the ${who[0]}'s list says the contractor was within their time`, row?.completion_met === true, short(row));
    }
  });

  /* ---------------------------------------------------------------- V5 */
  // what the contractor FIRM sees of its own jobs (its phone’s Jobs screens,
  // 2026-10-15): every job of its contract, live and completed, but — like its
  // supervisor — never the occupant’s objections, answers or disputes (README §2)
  await attempt('V5 the contractor firm', async () => {
    const firm = await as('CONTRACTOR:M/s Jayant Constructions');
    if (!firm.token) throw new Error(`firm sign-in ${short(firm)}`);
    const t = await assigned(normalSub);
    const step = async (tok, p, body) => {
      const r = await call(tok, `/tickets/${t.id}/${p}`, 'POST', body);
      if (![200, 201].includes(r.status)) throw new Error(`${p} ${r.status} ${short(await j(r))}`);
    };
    await step(sup.token, 'start', { workmen_assigned: 'Ram Prasad' });
    await step(resident.token, 'objections', { note: 'V5 the workmen left the tap running' });
    let row = list(await j(await call(firm.token, '/tickets'))).find((x) => x.id === t.id);
    check('V5 the firm’s list carries its job', !!row, '');
    check('V5 the firm can do nothing to it', (row?.available_actions || []).length === 0, short(row?.available_actions));
    check('V5 the list says which supervisor holds it', row?.assigned_to === verma.actor_id, short(row));
    let d = await j(await call(firm.token, `/tickets/${t.id}`));
    check('V5 the firm opens the job', d.id === t.id, short(d));
    check('V5 the firm does not see the occupant’s objection', !(d.objections || []).length, short(d.objections));
    const objs = list(await j(await call(firm.token, '/objections')));
    check('V5 nor in the objections list', !objs.some((o) => o.ticket_id === t.id), short(objs));
    const sObjs = list(await j(await call(sup.token, '/objections')));
    check('V5 (the supervisor does not either)', !sObjs.some((o) => o.ticket_id === t.id), short(sObjs));
    await step(sup.token, 'complete');
    await step(ovr.token, 'inspect', { accepted: true });
    await step(ovr.token, 'close');
    await step(resident.token, 'feedback', { confirmed: true, rating: 2, comment: 'V5 slow and untidy' });
    row = list(await j(await call(firm.token, '/tickets'))).find((x) => x.id === t.id);
    check('V5 the completed job stays in the firm’s list, closed', row?.state === 'CLOSED' && !!row?.closed_at, short(row));
    d = await j(await call(firm.token, `/tickets/${t.id}`));
    const kinds = (d.history || []).map((h) => h.event_type);
    check('V5 the firm sees the job’s history', kinds.includes('CLOSED'), short(kinds));
    check('V5 but not the occupant’s answer in it', !kinds.some((k) => String(k).startsWith('OCCUPANT_')), short(kinds));
    check('V5 nor their words anywhere in the job', !JSON.stringify(d).includes('V5 slow and untidy'), '');
    const fb = await call(firm.token, `/tickets/${t.id}/feedback`);
    check('V5 and the answer itself is not found', fb.status === 404, `${fb.status}`);
    check('V5 the firm sees no review of the job', !(d.reviews || []).length, short(d.reviews));
    const mats = await call(firm.token, `/tickets/${t.id}/materials`);
    check('V5 the firm reads the materials claimed on its job', mats.status === 200, `${mats.status}`);
    const mb = await call(firm.token, `/tickets/${t.id}/measurements`);
    check('V5 and what Civil measured', mb.status === 200, `${mb.status}`);
  });

  /* ---------------------------------------------------------------- V1 */
  let job;
  await attempt('V1 list fields', async () => {
    job = await assigned(normalSub);
    const items = list(await j(await call(ovr.token, '/tickets')));
    const row = items.find((x) => x.id === job.id);
    check('V1 the list returns the complaint', !!row, `${items.length}`);
    for (const k of ['paused', 'pause_attribution', 'paused_since', 'contractor_minutes', 'contractor_window_started_at',
      'sla_completion_minutes', 'response_deadline_at', 'category', 'premises_type']) {
      check(`V1 list carries ${k}`, row && k in row, short(row && Object.keys(row)));
    }
    check('V1 not paused to begin with', row?.paused === false && row?.pause_attribution === null && row?.paused_since === null, short(row));
    check('V1 the contractor\'s window is open once assigned', !!row?.contractor_window_started_at, short(row));
    check('V1 the SLA window is a number of minutes', Number.isInteger(row?.sla_completion_minutes) && row.sla_completion_minutes > 0, short(row));
    check('V1 premises type is QUARTER for a quarter', row?.premises_type === 'QUARTER', short(row));
  });

  await attempt('V1 pause shows', async () => {
    const r = await call(ovr.token, `/tickets/${job.id}/pause`, 'POST', { attribution: 'OCCUPANT', reason: 'Quarter locked; occupant away' });
    check('V1 the Overseer pauses the clock (occupant)', [200, 201].includes(r.status), `${r.status} ${short(await j(r))}`);
    const row = list(await j(await call(ovr.token, '/tickets'))).find((x) => x.id === job.id);
    check('V1 the list says it is paused', row?.paused === true, short(row));
    check('V1 and why: the occupant', row?.pause_attribution === 'OCCUPANT', short(row));
    check('V1 and since when', !!row?.paused_since && !Number.isNaN(Date.parse(row.paused_since)), short(row));
    const mine = list(await j(await call(resident.token, '/tickets'))).find((x) => x.id === job.id);
    check('V1 the resident\'s own list says it too', mine?.paused === true && mine?.pause_attribution === 'OCCUPANT', short(mine));
    const theirs = list(await j(await call(sup.token, '/tickets'))).find((x) => x.id === job.id);
    check('V1 the supervisor sees the pause on their job', theirs?.paused === true, short(theirs));
  });

  await attempt('V1 the pause ends', async () => {
    const pid = (await sys(`SELECT id FROM sla_pause WHERE ticket_id=$1 AND resumed_at IS NULL`, [job.id])).rows[0]?.id;
    const r = await call(ovr.token, `/tickets/${job.id}/resume`, 'POST', { pause_id: pid });
    check('V1 the Overseer resumes the clock', [200, 201, 204].includes(r.status), `${r.status} ${short(await j(r))}`);
    const row = list(await j(await call(ovr.token, '/tickets'))).find((x) => x.id === job.id);
    check('V1 the list no longer says paused', row?.paused === false && row?.paused_since === null, short(row));
  });

  /* ---------------------------------------------------------------- V2 */
  await attempt('V2 escalation path', async () => {
    const t = await j(await call(resident.token, `/tickets/${job.id}`));
    const p = t.escalation_path;
    check('V2 the complaint carries an escalation path of four levels', Array.isArray(p) && p.length === 4, short(p));
    check('V2 in order, Overseer → Incharge → Staff Officer → GM',
      p?.map((x) => x.role).join() === 'CIVIL_OVERSEER,MAINTENANCE_INCHARGE,STAFF_OFFICER_CIVIL,GM_CIVIL', short(p));
    const rules = (await sys(`SELECT level, minutes_after_breach FROM escalation_rule WHERE is_emergency = false ORDER BY level`)).rows;
    const dl = Date.parse(t.completion_deadline_at);
    const fits = p?.every((x, i) => Date.parse(x.due_at) === dl + rules[i].minutes_after_breach * 60000);
    check('V2 each level is due at the deadline plus the rule\'s interval', !!fits, short(p));
    check('V2 none reached while within the deadline', p?.every((x) => x.reached_at === null && x.reached === false), short(p));
    check('V2 the officer sees the same path', short((await j(await call(ovr.token, `/tickets/${job.id}`))).escalation_path) === short(p));
  });

  await attempt('V2 emergency rules', async () => {
    if (!emSub) { check('V2 an emergency-eligible sub-category exists', false); return; }
    const t = await raise(emSub, { is_emergency: true });
    await call(ovr.token, `/tickets/${t.id}/verify`, 'POST');
    const full = await j(await call(resident.token, `/tickets/${t.id}`));
    const rules = (await sys(`SELECT level, minutes_after_breach FROM escalation_rule WHERE is_emergency = true ORDER BY level`)).rows;
    const dl = Date.parse(full.completion_deadline_at);
    check('V2 an emergency follows the emergency intervals',
      full.escalation_path?.every((x, i) => Date.parse(x.due_at) === dl + rules[i].minutes_after_breach * 60000), short(full.escalation_path));
  });

  await attempt('V2 before verification', async () => {
    const t = await raise(plain.find((c) => c.id !== normalSub.id && c.id !== emSub?.id));
    const full = await j(await call(resident.token, `/tickets/${t.id}`));
    check('V2 before verification there is no deadline, so no due times',
      full.escalation_path?.length === 4 && full.escalation_path.every((x) => x.due_at === null), short(full.escalation_path));
  });

  await attempt('V2 reached levels', async () => {
    // the escalation sweep records levels as SYSTEM; here the record is written as it would be
    await sys(`INSERT INTO escalation_event (ticket_id, level) VALUES ($1, 1), ($1, 2)`, [job.id]);
    await sys(`UPDATE ticket SET escalation_level = 2 WHERE id = $1`, [job.id]);
    const p = (await j(await call(resident.token, `/tickets/${job.id}`))).escalation_path;
    check('V2 reached levels are marked, with when', p?.[0].reached && p?.[1].reached && !!p?.[1].reached_at && !p?.[2].reached, short(p));
  });

  /* ---------------------------------------------------------------- V3 */
  const colonies = await (await fetch(`${BASE}/identity/v1/masters/colonies`)).json();
  const jnt = colonies.find((c) => /Jayant/.test(c.name));
  const ngc = colonies.find((c) => /Nigahi/.test(c.name));
  let notice;

  await attempt('V3 posting', async () => {
    let r = await call(ovr.token, '/notices', 'POST', { colony_id: jnt.id, title: 'Water supply to Block B off until 4 pm', body: 'Main valve repair. Please do not report a no-water complaint for Block B before 4 pm.' });
    notice = await j(r);
    check('V3 the Overseer posts a notice for a colony in their Area', r.status === 201 && !!notice.id, `${r.status} ${short(notice)}`);
    check('V3 it records who posted it, as a role', notice.posted_by_role === 'CIVIL_OVERSEER', short(notice));
    r = await call(inc.token, '/notices', 'POST', { colony_id: jnt.id, title: 'Painting of Block A stairwells this week', body: 'Expect paint smell in the stairwells until Friday.' });
    check('V3 the Incharge may post too', r.status === 201, `${r.status}`);
    r = await call(ovr.token, '/notices', 'POST', { colony_id: jnt.id, title: '', body: 'x' });
    check('V3 a title is required', r.status === 422, `${r.status}`);
    r = await call(ngh.token, '/notices', 'POST', { colony_id: jnt.id, title: 'Not mine', body: 'x' });
    check('V3 an Overseer of another Area cannot post to Jayant (not found)', r.status === 404, `${r.status}`);
    r = await call(sup.token, '/notices', 'POST', { colony_id: jnt.id, title: 'From the contractor', body: 'x' });
    check('V3 a contractor cannot post', r.status === 403, `${r.status}`);
    r = await call(resident.token, '/notices', 'POST', { colony_id: jnt.id, title: 'From a resident', body: 'x' });
    check('V3 a resident cannot post', r.status === 403, `${r.status}`);
    r = await call(gm.token, '/notices', 'POST', { colony_id: jnt.id, title: 'From HQ', body: 'x' });
    check('V3 HQ is read-only here too', r.status === 403, `${r.status}`);
  });

  await attempt('V3 reading', async () => {
    const mine = list(await j(await call(resident.token, '/notices')));
    check('V3 the resident of that colony sees it', mine.some((n) => n.id === notice.id), `${mine.length}`);
    const theirs = list(await j(await call(nghRes.token, '/notices')));
    check('V3 a resident of another colony does not', !theirs.some((n) => n.id === notice.id), `${theirs.length}`);
    const other = list(await j(await call(ngh.token, '/notices')));
    check('V3 another Area\'s Overseer does not', !other.some((n) => n.id === notice.id), `${other.length}`);
    const hq = list(await j(await call(gm.token, '/notices')));
    check('V3 HQ reads every Area\'s notices', hq.some((n) => n.id === notice.id), `${hq.length}`);
    const sees = list(await j(await call(sup.token, '/notices')));
    check('V3 contractors read none', sees.length === 0, `${sees.length}`);
    check('V3 a notice carries no resident\'s data', !/R\. K\. Singh|B-234/.test(JSON.stringify(mine)), short(mine));
  });

  await attempt('V3 ending', async () => {
    let r = await call(ovr.token, `/notices/${notice.id}/end`, 'POST', {});
    check('V3 ending needs a reason', r.status === 422, `${r.status}`);
    r = await call(ngh.token, `/notices/${notice.id}/end`, 'POST', { reason: 'not mine' });
    check('V3 another Area cannot end it', r.status === 404, `${r.status}`);
    r = await call(ovr.token, `/notices/${notice.id}/end`, 'POST', { reason: 'Valve repaired at 3:10 pm' });
    check('V3 the Overseer ends it with a reason', r.status === 200, `${r.status} ${short(await j(r))}`);
    const mine = list(await j(await call(resident.token, '/notices')));
    check('V3 an ended notice leaves the resident\'s list', !mine.some((n) => n.id === notice.id), `${mine.length}`);
    const all = list(await j(await call(ovr.token, '/notices?all=true')));
    const kept = all.find((n) => n.id === notice.id);
    check('V3 officers still find it, ended, with the reason', kept?.ended_at && kept?.end_reason === 'Valve repaired at 3:10 pm', short(kept));
    r = await call(ovr.token, `/notices/${notice.id}/end`, 'POST', { reason: 'again' });
    check('V3 an ended notice cannot be ended again', r.status === 409, `${r.status}`);
  });

  await attempt('V3 the database keeps it', async () => {
    // row security admits no writer but the Overseer and Incharge (so the
    // system's update touches nothing), and the trigger refuses them a rewrite
    try { await sys(`UPDATE colony_notice SET title = 'rewritten' WHERE id = $1`, [notice.id]); } catch { /* refused outright is fine too */ }
    const after = (await sys(`SELECT title FROM colony_notice WHERE id = $1`, [notice.id])).rows[0]?.title;
    check('V3 a notice\'s words cannot be rewritten, even by the system', after === 'Water supply to Block B off until 4 pm', after);
    let refused = false;
    try { await sys(`DELETE FROM colony_notice WHERE id = $1`, [notice.id]); } catch { refused = true; }
    check('V3 nor deleted', refused);
    const log = (await sys(`SELECT event_type FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at`, [notice.id])).rows.map((x) => x.event_type);
    check('V3 the database logged posting and ending', log.includes('NOTICE_POSTED') && log.includes('NOTICE_ENDED'), short(log));
  });
}

run().catch((e) => { check('suite ran to the end', false, e.stack); })
  .finally(async () => {
    for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n         ${d}` : ''}`);
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await maintPool.end().catch(() => {}); await identityPool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
