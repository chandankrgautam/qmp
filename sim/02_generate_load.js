/**
 * LOAD SIMULATION — PART 2
 *
 *   node sim/02_generate_load.js --rate 0.15
 *
 * --rate is complaints per quarter per month. Nobody knows this figure for
 * NCL, which is the reason for the whole exercise, so it is a parameter and
 * the measurements are reported against it.
 *
 * Tickets are spread across the preceding 30 days and distributed across
 * lifecycle states in the proportions a real month's work would show.
 */
import { identityPool, maintPool, withSystem } from '../src/db.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
};
const RATE = arg('rate', 0.15);
const DAYS = arg('days', 30);

/* Where a month's tickets sit at the moment of measurement. Most are
   closed; the interesting tail is what is still open, and in particular
   what is waiting for inspection. */
const STATE_MIX = [
  ['CLOSED',             0.55],
  ['INSPECTED_ACCEPTED', 0.04],
  ['WORK_COMPLETED',     0.12],   // the Overseer's queue
  ['IN_PROGRESS',        0.13],
  ['ASSIGNED',           0.06],
  ['VERIFIED',           0.05],
  ['RAISED',             0.04],
  ['REWORK',             0.01]
];

/* Category mix: water and sanitary dominate colony maintenance. */
const CATEGORY_WEIGHT = {
  NOWATER: 6, BURST: 2, TAP: 14, INTPIPE: 8,
  SEWAGE: 4, MANHOLE: 2, WCBLOCK: 9,
  CRACK: 1, CEILING: 2, ROOF: 11, SEEP: 13,
  DOOR: 7, WINDOW: 4, WHITEWASH: 5
};

const pick = (weighted) => {
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of weighted) { r -= w; if (r <= 0) return v; }
  return weighted[0][0];
};

async function syncProjections() {
  console.log('projecting premises and devices into the maintenance database…');
  const prem = await withSystem(identityPool, (c) => c.query(
    `SELECT p.id, p.area_id, a.ticket_code, p.colony_id, p.scope_path::text,
            p.identifier, p.premises_type::text, p.quarter_type::text,
            p.occupancy_model::text, coalesce(r.rank, 99) AS rank
       FROM identity.premises p
       JOIN identity.area a ON a.id = p.area_id
       LEFT JOIN identity.inspection_sort_rank r
              ON r.premises_type = p.premises_type
             AND (r.quarter_type = p.quarter_type
                  OR (r.quarter_type IS NULL AND p.quarter_type IS NULL))`));
  const devs = await withSystem(identityPool, (c) => c.query(
    `SELECT d.id, pe.name, d.role::text, d.scope_path::text, d.premises_id, d.status::text
       FROM identity.device d LEFT JOIN identity.person pe ON pe.id = d.person_id
      WHERE d.status = 'ACTIVE'`));

  await withSystem(maintPool, async (c) => {
    // COPY-style bulk insert: one statement per 1000 rows
    for (let i = 0; i < prem.rows.length; i += 1000) {
      const chunk = prem.rows.slice(i, i + 1000);
      const vals = chunk.map((_, k) => {
        const b = k * 10;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5}::ltree,$${b+6},` +
               `$${b+7}::premises_type,$${b+8},$${b+9},$${b+10})`;
      }).join(',');
      await c.query(
        `INSERT INTO premises_ref (premises_id, area_id, area_code, colony_id, scope_path,
             identifier, premises_type, quarter_type, occupancy_model, inspection_rank)
         VALUES ${vals} ON CONFLICT (premises_id) DO NOTHING`,
        chunk.flatMap((p) => [p.id, p.area_id, p.ticket_code, p.colony_id, p.scope_path,
          p.identifier, p.premises_type, p.quarter_type, p.occupancy_model, p.rank]));
    }
    for (let i = 0; i < devs.rows.length; i += 1000) {
      const chunk = devs.rows.slice(i, i + 1000);
      const vals = chunk.map((_, k) => {
        const b = k * 6;
        return `($${b+1},$${b+2},$${b+3},$${b+4}::ltree,$${b+5},$${b+6})`;
      }).join(',');
      await c.query(
        `INSERT INTO device_ref (device_id, person_name, role, scope_path,
             premises_id, status)
         VALUES ${vals} ON CONFLICT (device_id) DO NOTHING`,
        chunk.flatMap((d) => [d.id, d.name, d.role, d.scope_path, d.premises_id, d.status]));
    }
  });
  console.log(`  ${prem.rowCount} premises, ${devs.rowCount} devices projected`);
}

async function generate() {
  const started = Date.now();
  // No truncate: ticket history is append-only and the application role
  // cannot clear it, by design. The generator therefore expects a fresh
  // database — npm run db:reset, npm run seed, then 01_bulk_premises.sql.
  const existing = Number((await withSystem(maintPool, (c) => c.query(
    `SELECT count(*) n FROM ticket`))).rows[0].n);
  if (existing > 50) {
    console.error(`  ${existing} tickets already present. Reset the database first:`);
    console.error('    npm run db:reset && npm run seed && npm run sim:premises');
    process.exit(1);
  }

  const subs = (await withSystem(maintPool, (c) => c.query(
    `SELECT s.id, s.code, s.emergency_eligible,
            r.response_minutes, r.completion_minutes
       FROM sub_category s
       JOIN sla_rule r ON r.sub_category_id = s.id AND r.premises_type IS NULL
      WHERE s.classification = 'CIVIL'`))).rows;
  const weighted = subs
    .filter((s) => CATEGORY_WEIGHT[s.code])
    .map((s) => [s, CATEGORY_WEIGHT[s.code]]);

  const premises = (await withSystem(maintPool, (c) => c.query(
    `SELECT premises_id, area_id, area_code, scope_path::text, inspection_rank,
            premises_type FROM premises_ref`))).rows;
  const quarters = premises.filter((p) => p.premises_type === 'QUARTER');

  const devByPremises = new Map();
  for (const r of (await withSystem(maintPool, (c) => c.query(
    `SELECT premises_id, device_id FROM device_ref
      WHERE role IN ('RESIDENT','CUSTODIAN') AND premises_id IS NOT NULL`))).rows) {
    if (!devByPremises.has(r.premises_id)) devByPremises.set(r.premises_id, r.device_id);
  }
  const contractorByScope = new Map();
  for (const r of (await withSystem(maintPool, (c) => c.query(
    `SELECT scope_path::text AS scope, device_id FROM device_ref
      WHERE role='CONTRACTOR_SUPERVISOR' AND status='ACTIVE'`))).rows) {
    contractorByScope.set(r.scope, r.device_id);
  }
  const overseerByScope = new Map();
  for (const r of (await withSystem(maintPool, (c) => c.query(
    `SELECT scope_path::text AS scope, device_id FROM device_ref
      WHERE role='CIVIL_OVERSEER' AND status='ACTIVE'`))).rows) {
    overseerByScope.set(r.scope, r.device_id);
  }

  const total = Math.round(quarters.length * RATE);
  console.log(`generating ${total} complaints over ${DAYS} days ` +
              `(${RATE} per quarter per month)…`);

  const rows = [];
  const seq = new Map();
  // Only one OPEN complaint per premises and sub-category is permitted, so
  // the generator must respect that too — the database will refuse
  // otherwise, exactly as it refuses a resident raising the same leak twice.
  const OPEN = new Set(['RAISED','VERIFIED','ASSIGNED','IN_PROGRESS','REWORK']);
  const openKeys = new Set();
  let attempts = 0;
  for (let i = 0; i < total && attempts < total * 6; i++) {
    const p = quarters[Math.floor(Math.random() * quarters.length)];
    const sub = pick(weighted);
    const state = pick(STATE_MIX);
    attempts++;
    if (OPEN.has(state)) {
      const key = `${p.premises_id}|${sub.id}`;
      if (openKeys.has(key)) { i--; continue; }
      openKeys.add(key);
    }
    const area = p.area_code;
    const n = (seq.get(area) || 0) + 1; seq.set(area, n);

    const ageDays = Math.random() * DAYS;
    const raised = new Date(Date.now() - ageDays * 864e5);
    const verified = state === 'RAISED' ? null
      : new Date(raised.getTime() + Math.random() * 20 * 36e5);
    const emergency = sub.emergency_eligible && Math.random() < 0.18;

    const areaScope = p.scope_path.split('.').slice(0, 2).join('.');
    rows.push({
      ticket_no: `${area}/${new Date().getFullYear()}/${String(n).padStart(5, '0')}`,
      premises_id: p.premises_id, area_id: p.area_id, scope_path: p.scope_path,
      inspection_rank: p.inspection_rank, sub_category_id: sub.id,
      is_emergency: emergency, state,
      raised_at: raised, verified_at: verified,
      completion_deadline_at: verified
        ? new Date(verified.getTime() + sub.completion_minutes * 6e4) : null,
      raised_by_device: devByPremises.get(p.premises_id) || null,
      assigned_to_device: ['ASSIGNED','IN_PROGRESS','WORK_COMPLETED',
        'INSPECTED_ACCEPTED','CLOSED','REWORK'].includes(state)
        ? contractorByScope.get(areaScope) || null : null,
      inspected_by_device: ['INSPECTED_ACCEPTED','CLOSED'].includes(state)
        ? overseerByScope.get(areaScope) || null : null,
      completed_claim_at: ['WORK_COMPLETED','INSPECTED_ACCEPTED','CLOSED'].includes(state)
        ? new Date(raised.getTime() + (0.4 + Math.random() * 0.5) * ageDays * 864e5) : null,
      closed_at: state === 'CLOSED' ? new Date(raised.getTime() + ageDays * 864e5 * 0.9) : null
    });
  }

  // insert in chunks; the state machine is bypassed deliberately — this is
  // load generation, not a behavioural test
  const COLS = ['ticket_no','premises_id','area_id','scope_path','inspection_rank',
    'sub_category_id','is_emergency','state','raised_at','verified_at',
    'completion_deadline_at','raised_by_device','assigned_to_device',
    'inspected_by_device','completed_claim_at','closed_at'];
  await withSystem(maintPool, async (c) => {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const vals = chunk.map((_, k) => {
        const b = k * COLS.length;
        return '(' + COLS.map((_, j) =>
          `$${b + j + 1}` + (j === 3 ? '::ltree' : j === 7 ? '::ticket_state' : '')
        ).join(',') + ')';
      }).join(',');
      await c.query(
        `INSERT INTO ticket (${COLS.join(',')}) VALUES ${vals}
         ON CONFLICT (ticket_no) DO NOTHING`,
        chunk.flatMap((r) => COLS.map((c2) => r[c2])));
    }
    await c.query('ANALYZE ticket');
    await c.query('ANALYZE premises_ref');
    await c.query('ANALYZE device_ref');
  });

  const counts = (await withSystem(maintPool, (c) => c.query(
    `SELECT state::text, count(*) FROM ticket GROUP BY state ORDER BY 2 DESC`))).rows;
  console.log(`  inserted in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (const r of counts) console.log(`    ${r.state.padEnd(20)} ${r.count}`);
}

await syncProjections();
await generate();
await identityPool.end(); await maintPool.end();
