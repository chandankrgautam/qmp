import express from 'express';
import { maintPool, withScope, withSystem, mapDbError, Forbidden, Unprocessable } from './db.js';
import { requireAuth } from './auth.js';

/**
 * The job card (decision 2026-09-30, item 5).
 *
 * Prepared by the database when a complaint is first assigned. Read by the
 * Overseer and everyone above; changed only by the Overseer or the Civil
 * Incharge. The database holds every one of those rules and writes the log
 * of each change — this file only presents them and gives plain messages.
 */
export const jobcards = express.Router();
jobcards.use(requireAuth);

const scoped = (req, fn) => withScope(maintPool, req.claims, fn);
// since 2026-10-16 the supervisor the job is assigned to, and each officer at
// their step of the chain, the Staff Officer included — the database decides when
const EDITORS = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'CONTRACTOR_SUPERVISOR', 'STAFF_OFFICER_CIVIL'];
const requireEditor = (req) => {
  if (!EDITORS.includes(req.claims.role)) throw new Forbidden('The job card is changed by the supervisor and the officers of the approval chain');
};
const notFound = () => Object.assign(new Error('Not found'), { status: 404 });
const withReason = (c, reason) => c.query(`SELECT set_config('app.reason', $1, true)`, [String(reason || '')]);

// the complaint as the card shows it: read live, so it can never go stale
const TICKET = `
  SELECT t.id, t.ticket_no, t.state, t.description, t.is_emergency, t.raised_at, t.verified_at, t.contract_id,
         t.assigned_at, t.started_at, t.completed_claim_at, t.inspected_at, t.closed_at,
         t.completion_deadline_at, t.sla_completion_minutes, t.contractor_minutes, t.completion_met,
         t.workmen_assigned, t.rework_count, t.reopened_count, t.objection_count,
         p.identifier, p.premises_type::text, p.quarter_type, p.area_code, p.occupancy_model,
         s.name_en AS sub_category, s.name_hi AS sub_category_hi, cat.name_en AS category,
         ct.contractor_name, ct.agreement_no, ct.contract_no,
         sup.person_name AS supervisor_name, ver.person_name AS verified_by_name
    FROM ticket t
    JOIN premises_ref p ON p.premises_id = t.premises_id
    JOIN sub_category s ON s.id = t.sub_category_id
    JOIN category cat ON cat.id = s.category_id
    LEFT JOIN contract ct ON ct.id = t.contract_id
    LEFT JOIN actor_ref sup ON sup.actor_id = t.assigned_to
    LEFT JOIN actor_ref ver ON ver.actor_id = t.verified_by`;

async function loadCard(c, ticketId, role) {
  const jc = (await c.query(
    `SELECT jc.ticket_id, jc.jc_no, jc.prepared_at, jc.scope_of_work, jc.site_notes, jc.updated_at,
            u.person_name AS updated_by_name
       FROM job_card jc LEFT JOIN actor_ref u ON u.actor_id = jc.updated_by
      WHERE jc.ticket_id = $1`, [ticketId])).rows[0];
  if (!jc) return null;
  jc.ticket = (await c.query(`${TICKET} WHERE t.id = $1`, [ticketId])).rows[0];
  jc.items = (await c.query(
    `SELECT i.id, i.seq, i.description, i.unit, i.qty_estimated::float8 AS qty_estimated, i.added_at, i.withdrawn_at,
            i.withdrawal_reason, a.person_name AS added_by_name, w.person_name AS withdrawn_by_name
       FROM job_card_item i
       LEFT JOIN actor_ref a ON a.actor_id = i.added_by
       LEFT JOIN actor_ref w ON w.actor_id = i.withdrawn_by
      WHERE i.ticket_id = $1 ORDER BY i.seq`, [ticketId])).rows;
  // the same rule as job_card_editor_check (2026-10-16): the card follows the
  // job's measurement sheet, so the screens offer only what the database allows
  const stage = (await c.query(`SELECT sheet_stage_of($1, 'MEASUREMENTS')::text AS s`, [ticketId])).rows[0].s || 'SUPERVISOR';
  const st = jc.ticket?.state;
  const atStep = { OVERSEER: 'CIVIL_OVERSEER', INCHARGE: 'MAINTENANCE_INCHARGE', STAFF_OFFICER: 'STAFF_OFFICER_CIVIL', APPROVED: 'STAFF_OFFICER_CIVIL' }[stage];
  jc.stage = stage;
  jc.editable = st !== 'REJECTED' && (stage === 'SUPERVISOR'
    ? role === 'CONTRACTOR_SUPERVISOR' || (['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE'].includes(role) && st !== 'CLOSED')
    : role === atStep);
  jc.reason_always = stage === 'APPROVED';
  jc.lifecycle = await lifecycle(c, ticketId, jc.ticket);
  return jc;
}

/* The whole life of the job, round by round (user's finding, 2026-10-07).
   A round begins when the job reaches the contractor — first assignment,
   a send-back, or reassignment after the occupant reopens it — and holds
   who had it, the workmen, the materials claimed in it, the completion
   claim, the inspection, the closure and the occupant's answers. Built
   from the append-only ticket history, so nothing here can be edited. The
   job ends only when the complainant is satisfied. */
async function lifecycle(c, ticketId, ticket) {
  const events = (await c.query(
    `SELECT e.event_type, e.from_state, e.to_state, e.reason, e.detail, e.occurred_at, e.actor_role,
            a.person_name AS actor_name, s.person_name AS supervisor_name
       FROM ticket_event e
       LEFT JOIN actor_ref a ON a.actor_id = e.actor_id
       LEFT JOIN actor_ref s ON s.actor_id = (e.detail->>'assigned_to')::uuid
      WHERE e.ticket_id = $1 ORDER BY e.occurred_at, e.id`, [ticketId])).rows;
  const photos = (await c.query(
    `SELECT purpose, uploaded_at FROM ticket_media
      WHERE ticket_id = $1 AND purpose IN ('BEFORE','COMPLETION') AND upload_state = 'STORED'`, [ticketId])).rows;
  const lines = (await c.query(
    `SELECT c.claimed_at, c.qty_claimed, c.qty_verified, c.withdrawn_at, c.withdrawal_reason,
            m.code, m.name_en, m.unit
       FROM material_claim c JOIN material m ON m.id = c.material_id
      WHERE c.ticket_id = $1 ORDER BY c.seq`, [ticketId])).rows;

  const rounds = [];
  let cur = null, pending = null;
  const begin = (e, cause) => {
    cur = { n: rounds.length + 1, began_at: e.occurred_at, cause, supervisor_name: e.supervisor_name || cur?.supervisor_name || null,
      started_at: null, workmen: null, claimed_at: null, inspection: null, closed_at: null, feedback: [], materials: [],
      photos: { before: 0, after: 0 } };
    rounds.push(cur);
  };
  for (const e of events) {
    switch (e.to_state || e.event_type) {
      case 'ASSIGNED':
        begin(e, pending || { type: 'ASSIGNED', at: e.occurred_at, by: e.actor_name || e.actor_role });
        pending = null;
        break;
      case 'REWORK':
        if (cur) cur.inspection = { result: 'SENT_BACK', at: e.occurred_at, by: e.actor_name || e.actor_role, remark: e.reason };
        begin(e, { type: 'SENT_BACK', at: e.occurred_at, by: e.actor_name || e.actor_role, reason: e.reason });
        break;
      case 'REOPENED':
        pending = { type: 'REOPENED', at: e.occurred_at, by: e.actor_name || e.actor_role, reason: e.reason };
        if (cur) cur.reopened = pending;
        break;
      case 'IN_PROGRESS':
        if (cur) { cur.started_at = e.occurred_at; cur.workmen = e.detail?.workmen_assigned ?? null; }
        break;
      case 'WORK_COMPLETED':
        if (cur) cur.claimed_at = e.occurred_at;
        break;
      case 'INSPECTED_ACCEPTED':
        if (cur) cur.inspection = { result: 'ACCEPTED', at: e.occurred_at, by: e.actor_name || e.actor_role };
        break;
      case 'CLOSED':
        if (cur) cur.closed_at = e.occurred_at;
        break;
      case 'REFERRED_SPECIAL_REPAIR':
        if (cur) cur.referred_at = e.occurred_at;
        break;
      case 'OCCUPANT_CONFIRMED': case 'OCCUPANT_DISPUTED': case 'OCCUPANT_NO_RESPONSE':
        if (cur) cur.feedback.push({ confirmed: e.detail?.confirmed ?? null, rating: e.detail?.rating ?? null,
          comment: e.detail?.comment ?? null, at: e.occurred_at });
        break;
      default:
    }
  }
  // each material line belongs to the round it was claimed in
  for (const l of lines) {
    const t = new Date(l.claimed_at).getTime();
    const r = [...rounds].reverse().find((x) => new Date(x.began_at).getTime() <= t);
    if (r) r.materials.push({ code: l.code, name_en: l.name_en, unit: l.unit, qty_claimed: Number(l.qty_claimed),
      qty_verified: l.qty_verified == null ? null : Number(l.qty_verified), claimed_at: l.claimed_at,
      withdrawn: !!l.withdrawn_at, withdrawal_reason: l.withdrawal_reason });
  }

  for (const ph of photos) {
    const t = new Date(ph.uploaded_at).getTime();
    const r = [...rounds].reverse().find((x) => new Date(x.began_at).getTime() <= t);
    if (r) r.photos[ph.purpose === 'BEFORE' ? 'before' : 'after'] += 1;
  }

  // the job ends only when the complainant is satisfied
  const last = rounds.at(-1)?.feedback.filter((f) => f.confirmed !== null).at(-1);
  let status = 'IN_HAND';
  if (ticket.state === 'REJECTED') status = 'REJECTED';
  else if (ticket.state === 'REFERRED_SPECIAL_REPAIR') status = 'REFERRED';
  else if (ticket.state === 'REOPENED') status = 'DISPUTED';
  else if (['INSPECTED_ACCEPTED', 'CLOSED'].includes(ticket.state)) {
    if (ticket.occupancy_model === 'DEPARTMENT_ONLY') status = ticket.state === 'CLOSED' ? 'CLOSED_ON_INSPECTION' : 'IN_HAND';
    else if (last?.confirmed === true) status = 'SATISFIED';
    else if (last?.confirmed === false) status = 'DISPUTED';
    else if (ticket.state === 'CLOSED' && ticket.closed_at) {
      const h = Number((await c.query(`SELECT value FROM maint_config WHERE key='reopen_window_hours'`)).rows[0]?.value ?? 24);
      status = Date.now() - new Date(ticket.closed_at).getTime() > h * 36e5 ? 'CLOSED_NO_DISPUTE' : 'AWAITING_CONFIRMATION';
    } else status = 'AWAITING_CONFIRMATION';
  }
  return { status, rounds };
}

jobcards.get('/tickets/:id/job-card', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => loadCard(c, req.params.id, req.claims.role));
    if (!out) throw notFound();
    res.json(out);
  } catch (e) { next(e); }
});

jobcards.put('/tickets/:id/job-card', async (req, res, next) => {
  try {
    requireEditor(req);
    const b = req.body || {};
    const fields = ['scope_of_work', 'site_notes'].filter((k) => k in b);
    if (!fields.length) throw new Unprocessable('Nothing to change');
    const out = await scoped(req, async (c) => {
      await withReason(c, b.reason);
      const r = await c.query(
        `UPDATE job_card SET ${fields.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE ticket_id = $1`,
        [req.params.id, ...fields.map((k) => (String(b[k] ?? '').trim() || null))]);
      if (!r.rowCount) throw notFound();
      return loadCard(c, req.params.id, req.claims.role);
    });
    res.json(out);
  } catch (e) { next(e); }
});

const qty = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Unprocessable('The quantity is a number, zero or more');
  return n;
};

jobcards.post('/tickets/:id/job-card/items', async (req, res, next) => {
  try {
    requireEditor(req);
    const { description, unit } = req.body || {};
    if (!String(description || '').trim() || !String(unit || '').trim()) throw new Unprocessable('Give the item and its unit');
    const q = qty(req.body.qty_estimated);
    const out = await scoped(req, async (c) => {
      const jc = await c.query(`SELECT 1 FROM job_card WHERE ticket_id=$1`, [req.params.id]);
      if (!jc.rowCount) throw notFound();
      return (await c.query(
        `INSERT INTO job_card_item (ticket_id, seq, description, unit, qty_estimated)
         VALUES ($1, 0, $2, $3, $4) RETURNING id, seq, description, unit, qty_estimated::float8 AS qty_estimated, added_at`,
        [req.params.id, String(description).trim(), String(unit).trim(), q])).rows[0];
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

jobcards.put('/tickets/:id/job-card/items/:item', async (req, res, next) => {
  try {
    requireEditor(req);
    const b = req.body || {};
    const sets = [], vals = [];
    if ('description' in b) { vals.push(String(b.description || '').trim()); sets.push(`description = $${vals.length + 2}`); }
    if ('unit' in b) { vals.push(String(b.unit || '').trim()); sets.push(`unit = $${vals.length + 2}`); }
    if ('qty_estimated' in b) { vals.push(qty(b.qty_estimated)); sets.push(`qty_estimated = $${vals.length + 2}`); }
    if (!sets.length) throw new Unprocessable('Nothing to change');
    if (!String(b.reason || '').trim()) throw new Unprocessable('Give the reason for changing a work item');
    const out = await scoped(req, async (c) => {
      await withReason(c, b.reason);
      const r = await c.query(
        `UPDATE job_card_item SET ${sets.join(', ')} WHERE ticket_id = $1 AND id = $2
         RETURNING id, seq, description, unit, qty_estimated::float8 AS qty_estimated`, [req.params.id, req.params.item, ...vals]);
      if (!r.rowCount) throw notFound();
      return r.rows[0];
    });
    res.json(out);
  } catch (e) { next(e); }
});

jobcards.post('/tickets/:id/job-card/items/:item/withdraw', async (req, res, next) => {
  try {
    requireEditor(req);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw new Unprocessable('Give the reason for withdrawing the item');
    const out = await scoped(req, async (c) => {
      const r = await c.query(
        `UPDATE job_card_item SET withdrawal_reason = $3 WHERE ticket_id = $1 AND id = $2
         RETURNING id, seq, withdrawn_at, withdrawal_reason`, [req.params.id, req.params.item, reason]);
      if (!r.rowCount) throw notFound();
      return r.rows[0];
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* Every change, newest first, with its reason — for everyone who reads the card. */
jobcards.get('/tickets/:id/job-card/history', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => {
      const jc = await c.query(`SELECT 1 FROM job_card WHERE ticket_id=$1`, [req.params.id]);
      if (!jc.rowCount) return null;
      const q = `SELECT l.occurred_at, l.event_type, l.actor_role, l.before_value, l.after_value, l.reason,
                a.person_name AS actor_name
           FROM audit_log l LEFT JOIN actor_ref a ON a.actor_id = l.actor_id
          WHERE l.entity_type = 'job_card' AND l.entity_id = $1
          ORDER BY l.id DESC`;
      // the supervisor reads the card (2026-10-16) but no officer's record:
      // the card's own log, by role, never by name (the audit log is closed to him)
      if (req.claims.role === 'CONTRACTOR_SUPERVISOR') {
        return (await withSystem(maintPool, (s) => s.query(q, [req.params.id]))).rows.map(({ actor_name, ...r }) => r);
      }
      return (await c.query(q, [req.params.id])).rows;
    });
    if (!out) throw notFound();
    res.json(out);
  } catch (e) { next(e); }
});

/* The job cards the caller may read: open work by default, all with open=false. */
jobcards.get('/job-cards', async (req, res, next) => {
  try {
    const open = req.query.open !== 'false';
    const q = String(req.query.q || '').trim() || null;
    const out = await scoped(req, (c) => c.query(
      `SELECT jc.ticket_id, jc.jc_no, jc.prepared_at, jc.updated_at,
              (jc.scope_of_work IS NOT NULL) AS has_scope,
              (SELECT count(*) FROM job_card_item i WHERE i.ticket_id = jc.ticket_id AND i.withdrawn_at IS NULL) AS items,
              x.ticket_no, x.state, x.identifier, x.sub_category, x.contractor_name, x.supervisor_name,
              x.assigned_at, x.completion_deadline_at, x.is_emergency
         FROM job_card jc
         JOIN (${TICKET}) x ON x.id = jc.ticket_id
        WHERE ($1::boolean IS FALSE OR x.state NOT IN ('CLOSED','REJECTED'))
          AND ($2::text IS NULL OR x.ticket_no ILIKE '%'||$2||'%' OR x.identifier ILIKE '%'||$2||'%'
               OR x.contractor_name ILIKE '%'||$2||'%')
        ORDER BY x.is_emergency DESC, jc.prepared_at DESC
        LIMIT 300`, [open, q]));
    res.json({ items: out.rows, total: out.rowCount });
  } catch (e) { next(e); }
});

jobcards.use((err, req, res, _next) => {
  const mapped = mapDbError(err);
  const status = err.status || mapped?.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({
    title: status === 403 ? 'Not permitted' : status === 404 ? 'Not found' : status === 422 ? 'Cannot do that' : 'Error',
    status, detail: err.status ? err.message : (mapped?.detail || 'Unexpected error') });
});
