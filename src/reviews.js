import express from 'express';
import { maintPool, withScope, withSystem, mapDbError, Forbidden, Conflict, Unprocessable } from './db.js';
import { requireAuth } from './auth.js';
import { notify } from './notify.js';
import { REVIEWS } from './maintenance.js';

/**
 * Disputes the department must decide (user's findings, 2026-10-07).
 *
 * A rejection the occupant contests, once: the Overseer or Incharge
 * reinstates it or upholds the rejection; upheld, the Area Civil Staff
 * Officer must decide in writing. A complaint reopened for the third time
 * is referred to the Staff Officer by the database itself. After a Staff
 * Officer's decision the occupant can neither contest nor reopen that
 * complaint; further disputes go on paper to the Area Civil Office.
 * Every rule is the database's (ticket_review_guard, ticket_review_gate);
 * this file moves the complaint as the decision says and tells people.
 */
export const reviews = express.Router();
reviews.use(requireAuth);

const scoped = (req, fn) => withScope(maintPool, req.claims, fn);
const notFound = () => Object.assign(new Error('Not found'), { status: 404 });
const OFFICERS = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE'];
const FINAL_NOTE = 'This complaint has been decided by the Area Civil Staff Officer. ' +
  'Further disputes are not taken in the portal; you may write to the Area Civil Office.';

async function event(c, req, ticketId, from, to, type, reason) {
  await c.query(
    `INSERT INTO ticket_event (ticket_id, from_state, to_state, event_type, actor_id, actor_role, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ticketId, from, to, type, req.claims.actor_id, req.claims.role, reason]);
}

async function tell(ticketId, roles, en, occupant) {
  const t = (await withSystem(maintPool, (c) => c.query(
    `SELECT t.ticket_no, t.premises_id, t.scope_path::text AS scope, p.identifier
       FROM ticket t JOIN premises_ref p ON p.premises_id = t.premises_id WHERE t.id = $1`, [ticketId]))).rows[0];
  if (!t) return;
  for (const role of roles) {
    await notify({ role, scope: t.scope, event: 'DISPUTE', en: [`${t.ticket_no} — ${en}`, t.identifier], hi: [t.ticket_no, t.identifier] });
  }
  if (occupant) {
    await notify({ premisesId: t.premises_id, event: 'DISPUTE', en: [occupant, t.ticket_no], hi: [occupant, t.ticket_no] });
  }
}

/* The occupant contests a rejection — once. */
reviews.post('/tickets/:id/contest', async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    const out = await scoped(req, async (c) => {
      const t = (await c.query(`SELECT id, state FROM ticket WHERE id = $1`, [req.params.id])).rows[0];
      if (!t) throw notFound();
      if (!['RESIDENT', 'CUSTODIAN'].includes(req.claims.role)) throw new Forbidden('Only the occupant may contest a rejection');
      const prior = (await c.query(`SELECT so_outcome FROM ticket_review WHERE ticket_id = $1 AND kind = 'REJECTION_CONTEST'`, [t.id])).rows[0];
      if (prior || (await c.query(`SELECT ticket_final_decision($1) f`, [t.id])).rows[0].f) {
        throw new Conflict(prior?.so_outcome ? FINAL_NOTE : 'This rejection has already been contested. Further disputes are not taken in the portal; you may write to the Area Civil Office.');
      }
      if (t.state !== 'REJECTED') throw new Conflict('Only a rejected complaint can be contested');
      if (!reason) throw new Unprocessable('Say why the rejection is wrong');
      const r = (await c.query(
        `INSERT INTO ticket_review (ticket_id, kind, stage, raised_reason, area_id, scope_path)
         SELECT $1, 'REJECTION_CONTEST', 'WITH_OFFICERS', $2, area_id, scope_path FROM ticket WHERE id = $1
         RETURNING id`, [t.id, reason])).rows[0];
      return (await c.query(`${REVIEWS} WHERE r.id = $1`, [r.id])).rows[0];
    });
    await tell(req.params.id, OFFICERS, 'rejection contested by the occupant');
    res.status(201).json(out);
  } catch (e) { next(e); }
});

reviews.get('/tickets/:id/reviews', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => {
      if (['CONTRACTOR', 'CONTRACTOR_SUPERVISOR'].includes(req.claims.role)) return null;
      const t = await c.query(`SELECT 1 FROM ticket WHERE id = $1`, [req.params.id]);
      if (!t.rowCount) return null;
      return (await c.query(`${REVIEWS} WHERE r.ticket_id = $1 ORDER BY r.raised_at`, [req.params.id])).rows;
    });
    if (!out) throw notFound();
    res.json(out);
  } catch (e) { next(e); }
});

/* Waiting for the caller: the Overseer and Incharge review contests; the
   Staff Officer decides what reaches them. */
reviews.get('/reviews', async (req, res, next) => {
  try {
    const stage = OFFICERS.includes(req.claims.role) ? 'WITH_OFFICERS'
      : req.claims.role === 'STAFF_OFFICER_CIVIL' ? 'WITH_STAFF_OFFICER' : null;
    const pending = req.query.pending !== 'false';
    if (pending && !stage) return res.json([]);
    const out = await scoped(req, (c) => c.query(
      `SELECT x.*, t.ticket_no, t.state, p.identifier, s.name_en AS sub_category
         FROM (${REVIEWS}) x
         JOIN ticket t ON t.id = x.ticket_id
         JOIN premises_ref p ON p.premises_id = t.premises_id
         JOIN sub_category s ON s.id = t.sub_category_id
        WHERE ($1::text IS NULL OR x.stage = $1)
        ORDER BY x.raised_at`, [pending ? stage : null]));
    res.json(out.rows);
  } catch (e) { next(e); }
});

async function loadReview(c, id) {
  const r = (await c.query(`SELECT r.*, t.state FROM ticket_review r JOIN ticket t ON t.id = r.ticket_id WHERE r.id = $1`, [id])).rows[0];
  if (!r) throw notFound();
  return r;
}

/* The Overseer or Incharge on a contested rejection. */
reviews.post('/reviews/:id/officer', async (req, res, next) => {
  try {
    const { outcome } = req.body || {};
    const note = String(req.body?.note || '').trim();
    const out = await scoped(req, async (c) => {
      const r = await loadReview(c, req.params.id);
      if (!OFFICERS.includes(req.claims.role)) throw new Forbidden('A contested rejection is reviewed first by the Overseer or the Civil Incharge');
      if (r.stage !== 'WITH_OFFICERS') throw new Conflict('This dispute is no longer with the Overseer and Incharge');
      if (!['REINSTATE', 'UPHOLD'].includes(outcome)) throw new Unprocessable('Choose to reinstate the complaint or uphold the rejection');
      if (!note) throw new Unprocessable('Write a note — the occupant sees it');
      await c.query(`UPDATE ticket_review SET officer_outcome = $2, officer_note = $3 WHERE id = $1`, [r.id, outcome, note]);
      if (outcome === 'REINSTATE') {
        await c.query(`UPDATE ticket SET state = 'RAISED' WHERE id = $1`, [r.ticket_id]);
        await event(c, req, r.ticket_id, 'REJECTED', 'RAISED', 'REINSTATED', note);
      }
      return (await c.query(`${REVIEWS} WHERE r.id = $1`, [r.id])).rows[0];
    });
    if (outcome === 'UPHOLD') await tell(out.ticket_id, ['STAFF_OFFICER_CIVIL'], 'rejection contested and upheld — your decision is needed', 'Your contest has gone to the Area Civil Staff Officer');
    else await tell(out.ticket_id, ['CIVIL_OVERSEER'], 'reinstated on review — verify it', 'Your complaint has been reinstated');
    res.json(out);
  } catch (e) { next(e); }
});

/* The Staff Officer's written decision — final in the portal. */
reviews.post('/reviews/:id/decide', async (req, res, next) => {
  try {
    const { outcome } = req.body || {};
    const decision = String(req.body?.decision || '').trim();
    const out = await scoped(req, async (c) => {
      const r = await loadReview(c, req.params.id);
      if (req.claims.role !== 'STAFF_OFFICER_CIVIL') throw new Forbidden('This dispute is for the Area Civil Staff Officer to decide');
      if (r.stage !== 'WITH_STAFF_OFFICER') throw new Conflict(r.stage === 'DECIDED' ? 'This dispute has been decided' : 'This dispute has not reached the Staff Officer');
      const allowed = r.kind === 'REJECTION_CONTEST' ? ['REINSTATE', 'UPHOLD'] : ['REWORK', 'CLOSE', 'SPECIAL_REPAIR'];
      if (!allowed.includes(outcome)) throw new Unprocessable(`Choose one of: ${allowed.join(', ')}`);
      if (!decision) throw new Unprocessable('A written decision is required');
      await c.query(`UPDATE ticket_review SET so_outcome = $2, so_decision = $3 WHERE id = $1`, [r.id, outcome, decision]);
      const move = { REINSTATE: ['REJECTED', 'RAISED', 'REINSTATED'], CLOSE: ['REOPENED', 'CLOSED', 'CLOSED'],
        SPECIAL_REPAIR: ['REOPENED', 'REFERRED_SPECIAL_REPAIR', 'REFERRED_SPECIAL_REPAIR'] }[outcome];
      if (move) {
        if (r.state !== move[0]) throw new Conflict(`The complaint is ${r.state.toLowerCase()}, not ${move[0].toLowerCase()}`);
        await c.query(`UPDATE ticket SET state = $2 ${move[1] === 'CLOSED' ? ', closed_at = now()' : ''} WHERE id = $1`, [r.ticket_id, move[1]]);
        await event(c, req, r.ticket_id, move[0], move[1], move[2], decision);
      }
      return (await c.query(`${REVIEWS} WHERE r.id = $1`, [r.id])).rows[0];
    });
    await tell(out.ticket_id, OFFICERS, `Staff Officer has decided: ${outcome.toLowerCase().replace('_', ' ')}`,
      'The Area Civil Staff Officer has decided your complaint — see the decision');
    res.json(out);
  } catch (e) { next(e); }
});

reviews.use((err, req, res, _next) => {
  const mapped = mapDbError(err);
  const status = err.status || mapped?.status || (err.code === '22P02' ? 404 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({
    title: status === 403 ? 'Not permitted' : status === 404 ? 'Not found' : status === 409 ? 'Conflict' : status === 422 ? 'Cannot do that' : 'Error',
    status, detail: err.status ? err.message : (mapped?.detail || (status === 404 ? 'Not found' : 'Unexpected error')) });
});
