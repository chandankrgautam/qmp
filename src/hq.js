import express from 'express';
import { maintPool, identityPool, withScope, withSystem, mapDbError, Forbidden, Unprocessable } from './db.js';
import { requireAuth } from './auth.js';

/**
 * HQ executive dashboard (phase 6) — GM Civil, Directors, CMD.
 *
 * Read-only figures for all thirteen Areas, computed from the record and
 * nothing else. Evidence only: no deduction, penalty or amount is
 * calculated (control 9). Every query runs under the caller's own row
 * security, so the figures are exactly what that role may see. Months are
 * calendar months in IST. The definitions are in README §5.5 and on the
 * screen; they are stated because a contractor will otherwise read a rate
 * whichever way suits them.
 */
export const hq = express.Router();
hq.use(requireAuth);

const READERS = ['GM_CIVIL', 'HQ_EXECUTIVE', 'ADMINISTRATOR'];
const scoped = (req, fn) => withScope(maintPool, req.claims, fn);
const n = (v) => (v === null || v === undefined ? null : Number(v));
const pct = (a, b) => (Number(b) > 0 ? Math.round((1000 * Number(a)) / Number(b)) / 10 : null);
const r1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const r2 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
const TZ = `'Asia/Kolkata'`;

function months(req) {
  const raw = req.query.months;
  if (raw === undefined || raw === '') return 12;
  const m = Number(raw);
  if (!Number.isInteger(m) || m < 1 || m > 24) throw new Unprocessable('months is a whole number from 1 to 24');
  return m;
}

/* The figures of one window, per Area. A complaint "closed in the window"
   is one closed then and still closed (a reopened one is not closed). */
const WINDOW = `
  SELECT t.area_id,
         count(*) FILTER (WHERE t.raised_at >= $1 AND t.raised_at < $2) AS complaints,
         count(*) FILTER (WHERE t.completed_claim_at >= $1 AND t.completed_claim_at < $2 AND t.completion_met) AS met,
         count(*) FILTER (WHERE t.completed_claim_at >= $1 AND t.completed_claim_at < $2 AND t.completion_met IS NOT NULL) AS judged,
         count(*) FILTER (WHERE c.closed) AS closed,
         count(*) FILTER (WHERE c.closed AND t.rework_count = 0 AND t.reopened_count = 0) AS first_time,
         count(*) FILTER (WHERE c.closed AND t.reopened_count > 0) AS reopened,
         count(*) FILTER (WHERE c.closed AND pr.occupancy_model IS DISTINCT FROM 'DEPARTMENT_ONLY') AS occupied,
         count(*) FILTER (WHERE c.closed AND pr.occupancy_model IS DISTINCT FROM 'DEPARTMENT_ONLY' AND fb.confirmed) AS confirmed,
         avg(fb.rating) FILTER (WHERE c.closed) AS avg_rating,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY c.total_h) FILTER (WHERE c.closed) AS median_close_hours,
         avg(c.total_h) FILTER (WHERE c.closed) AS total_h,
         avg(t.contractor_minutes / 60.0) FILTER (WHERE c.closed) AS contractor_h,
         avg(t.total_paused_minutes / 60.0) FILTER (WHERE c.closed) AS paused_h
    FROM ticket t
    LEFT JOIN ticket_feedback fb ON fb.ticket_id = t.id
    LEFT JOIN premises_ref pr ON pr.premises_id = t.premises_id
    CROSS JOIN LATERAL (SELECT t.state = 'CLOSED' AND t.closed_at >= $1 AND t.closed_at < $2 AS closed,
                               extract(epoch FROM t.closed_at - t.raised_at) / 3600.0 AS total_h) c
   GROUP BY t.area_id`;

function figures(r) {
  if (!r) r = {};
  const total = n(r.total_h), contractor = n(r.contractor_h) ?? 0, paused = n(r.paused_h) ?? 0;
  return {
    complaints: Number(r.complaints || 0),
    sla_pct: pct(r.met, r.judged), judged: Number(r.judged || 0),
    first_time_fix_pct: pct(r.first_time, r.closed), reopen_pct: pct(r.reopened, r.closed),
    median_close_hours: r1(r.median_close_hours), confirmation_pct: pct(r.confirmed, r.occupied),
    avg_rating: r2(r.avg_rating), closed: Number(r.closed || 0),
    lag: total === null ? null : {
      contractor_hours: r1(contractor), paused_hours: r1(paused),
      department_hours: r1(Math.max(0, total - contractor - paused)), total_hours: r1(total)
    }
  };
}
/* Sum several Areas' rows into one, for the all-Areas KPIs. */
function sumRows(rows) {
  const s = {};
  const keys = ['complaints', 'met', 'judged', 'closed', 'first_time', 'reopened', 'occupied', 'confirmed'];
  for (const k of keys) s[k] = rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  // averages weighted by closed complaints; the median cannot be summed, so
  // the all-Areas median is asked of the database separately
  const w = rows.reduce((a, r) => a + (r.avg_rating === null ? 0 : Number(r.closed || 0)), 0);
  s.avg_rating = w ? rows.reduce((a, r) => a + (r.avg_rating === null ? 0 : Number(r.avg_rating) * Number(r.closed || 0)), 0) / w : null;
  return s;
}

async function build(req) {
  if (!READERS.includes(req.claims.role)) throw new Forbidden('The HQ dashboard is for the GM (Civil), the Directors, the CMD and the HQ System Administrator');
  const m = months(req);
  const areaRows = (await withSystem(identityPool, (c) => c.query(
    `SELECT id, ticket_code AS code, name FROM identity.area ORDER BY ticket_code`))).rows;

  return scoped(req, async (c) => {
    const b = (await c.query(
      `SELECT (date_trunc('month', now() AT TIME ZONE ${TZ}) - make_interval(months => $1 - 1)) AT TIME ZONE ${TZ} AS start_at,
              date_trunc('month', now() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ} AS this_at,
              (date_trunc('month', now() AT TIME ZONE ${TZ}) - interval '1 month') AT TIME ZONE ${TZ} AS prev_at,
              'infinity'::timestamptz AS end_at,
              to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS today,
              array(SELECT to_char(g, 'YYYY-MM') FROM generate_series(
                      date_trunc('month', now() AT TIME ZONE ${TZ}) - make_interval(months => $1 - 1),
                      date_trunc('month', now() AT TIME ZONE ${TZ}), interval '1 month') g) AS labels`, [m])).rows[0];
    const cfg = async (key, dflt) => Number((await c.query(`SELECT value FROM maint_config WHERE key = $1`, [key])).rows[0]?.value ?? dflt);
    const target = await cfg('hq_sla_target_percent', 90);
    const backlogHours = await cfg('inspection_backlog_warn_hours', 48);

    const win = async (lo, hi) => (await c.query(WINDOW, [lo, hi])).rows;
    const [period, thisM, prevM] = [await win(b.start_at, b.end_at), await win(b.this_at, b.end_at), await win(b.prev_at, b.this_at)];
    const byArea = (rows) => new Map(rows.map((r) => [r.area_id, r]));
    const P = byArea(period), T = byArea(thisM), V = byArea(prevM);
    const median = async (lo, hi) => r1((await c.query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - raised_at) / 3600.0) AS m
         FROM ticket WHERE state = 'CLOSED' AND closed_at >= $1 AND closed_at < $2`, [lo, hi])).rows[0].m);

    const live = byArea((await c.query(
      `SELECT area_id,
              count(*) FILTER (WHERE state NOT IN ('CLOSED','REJECTED')) AS open_now,
              count(*) FILTER (WHERE state NOT IN ('CLOSED','REJECTED') AND completion_deadline_at < now()) AS overdue_now,
              count(*) FILTER (WHERE state = 'WORK_COMPLETED' AND completed_claim_at < now() - make_interval(hours => $1)) AS inspection_waiting,
              count(*) FILTER (WHERE state NOT IN ('CLOSED','REJECTED') AND escalation_level >= 4) AS open_level4
         FROM ticket GROUP BY area_id`, [backlogHours])).rows);
    const quarters = new Map((await c.query(
      `SELECT area_id, count(*)::int AS q FROM premises_ref WHERE premises_type = 'QUARTER' GROUP BY area_id`)).rows.map((r) => [r.area_id, r.q]));
    const contracts = (await c.query(
      `SELECT id, area_id, contractor_name, expires_on, (expires_on - current_date) AS days_left
         FROM contract WHERE active ORDER BY contractor_name`)).rows;

    /* ---------------- KPIs */
    const allNow = figures(sumRows(thisM)), allPrev = figures(sumRows(prevM));
    const liveSum = (k) => [...live.values()].reduce((a, r) => a + Number(r[k] || 0), 0);
    const pair = (k) => ({ now: allNow[k], prev: allPrev[k] });
    const kpis = {
      complaints: pair('complaints'), sla_pct: pair('sla_pct'), first_time_fix_pct: pair('first_time_fix_pct'),
      reopen_pct: pair('reopen_pct'), confirmation_pct: pair('confirmation_pct'), avg_rating: pair('avg_rating'),
      median_close_hours: { now: await median(b.this_at, b.end_at), prev: await median(b.prev_at, b.this_at) },
      open_now: liveSum('open_now'), overdue_now: liveSum('overdue_now'),
      inspection_waiting: liveSum('inspection_waiting'), open_level4: liveSum('open_level4')
    };

    /* ---------------- Areas, ranked */
    const areas = areaRows.map((a) => {
      const f = figures(P.get(a.id)), l = live.get(a.id) || {}, q = quarters.get(a.id) || 0;
      return {
        area_id: a.id, code: a.code, name: a.name, quarters: q,
        contractors: [...new Set(contracts.filter((k) => k.area_id === a.id).map((k) => k.contractor_name))],
        complaints: f.complaints, per100: q ? r2((f.complaints / q / m) * 100) : null,
        sla_pct: f.sla_pct, first_time_fix_pct: f.first_time_fix_pct, reopen_pct: f.reopen_pct,
        median_close_hours: f.median_close_hours, confirmation_pct: f.confirmation_pct, avg_rating: f.avg_rating,
        open_now: Number(l.open_now || 0), overdue_now: Number(l.overdue_now || 0),
        inspection_waiting: Number(l.inspection_waiting || 0), open_level4: Number(l.open_level4 || 0),
        sla_now: figures(T.get(a.id)).sla_pct, sla_prev: figures(V.get(a.id)).sla_pct,
        _lag: f.lag, _closed: f.closed
      };
    });
    const byNull = (k) => (x, y) => (x[k] === null) - (y[k] === null) || (y[k] ?? 0) - (x[k] ?? 0);
    const rankBy = (k, extra) => {
      const order = [...areas].sort((x, y) => byNull(k)(x, y) || (extra ? extra(x, y) : 0) || x.code.localeCompare(y.code));
      order.forEach((a, i) => { a[k === 'sla_pct' ? 'rank' : k === 'sla_now' ? 'rank_now' : 'rank_prev'] = i + 1; });
      return order;
    };
    rankBy('sla_now'); rankBy('sla_prev');
    const ranked = rankBy('sla_pct', (x, y) => y.complaints - x.complaints);

    /* ---------------- by month */
    const monthly = (await c.query(
      `SELECT area_id, to_char(completed_claim_at AT TIME ZONE ${TZ}, 'YYYY-MM') AS month,
              count(*) FILTER (WHERE completion_met) AS met, count(*) FILTER (WHERE completion_met IS NOT NULL) AS judged
         FROM ticket WHERE completed_claim_at >= $1 GROUP BY 1, 2`, [b.start_at])).rows;
    const raisedMonthly = (await c.query(
      `SELECT to_char(raised_at AT TIME ZONE ${TZ}, 'YYYY-MM') AS month, count(*)::int AS complaints
         FROM ticket WHERE raised_at >= $1 GROUP BY 1`, [b.start_at])).rows;
    const cell = (areaId, month) => monthly.find((x) => x.area_id === areaId && x.month === month);
    const heatmap = areaRows.map((a) => ({ code: a.code, name: a.name, months: b.labels.map((mo) => {
      const x = cell(a.id, mo); return { month: mo, sla_pct: x ? pct(x.met, x.judged) : null, judged: x ? Number(x.judged) : 0 };
    }) }));
    const trend = b.labels.map((mo) => {
      const xs = monthly.filter((x) => x.month === mo);
      return { month: mo, complaints: raisedMonthly.find((x) => x.month === mo)?.complaints || 0,
        sla_pct: pct(xs.reduce((s, x) => s + Number(x.met), 0), xs.reduce((s, x) => s + Number(x.judged), 0)) };
    });

    /* ---------------- where the time goes */
    // every Area, so the panel lines up with the ranking; empty where nothing closed
    const lag = ranked.map((a) => ({ code: a.code, name: a.name,
      ...(a._lag || { contractor_hours: null, department_hours: null, paused_hours: null, total_hours: null }), closed: a._closed }));

    /* ---------------- funnel: complaints raised in the period, by the stages they reached */
    const f = (await c.query(
      `WITH t AS (SELECT id, state, referred_special_repair FROM ticket WHERE raised_at >= $1),
            reached AS (SELECT e.ticket_id, array_agg(DISTINCT e.to_state::text) AS s
                          FROM ticket_event e JOIN t ON t.id = e.ticket_id GROUP BY e.ticket_id)
       SELECT count(*) AS raised,
              count(*) FILTER (WHERE 'VERIFIED' = ANY(r.s)) AS verified,
              count(*) FILTER (WHERE 'ASSIGNED' = ANY(r.s)) AS assigned,
              count(*) FILTER (WHERE 'WORK_COMPLETED' = ANY(r.s)) AS claimed,
              count(*) FILTER (WHERE 'INSPECTED_ACCEPTED' = ANY(r.s)) AS accepted,
              count(*) FILTER (WHERE t.state = 'CLOSED') AS closed,
              count(*) FILTER (WHERE t.state = 'CLOSED' AND fb.confirmed) AS confirmed,
              count(*) FILTER (WHERE t.state = 'REJECTED') AS rejected,
              count(*) FILTER (WHERE t.referred_special_repair) AS special_repair
         FROM t LEFT JOIN reached r ON r.ticket_id = t.id LEFT JOIN ticket_feedback fb ON fb.ticket_id = t.id`, [b.start_at])).rows[0];
    const funnel = ['raised', 'verified', 'assigned', 'claimed', 'accepted', 'closed', 'confirmed']
      .map((k) => ({ stage: k.toUpperCase(), count: Number(f[k]) }));

    /* ---------------- category concentration */
    const cats = (await c.query(
      `SELECT t.area_id, cat.code, cat.name_en, cat.display_order, count(*)::int AS n
         FROM ticket t JOIN sub_category s ON s.id = t.sub_category_id JOIN category cat ON cat.id = s.category_id
        WHERE t.raised_at >= $1 GROUP BY 1, 2, 3, 4`, [b.start_at])).rows;
    const allCats = (await c.query(`SELECT code, name_en FROM category ORDER BY display_order`)).rows;
    const categories = {
      columns: allCats,
      rows: areaRows.map((a) => {
        const counts = Object.fromEntries(allCats.map((k) => [k.code, cats.find((x) => x.area_id === a.id && x.code === k.code)?.n || 0]));
        return { code: a.code, name: a.name, total: Object.values(counts).reduce((s, v) => s + v, 0), counts };
      })
    };

    /* ---------------- contractors across Areas */
    const perContract = (await c.query(
      `SELECT t.contract_id,
              count(*) FILTER (WHERE t.raised_at >= $1) AS complaints,
              count(*) FILTER (WHERE t.completed_claim_at >= $1 AND t.completion_met) AS met,
              count(*) FILTER (WHERE t.completed_claim_at >= $1 AND t.completion_met IS NOT NULL) AS judged,
              (SELECT count(*) FROM sla_breach sb JOIN ticket t2 ON t2.id = sb.ticket_id
                WHERE t2.contract_id = t.contract_id AND sb.breached_at >= $1) AS breaches
         FROM ticket t WHERE t.contract_id IS NOT NULL GROUP BY t.contract_id`, [b.start_at])).rows;
    const codeOf = new Map(areaRows.map((a) => [a.id, a.code]));
    const firms = new Map();
    for (const k of contracts) {
      const x = perContract.find((p) => p.contract_id === k.id) || {};
      const e = firms.get(k.contractor_name) || { contractor_name: k.contractor_name, areas: [], complaints: 0, met: 0, judged: 0, breaches: 0, below_target_areas: [] };
      const code = codeOf.get(k.area_id);
      if (code && !e.areas.includes(code)) e.areas.push(code);
      e.complaints += Number(x.complaints || 0); e.met += Number(x.met || 0); e.judged += Number(x.judged || 0); e.breaches += Number(x.breaches || 0);
      const s = pct(x.met, x.judged);
      if (s !== null && s < target && code && !e.below_target_areas.includes(code)) e.below_target_areas.push(code);
      firms.set(k.contractor_name, e);
    }
    const contractors = [...firms.values()].map(({ met, judged, ...e }) => ({ ...e, sla_pct: pct(met, judged), flagged: e.below_target_areas.length > 1 }))
      .sort((x, y) => (y.flagged - x.flagged) || x.contractor_name.localeCompare(y.contractor_name));

    /* ---------------- needs HQ attention */
    const pending = new Map((await c.query(
      `SELECT area_id, count(*)::int AS n FROM ticket_review WHERE stage = 'WITH_STAFF_OFFICER' GROUP BY area_id`)).rows.map((r) => [r.area_id, r.n]));
    const watch = [];
    for (const a of areas) {
      if (a.sla_now !== null && a.sla_now < target) {
        watch.push({ severity: a.sla_now < target - 15 ? 'critical' : 'warning', kind: 'SLA_BELOW_TARGET', code: a.code,
          title: `${a.name}: SLA ${a.sla_now}% this month`, detail: `Below the ${target}% target.` });
      }
      if (a.inspection_waiting > 0) {
        watch.push({ severity: a.inspection_waiting >= 5 ? 'critical' : 'warning', kind: 'INSPECTION_BACKLOG', code: a.code,
          title: `${a.name}: ${a.inspection_waiting} awaiting inspection over ${backlogHours} h`, detail: 'Work claimed complete and not yet inspected.' });
      }
      if (a.open_level4 > 0) {
        watch.push({ severity: 'critical', kind: 'LEVEL4_OPEN', code: a.code,
          title: `${a.name}: ${a.open_level4} open at escalation level 4`, detail: 'Escalated to the GM (Civil) and still open.' });
      }
      for (const k of contracts.filter((x) => x.area_id === a.area_id && x.days_left <= 30)) {
        watch.push({ severity: k.days_left < 0 ? 'critical' : 'warning', kind: 'CONTRACT_ENDING', code: a.code,
          title: `${a.name}: ${k.contractor_name}'s contract ${k.days_left < 0 ? 'has ended' : `ends in ${k.days_left} days`}`,
          detail: `Completion date ${k.expires_on}. A successor or an extension is needed.` });
      }
      if (pending.get(a.area_id)) {
        watch.push({ severity: 'warning', kind: 'STAFF_OFFICER_PENDING', code: a.code,
          title: `${a.name}: ${pending.get(a.area_id)} dispute(s) awaiting the Staff Officer's decision`, detail: 'The complaint cannot move until it is decided in writing.' });
      }
    }
    watch.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'critical' ? -1 : 1) || x.code.localeCompare(y.code));

    return {
      period: { months: m, from: `${b.labels[0]}-01`, to: b.today, labels: b.labels },
      target_percent: target, generated_at: new Date().toISOString(), kpis,
      areas: ranked.map(({ _lag, _closed, open_level4, ...a }) => a),
      heatmap, trend, lag, funnel,
      funnel_exits: { rejected: Number(f.rejected), special_repair: Number(f.special_repair) },
      categories, contractors, watch
    };
  });
}

hq.get('/hq/executive', async (req, res, next) => {
  try { res.json(await build(req)); } catch (e) { next(e); }
});

hq.get('/hq/executive.csv', async (req, res, next) => {
  try {
    const x = await build(req);
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const cols = ['rank', 'code', 'area', 'contractors', 'quarters', 'complaints', 'per_100_quarters_per_month', 'sla_pct',
      'first_time_fix_pct', 'reopen_pct', 'median_hours_to_close', 'confirmation_pct', 'avg_rating', 'open_now', 'overdue_now', 'inspection_waiting'];
    const rows = x.areas.map((a) => [a.rank, a.code, a.name, a.contractors.join('; '), a.quarters, a.complaints, a.per100, a.sla_pct,
      a.first_time_fix_pct, a.reopen_pct, a.median_close_hours, a.confirmation_pct, a.avg_rating, a.open_now, a.overdue_now, a.inspection_waiting]);
    res.set('content-type', 'text/csv; charset=utf-8');
    res.set('content-disposition', 'attachment; filename="hq-all-areas.csv"');
    res.send([cols.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n') + '\n');
  } catch (e) { next(e); }
});

hq.use((err, req, res, _next) => {
  const mapped = mapDbError(err);
  const status = err.status || mapped?.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({
    title: status === 403 ? 'Not permitted' : status === 422 ? 'Cannot do that' : 'Error',
    status, detail: err.status ? err.message : (mapped?.detail || 'Unexpected error') });
});
