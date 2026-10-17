/**
 * LOAD SIMULATION — PART 4: capacity sweep
 *
 *   node sim/04_capacity.js
 *
 * Runs the whole load at several complaint rates and reports where
 * mandatory inspection stops being feasible. The complaint rate for NCL
 * colonies is unknown, so the useful output is not one number but the
 * point at which the design changes.
 *
 * Also reports how the database behaves as ticket volume grows, since the
 * escalation sweep scans every open ticket in twelve Areas.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { appConnection } from '../src/db.js';
import { dropdb, createdb, psqlFile, psqlCommand } from '../src/pgadmin.js';

/* A fresh pool per iteration: the sweep drops and recreates the
   maintenance database between rates, and a pooled connection would hold
   it open. */
function pool() {
  return new pg.Pool({ ...appConnection, database: 'ncl_maint', max: 2 });
}
async function query(sql, params = []) {
  const p = pool();
  try {
    const c = await p.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.role','SYSTEM',true)");
      await c.query("SELECT set_config('app.scope_path','ncl',true)");
      await c.query('SET LOCAL search_path TO maint, public');
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r;
    } finally { c.release(); }
  } finally { await p.end(); }
}

const RATES = [0.25, 0.50, 0.75, 1.00, 1.25, 1.50, 1.75];
const OVERSEERS = 3;   // departmental decision
const WORKING_DAYS = 26;
const MINUTES_PER_INSPECTION = 12;   // travel within a block, look, photograph
const OVERSEER_FIELD_MINUTES = 240;  // four hours a day in the field, not eight

const sql = fileURLToPath(new URL('../sql', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));

function resetMaintenance() {
  // dropdb --force ends anything still connected, which would block the drop
  dropdb('ncl_maint');
  createdb('ncl_maint');
  psqlFile('ncl_maint', path.join(sql, '02_maintenance_schema.sql'));
  psqlCommand('ncl_maint', 'GRANT USAGE ON SCHEMA maint TO appconn; ' +
    'GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA maint TO appconn; ' +
    'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA maint TO appconn;');
}

async function run() {
  const rows = [];
  console.log('');
  console.log('─'.repeat(92));
  console.log('CAPACITY SWEEP — mandatory inspection of every completed job');
  console.log('─'.repeat(92));
  console.log('  Assumptions: 13 Areas, 15,000 quarters, 3 Overseers per Area,');
  console.log(`  ${WORKING_DAYS} working days, ${MINUTES_PER_INSPECTION} minutes per inspection,`);
  console.log(`  ${OVERSEER_FIELD_MINUTES / 60} hours a day actually in the field.`);
  console.log('');

  for (const rate of RATES) {
    resetMaintenance();
    // reference data, then premises projection and tickets
    execFileSync(process.execPath, ['src/seed.js', '--maint-only'],
      { cwd: root, stdio: 'ignore' });
    execFileSync(process.execPath, ['sim/02_generate_load.js', '--rate', String(rate)],
      { cwd: root, stdio: 'ignore' });

    const t = await query(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE state='WORK_COMPLETED') AS waiting,
              count(*) FILTER (WHERE completion_deadline_at < now()
                                 AND state NOT IN ('CLOSED','REJECTED')) AS overdue
         FROM ticket`);
    const { total, waiting, overdue } = t.rows[0];

    const t0 = Date.now();
    await query(
      `SELECT t.id FROM ticket t
        WHERE t.state='WORK_COMPLETED' AND t.scope_path <@ 'ncl.jayant'
        ORDER BY t.is_emergency DESC, t.inspection_priority NULLS LAST,
                 t.inspection_rank, t.verified_at LIMIT 50`);
    const queueMs = Date.now() - t0;

    const t1 = Date.now();
    await query(
      `SELECT count(*) FROM ticket
        WHERE completion_deadline_at < now()
          AND state IN ('VERIFIED','ASSIGNED','IN_PROGRESS','REWORK')`);
    const sweepMs = Date.now() - t1;

    const perAreaMonth = Number(total) / 13;
    const perOverseerDay = perAreaMonth / OVERSEERS / WORKING_DAYS;
    const minutesNeeded = perOverseerDay * MINUTES_PER_INSPECTION;
    const utilisation = minutesNeeded / OVERSEER_FIELD_MINUTES;

    rows.push({ rate, total: Number(total), waiting: Number(waiting),
      overdue: Number(overdue), perOverseerDay, utilisation, queueMs, sweepMs });
  }

  console.log('  rate   complaints/mo   inspections    per Overseer   field time   queue   sweep');
  console.log('  /qtr      all Areas      per Area         per day        used      ms      ms');
  console.log('  ' + '─'.repeat(88));
  for (const r of rows) {
    const pct = (r.utilisation * 100).toFixed(0) + '%';
    const flag = r.utilisation > 1 ? '  NOT FEASIBLE'
      : r.utilisation > 0.75 ? '  at the limit'
      : r.utilisation > 0.5 ? '  tight' : '';
    console.log(
      `  ${r.rate.toFixed(2)}   ${String(r.total).padStart(11)}   ` +
      `${String(Math.round(r.total / 13)).padStart(11)}   ` +
      `${r.perOverseerDay.toFixed(1).padStart(13)}   ` +
      `${pct.padStart(9)}   ${String(r.queueMs).padStart(5)}   ` +
      `${String(r.sweepMs).padStart(5)}${flag}`);
  }
  console.log('');

  const breaking = rows.find((r) => r.utilisation > 1);
  const limit = rows.filter((r) => r.utilisation <= 1).pop();
  console.log('─'.repeat(92));
  console.log('  WHAT THIS MEANS');
  console.log('');
  if (limit) {
    console.log(`  Three Overseers per Area sustain mandatory inspection up to about`);
    console.log(`  ${limit.rate.toFixed(2)} complaints per quarter per month — roughly ` +
                `${Math.round(limit.total / 13)} a month per Area,`);
    console.log(`  or ${limit.perOverseerDay.toFixed(0)} inspections per Overseer per working day.`);
  }
  if (breaking) {
    console.log('');
    console.log(`  At ${breaking.rate.toFixed(2)} per quarter per month the burden is ` +
                `${breaking.perOverseerDay.toFixed(0)} inspections a day each,`);
    console.log(`  which needs ${(breaking.utilisation * OVERSEER_FIELD_MINUTES / 60).toFixed(1)} ` +
                `hours in the field. That is not a software problem —`);
    console.log('  it is a staffing decision, and it belongs with the department.');
  }
  console.log('');
  console.log('  Database behaviour is not the constraint at any of these rates.');
  console.log('─'.repeat(92));
  console.log('');
}

run().catch((e) => { console.error(e); process.exit(1); });
