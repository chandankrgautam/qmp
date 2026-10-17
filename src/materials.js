import express from 'express';
import { maintPool, withScope, mapDbError, Forbidden, Unprocessable } from './db.js';
import { requireAuth } from './auth.js';

/**
 * Materials (decision 2026-09-30, item 9) — a record, never a bill.
 *
 * The master (kept by the HQ System Administrator), the contractor's claim
 * lines on each job, Civil's verification of them, and consumption reports
 * with anomaly flags. No rate, price or amount anywhere (control 9). The
 * database holds every rule; this file gives the plain messages.
 */
export const materials = express.Router();
materials.use(requireAuth);

const scoped = (req, fn) => withScope(maintPool, req.claims, fn);
const notFound = () => Object.assign(new Error('Not found'), { status: 404 });
const withReason = (c, reason) => c.query(`SELECT set_config('app.reason', $1, true)`, [String(reason || '')]);
const OCCUPANTS = ['RESIDENT', 'CUSTODIAN'];
// up to closure the Overseer or Incharge; in the approval chain after the work, the officer
// whose step it is, the Staff Officer included (2026-10-16) — the database decides which
const VERIFIERS = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL'];
// reports are departmental: the Overseer and every role above
const READERS = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL', 'GM_CIVIL', 'HQ_EXECUTIVE', 'ADMINISTRATOR'];
const requireRole = (req, roles, msg) => { if (!roles.includes(req.claims.role)) throw new Forbidden(msg); };
const num = (v) => (v === null || v === undefined ? null : Number(v));
const quantity = (v, { zero = false } = {}) => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || (zero ? n < 0 : n <= 0)) {
    throw new Unprocessable(zero ? 'The quantity is a number, zero or more' : 'The quantity is a number above zero');
  }
  return n;
};
const MATERIAL_COLS = 'id, code, name_en, name_hi, unit, category, norm_max_per_job, active';
const toMaterial = (r) => ({ ...r, norm_max_per_job: num(r.norm_max_per_job) });

/* ------------------------------------------------------------ master */
materials.get('/materials', async (req, res, next) => {
  try {
    const all = req.query.all === 'true';
    const out = await scoped(req, (c) => c.query(
      `SELECT ${MATERIAL_COLS} FROM material WHERE ($1 OR active) ORDER BY category NULLS LAST, name_en`, [all]));
    res.json(out.rows.map(toMaterial));
  } catch (e) { next(e); }
});

materials.post('/materials', async (req, res, next) => {
  try {
    requireRole(req, ['ADMINISTRATOR'], 'The materials master is kept by the HQ System Administrator');
    const b = req.body || {};
    for (const k of ['code', 'name_en', 'name_hi', 'unit']) {
      if (!String(b[k] || '').trim()) throw new Unprocessable('Code, English and Hindi names and the unit are required');
    }
    const norm = b.norm_max_per_job === undefined || b.norm_max_per_job === null || b.norm_max_per_job === ''
      ? null : quantity(b.norm_max_per_job);
    const out = await scoped(req, (c) => c.query(
      `INSERT INTO material (code, name_en, name_hi, unit, category, norm_max_per_job)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${MATERIAL_COLS}`,
      [String(b.code).trim().toUpperCase(), b.name_en.trim(), b.name_hi.trim(), b.unit.trim(), b.category || null, norm]));
    res.status(201).json(toMaterial(out.rows[0]));
  } catch (e) { next(e); }
});

materials.put('/materials/:id', async (req, res, next) => {
  try {
    requireRole(req, ['ADMINISTRATOR'], 'The materials master is kept by the HQ System Administrator');
    const b = req.body || {};
    if (!String(b.reason || '').trim()) throw new Unprocessable('Give the reason for changing the materials master');
    const fields = ['name_en', 'name_hi', 'unit', 'category', 'norm_max_per_job', 'active'].filter((k) => k in b);
    const out = await scoped(req, async (c) => {
      const cur = (await c.query(`SELECT code FROM material WHERE id=$1`, [req.params.id])).rows[0];
      if (!cur) throw notFound();
      if ('code' in b && b.code !== cur.code) throw new Unprocessable("A material's code is fixed; add a new material instead");
      if (!fields.length) throw new Unprocessable('Nothing to change');
      const vals = fields.map((k) => (k === 'norm_max_per_job' ? (b[k] === null || b[k] === '' ? null : quantity(b[k]))
        : k === 'active' ? !!b[k] : String(b[k] ?? '').trim() || null));
      await withReason(c, b.reason);
      return (await c.query(
        `UPDATE material SET ${fields.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING ${MATERIAL_COLS}`,
        [req.params.id, ...vals])).rows[0];
    });
    res.json(toMaterial(out));
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ claim lines */
const LINES = `
  SELECT c.id, c.seq, c.material_id, m.code, m.name_en, m.name_hi, m.unit,
         c.qty_claimed, c.claimed_at, c.claimed_via, cb.person_name AS claimed_by_name, c.claimed_by,
         c.withdrawn_at, c.withdrawal_reason,
         c.qty_verified, c.verified_at, vb.person_name AS verified_by_name, c.verification_remark
    FROM material_claim c
    JOIN material m ON m.id = c.material_id
    LEFT JOIN actor_ref cb ON cb.actor_id = c.claimed_by
    LEFT JOIN actor_ref vb ON vb.actor_id = c.verified_by`;
const toLine = (r) => ({ ...r, qty_claimed: num(r.qty_claimed), qty_verified: num(r.qty_verified) });

/* the ticket, if the caller may see its materials at all */
async function ticketFor(c, req) {
  if (OCCUPANTS.includes(req.claims.role)) return null;
  return (await c.query(`SELECT id, state, assigned_to FROM ticket WHERE id = $1`, [req.params.id])).rows[0] || null;
}

materials.get('/tickets/:id/materials', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => {
      const t = await ticketFor(c, req);
      if (!t) throw notFound();
      const contractor = ['CONTRACTOR', 'CONTRACTOR_SUPERVISOR'].includes(req.claims.role);
      // contractors read no officer's record: the field is left out, not just empty
      const items = (await c.query(`${LINES} WHERE c.ticket_id = $1 ORDER BY c.seq`, [t.id])).rows.map(toLine)
        .map((l) => (contractor ? (({ verified_by_name, ...rest }) => rest)(l) : l));
      // the same rule as material_claim_guard, so the screens offer only what it allows
      const stage = (await c.query(`SELECT sheet_stage_of($1, 'MATERIALS')::text AS s`, [t.id])).rows[0].s || 'SUPERVISOR';
      const atStep = [['CIVIL_OVERSEER', 'OVERSEER'], ['MAINTENANCE_INCHARGE', 'INCHARGE'], ['STAFF_OFFICER_CIVIL', 'STAFF_OFFICER'],
        ['STAFF_OFFICER_CIVIL', 'APPROVED']].some(([r, st]) => r === req.claims.role && st === stage);
      const after = ['WORK_COMPLETED', 'INSPECTED_ACCEPTED', 'CLOSED'].includes(t.state);
      return {
        items,
        stage,
        can_claim: (req.claims.role === 'CONTRACTOR_SUPERVISOR' && t.assigned_to === req.claims.actor_id
          && (['IN_PROGRESS', 'REWORK'].includes(t.state) || (after && stage === 'SUPERVISOR'))) || atStep,
        can_verify: atStep || (['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE'].includes(req.claims.role) && stage === 'SUPERVISOR'
          && ['WORK_COMPLETED', 'INSPECTED_ACCEPTED'].includes(t.state)),
        // a change at a step of the chain, or any after approval, needs a reason
        reason_needed: atStep
      };
    });
    res.json(out);
  } catch (e) { next(e); }
});

materials.post('/tickets/:id/materials', async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await scoped(req, async (c) => {
      const t = await ticketFor(c, req);
      if (!t) throw notFound();
      // the supervisor claims; an officer adds a missed line at their own step (2026-10-16)
      requireRole(req, ['CONTRACTOR_SUPERVISOR', ...VERIFIERS], "Materials are claimed by the contractor's supervisor the job is assigned to");
      if (!b.material_id) throw new Unprocessable('Choose the material');
      const q = quantity(b.qty_claimed);
      await withReason(c, b.reason);
      const r = (await c.query(
        `INSERT INTO material_claim (ticket_id, seq, material_id, qty_claimed) VALUES ($1, 0, $2, $3) RETURNING id`,
        [t.id, b.material_id, q])).rows[0];
      return toLine((await c.query(`${LINES} WHERE c.id = $1`, [r.id])).rows[0]);
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

materials.post('/tickets/:id/materials/:line/withdraw', async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    const out = await scoped(req, async (c) => {
      const t = await ticketFor(c, req);
      if (!t) throw notFound();
      requireRole(req, ['CONTRACTOR_SUPERVISOR'], 'Only the supervisor who claimed a line may withdraw it');
      if (!reason) throw new Unprocessable('Give the reason for withdrawing the line');
      const r = await c.query(
        `UPDATE material_claim SET withdrawal_reason = $3 WHERE ticket_id = $1 AND id = $2 RETURNING id`,
        [t.id, req.params.line, reason]);
      if (!r.rowCount) throw notFound();
      return toLine((await c.query(`${LINES} WHERE c.id = $1`, [req.params.line])).rows[0]);
    });
    res.json(out);
  } catch (e) { next(e); }
});

materials.post('/tickets/:id/materials/:line/verify', async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await scoped(req, async (c) => {
      const t = await ticketFor(c, req);
      if (!t) throw notFound();
      requireRole(req, VERIFIERS, 'Materials are verified by the Civil Overseer or the Civil Incharge');
      const q = quantity(b.qty_verified, { zero: true });
      await withReason(c, b.reason);
      const r = await c.query(
        `UPDATE material_claim SET qty_verified = $3, verification_remark = $4, verified_at = clock_timestamp()
          WHERE ticket_id = $1 AND id = $2 RETURNING id`,
        [t.id, req.params.line, q, String(b.remark || '').trim() || null]);
      if (!r.rowCount) throw notFound();
      return toLine((await c.query(`${LINES} WHERE c.id = $1`, [req.params.line])).rows[0]);
    });
    res.json(out);
  } catch (e) { next(e); }
});

materials.get('/tickets/:id/materials/history', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => {
      const t = await ticketFor(c, req);
      if (!t) throw notFound();
      return (await c.query(
        `SELECT l.occurred_at, l.event_type, l.actor_role, l.before_value, l.after_value, l.reason,
                a.person_name AS actor_name
           FROM audit_log l LEFT JOIN actor_ref a ON a.actor_id = l.actor_id
          WHERE l.entity_type = 'material_claim' AND l.entity_id = $1
          ORDER BY l.id DESC`, [t.id])).rows;
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ reports */
// filters shared by both reports: contract, and claimed between from and to (inclusive)
const FILTER = `c.withdrawn_at IS NULL
   AND ($1::uuid IS NULL OR c.contract_id = $1)
   AND ($2::date IS NULL OR c.claimed_at >= $2::date)
   AND ($3::date IS NULL OR c.claimed_at < $3::date + 1)`;
const filterArgs = (req) => {
  const d = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
  return [req.query.contract_id || null, d(req.query.from), d(req.query.to)];
};

async function consumption(req) {
  requireRole(req, READERS, 'Material reports are for the Civil Overseer and the officers above');
  const out = await scoped(req, (c) => c.query(
    `SELECT m.id AS material_id, m.code, m.name_en, m.unit,
            count(DISTINCT c.ticket_id)::int AS jobs,
            sum(c.qty_claimed) AS qty_claimed,
            coalesce(sum(c.qty_verified), 0) AS qty_verified,
            coalesce(sum(c.qty_claimed) FILTER (WHERE c.qty_verified IS NULL), 0) AS qty_unverified,
            coalesce(sum(c.qty_claimed - c.qty_verified) FILTER (WHERE c.qty_verified IS NOT NULL), 0) AS variance
       FROM material_claim c JOIN material m ON m.id = c.material_id
      WHERE ${FILTER}
      GROUP BY m.id, m.code, m.name_en, m.unit, m.category
      ORDER BY m.category NULLS LAST, m.name_en`, filterArgs(req)));
  return out.rows.map((r) => ({ ...r, qty_claimed: num(r.qty_claimed), qty_verified: num(r.qty_verified),
    qty_unverified: num(r.qty_unverified), variance: num(r.variance) }));
}

materials.get('/materials/consumption', async (req, res, next) => {
  try {
    const [, from, to] = filterArgs(req);
    res.json({ rows: await consumption(req), period: { from, to } });
  } catch (e) { next(e); }
});

materials.get('/materials/consumption.csv', async (req, res, next) => {
  try {
    const rows = await consumption(req);
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const cols = ['code', 'name_en', 'unit', 'jobs', 'qty_claimed', 'qty_verified', 'qty_unverified', 'variance'];
    res.set('content-type', 'text/csv; charset=utf-8');
    res.set('content-disposition', 'attachment; filename="material-consumption.csv"');
    res.send([cols.join(','), ...rows.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\n') + '\n');
  } catch (e) { next(e); }
});

/* Departmental signals, never shown to contractors or occupants. */
materials.get('/materials/anomalies', async (req, res, next) => {
  try {
    requireRole(req, READERS, 'Material reports are for the Civil Overseer and the officers above');
    const out = await scoped(req, (c) => c.query(
      `WITH live AS (
         SELECT c.*, m.code, m.name_en, m.unit, m.norm_max_per_job, t.ticket_no, t.state, p.identifier
           FROM material_claim c
           JOIN material m ON m.id = c.material_id
           JOIN ticket t ON t.id = c.ticket_id
           JOIN premises_ref p ON p.premises_id = c.premises_id
          WHERE ${FILTER})
       SELECT 'OVER_CLAIM' AS flag, ticket_id, ticket_no, identifier, id AS line_id, code, name_en, unit,
              qty_claimed, qty_verified,
              'Claimed ' || trim_scale(qty_claimed)::text || ' ' || unit || ', verified ' || trim_scale(qty_verified)::text AS detail
         FROM live WHERE qty_verified IS NOT NULL AND qty_verified < qty_claimed
       UNION ALL
       SELECT 'ABOVE_NORM', ticket_id, ticket_no, identifier, NULL, code, name_en, unit,
              sum(qty_claimed), sum(qty_verified),
              'Claimed ' || trim_scale(sum(qty_claimed))::text || ' ' || unit || ' on one job; a job normally needs up to '
                || trim_scale(max(norm_max_per_job))::text
         FROM live WHERE norm_max_per_job IS NOT NULL
        GROUP BY ticket_id, ticket_no, identifier, material_id, code, name_en, unit
       HAVING sum(qty_claimed) > max(norm_max_per_job)
       UNION ALL
       SELECT 'REPEAT_AT_PREMISES', l.ticket_id, l.ticket_no, l.identifier, l.id, l.code, l.name_en, l.unit,
              l.qty_claimed, l.qty_verified,
              'Also claimed at ' || l.identifier || ' on ' || o.ticket_no || ' within the previous 90 days'
         FROM live l
         JOIN LATERAL (SELECT t2.ticket_no FROM material_claim o2 JOIN ticket t2 ON t2.id = o2.ticket_id
                        WHERE o2.premises_id = l.premises_id AND o2.material_id = l.material_id
                          AND o2.ticket_id <> l.ticket_id AND o2.withdrawn_at IS NULL
                          AND o2.claimed_at < l.claimed_at AND o2.claimed_at >= l.claimed_at - interval '90 days'
                        ORDER BY o2.claimed_at DESC LIMIT 1) o ON true
       UNION ALL
       SELECT 'UNVERIFIED', ticket_id, ticket_no, identifier, id, code, name_en, unit, qty_claimed, qty_verified,
              'Passed inspection without the materials being verified'
         FROM live WHERE qty_verified IS NULL AND state IN ('INSPECTED_ACCEPTED','CLOSED')
       ORDER BY 1, 3`, filterArgs(req)));
    res.json({ items: out.rows.map((r) => ({ ...r, qty_claimed: num(r.qty_claimed), qty_verified: num(r.qty_verified) })) });
  } catch (e) { next(e); }
});

materials.use((err, req, res, _next) => {
  const mapped = mapDbError(err);
  const status = err.status || mapped?.status || (err.code === '22P02' ? 404 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({
    title: status === 403 ? 'Not permitted' : status === 404 ? 'Not found' : status === 409 ? 'Conflict' : status === 422 ? 'Cannot do that' : 'Error',
    status, detail: err.status ? err.message : (mapped?.detail || (status === 404 ? 'Not found' : 'Unexpected error')) });
});
