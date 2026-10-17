import { maintPool, withSystem } from './db.js';

/* ------------------------------------------------------------------ *
 * Archive sweep
 *
 * A closed ticket leaves the working views after a configurable period.
 * The row is never moved and never deleted: the premises file is the
 * long-term asset of the system, and an archived ticket stays fully
 * retrievable through search. Archiving is about what an officer is shown
 * by default, not about what the department keeps.
 * ------------------------------------------------------------------ */
export async function runArchiveSweep({ quiet = false, batch = 2000 } = {}) {
  return withSystem(maintPool, async (c) => {
    const days = Number((await c.query(
      `SELECT value FROM maint_config WHERE key='archive_after_days'`)).rows[0]?.value ?? 30);

    const r = await c.query(`
      UPDATE ticket SET archived_at = now()
       WHERE id IN (
         SELECT id FROM ticket
          WHERE archived_at IS NULL
            AND state IN ('CLOSED','REJECTED')
            AND closed_at < now() - ($1 || ' days')::interval
          ORDER BY closed_at
          LIMIT $2)
      RETURNING id`, [days, batch]);

    const remaining = Number((await c.query(
      `SELECT count(*) n FROM ticket
        WHERE archived_at IS NULL AND state IN ('CLOSED','REJECTED')
          AND closed_at < now() - ($1 || ' days')::interval`, [days])).rows[0].n);

    const summary = { archived: r.rowCount, still_to_archive: remaining,
      archive_after_days: days };
    if (!quiet) console.log('[archive-sweep]', JSON.stringify(summary));
    return summary;
  });
}

/* ------------------------------------------------------------------ *
 * Search
 *
 * Covers EVERY ticket, archived or not. Scope is applied by row-level
 * security, so a filter can narrow the result but never widen it: a
 * Jayant officer searching with no filters still sees only Jayant.
 * ------------------------------------------------------------------ */
export function buildSearch(f = {}) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };

  // archived rows are INCLUDED by default: the point of search is the
  // full record, not the working view
  if (f.archived === 'open') where.push('t.archived_at IS NULL');
  if (f.archived === 'archived') where.push('t.archived_at IS NOT NULL');

  if (f.q) {
    // "leak" should find "leaking" and "leakage": every word as a prefix
    // (user's finding, 2026-10-07); the complaint number also as typed
    const words = String(f.q).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const parts = [];
    params.push(f.q); parts.push(`t.search_vector @@ plainto_tsquery('simple', $${params.length})`);
    if (words.length) {
      params.push(words.map((w) => `${w}:*`).join(' & '));
      parts.push(`t.search_vector @@ to_tsquery('simple', $${params.length})`);
    }
    params.push(f.q); parts.push(`t.ticket_no ILIKE '%' || $${params.length} || '%'`);
    where.push(`(${parts.join(' OR ')})`);
  }
  if (f.premises_id)      add('t.premises_id = ?', f.premises_id);
  if (f.identifier)       add('p.identifier ILIKE ?', `%${f.identifier}%`);
  if (f.area_id)          add('t.area_id = ?', f.area_id);
  if (f.colony_id)        add('p.colony_id = ?', f.colony_id);
  if (f.premises_type)    add('p.premises_type = ?::premises_type', f.premises_type);
  if (f.quarter_type)     add('p.quarter_type = ?', f.quarter_type);
  if (f.sub_category_id)  add('t.sub_category_id = ?', f.sub_category_id);
  if (f.category_code)    add('cat.code = ?', f.category_code);
  if (f.ticket_no)        add('t.ticket_no ILIKE ?', `%${f.ticket_no}%`);
  if (f.contract_id)      add('t.contract_id = ?', f.contract_id);
  if (f.supervisor_id)    add('t.assigned_to = ?', f.supervisor_id);
  if (f.raised_from)      add('t.raised_at >= ?', f.raised_from);
  if (f.raised_to)        add('t.raised_at <= ?', f.raised_to);
  if (f.closed_from)      add('t.closed_at >= ?', f.closed_from);
  if (f.closed_to)        add('t.closed_at <= ?', f.closed_to);
  if (f.min_escalation)   add('t.escalation_level >= ?', Number(f.min_escalation));
  if (f.min_rating)       add('fb.rating >= ?', Number(f.min_rating));
  if (f.max_rating)       add('fb.rating <= ?', Number(f.max_rating));

  if (f.state) {
    const states = Array.isArray(f.state) ? f.state : String(f.state).split(',');
    add('t.state = ANY(?::ticket_state[])', states);
  }
  if (f.is_emergency === 'true')  where.push('t.is_emergency');
  if (f.is_emergency === 'false') where.push('NOT t.is_emergency');
  if (f.overdue === 'true') where.push(
    `t.completion_deadline_at < now() AND t.state NOT IN ('CLOSED','REJECTED')`);
  if (f.missed_sla === 'true')  where.push('t.completion_met IS FALSE');
  if (f.had_objection === 'true') where.push('t.objection_count > 0');
  if (f.was_reopened === 'true')  where.push('t.reopened_count > 0');
  if (f.had_rework === 'true')    where.push('t.rework_count > 0');
  // the measurements' approval (2026-10-16): approved, or still in the chain
  if (f.mb === 'approved') where.push(`EXISTS (SELECT 1 FROM job_sheet js WHERE js.ticket_id = t.id AND js.kind = 'MEASUREMENTS' AND js.stage = 'APPROVED')`);
  if (f.mb === 'pending')  where.push(`EXISTS (SELECT 1 FROM job_sheet js WHERE js.ticket_id = t.id AND js.kind = 'MEASUREMENTS' AND js.stage <> 'APPROVED') AND t.inspected_at IS NOT NULL`);

  const sortable = {
    raised_at: 't.raised_at', closed_at: 't.closed_at',
    ticket_no: 't.ticket_no', escalation_level: 't.escalation_level',
    premises: 'p.identifier'
  };
  const order = sortable[f.sort] || 't.raised_at';
  const dir = f.dir === 'asc' ? 'ASC' : 'DESC';

  const limit = Math.min(Number(f.page_size) || 50, 200);
  const offset = ((Number(f.page) || 1) - 1) * limit;
  params.push(limit, offset);

  const sql = `
    SELECT t.id, t.ticket_no, t.state::text, t.is_emergency, t.raised_at,
           t.closed_at, t.archived_at, t.escalation_level, t.objection_count,
           t.reopened_count, t.rework_count, t.completion_met,
           t.workmen_assigned, p.identifier, p.quarter_type, p.premises_type::text,
           s.name_en AS sub_category, cat.name_en AS category,
           fb.rating, ct.contractor_name, t.contract_id,
           mbk.mb_no, (SELECT array_agg(DISTINCT l.page ORDER BY l.page) FROM mb_line l WHERE l.ticket_id = t.id) AS mb_pages,
           (SELECT js.stage::text FROM job_sheet js WHERE js.ticket_id = t.id AND js.kind = 'MEASUREMENTS') AS mb_stage,
           count(*) OVER () AS total_matches
      FROM ticket t
      JOIN premises_ref p  ON p.premises_id = t.premises_id
      JOIN sub_category s  ON s.id = t.sub_category_id
      JOIN category cat    ON cat.id = s.category_id
      LEFT JOIN ticket_feedback fb ON fb.ticket_id = t.id
      LEFT JOIN contract ct ON ct.id = t.contract_id
      LEFT JOIN mb_book mbk ON mbk.contract_id = t.contract_id AND EXISTS (SELECT 1 FROM mb_line l WHERE l.ticket_id = t.id)
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${order} ${dir} NULLS LAST
     LIMIT $${params.length - 1} OFFSET $${params.length}`;
  return { sql, params };
}

/* Configurable dashboard: the department decides which measures appear
   and where a figure turns from normal to warning to critical. */
export async function buildDashboard(client, role) {
  const cards = (await client.query(
    `SELECT key, label_en, label_hi, warn_above, critical_above
       FROM dashboard_card WHERE role = $1 AND active
      ORDER BY display_order`, [role])).rows;

  const openOnly = (await client.query(
    `SELECT value FROM maint_config WHERE key='gm_dashboard_open_only'`)
  ).rows[0]?.value === 'true';
  // Live work only. Archived tickets are reached through search, which is
  // what keeps this query bounded as years of history accumulate.
  const live = openOnly ? 'AND archived_at IS NULL' : '';

  const MEASURES = {
    open_complaints: `SELECT count(*) n FROM ticket
                       WHERE state NOT IN ('CLOSED','REJECTED') ${live}`,
    to_verify:       `SELECT count(*) n FROM ticket WHERE state='RAISED' ${live}`,
    to_assign:       `SELECT count(*) n FROM ticket WHERE state='VERIFIED' ${live}`,
    awaiting_inspection: `SELECT count(*) n FROM ticket
                           WHERE state='WORK_COMPLETED' ${live}`,
    overdue:         `SELECT count(*) n FROM ticket
                       WHERE completion_deadline_at < now()
                         AND state NOT IN ('CLOSED','REJECTED') ${live}`,
    escalated_l3:    `SELECT count(*) n FROM ticket WHERE escalation_level >= 3
                         AND state NOT IN ('CLOSED','REJECTED') ${live}`,
    escalated_l4:    `SELECT count(*) n FROM ticket WHERE escalation_level >= 4
                         AND state NOT IN ('CLOSED','REJECTED') ${live}`,
    special_repair:  `SELECT count(*) n FROM ticket
                       WHERE state='REFERRED_SPECIAL_REPAIR' ${live}`,
    open_objections: `SELECT count(*) n FROM ticket_objection
                       WHERE responded_at IS NULL`,
    inspection_backlog_hours:
      `SELECT coalesce(round(max(extract(epoch FROM now()-completed_claim_at)/3600)),0) n
         FROM ticket WHERE state='WORK_COMPLETED' ${live}`
  };

  const out = [];
  for (const card of cards) {
    const sql = MEASURES[card.key];
    if (!sql) continue;
    const value = Number((await client.query(sql)).rows[0].n);
    const severity = card.critical_above !== null && value > Number(card.critical_above)
      ? 'critical'
      : card.warn_above !== null && value > Number(card.warn_above) ? 'warning' : 'normal';
    out.push({ key: card.key, label_en: card.label_en, label_hi: card.label_hi,
      value, severity });
  }
  return { role, open_only: openOnly, cards: out };
}
