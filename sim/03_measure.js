/**
 * LOAD SIMULATION — PART 3: measurement
 *
 *   node sim/03_measure.js
 *
 * Answers three questions the design currently assumes rather than knows:
 *
 *   1. Do the indexes hold at 15,000 premises, or does the inspection
 *      queue and the escalation sweep fall back to sequential scans?
 *   2. How long does the SLA sweep take, given it runs every few minutes
 *      across every open ticket in twelve Areas?
 *   3. How many inspections a day does this actually put on an Overseer,
 *      against the two accounts per Area the design provisions?
 */
import { maintPool, withSystem } from '../src/db.js';
import { runSlaSweep } from '../src/notify.js';

const OVERSEERS_PER_AREA = 3;   // departmental decision
const WORKING_DAYS = 26;
// same assumptions as 04_capacity.js — the two must not disagree
const MINUTES_PER_INSPECTION = 12;
const OVERSEER_FIELD_MINUTES = 240;

const line = (s = '') => console.log(s);
const rule = () => line('─'.repeat(74));

async function explain(label, sql, params = []) {
  const r = await withSystem(maintPool, (c) =>
    c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params));
  const plan = r.rows[0]['QUERY PLAN'][0];
  const text = JSON.stringify(plan.Plan);
  const seq = (text.match(/"Node Type":"Seq Scan"/g) || []).length;
  const idx = (text.match(/"Node Type":"(Index|Bitmap Index) Scan"/g) || []).length;
  line(`  ${label}`);
  line(`      ${plan['Execution Time'].toFixed(1)} ms` +
       `   index scans: ${idx}   sequential scans: ${seq}` +
       (seq > 0 ? '   <- check this' : ''));
  return { ms: plan['Execution Time'], seq, idx };
}

async function main() {
  const totals = (await withSystem(maintPool, (c) => c.query(
    `SELECT (SELECT count(*) FROM premises_ref) AS premises,
            (SELECT count(*) FROM device_ref)   AS devices,
            (SELECT count(*) FROM ticket)       AS tickets,
            (SELECT count(*) FROM ticket WHERE state='WORK_COMPLETED') AS to_inspect,
            (SELECT count(*) FROM ticket
              WHERE state NOT IN ('CLOSED','REJECTED')) AS open_tickets`))).rows[0];

  rule();
  line('LOAD SIMULATION — measured against the real schema');
  rule();
  line(`  premises ${totals.premises}   devices ${totals.devices}   ` +
       `tickets ${totals.tickets}   open ${totals.open_tickets}`);
  line();

  /* ---------------- 1. query plans ---------------- */
  line('1. QUERY PLANS');
  line();
  await explain('Overseer inspection queue (one Area)',
    `SELECT t.id, t.ticket_no, p.identifier
       FROM ticket t JOIN premises_ref p ON p.premises_id = t.premises_id
      WHERE t.state='WORK_COMPLETED' AND t.scope_path <@ 'ncl.jayant'
      ORDER BY t.is_emergency DESC, t.inspection_priority NULLS LAST,
               t.inspection_rank, t.verified_at
      LIMIT 50`);
  await explain('escalation sweep — overdue scan, all Areas',
    `SELECT t.id FROM ticket t
      WHERE t.completion_deadline_at < now()
        AND t.state IN ('VERIFIED','ASSIGNED','IN_PROGRESS','REWORK')`);
  // bind real ids rather than subselects: a subselect over a small table
  // scans it, which flagged a false positive in an earlier version
  const someTicket = (await withSystem(maintPool, (c) => c.query(
    `SELECT premises_id, sub_category_id FROM ticket LIMIT 1`))).rows[0];
  await explain('resident ticket list (one premises)',
    `SELECT t.id FROM ticket t WHERE t.premises_id = $1
      ORDER BY t.raised_at DESC LIMIT 50`, [someTicket.premises_id]);
  await explain('duplicate check on raising a complaint',
    `SELECT t.id FROM ticket t
      WHERE t.premises_id = $1 AND t.sub_category_id = $2
        AND t.state IN ('RAISED','VERIFIED','ASSIGNED','IN_PROGRESS','REWORK')`,
    [someTicket.premises_id, someTicket.sub_category_id]);
  await explain('notification routing by ancestor scope',
    `SELECT device_id FROM devices_to_notify('CIVIL_OVERSEER','ncl.jayant.colony1')`);
  await explain('GM dashboard — over ALL history (the naive query)',
    `SELECT t.area_id, count(*) FILTER (WHERE t.state='WORK_COMPLETED') AS to_inspect,
            count(*) FILTER (WHERE t.completion_deadline_at < now()
                               AND t.state NOT IN ('CLOSED','REJECTED')) AS overdue
       FROM ticket t GROUP BY t.area_id`);
  await explain('GM dashboard — open tail only (what the app should run)',
    `SELECT t.area_id, count(*) FILTER (WHERE t.state='WORK_COMPLETED') AS to_inspect,
            count(*) FILTER (WHERE t.completion_deadline_at < now()) AS overdue
       FROM ticket t
      WHERE t.state NOT IN ('CLOSED','REJECTED')
      GROUP BY t.area_id`);
  line();

  /* ---------------- 2. sweep timing ---------------- */
  line('2. SLA SWEEP AND ESCALATION');
  line();
  const t0 = Date.now();
  const first = await runSlaSweep({ quiet: true });
  void first;
  const firstMs = Date.now() - t0;
  const t1 = Date.now();
  const second = await runSlaSweep({ quiet: true });
  const secondMs = Date.now() - t1;
  line(`  first run   ${String(firstMs).padStart(6)} ms   ` +
       `breaches ${first.new_breaches}   escalated ${first.escalated}   ` +
       `notifications ${first.notifications}`);
  line(`  second run  ${String(secondMs).padStart(6)} ms   ` +
       `breaches ${second.new_breaches}   escalated ${second.escalated}   ` +
       `notifications ${second.notifications}`);
  line(`  the second run is the steady state: nothing is re-escalated.`);
  line();

  /* ---------------- 3. the real question ---------------- */
  line('3. INSPECTION BURDEN — the assumption the design rests on');
  line();
  const perArea = (await withSystem(maintPool, (c) => c.query(
    `SELECT p.area_code AS area,
            count(*) FILTER (WHERE t.state='WORK_COMPLETED') AS waiting,
            count(*) AS month_total
       FROM ticket t JOIN premises_ref p ON p.premises_id = t.premises_id
      GROUP BY 1 ORDER BY 2 DESC`))).rows;

  const monthTotal = perArea.reduce((s, r) => s + Number(r.month_total), 0);
  const inspectionsPerMonth = monthTotal;      // every completed job is inspected
  const perAreaMonth = inspectionsPerMonth / perArea.length;
  const perOverseerDay = perAreaMonth / OVERSEERS_PER_AREA / WORKING_DAYS;

  line(`  complaints this month, all Areas        ${monthTotal}`);
  line(`  every one is inspected before closure   ${inspectionsPerMonth}`);
  line(`  per Area per month                      ${perAreaMonth.toFixed(0)}`);
  line(`  per Overseer per working day            ${perOverseerDay.toFixed(1)}` +
       `   (${OVERSEERS_PER_AREA} Overseers, ${WORKING_DAYS} working days)`);
  line();
  line('  Area                waiting to inspect   month total');
  for (const r of perArea.slice(0, Math.min(6, perArea.length))) {
    line(`    ${r.area.padEnd(16)} ${String(r.waiting).padStart(10)} ` +
         `${String(r.month_total).padStart(14)}`);
  }
  if (perArea.length > 6) line(`    … ${perArea.length - 6} more Areas`);
  line();

  const utilisation = (perOverseerDay * MINUTES_PER_INSPECTION) / OVERSEER_FIELD_MINUTES;
  const verdict = utilisation <= 0.5 ? 'comfortable'
    : utilisation <= 0.75 ? 'tight'
    : utilisation <= 1.0 ? 'at the limit — a third Overseer is needed in busy Areas'
    : 'not feasible as designed';
  line(`  field time used                         ${(utilisation * 100).toFixed(0)}%` +
       `   (${MINUTES_PER_INSPECTION} min each, ` +
       `${OVERSEER_FIELD_MINUTES / 60} field hours a day)`);
  line(`  VERDICT at this complaint rate: ${verdict}`);
  rule();

  await maintPool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
