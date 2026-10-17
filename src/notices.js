import express from 'express';
import { maintPool, withScope, Forbidden, Conflict, Unprocessable } from './db.js';
import { requireAuth } from './auth.js';

/* Colony notices (V2 blueprint R4, experiment branch 2026-10-13).
   One notice for a colony-wide fault ("water to Block B off until 4 pm")
   saves twenty identical complaints. Who may read, post and end is the
   database's decision (policies notice_*, trigger colony_notice_guard);
   these routes only shape the request. A notice is never edited or
   deleted: it is ended with a reason, and the database logs both. */

export const notices = express.Router();
notices.use(requireAuth);

const scoped = (req, fn) => withScope(maintPool, req.claims, fn);
const notFound = () => Object.assign(new Error('Not found'), { status: 404 });
const POSTERS = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE'];
const OFFICERS = [...POSTERS, 'STAFF_OFFICER_CIVIL', 'GM_CIVIL', 'HQ_EXECUTIVE', 'ADMINISTRATOR'];
// who posted is shown as a role: occupants read no officer's record
const COLS = `n.id, n.colony_id, n.title, n.body, n.starts_at, n.ends_at, n.posted_by_role, n.posted_at,
              n.ended_at, n.end_reason`;
const LIVE = `n.ended_at IS NULL AND n.starts_at <= now() AND (n.ends_at IS NULL OR n.ends_at > now())`;

notices.get('/notices', async (req, res, next) => {
  try {
    // officers may ask for ended ones too; residents see only what is live
    const all = req.query.all === 'true' && OFFICERS.includes(req.claims.role);
    const out = await scoped(req, (c) => c.query(
      `SELECT ${COLS} FROM colony_notice n ${all ? '' : `WHERE ${LIVE}`} ORDER BY n.posted_at DESC LIMIT 100`));
    res.json({ items: out.rows, total: out.rowCount });
  } catch (e) { next(e); }
});

notices.post('/notices', async (req, res, next) => {
  try {
    if (!POSTERS.includes(req.claims.role)) throw new Forbidden('Only the Civil Overseer or Incharge posts a colony notice');
    const { colony_id, title, body = '', ends_at = null } = req.body || {};
    if (!title || !String(title).trim()) throw new Unprocessable('A title is required');
    if (String(title).trim().length > 120) throw new Unprocessable('The title is at most 120 characters');
    if (String(body).length > 600) throw new Unprocessable('The notice is at most 600 characters');
    if (ends_at && Number.isNaN(Date.parse(ends_at))) throw new Unprocessable('ends_at must be a date and time');
    const n = await scoped(req, async (c) => {
      // the colony must lie inside the caller's own scope; anywhere else is not found (control 3)
      const col = await c.query(
        `SELECT area_id, scope_path FROM premises_ref
          WHERE colony_id = $1 AND scope_path <@ current_scope() LIMIT 1`, [colony_id]);
      if (!col.rowCount) throw notFound();
      const r = await c.query(
        `INSERT INTO colony_notice (area_id, colony_id, scope_path, title, body, ends_at, posted_by, posted_by_role)
         VALUES ($1, $2, $3, $4, $5, $6, current_actor(), current_role_name())
         RETURNING id`,
        [col.rows[0].area_id, colony_id, col.rows[0].scope_path, String(title).trim(), String(body), ends_at]);
      return (await c.query(`SELECT ${COLS} FROM colony_notice n WHERE n.id = $1`, [r.rows[0].id])).rows[0];
    });
    res.status(201).json(n);
  } catch (e) { next(e); }
});

notices.post('/notices/:id/end', async (req, res, next) => {
  try {
    if (!POSTERS.includes(req.claims.role)) throw new Forbidden('Only the Civil Overseer or Incharge ends a colony notice');
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw new Unprocessable('A reason is required to end a notice');
    const n = await scoped(req, async (c) => {
      const cur = await c.query(`SELECT ended_at FROM colony_notice WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!cur.rowCount) throw notFound();
      if (cur.rows[0].ended_at) throw new Conflict('This notice has already ended');
      const r = await c.query(
        `UPDATE colony_notice SET ended_at = now(), ended_by = current_actor(), end_reason = $2
          WHERE id = $1 RETURNING id`, [req.params.id, reason]);
      if (!r.rowCount) throw notFound();
      return (await c.query(`SELECT ${COLS} FROM colony_notice n WHERE n.id = $1`, [req.params.id])).rows[0];
    });
    res.json(n);
  } catch (e) { next(e); }
});
