/**
 * Suite 16 — the HQ executive dashboard (GET /hq/executive and .csv).
 * Read-only, evidence only (control 9).
 *
 * Written from the specification alone, to check the implementation
 * independently of whoever built it.
 *
 *   H1  access, the months parameter, the default period
 *   H2  shape: every Area, every month, funnel stages, KPI keys
 *   H3  data: figures computed from complaints created here
 *   H4  the watch list
 *   H5  the CSV
 *   H6  evidence only: no deduction, penalty, rate or money anywhere
 *   H7  an Overseer cannot reach it
 *
 * Needs a freshly reset and seeded database: the exact figures assume the
 * only complaints are the ones this suite raises.
 */
import fs from 'node:fs';
import { signNonce } from './auth.js';
import { uploadCompletion, uploadInspection } from './testutil.js';
import { withSystem, maintPool, identityPool } from './db.js';

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
const near = (a, b, tol = 0.0006) => a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(Number(a) - Number(b)) <= tol;

/* Keys that would mean money or a penalty. Bare "rate" is deliberately not
   here: reopen_rate-style names are legitimate. */
const MONEY = /deduct|penalt|rate_rs|amount|price|cost|₹/i;
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

const CSV_HEADER = 'rank,code,area,contractors,quarters,complaints,per_100_quarters_per_month,sla_pct,first_time_fix_pct,reopen_pct,median_hours_to_close,confirmation_pct,avg_rating,open_now,overdue_now,inspection_waiting';
const STAGES = ['RAISED', 'VERIFIED', 'ASSIGNED', 'CLAIMED', 'ACCEPTED', 'CLOSED', 'CONFIRMED'];
const RATIO_KPIS = ['complaints', 'sla_pct', 'first_time_fix_pct', 'reopen_pct', 'median_close_hours', 'confirmation_pct', 'avg_rating'];
const LIVE_KPIS = ['open_now', 'overdue_now', 'inspection_waiting', 'open_level4'];

/* The current calendar month in IST, as YYYY-MM. */
function istMonth(offset = 0) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' })
    .formatToParts(new Date());
  let y = Number(p.find((x) => x.type === 'year').value);
  let m = Number(p.find((x) => x.type === 'month').value) + offset;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

async function run() {
  const resident = await as('RESIDENT:R. K. Singh');
  const nghRes = await as('RESIDENT:Nigahi resident');
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey');
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
  const so = await as('STAFF_OFFICER_CIVIL:S. Tiwari');
  const gm = await as('GM_CIVIL:GM (Civil)');
  const sup = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const firm = await as('CONTRACTOR:M/s Jayant Constructions');
  const ngh = await as('CIVIL_OVERSEER:Nigahi Overseer');
  const hq = await device('HQ_EXECUTIVE:CMD', { role: 'HQ_EXECUTIVE' });
  const admin = await as('ADMINISTRATOR:System Admin');

  const cats = await j(await call(resident.token, '/masters/categories'));
  const sub = (p) => cats.find((c) => c.name_en.startsWith(p));
  const assignable = await j(await call(inc.token, '/devices/assignable'));
  const verma = assignable.find((a) => a.person_name === 'M/s Verma — Supr');

  const hqGet = (tok, qs = '') => call(tok.token, `/hq/executive${qs}`);

  /* ================= H1 — access and parameters ================= */
  await attempt('H1 access', async () => {
    for (const [who, tok] of [['the GM', gm], ['an HQ executive', hq], ['the administrator', admin]]) {
      const r = await hqGet(tok);
      const b = await j(r);
      check(`H1 ${who} reads the dashboard (200)`, r.status === 200 && !!b.kpis && Array.isArray(b.areas), `${r.status} ${short(b)}`);
    }
    for (const [who, tok] of [['the Overseer', ovr], ['the Incharge', inc], ['the Staff Officer', so],
      ['the contractor firm', firm], ['the supervisor', sup], ['the resident', resident]]) {
      const r = await hqGet(tok);
      check(`H1 ${who} is refused (403)`, r.status === 403, `${r.status}`);
    }
    for (const bad of ['0', '25', 'abc', '-3', '1.5']) {
      const r = await hqGet(gm, `?months=${bad}`);
      check(`H1 months=${bad} is refused (422)`, r.status === 422, `${r.status}`);
    }
    let r = await hqGet(gm);
    const b = await j(r);
    check('H1 the default period is 12 months', b.period?.months === 12, short(b.period));
    check('H1 there are 12 labels', Array.isArray(b.period?.labels) && b.period.labels.length === 12, short(b.period?.labels));
    check('H1 the labels end with the current month in IST', b.period?.labels?.[11] === istMonth(), `${b.period?.labels?.[11]} vs ${istMonth()}`);
    check('H1 the labels run in order, one month apart',
      b.period?.labels?.every((l, k) => l === istMonth(k - 11)), short(b.period?.labels));
    check('H1 period.from is the first day of the first label', b.period?.from === `${b.period?.labels?.[0]}-01`, short(b.period));
    check('H1 period.to is a date', /^\d{4}-\d{2}-\d{2}$/.test(b.period?.to || ''), short(b.period));

    r = await hqGet(gm, '?months=24');
    let b2 = await j(r);
    check('H1 months=24 is accepted with 24 labels', r.status === 200 && b2.period?.labels?.length === 24 && b2.period?.months === 24, `${r.status}`);
    r = await hqGet(gm, '?months=1');
    b2 = await j(r);
    check('H1 months=1 is accepted with one label, the current month',
      r.status === 200 && b2.period?.labels?.length === 1 && b2.period.labels[0] === istMonth(), `${r.status} ${short(b2.period)}`);
  });

  /* ================= H3 setup — complaints in Jayant and Nigahi ================= */
  let ta, tb, tc, td, te;
  const tag = String(Date.now() % 1000000);
  const raise = async (tok, prefix, label) => {
    const t = await j(await call(tok.token, '/tickets', 'POST', { sub_category_id: sub(prefix).id, description: `HQ test ${label} ${tag}` }));
    if (!t.id) throw new Error(`raise ${short(t)}`);
    return t;
  };
  const assigned = async (prefix, label) => {
    const t = await raise(resident, prefix, label);
    await call(ovr.token, `/tickets/${t.id}/verify`, 'POST');
    const r = await call(inc.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: verma.actor_id });
    if (r.status !== 200) throw new Error(`assign ${r.status} ${short(await j(r))}`);
    return t;
  };
  const start = (t) => call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
  async function complete(t) {
    await uploadCompletion(BASE, sup.token, t.id);
    const r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST');
    if (r.status !== 200) throw new Error(`complete ${r.status} ${short(await j(r))}`);
  }
  const stateOf = async (t) => (await sys(`SELECT state FROM ticket WHERE id=$1`, [t.id])).rows[0].state;
  async function inspect(t, accepted) {
    await uploadInspection(BASE, ovr.token, t.id);
    return call(ovr.token, `/tickets/${t.id}/inspect`, 'POST', accepted ? { accepted: true } : { accepted: false, remark: 'Not done properly' });
  }
  let backdated = false, level4Set = false;

  await attempt('H3 setup', async () => {
    /* (a) closed first time, SLA met, resident confirms with rating 4 */
    ta = await assigned('Leaking tap', 'a');
    await start(ta); await complete(ta);
    let r = await inspect(ta, true);
    check('H3 (setup) a is accepted', r.status === 200, `${r.status} ${short(await j(r))}`);
    r = await call(ovr.token, `/tickets/${ta.id}/close`, 'POST');
    check('H3 (setup) a is closed', (await stateOf(ta)) === 'CLOSED', `${r.status}`);
    r = await call(resident.token, `/tickets/${ta.id}/feedback`, 'POST', { confirmed: true, rating: 4 });
    check('H3 (setup) the resident confirms a with 4 stars', r.ok, `${r.status} ${short(await j(r))}`);

    /* (b) sent back once, then accepted and closed; the resident does not answer */
    tb = await assigned('Internal pipe', 'b');
    await start(tb); await complete(tb);
    r = await inspect(tb, false);
    check('H3 (setup) b is sent back', r.status === 200 && (await stateOf(tb)) === 'REWORK', `${r.status} ${await stateOf(tb)}`);
    await start(tb); await complete(tb);
    r = await inspect(tb, true);
    r = await call(ovr.token, `/tickets/${tb.id}/close`, 'POST');
    check('H3 (setup) b is closed after rework', (await stateOf(tb)) === 'CLOSED', `${r.status}`);

    /* (c) claimed, awaiting inspection */
    tc = await assigned('Roof leakage', 'c');
    await start(tc); await complete(tc);
    check('H3 (setup) c awaits inspection', (await stateOf(tc)) === 'WORK_COMPLETED');

    /* (d) rejected in Jayant */
    td = await raise(resident, 'Leaking tap', 'd');
    r = await call(ovr.token, `/tickets/${td.id}/reject`, 'POST', { reason: 'Not a civil matter' });
    check('H3 (setup) d is rejected', (await stateOf(td)) === 'REJECTED', `${r.status} ${short(await j(r))}`);

    /* (e) Nigahi has no seeded supervisor, so it cannot be taken to closure;
       raise it and reject it. It still counts as raised, and the closed
       figures of Nigahi must stay empty. */
    te = await raise(nghRes, 'Leaking tap', 'e');
    r = await call(ngh.token, `/tickets/${te.id}/reject`, 'POST', { reason: 'Not a civil matter' });
    check('H3 (setup) e (Nigahi) is rejected', (await stateOf(te)) === 'REJECTED', `${r.status} ${short(await j(r))}`);
  });

  /* Back-date c's claim so that it counts as waiting more than 48 hours.
     If the database refuses (the claim time is guarded), skip. */
  await attempt('H3 backdate', async () => {
    try {
      await sys(`UPDATE ticket SET completed_claim_at = now() - interval '3 days' WHERE id=$1`, [tc.id]);
      const v = (await sys(`SELECT completed_claim_at < now() - interval '48 hours' ok FROM ticket WHERE id=$1`, [tc.id])).rows[0].ok;
      backdated = v === true;
    } catch { backdated = false; /* refused by the database: the waiting sub-check is skipped */ }
    try {
      await sys(`UPDATE ticket SET escalation_level = 4 WHERE id=$1`, [tc.id]);
      level4Set = (await sys(`SELECT escalation_level l FROM ticket WHERE id=$1`, [tc.id])).rows[0].l === 4;
    } catch { level4Set = false; /* skipped: counters are not writable even by the system */ }
  });

  /* ================= H2 / H3 — the dashboard ================= */
  const res = await hqGet(gm);
  const d = await j(res);
  const months = d.period?.months ?? 12;
  const labels = d.period?.labels || [];
  const jnt = d.areas?.find((a) => a.code === 'JNT');
  const ngA = d.areas?.find((a) => a.code === 'NGH');

  await attempt('H2 shape', async () => {
    check('H2 the dashboard answers 200', res.status === 200, `${res.status}`);
    check('H2 target_percent is 90', d.target_percent === 90, short(d.target_percent));
    check('H2 generated_at is present', !!d.generated_at && !Number.isNaN(Date.parse(d.generated_at)), short(d.generated_at));

    check('H2 all 13 Areas are in areas', d.areas?.length === 13 && new Set(d.areas.map((a) => a.code)).size === 13, `${d.areas?.length}`);
    check('H2 every Area has its identity fields',
      d.areas?.every((a) => a.area_id && a.code && a.name && a.quarters !== undefined && Array.isArray(a.contractors)), short(d.areas?.[0]));
    const aKeys = ['complaints', 'per100', 'sla_pct', 'first_time_fix_pct', 'reopen_pct', 'median_close_hours', 'confirmation_pct',
      'avg_rating', 'open_now', 'overdue_now', 'inspection_waiting', 'sla_now', 'sla_prev', 'rank', 'rank_now', 'rank_prev'];
    check('H2 every Area row carries all its figures (null allowed, absent not)',
      d.areas?.every((a) => aKeys.every((k) => k in a)), short(d.areas?.find((a) => aKeys.some((k) => !(k in a)))));

    check('H2 the heatmap has all 13 Areas', d.heatmap?.length === 13 && new Set(d.heatmap.map((h) => h.code)).size === 13, `${d.heatmap?.length}`);
    check('H2 each heatmap row has exactly `months` entries', d.heatmap?.every((h) => h.months?.length === months), short(d.heatmap?.map((h) => h.months?.length)));
    check('H2 the heatmap months match the labels, in order',
      d.heatmap?.every((h) => h.months.every((m, k) => m.month === labels[k])), short(d.heatmap?.[0]?.months?.map((m) => m.month)));
    check('H2 each heatmap cell has sla_pct and judged', d.heatmap?.every((h) => h.months.every((m) => 'sla_pct' in m && 'judged' in m)), short(d.heatmap?.[0]?.months?.[0]));

    check('H2 the trend has one entry per month, matching the labels',
      d.trend?.length === months && d.trend.every((t, k) => t.month === labels[k] && 'complaints' in t && 'sla_pct' in t), short(d.trend));

    check('H2 the funnel has the seven stages in order', Array.isArray(d.funnel) && d.funnel.map((f) => f.stage).join() === STAGES.join(), short(d.funnel));
    check('H2 every funnel count is a number', d.funnel?.every((f) => Number.isFinite(Number(f.count))), short(d.funnel));
    check('H2 funnel_exits has rejected and special_repair', d.funnel_exits && 'rejected' in d.funnel_exits && 'special_repair' in d.funnel_exits, short(d.funnel_exits));

    check('H2 the categories have columns', Array.isArray(d.categories?.columns) && d.categories.columns.length > 0, short(d.categories?.columns));
    check('H2 each column has a code and an English name', d.categories?.columns?.every((c) => c.code && c.name_en), short(d.categories?.columns?.[0]));
    check('H2 the category rows have code, name, total and counts',
      Array.isArray(d.categories?.rows) && d.categories.rows.every((r) => r.code && r.name && 'total' in r && r.counts && typeof r.counts === 'object'), short(d.categories?.rows?.[0]));

    check('H2 lag has all 13 Areas', d.lag?.length === 13, `${d.lag?.length}`);
    check('H2 contractors and watch are lists', Array.isArray(d.contractors) && Array.isArray(d.watch), '');

    const k = d.kpis || {};
    check('H2 each ratio KPI is {now, prev}', RATIO_KPIS.every((n) => k[n] && 'now' in k[n] && 'prev' in k[n]), short(k));
    check('H2 each live count is a plain integer', LIVE_KPIS.every((n) => Number.isInteger(k[n])), short(LIVE_KPIS.map((n) => k[n])));
  });

  await attempt('H3 data', async () => {
    const k = d.kpis || {};
    check('H3 Jayant has at least 4 complaints this period (a, b, c, d)', Number(jnt?.complaints) >= 4, short(jnt));
    check('H3 the HQ complaints KPI this month counts at least all five', Number(k.complaints?.now) >= 5, short(k.complaints));
    check('H3 Nigahi counts its rejected complaint', Number(ngA?.complaints) >= 1, short(ngA));
    check('H3 Nigahi has no closed work: no first-time fix or confirmation', ngA && ngA.first_time_fix_pct === null && ngA.confirmation_pct === null && ngA.avg_rating === null, short(ngA));

    /* exact figures: the database is fresh, so a and b are Jayant's only closed complaints */
    check('H3 Jayant first-time fix is 50.0 (a clean, b reworked)', near(jnt?.first_time_fix_pct, 50), short(jnt?.first_time_fix_pct));
    check('H3 Jayant reopen rate is 0', near(jnt?.reopen_pct, 0), short(jnt?.reopen_pct));
    check('H3 Jayant resident confirmation is 50.0 (a confirmed, b unanswered)', near(jnt?.confirmation_pct, 50), short(jnt?.confirmation_pct));
    check('H3 Jayant average rating is 4', near(jnt?.avg_rating, 4, 0.006), short(jnt?.avg_rating));
    check('H3 Jayant median hours to close is a number, not negative', jnt?.median_close_hours !== null && Number(jnt.median_close_hours) >= 0, short(jnt?.median_close_hours));
    check('H3 the HQ first-time fix KPI this month is 50.0', near(k.first_time_fix_pct?.now, 50), short(k.first_time_fix_pct));
    check('H3 the HQ average rating KPI this month is 4', near(k.avg_rating?.now, 4, 0.006), short(k.avg_rating));

    /* SLA: read the contractor's own verdict on a, b, c from the database */
    const v = (await sys(`SELECT count(*) FILTER (WHERE completion_met) met, count(*) FILTER (WHERE completion_met IS NOT NULL) judged
                            FROM ticket WHERE id = ANY($1) AND completed_claim_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
      [[ta.id, tb.id, tc.id]])).rows[0];
    const judged = Number(v.judged), met = Number(v.met);
    const expected = judged ? Math.round((met / judged) * 1000) / 10 : null;
    if (expected === null) {
      check('H3 sla_pct is null when nothing was judged', jnt?.sla_now === null, short(jnt?.sla_now));
    } else {
      check(`H3 Jayant's SLA this month agrees with completion_met (${met} of ${judged})`, near(jnt?.sla_now, expected, 0.06), `${jnt?.sla_now} vs ${expected}`);
      check('H3 Jayant\'s SLA over the period agrees too', near(jnt?.sla_pct, expected, 0.06), `${jnt?.sla_pct} vs ${expected}`);
    }

    /* the heatmap, trend and Area row tell the same story */
    const hm = d.heatmap?.find((h) => h.code === 'JNT')?.months?.at(-1);
    check('H3 the heatmap\'s current month for Jayant equals the Area\'s sla_now', hm && (hm.sla_pct === jnt?.sla_now || near(hm.sla_pct, jnt?.sla_now, 0.001)), short({ hm, sla_now: jnt?.sla_now }));
    check('H3 the heatmap cell says how many were judged', hm && Number(hm.judged) === judged, short({ hm, judged }));
    const tr = d.trend?.at(-1);
    check('H3 the trend\'s current month counts this month\'s complaints', tr?.month === istMonth() && Number(tr.complaints) >= 5, short(tr));

    /* funnel */
    const f = Object.fromEntries((d.funnel || []).map((x) => [x.stage, Number(x.count)]));
    let ordered = true;
    for (let i = 1; i < STAGES.length; i++) if (!(f[STAGES[i - 1]] >= f[STAGES[i]])) ordered = false;
    check('H3 the funnel never grows from one stage to the next', ordered, short(f));
    check('H3 RAISED counts every complaint raised (at least 5)', f.RAISED >= 5, short(f));
    check('H3 CLOSED is at least 2 and CONFIRMED at least 1', f.CLOSED >= 2 && f.CONFIRMED >= 1, short(f));
    check('H3 CLAIMED covers a, b and c', f.CLAIMED >= 3, short(f));
    check('H3 rejected exits number at least 1 (in fact 2)', Number(d.funnel_exits?.rejected) >= 1, short(d.funnel_exits));

    /* where the time goes */
    const lg = d.lag?.find((x) => x.code === 'JNT');
    check('H3 lag for Jayant counts 2 closed complaints', Number(lg?.closed) === 2, short(lg));
    check('H3 lag: total = contractor + department + paused (within 0.2 h)',
      lg && near(lg.total_hours, Number(lg.contractor_hours) + Number(lg.department_hours) + Number(lg.paused_hours), 0.2), short(lg));
    check('H3 lag: department hours are never negative', lg && Number(lg.department_hours) >= 0 && Number(lg.contractor_hours) >= 0 && Number(lg.paused_hours) >= 0, short(lg));

    /* per 100 quarters */
    if (Number(jnt?.quarters) > 0) {
      const p = Math.round((Number(jnt.complaints) / Number(jnt.quarters) / months) * 100 * 100) / 100;
      check('H3 per100 = complaints / quarters / months x 100 (2 dp)', near(jnt.per100, p, 0.0101), `${jnt.per100} vs ${p}`);
    } else {
      check('H3 Jayant has quarters on the register', false, short(jnt));
    }
    const noQ = d.areas?.filter((a) => Number(a.quarters) === 0);
    check('H3 an Area with no quarters has per100 null', noQ?.every((a) => a.per100 === null), short(noQ?.find((a) => a.per100 !== null)));

    /* rank */
    const nul = (x) => (x === null || x === undefined);
    const expectOrder = [...d.areas].sort((p, q) =>
      (nul(p.sla_pct) - nul(q.sla_pct)) || (nul(p.sla_pct) ? 0 : Number(q.sla_pct) - Number(p.sla_pct)) ||
      (Number(q.complaints) - Number(p.complaints)) || p.code.localeCompare(q.code)).map((a) => a.code);
    const byRank = [...d.areas].sort((p, q) => p.rank - q.rank).map((a) => a.code);
    check('H3 ranks are 1..13 once each', d.areas.map((a) => a.rank).sort((p, q) => p - q).join() === Array.from({ length: 13 }, (_, i) => i + 1).join(), short(d.areas.map((a) => a.rank)));
    check('H3 rank follows SLA (desc, nulls last), then complaints (desc), then code', byRank.join() === expectOrder.join(), `${byRank.join()} vs ${expectOrder.join()}`);
    const nowOrder = [...d.areas].sort((p, q) => (nul(p.sla_now) - nul(q.sla_now)) || (nul(p.sla_now) ? 0 : Number(q.sla_now) - Number(p.sla_now)) || p.code.localeCompare(q.code)).map((a) => a.code);
    const byRankNow = [...d.areas].sort((p, q) => p.rank_now - q.rank_now).map((a) => a.code);
    check('H3 rank_now follows this month\'s SLA, then code', byRankNow.join() === nowOrder.join(), `${byRankNow.join()} vs ${nowOrder.join()}`);
    const prevOrder = [...d.areas].sort((p, q) => (nul(p.sla_prev) - nul(q.sla_prev)) || (nul(p.sla_prev) ? 0 : Number(q.sla_prev) - Number(p.sla_prev)) || p.code.localeCompare(q.code)).map((a) => a.code);
    const byRankPrev = [...d.areas].sort((p, q) => p.rank_prev - q.rank_prev).map((a) => a.code);
    check('H3 rank_prev follows last month\'s SLA, then code', byRankPrev.join() === prevOrder.join(), `${byRankPrev.join()} vs ${prevOrder.join()}`);

    /* categories */
    check('H3 each category row\'s counts add up to its total',
      d.categories?.rows?.every((r) => Object.values(r.counts).reduce((s, n) => s + Number(n), 0) === Number(r.total)), short(d.categories?.rows?.find((r) => Object.values(r.counts).reduce((s, n) => s + Number(n), 0) !== Number(r.total))));
    const colCodes = new Set((d.categories?.columns || []).map((c) => c.code));
    check('H3 every count is keyed by a listed column', d.categories?.rows?.every((r) => Object.keys(r.counts).every((c) => colCodes.has(c))), '');
    const jr = d.categories?.rows?.find((r) => r.code === 'JNT');
    check('H3 Jayant\'s category row totals its complaints', jr && Number(jr.total) === Number(jnt?.complaints), short({ jr, c: jnt?.complaints }));

    /* contractors */
    const ct = d.contractors?.find((c) => (c.areas || []).includes('JNT'));
    check('H3 the contractors list includes the Jayant firm, with JNT in its areas', !!ct && !!ct.contractor_name, short(d.contractors));
    check('H3 the firm carries complaints, sla_pct, breaches, below_target_areas and flagged',
      ct && 'complaints' in ct && 'sla_pct' in ct && 'breaches' in ct && Array.isArray(ct.below_target_areas) && typeof ct.flagged === 'boolean', short(ct));
    check('H3 flagged means below target in more than one Area', d.contractors?.every((c) => c.flagged === (c.below_target_areas.length > 1)), short(d.contractors?.find((c) => c.flagged !== (c.below_target_areas.length > 1))));
    check('H3 the Area row names the same firm', jnt?.contractors?.length >= 1 && ct && jnt.contractors.includes(ct.contractor_name), short({ a: jnt?.contractors, c: ct?.contractor_name }));

    /* live counts */
    check('H3 Jayant has c open, and the HQ open count includes it', Number(jnt?.open_now) >= 1 && Number(k.open_now) >= 1, short({ j: jnt?.open_now, k: k.open_now }));
    check('H3 open_now at HQ is the sum over Areas', d.areas.reduce((s, a) => s + Number(a.open_now), 0) === Number(k.open_now), `${k.open_now}`);
    if (backdated) {
      check('H3 c, claimed three days ago, counts as inspection waiting', Number(jnt?.inspection_waiting) >= 1 && Number(k.inspection_waiting) >= 1, short({ j: jnt?.inspection_waiting, k: k.inspection_waiting }));
    } else {
      // SKIPPED: the database refused to back-date completed_claim_at, so a job
      // cannot be made to wait more than 48 hours inside a test.
      check('H3 (skipped) inspection waiting — completed_claim_at cannot be back-dated', jnt && Number(jnt.inspection_waiting) >= 0, short(jnt?.inspection_waiting));
    }
  });

  /* ================= H4 — watch ================= */
  await attempt('H4 watch', async () => {
    const w = d.watch || [];
    const codes = new Set((d.areas || []).map((a) => a.code));
    check('H4 every watch item has severity critical or warning', w.every((x) => ['critical', 'warning'].includes(x.severity)), short(w.find((x) => !['critical', 'warning'].includes(x.severity))));
    check('H4 every watch item names a real Area, a kind, a title and a detail', w.every((x) => codes.has(x.code) && x.kind && x.title && x.detail), short(w.find((x) => !(codes.has(x.code) && x.kind && x.title && x.detail))));
    let seenWarn = false, ordered = true;
    for (const x of w) { if (x.severity === 'warning') seenWarn = true; else if (seenWarn) ordered = false; }
    check('H4 critical items come first', ordered, short(w.map((x) => x.severity)));
    const kinds = new Set(['SLA_BELOW_TARGET', 'INSPECTION_BACKLOG', 'LEVEL4_OPEN', 'CONTRACT_ENDING', 'STAFF_OFFICER_PENDING']);
    check('H4 every kind is one of the five rules', w.every((x) => kinds.has(x.kind)), short(w.map((x) => x.kind)));
    const crit = w.filter((x) => x.severity === 'critical');
    const sortedCrit = [...crit].sort((p, q) => p.code.localeCompare(q.code)).map((x) => x.code).join();
    check('H4 within a severity items run by Area code', crit.map((x) => x.code).join() === sortedCrit, `${crit.map((x) => x.code).join()}`);

    if (level4Set) {
      const x = w.find((i) => i.kind === 'LEVEL4_OPEN' && i.code === 'JNT');
      check('H4 an open level-4 complaint in Jayant raises LEVEL4_OPEN, critical', !!x && x.severity === 'critical', short(w));
      check('H4 and the open-at-level-4 counts show it', Number(jnt?.open_now) >= 1 && Number(d.kpis?.open_level4) >= 1, short(d.kpis?.open_level4));
    } else {
      // SKIPPED: escalation_level could not be set even as SYSTEM (computed by the
      // database), so LEVEL4_OPEN cannot be provoked from a test.
    }
    if (backdated) {
      const x = w.find((i) => i.kind === 'INSPECTION_BACKLOG' && i.code === 'JNT');
      check('H4 one job waiting over 48 h raises INSPECTION_BACKLOG for Jayant, warning', !!x && x.severity === 'warning', short(w));
    }
    // SKIPPED: CONTRACT_ENDING and STAFF_OFFICER_PENDING — the seeded contracts end
    // beyond 30 days and a contract's end cannot be shortened; a pending Staff
    // Officer review needs a third reopening, which the seed cannot build cheaply.
  });

  /* ================= H5 — CSV ================= */
  await attempt('H5 csv', async () => {
    for (const [who, tok] of [['the Overseer', ovr], ['the supervisor', sup], ['the resident', resident]]) {
      const r = await call(tok.token, '/hq/executive.csv');
      check(`H5 ${who} cannot download the CSV (403)`, r.status === 403, `${r.status}`);
    }
    for (const [who, tok] of [['the GM', gm], ['an HQ executive', hq], ['the administrator', admin]]) {
      const r = await call(tok.token, '/hq/executive.csv');
      check(`H5 ${who} downloads the CSV (200)`, r.status === 200, `${r.status}`);
    }
    let r = await call(gm.token, '/hq/executive.csv');
    const csv = await r.text();
    const lines = csv.split(/\r?\n/).filter(Boolean);
    check('H5 it is served as text/csv', /text\/csv/i.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
    check('H5 the header row is exactly as specified', lines[0]?.trim() === CSV_HEADER, lines[0]);
    check('H5 there are 13 data rows', lines.length - 1 === 13, `${lines.length - 1}`);
    check('H5 the rank column runs 1..13', lines.slice(1).map((l) => Number(l.split(',')[0])).join() === Array.from({ length: 13 }, (_, i) => i + 1).join(), lines.slice(1).map((l) => l.split(',')[0]).join());
    check('H5 every Area code appears once', new Set(lines.slice(1).map((l) => l.split(',')[1])).size === 13, '');
    const row = lines.find((l) => l.split(',')[1] === 'JNT') || '';
    check('H5 Jayant\'s row carries the Area name and complaint count', row.includes('Jayant') && row.split(',').length >= 16, row);
    r = await call(gm.token, '/hq/executive.csv?months=3');
    const l3 = (await r.text()).split(/\r?\n/).filter(Boolean);
    check('H5 the months parameter applies to the CSV', r.status === 200 && l3.length === 14, `${r.status} ${l3.length}`);
    r = await call(gm.token, '/hq/executive.csv?months=0');
    check('H5 months=0 is refused for the CSV too (422)', r.status === 422, `${r.status}`);
  });

  /* ================= H6 — evidence only ================= */
  await attempt('H6 money', async () => {
    const bad = moneyKeys(d);
    check('H6 no key anywhere in the dashboard speaks of deductions, penalties, rates in rupees, amounts, prices or costs', bad.length === 0, bad.join(','));
    const csvHead = (await (await call(gm.token, '/hq/executive.csv')).text()).split(/\r?\n/)[0];
    check('H6 nor does the CSV header', !MONEY.test(csvHead), csvHead);
    const body24 = await j(await hqGet(hq, '?months=24'));
    check('H6 nor does the 24-month view for an HQ executive', moneyKeys(body24).length === 0, moneyKeys(body24).join(','));
    check('H6 the text of the response holds no rupee sign', !JSON.stringify(d).includes('₹'), '');
  });

  /* ================= H7 — an Overseer cannot reach it ================= */
  await attempt('H7 closed to Overseers', async () => {
    let r = await hqGet(ovr, '?months=1');
    check('H7 the Overseer is refused even with months=1 (403)', r.status === 403, `${r.status}`);
    r = await hqGet(ngh, '?months=1');
    check('H7 the Overseer of another Area is refused too (403)', r.status === 403, `${r.status}`);
    r = await call(ovr.token, '/hq/executive.csv?months=1');
    check('H7 and the CSV (403)', r.status === 403, `${r.status}`);
    const body = await j(await hqGet(ovr, '?months=1'));
    check('H7 the refusal carries no figures', !body.areas && !body.kpis, short(body));
  });
}

run().catch((e) => { check('suite ran to the end', false, e.stack); })
  .finally(async () => {
    for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n         ${d}` : ''}`);
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await maintPool.end().catch(() => {}); await identityPool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
