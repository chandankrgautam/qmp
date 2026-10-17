import express from 'express';
import { maintPool, withScope, mapDbError } from './db.js';
import { requireAuth } from './auth.js';

/**
 * The approval chain after the work (user's decisions, 2026-10-16; README
 * §5.5 "Materials and measurements after the work"). Each job has a sheet for
 * its materials and one for its measurements, moving up contractor supervisor
 * → Civil Overseer → Civil Colony Incharge → Area Civil Staff Officer. The
 * database decides who may move a sheet and when (job_sheet_guard) and writes
 * every move itself (job_sheet_event); this file only asks and answers.
 */
export const sheets = express.Router();
sheets.use(requireAuth);

const scoped = (req, fn) => withScope(maintPool, req.claims, fn);
const notFound = () => Object.assign(new Error('Not found'), { status: 404 });
const KINDS = { materials: 'MATERIALS', measurements: 'MEASUREMENTS' };

const HOLDER = { SUPERVISOR: 'CONTRACTOR_SUPERVISOR', OVERSEER: 'CIVIL_OVERSEER', INCHARGE: 'MAINTENANCE_INCHARGE', STAFF_OFFICER: 'STAFF_OFFICER_CIVIL' };
const CONTRACTOR = ['CONTRACTOR', 'CONTRACTOR_SUPERVISOR'];
// URL action → the database's action, and where it takes the sheet from each step
const ACTIONS = {
  submit: ['SUBMIT', { SUPERVISOR: 'OVERSEER' }],
  pass: ['PASS', { OVERSEER: 'INCHARGE', INCHARGE: 'STAFF_OFFICER' }],
  'pass-no-change': ['PASS_NO_CHANGE', { OVERSEER: 'INCHARGE', INCHARGE: 'STAFF_OFFICER' }],
  return: ['RETURN', { OVERSEER: 'SUPERVISOR', INCHARGE: 'OVERSEER', STAFF_OFFICER: 'INCHARGE' }],
  approve: ['APPROVE', { STAFF_OFFICER: 'APPROVED' }],
  reopen: ['REOPEN', { APPROVED: 'INCHARGE' }]
};

/* What the caller may do with a sheet now — the same rule the database
   enforces, so the buttons never offer what would be refused. */
function canDo(claims, sheet, ticket, other) {
  if (sheet.stage === 'APPROVED') {
    return claims.role === 'STAFF_OFFICER_CIVIL' && sheet.kind === 'MATERIALS' && other?.stage !== 'APPROVED' ? ['reopen'] : [];
  }
  if (claims.role !== HOLDER[sheet.stage]) return [];
  if (sheet.stage === 'SUPERVISOR') {
    if (ticket.assigned_to !== claims.actor_id) return [];
    const ready = sheet.kind === 'MATERIALS' ? ['WORK_COMPLETED', 'INSPECTED_ACCEPTED', 'CLOSED'] : ['INSPECTED_ACCEPTED', 'CLOSED'];
    return ready.includes(ticket.state) ? ['submit'] : [];
  }
  if (sheet.stage === 'STAFF_OFFICER') return ['approve', 'return'];
  return ['pass', 'pass-no-change', 'return'];
}

/* Sheets waiting longer than the setting at one step (user's decision,
   2026-10-16), for Today and the Area dashboard. Departmental roles only; row
   security keeps it to the caller's Area. */
sheets.get('/sheets/waiting', async (req, res, next) => {
  try {
    if (!['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL', 'GM_CIVIL', 'HQ_EXECUTIVE', 'ADMINISTRATOR'].includes(req.claims.role)) throw notFound();
    const out = await scoped(req, async (c) => {
      const days = Number((await c.query(`SELECT value FROM maint_config WHERE key = 'sheet_waiting_days'`)).rows[0]?.value ?? 7);
      const items = (await c.query(
        `SELECT s.ticket_id, t.ticket_no, s.kind::text, s.stage::text, s.stage_since,
                round((extract(epoch FROM now() - s.stage_since) / 86400)::numeric, 1)::float8 AS days
           FROM job_sheet s JOIN ticket t ON t.id = s.ticket_id
          WHERE s.stage <> 'APPROVED' AND s.stage_since < now() - make_interval(secs => $1 * 86400)
          ORDER BY s.stage_since`, [days])).rows;
      const by_stage = {};
      for (const i of items) by_stage[i.stage] = (by_stage[i.stage] || 0) + 1;
      return { wait_days: days, items, by_stage };
    });
    res.json(out);
  } catch (e) { next(e); }
});

async function load(c, req) {
  const t = (await c.query(`SELECT id, state::text, assigned_to FROM ticket WHERE id = $1`, [req.params.id])).rows[0];
  if (!t || ['RESIDENT', 'CUSTODIAN'].includes(req.claims.role)) return null;
  const rows = (await c.query(
    `SELECT kind::text, stage::text, stage_since, approved_at FROM job_sheet WHERE ticket_id = $1`, [t.id])).rows;
  // the contractor reads no officer's record: it sees the role, never the name
  // (actor_ref's own row security answers NULL for them)
  const events = (await c.query(
    `SELECT e.kind::text, e.action, e.from_stage::text, e.to_stage::text, e.actor_role, e.remark, e.via, e.at,
            ${CONTRACTOR.includes(req.claims.role) ? 'NULL::text' : 'a.person_name'} AS actor_name
       FROM job_sheet_event e LEFT JOIN actor_ref a ON a.actor_id = e.actor_id
      WHERE e.ticket_id = $1 ORDER BY e.id`, [t.id])).rows;
  const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
  const out = {};
  for (const [name, kind] of Object.entries(KINDS)) {
    const s = by[kind];
    out[name] = s ? {
      kind, stage: s.stage, stage_since: s.stage_since, approved_at: s.approved_at,
      events: events.filter((e) => e.kind === kind).map(({ kind: _k, ...e }) => e),
      can: canDo(req.claims, s, t, by[kind === 'MATERIALS' ? 'MEASUREMENTS' : 'MATERIALS'])
    } : null;
  }
  return out;
}

sheets.get('/tickets/:id/sheets', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => load(c, req));
    if (!out) throw notFound();
    res.json(out);
  } catch (e) { next(e); }
});

sheets.post('/tickets/:id/sheets/:kind/:action', async (req, res, next) => {
  try {
    const kind = KINDS[req.params.kind];
    const act = ACTIONS[req.params.action];
    if (!kind || !act) throw notFound();
    const remark = String(req.body?.remark || '').trim();
    const out = await scoped(req, async (c) => {
      const cur = await load(c, req);
      const s = cur?.[req.params.kind];
      if (!s) throw notFound();
      const to = act[1][s.stage];
      if (!to) {
        // the move does not exist from this step: out of turn unless it is the holder's
        const err = new Error(`This sheet is at the ${s.stage.toLowerCase().replace('_', ' ')} step`);
        err.status = HOLDER[s.stage] && req.claims.role !== HOLDER[s.stage] ? 403 : 422;
        throw err;
      }
      await c.query(`SELECT set_config('app.sheet_action', $1, true), set_config('app.reason', $2, true)`, [act[0], remark]);
      const r = await c.query(
        `UPDATE job_sheet SET stage = $3::sheet_stage WHERE ticket_id = $1 AND kind = $2::sheet_kind AND stage = $4::sheet_stage RETURNING ticket_id`,
        [req.params.id, kind, to, s.stage]);
      if (!r.rowCount) throw Object.assign(new Error('The sheet moved meanwhile; reload it'), { status: 409 });
      return (await load(c, req))[req.params.kind];
    });
    res.json(out);
  } catch (e) { next(e); }
});

sheets.use((err, req, res, _next) => {
  const mapped = mapDbError(err);
  const status = err.status || mapped?.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({
    title: status === 403 ? 'Not permitted' : status === 404 ? 'Not found' : status === 409 ? 'Conflict' : status === 422 ? 'Cannot do that' : 'Error',
    status, detail: err.status ? err.message : (mapped?.detail || (status === 404 ? 'Not found' : 'Unexpected error')) });
});
