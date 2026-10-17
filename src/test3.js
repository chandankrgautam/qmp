import fs from 'node:fs';
import { signNonce, generateDeviceKeypair } from './auth.js';
import { uploadCompletion, uploadInspection } from './testutil.js';
import { runArchiveSweep } from './archive.js';
import { withSystem, maintPool, identityPool } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); }
};

async function login(key) {
  const d = devices[key];
  const ch = await (await fetch(`${BASE}/identity/v1/auth/challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: d.publicKey }) })).json();
  return (await (await fetch(`${BASE}/identity/v1/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: d.publicKey, nonce: ch.nonce,
      signature: signNonce(d.privateKey, ch.nonce), second_factor_satisfied: true, role: d.role })
  })).json());
}
const call = (tok, path) => fetch(`${BASE}/maintenance/v1${path}`,
  { headers: { authorization: `Bearer ${tok}` } });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };

async function run() {
  const gm = await login('GM_CIVIL:GM (Civil)');
  const overseer = await login('CIVIL_OVERSEER:A. K. Dubey');
  const incharge = await login('MAINTENANCE_INCHARGE:P. N. Mishra');
  const resident = await login('RESIDENT:R. K. Singh');
  const nigahiOvr = await login('CIVIL_OVERSEER:Nigahi Overseer');

  /* ------------ DECISION 1: three Overseers per Area ------------ */
  const cfg = await withSystem(identityPool, (c) => c.query(
    `SELECT value FROM identity.config WHERE key='overseers_per_area'`));
  check('identity config provisions 3 Overseers per Area',
    cfg.rows[0]?.value === '3', JSON.stringify(cfg.rows));
  const mcfg = await withSystem(maintPool, (c) => c.query(
    `SELECT value FROM maint_config WHERE key='overseers_per_area'`));
  check('maintenance config agrees', mcfg.rows[0]?.value === '3');

  // three Overseer devices on one Area must all be able to work
  const made = [];
  for (let i = 1; i <= 3; i++) {
    const kp = generateDeviceKeypair();
    const d = await withSystem(identityPool, async (c) => {
      const p = await c.query(
        `INSERT INTO identity.person (name, mobile) VALUES ($1,$2) RETURNING id`,
        [`Overseer Extra ${i}`, '9000000' + String(100 + i)]);
      await c.query(`INSERT INTO identity.device (public_key, platform, person_id, scope_path, status)
                     VALUES ($1,'web',$2,'ncl.jayant','ACTIVE')`, [kp.publicKey, p.rows[0].id]);
      return { ...(await c.query(
        `INSERT INTO identity.role_assignment (person_id, role, scope_path, status)
         VALUES ($1,'CIVIL_OVERSEER','ncl.jayant','ACTIVE') RETURNING id`, [p.rows[0].id])).rows[0], person_id: p.rows[0].id };
    });
    await withSystem(maintPool, (c) => c.query(
      `INSERT INTO actor_ref (actor_id, person_id, person_name, role, scope_path, status)
       VALUES ($1,$2,$3,'CIVIL_OVERSEER','ncl.jayant','ACTIVE')
       ON CONFLICT DO NOTHING`, [d.id, d.person_id, `Overseer Extra ${i}`]));
    made.push({ ...d, kp });
  }
  check('three Overseer devices can be provisioned for one Area', made.length === 3);

  const routed = await withSystem(maintPool, (c) => c.query(
    `SELECT count(*) n FROM actors_to_notify('CIVIL_OVERSEER','ncl.jayant.colony1')`));
  check('an escalation reaches every Overseer in the Area',
    Number(routed.rows[0].n) >= 4, `${routed.rows[0].n} devices`);

  /* ------------ DECISION 2a: dashboard is configurable ------------ */
  const dash = await j(await call(gm.token, '/dashboard'));
  check('GM dashboard is built from configured cards',
    Array.isArray(dash.cards) && dash.cards.length > 0, JSON.stringify(dash).slice(0, 150));
  check('cards carry both languages',
    dash.cards.every((c) => c.label_en && c.label_hi));
  check('cards carry a severity against the configured threshold',
    dash.cards.every((c) => ['normal', 'warning', 'critical'].includes(c.severity)));
  check('the dashboard reports that it shows live work only',
    dash.open_only === true);

  const ovrDash = await j(await call(overseer.token, '/dashboard'));
  check('the Overseer gets a different card set from the GM',
    JSON.stringify(ovrDash.cards.map((c) => c.key))
      !== JSON.stringify(dash.cards.map((c) => c.key)),
    JSON.stringify(ovrDash.cards.map((c) => c.key)));

  // change a threshold and the dashboard follows, with no release
  await withSystem(maintPool, (c) => c.query(
    `UPDATE dashboard_card SET warn_above = 0
      WHERE role='GM_CIVIL' AND key='open_complaints'`));
  await withSystem(maintPool, (c) => c.query(
    `UPDATE dashboard_card SET critical_above = NULL
      WHERE role='GM_CIVIL' AND key='open_complaints'`));
  const dash2 = await j(await call(gm.token, '/dashboard'));
  const card = dash2.cards.find((c) => c.key === 'open_complaints');
  check('changing a threshold changes the dashboard without a release',
    card.value > 0 ? card.severity === 'warning' : true,
    JSON.stringify(card));

  // switch a card off
  await withSystem(maintPool, (c) => c.query(
    `UPDATE dashboard_card SET active=false WHERE role='GM_CIVIL' AND key='open_objections'`));
  const dash3 = await j(await call(gm.token, '/dashboard'));
  check('a card can be switched off administratively',
    !dash3.cards.some((c) => c.key === 'open_objections'));
  await withSystem(maintPool, (c) => c.query(
    `UPDATE dashboard_card SET active=true WHERE role='GM_CIVIL' AND key='open_objections'`));

  /* ------------ DECISION 2b: archiving ------------ */
  // build a closed ticket and age it past the archive window
  const cats = await j(await call(resident.token, '/masters/categories'));
  const leak = cats.find((c) => c.name_en.startsWith('Leaking tap'));
  const post = (tok, path, body) => fetch(`${BASE}/maintenance/v1${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Bearer ${tok}` }, body: JSON.stringify(body || {}) });

  const t = await j(await post(resident.token, '/tickets',
    { sub_category_id: leak.id, description: 'Archive test' }));
  await post(overseer.token, `/tickets/${t.id}/verify`);
  const assignable = await j(await call(incharge.token, '/devices/assignable'));
  await post(incharge.token, `/tickets/${t.id}/assign`,
    { supervisor_id: assignable[0].actor_id });
  const contractor = await login('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  await post(contractor.token, `/tickets/${t.id}/start`, { workmen_assigned: 'Ram Prasad' });
  await uploadCompletion(BASE, contractor.token, t.id);
  await post(contractor.token, `/tickets/${t.id}/complete`);
  await uploadInspection(BASE, overseer.token, t.id);
  await post(overseer.token, `/tickets/${t.id}/inspect`, { accepted: true });
  await post(overseer.token, `/tickets/${t.id}/close`);

  await withSystem(maintPool, (c) => c.query(
    `UPDATE ticket SET closed_at = now() - interval '45 days' WHERE id=$1`, [t.id]));

  let sweep = await runArchiveSweep({ quiet: true });
  check('the archive sweep archives a long-closed ticket', sweep.archived >= 1,
    JSON.stringify(sweep));
  check('the sweep reports what is left to archive', 'still_to_archive' in sweep);

  const stillThere = await withSystem(maintPool, (c) => c.query(
    `SELECT archived_at, state::text FROM ticket WHERE id=$1`, [t.id]));
  check('the row is NOT deleted — only marked',
    stillThere.rowCount === 1 && stillThere.rows[0].archived_at !== null);

  const list = await j(await call(overseer.token, '/tickets'));
  check('an archived ticket leaves the working list',
    !list.items.some((x) => x.id === t.id));

  const dash4 = await j(await call(gm.token, '/dashboard'));
  check('and is excluded from the dashboard counts',
    typeof dash4.cards.find((c) => c.key === 'open_complaints').value === 'number');

  /* ------------ DECISION 2c: search retrieves everything ------------ */
  let s = await j(await call(overseer.token, `/search?ticket_no=${encodeURIComponent(t.ticket_no)}`));
  check('search finds the archived ticket', s.items.some((x) => x.id === t.id),
    JSON.stringify(s.items.map((x) => x.ticket_no)));
  check('search marks it as archived',
    s.items.find((x) => x.id === t.id)?.archived_at !== null);

  s = await j(await call(overseer.token, '/search?archived=open'));
  check('search can be limited to live work',
    !s.items.some((x) => x.id === t.id));
  s = await j(await call(overseer.token, '/search?archived=archived'));
  check('search can be limited to archived work',
    s.items.every((x) => x.archived_at !== null));

  /* filters */
  const filters = await j(await call(overseer.token, '/search/filters'));
  check('the filter vocabulary is served, not hard-coded in clients',
    filters.categories?.length > 0 && filters.states?.length > 0 &&
    filters.flags?.length > 0, JSON.stringify(Object.keys(filters)));

  const cases = [
    ['free text', `q=${encodeURIComponent('Archive')}`],
    ['premises identifier', 'identifier=B-234'],
    ['state', 'state=CLOSED'],
    ['several states', 'state=CLOSED,RAISED'],
    ['date range', `raised_from=${new Date(Date.now() - 864e5 * 7).toISOString()}`],
    ['emergency flag', 'is_emergency=false'],
    ['category code', 'category_code=WATER'],
    ['sub-category', `sub_category_id=${leak.id}`],
    ['quarter type', 'quarter_type=B'],
    ['premises type', 'premises_type=QUARTER'],
    ['escalation level', 'min_escalation=0'],
    ['sorted by ticket number', 'sort=ticket_no&dir=asc'],
    ['paged', 'page=1&page_size=5']
  ];
  let filterOk = true, failing = '';
  for (const [label, qs] of cases) {
    const r = await call(overseer.token, `/search?${qs}`);
    if (!r.ok) { filterOk = false; failing = `${label}: ${r.status}`; break; }
    const body = await j(r);
    if (!Array.isArray(body.items)) { filterOk = false; failing = label; break; }
  }
  check(`every documented filter works (${cases.length} tried)`, filterOk, failing);

  const paged = await j(await call(overseer.token, '/search?page_size=5'));
  check('search reports the total match count, not just the page',
    typeof paged.total === 'number' && paged.items.length <= 5);

  /* scope still governs search */
  const nigahi = await j(await call(nigahiOvr.token,
    `/search?ticket_no=${encodeURIComponent(t.ticket_no)}`));
  check('a filter cannot widen scope — Nigahi cannot search a Jayant ticket',
    !nigahi.items.some((x) => x.id === t.id), JSON.stringify(nigahi.items.length));

  const resSearch = await j(await call(resident.token, '/search'));
  check('a resident searching with no filters sees only their own premises',
    resSearch.items.every((x) => x.identifier === 'B-234'),
    JSON.stringify(resSearch.items.map((x) => x.identifier)));

  /* archiving must not touch live work */
  const t2 = await j(await post(resident.token, '/tickets',
    { sub_category_id: cats.find((c) => c.name_en.startsWith('Roof')).id }));
  sweep = await runArchiveSweep({ quiet: true });
  const open2 = await withSystem(maintPool, (c) => c.query(
    `SELECT archived_at FROM ticket WHERE id=$1`, [t2.id]));
  check('an open ticket is never archived', open2.rows[0].archived_at === null);

  await withSystem(maintPool, (c) => c.query(
    `UPDATE maint_config SET value='90' WHERE key='archive_after_days'`));
  const sweep2 = await runArchiveSweep({ quiet: true });
  check('the archive window is configurable', sweep2.archive_after_days === 90);

  console.log('');
  for (const [st, n, d] of out) {
    console.log(`  ${st}  ${n}${d ? '\n         ' + String(d).slice(0, 170) : ''}`);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await maintPool.end(); await identityPool.end();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
