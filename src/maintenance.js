import express from 'express';
import crypto from 'node:crypto';
import { maintPool, withScope, withSystem, mustAffect, mapDbError,
         Forbidden, Conflict, Unprocessable } from './db.js';
import { requireAuth } from './auth.js';
import { notify } from './notify.js';
import { buildSearch, buildDashboard } from './archive.js';
import { driver, objectKey, extensionFor, verifyUpload, purgeExpiredBytes,
         storageLimits } from './storage.js';

export const api = express.Router();
api.use(requireAuth);

const scoped = (req, fn) => withScope(maintPool, req.claims, fn);

/* Actions the CALLING role may take on a ticket in its current state.
   Read from the same table the database enforces, so the UI can never
   offer a button the database will refuse. */
async function availableActions(c, role, state) {
  const r = await c.query(
    `SELECT to_state FROM ticket_transition
      WHERE from_state = $1 AND allowed_role = $2`, [state, role]);
  const map = {
    VERIFIED: 'verify', REJECTED: 'reject', ASSIGNED: 'assign',
    IN_PROGRESS: 'start', WORK_COMPLETED: 'complete',
    INSPECTED_ACCEPTED: 'inspect', REWORK: 'send-back', CLOSED: 'close',
    REOPENED: 'reopen', REFERRED_SPECIAL_REPAIR: 'refer-special-repair'
  };
  // a reopened complaint is closed or referred only through the Staff
  // Officer's written decision on it (ticket_review_gate), never by a button
  const viaDecision = state === 'REOPENED' ? ['close', 'refer-special-repair'] : [];
  return r.rows.map((x) => map[x.to_state]).filter((a) => a && !viaDecision.includes(a));
}

async function loadTicket(c, id, role) {
  const r = await c.query(
    `SELECT t.*, s.name_en AS sub_category, cat.name_en AS category,
            p.identifier, p.quarter_type, p.colony_id,
            (t.state IN ('ASSIGNED','IN_PROGRESS','REWORK','WORK_COMPLETED') AND assignee_role_ended(t.assigned_to)) AS assignee_role_ended
       FROM ticket t
       JOIN sub_category s ON s.id = t.sub_category_id
       JOIN category cat ON cat.id = s.category_id
       JOIN premises_ref p ON p.premises_id = t.premises_id
      WHERE t.id = $1`, [id]);
  if (!r.rowCount) return null;                    // invisible and absent are the same
  const t = r.rows[0];
  delete t.search_vector;                          // the search index is the server's own
  t.available_actions = await availableActions(c, role, t.state);
  // disputes the department must decide (2026-10-07); row security hides
  // them from contractors, so they simply come back empty there
  t.reviews = (await c.query(`${REVIEWS} WHERE r.ticket_id = $1 ORDER BY r.raised_at`, [id])).rows;
  t.escalation_path = (await c.query(
    `SELECT r.level, r.notify_role AS role,
            CASE WHEN t.completion_deadline_at IS NULL THEN NULL
                 ELSE t.completion_deadline_at + r.minutes_after_breach * interval '1 minute' END AS due_at,
            e.reached_at, (e.reached_at IS NOT NULL OR r.level <= t.escalation_level) AS reached
       FROM ticket t
       JOIN escalation_rule r ON r.is_emergency = t.is_emergency
       LEFT JOIN LATERAL (SELECT min(triggered_at) AS reached_at FROM escalation_event
                           WHERE ticket_id = t.id AND level = r.level) e ON true
      WHERE t.id = $1 ORDER BY r.level`, [id])).rows;
  t.final_decision = t.reviews.some((x) => x.so_outcome);
  // waiting for the Staff Officer: nobody may reassign it until the decision
  if (t.reviews.some((x) => x.kind === 'REPEAT_DISPUTE' && x.so_outcome !== 'REWORK')) {
    t.available_actions = t.available_actions.filter((a) => a !== 'assign');
  }
  // which photographs the screens must ask for (optional until HQ requires them, 2026-10-12)
  const pr = (await c.query(`SELECT photo_setting('completion_photos_required') AS c, photo_setting('inspection_photo_required') AS i`)).rows[0];
  t.photo_rules = { completion_photos_required: pr.c, inspection_photo_required: pr.i };
  t.breach_unattributed = !!(await c.query(
    `SELECT 1 FROM sla_breach WHERE ticket_id = $1 AND attribution IS NULL`, [id])).rowCount;
  // a complaint that reached the GM closes only after the Staff Officer's remark
  t.l4_remark_needed = t.escalation_level >= 4 && t.state !== 'CLOSED' && !(await c.query(
    `SELECT 1 FROM escalation_event WHERE ticket_id = $1 AND level = 4 AND remark IS NOT NULL`, [id])).rowCount;
  t.can_contest = ['RESIDENT', 'CUSTODIAN'].includes(role) && t.state === 'REJECTED'
    && !t.reviews.some((x) => x.kind === 'REJECTION_CONTEST');
  if (t.final_decision) {
    t.final_note = 'This complaint has been decided by the Area Civil Staff Officer. Further disputes are not taken in the portal; you may write to the Area Civil Office.';
  }
  return t;
}

export const REVIEWS = `
  SELECT r.id, r.ticket_id, r.kind, r.stage, r.raised_at, r.raised_reason,
         r.officer_outcome, r.officer_note, ob.person_name AS officer_by_name, r.officer_role AS officer_by_role, r.officer_at,
         r.so_outcome, r.so_decision, sb.person_name AS so_by_name,
         CASE WHEN r.so_at IS NOT NULL THEN 'STAFF_OFFICER_CIVIL' END AS so_by_role, r.so_at
    FROM ticket_review r
    LEFT JOIN actor_ref ob ON ob.actor_id = r.officer_by
    LEFT JOIN actor_ref sb ON sb.actor_id = r.so_by`;

/* When a reopening has just referred the complaint to the Staff Officer,
   tell the Staff Officer, the Overseer and the Incharge. */
export async function notifyReferral(ticketId) {
  const r = await withSystem(maintPool, (c) => c.query(
    `SELECT t.ticket_no, t.scope_path::text AS scope, p.identifier
       FROM ticket_review rv JOIN ticket t ON t.id = rv.ticket_id
       JOIN premises_ref p ON p.premises_id = t.premises_id
      WHERE rv.ticket_id = $1 AND rv.kind = 'REPEAT_DISPUTE' AND rv.stage = 'WITH_STAFF_OFFICER'
        AND rv.raised_at > now() - interval '1 minute'`, [ticketId]));
  if (!r.rowCount) return;
  const { ticket_no, scope, identifier } = r.rows[0];
  for (const role of ['STAFF_OFFICER_CIVIL', 'MAINTENANCE_INCHARGE', 'CIVIL_OVERSEER']) {
    await notify({ role, scope, event: 'REFERRED_TO_STAFF_OFFICER',
      en: [`${ticket_no} reopened again — Staff Officer to decide`, `${identifier}: the occupant has reopened it repeatedly`],
      hi: [`${ticket_no} — स्टाफ ऑफिसर निर्णय करें`, identifier] });
  }
}

/* ---------------------------- read ---------------------------- */

api.get('/masters/categories', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT s.id, s.name_en, s.name_hi, s.emergency_eligible, s.classification,
              cat.name_en AS category
         FROM sub_category s JOIN category cat ON cat.id = s.category_id
        WHERE s.active ORDER BY cat.display_order, s.display_order`));
    res.json(out.rows);
  } catch (e) { next(e); }
});

api.get('/tickets', async (req, res, next) => {
  try {
    // No area or premises filter is accepted. Visibility is RLS's decision.
    const out = await scoped(req, async (c) => {
      const r = await c.query(
        `SELECT t.id, t.ticket_no, t.state, t.is_emergency, t.raised_at,
                t.completion_deadline_at, t.escalation_level, t.objection_count,
                t.workmen_assigned, t.inspection_priority,
                p.identifier, p.premises_type::text AS premises_type,
                s.name_en AS sub_category, cat.name_en AS category,
                t.response_deadline_at, t.sla_completion_minutes,
                t.contractor_minutes, t.contractor_window_started_at,
                -- when each step happened, and the contractor's own verdict: the
                -- Completed tabs and the phones' status lines (2026-10-15)
                t.verified_at, t.assigned_at, t.started_at, t.completed_claim_at,
                t.inspected_at, t.closed_at, t.completion_met,
                -- who holds the job: the firm's Jobs page names and filters by supervisor (2026-10-16)
                t.assigned_to,
                (pz.id IS NOT NULL) AS paused,
                pz.attribution::text AS pause_attribution, pz.paused_at AS paused_since,
                (t.state IN ('ASSIGNED','IN_PROGRESS','REWORK','WORK_COMPLETED') AND assignee_role_ended(t.assigned_to)) AS assignee_role_ended,
                -- the decisions an SLA breach waits on (queue tile, 2026-10-12)
                EXISTS (SELECT 1 FROM sla_breach b WHERE b.ticket_id = t.id AND b.attribution IS NULL) AS breach_unattributed,
                (t.escalation_level >= 4 AND t.state <> 'CLOSED' AND NOT EXISTS (
                  SELECT 1 FROM escalation_event e WHERE e.ticket_id = t.id AND e.level = 4 AND e.remark IS NOT NULL)) AS l4_remark_needed,
                (t.completion_deadline_at IS NOT NULL
                 AND t.completion_deadline_at < now()
                 AND t.state NOT IN ('CLOSED','REJECTED')) AS overdue
           FROM ticket t
           JOIN sub_category s ON s.id = t.sub_category_id
           JOIN category cat ON cat.id = s.category_id
           JOIN premises_ref p ON p.premises_id = t.premises_id
           -- the open pause, if any: whose clock is stopped, and why (V2, O2)
           LEFT JOIN LATERAL (
             SELECT sp.id, sp.attribution, sp.paused_at FROM sla_pause sp
              WHERE sp.ticket_id = t.id AND sp.resumed_at IS NULL
              ORDER BY sp.paused_at DESC LIMIT 1) pz ON true
          WHERE t.archived_at IS NULL
          ORDER BY t.raised_at DESC LIMIT 100`);
      for (const row of r.rows) {
        row.available_actions = await availableActions(c, req.claims.role, row.state);
      }
      return r.rows;
    });
    res.json({ items: out, total: out.length });
  } catch (e) { next(e); }
});

api.get('/tickets/:id', async (req, res, next) => {
  try {
    const t = await scoped(req, async (c) => {
      const t = await loadTicket(c, req.params.id, req.claims.role);
      if (!t) return null;
      t.history = (await c.query(
        `SELECT event_type, from_state, to_state, actor_role, reason, via, occurred_at
           FROM ticket_event WHERE ticket_id=$1 ORDER BY occurred_at`, [t.id])).rows;
      t.objections = (await c.query(
        `SELECT id, note, raised_at, responded_at, response_note
           FROM ticket_objection WHERE ticket_id=$1 ORDER BY raised_at`, [t.id])).rows;
      t.media = (await c.query(
        `SELECT id, purpose, latitude::float8 AS latitude, longitude::float8 AS longitude, gps_accuracy_m::float8 AS gps_accuracy_m, captured_at
           FROM ticket_media WHERE ticket_id=$1 AND upload_state = 'STORED' ORDER BY uploaded_at`, [t.id])).rows;
      return t;
    });
    if (!t) return res.status(404).json({ title: 'Not found', status: 404 });
    res.json(t);
  } catch (e) { next(e); }
});

api.get('/inspections/queue', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      // Every ordering term is departmental. See FRS 5.4 / decision 18.
      `SELECT t.id, t.ticket_no, t.is_emergency, t.inspection_priority,
              t.inspection_priority_note, t.inspection_rank, t.verified_at,
              t.completed_claim_at, t.objection_count, t.workmen_assigned,
              p.identifier, p.quarter_type, p.premises_type,
              s.name_en AS sub_category,
              round(extract(epoch FROM now()-t.completed_claim_at)/3600)::int AS waiting_hours
         FROM ticket t
         JOIN sub_category s ON s.id = t.sub_category_id
         JOIN premises_ref p ON p.premises_id = t.premises_id
        WHERE t.state='WORK_COMPLETED' AND t.archived_at IS NULL
        ORDER BY t.is_emergency DESC, t.inspection_priority NULLS LAST,
                 t.inspection_rank, t.verified_at`));
    const oldest = out.rows.reduce((m, r) => Math.max(m, Number(r.waiting_hours) || 0), 0);
    res.json({ items: out.rows, total: out.rows.length, oldest_pending_hours: oldest });
  } catch (e) { next(e); }
});

/* Cards, thresholds and ordering come from dashboard_card, so the
   department can change what an officer sees without a release. Live work
   only: archived tickets are reached through search. */
api.get('/dashboard', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => buildDashboard(c, req.claims.role));
    // kept for the existing screens, which read these directly
    const legacy = await scoped(req, async (c) => {
      const q = async (sql) => Number((await c.query(sql)).rows[0].n);
      return {
        to_verify: await q(`SELECT count(*) n FROM ticket
                             WHERE state='RAISED' AND archived_at IS NULL`),
        to_assign: await q(`SELECT count(*) n FROM ticket
                             WHERE state='VERIFIED' AND archived_at IS NULL`),
        to_inspect: await q(`SELECT count(*) n FROM ticket
                              WHERE state='WORK_COMPLETED' AND archived_at IS NULL`),
        overdue: await q(`SELECT count(*) n FROM ticket
                           WHERE completion_deadline_at < now()
                             AND state NOT IN ('CLOSED','REJECTED')
                             AND archived_at IS NULL`),
        open_objections: await q(`SELECT count(*) n FROM ticket_objection
                                   WHERE responded_at IS NULL`)
      };
    });
    res.json({ ...out, ...legacy });
  } catch (e) { next(e); }
});

/* Search — the full record, archived included, with the filters the
   department asked for. Scope is applied by row-level security, so a
   filter can narrow the result and never widen it. */
api.get('/search', async (req, res, next) => {
  try {
    const { sql, params } = buildSearch(req.query);
    const out = await scoped(req, (c) => c.query(sql, params));
    const total = out.rows.length ? Number(out.rows[0].total_matches) : 0;
    res.json({
      items: out.rows.map(({ total_matches, ...r }) => r),
      total,
      page: Number(req.query.page) || 1,
      page_size: Math.min(Number(req.query.page_size) || 50, 200),
      filters_applied: Object.keys(req.query).filter((k) =>
        !['page','page_size','sort','dir'].includes(k))
    });
  } catch (e) { next(e); }
});

/* CSV downloads (user's decisions, 2026-10-16): the contractor firm downloads
   its own jobs; the department downloads the complaints it may see — from the
   Inbox (this list) and from Search. Row security decides every row, so a
   filter narrows and never widens. Residents and supervisors are not given it. */
const CSV_LIST = ['CONTRACTOR', 'CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL', 'GM_CIVIL', 'HQ_EXECUTIVE', 'ADMINISTRATOR'];
const CSV_SEARCH = CSV_LIST.filter((r) => r !== 'CONTRACTOR');
const csvEsc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const IST = (col) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')`;
const sendCsv = (res, name, cols, rows) => {
  res.set('content-type', 'text/csv; charset=utf-8');
  res.set('content-disposition', `attachment; filename="${name}"`);
  res.send([cols.map(([, h]) => csvEsc(h)).join(','), ...rows.map((r) => cols.map(([k]) => csvEsc(r[k])).join(','))].join('\n') + '\n');
};
const TICKET_CSV = [['ticket_no', 'Complaint'], ['area', 'Area'], ['identifier', 'Quarter / building'], ['category', 'Category'],
  ['sub_category', 'Fault'], ['emergency', 'Emergency'], ['state', 'State'], ['contract', 'Work order'], ['firm', 'Contractor'],
  ['supervisor', 'Supervisor'], ['raised', 'Raised'], ['verified', 'Verified'], ['assigned', 'Assigned'], ['started', 'Started'],
  ['claimed', 'Claimed done'], ['inspected', 'Inspected'], ['closed', 'Closed'], ['sla_hours', 'SLA (hours)'],
  ['contractor_hours', "Contractor's time (hours)"], ['within_time', "Within the contractor's time"],
  ['rework_count', 'Sent back'], ['reopened_count', 'Reopened']];
const TICKET_CSV_SELECT = `
  SELECT t.ticket_no, split_part(t.ticket_no, '/', 1) AS area, p.identifier, cat.name_en AS category, s.name_en AS sub_category,
         CASE WHEN t.is_emergency THEN 'Yes' ELSE '' END AS emergency, t.state::text AS state,
         ct.agreement_no AS contract, ct.contractor_name AS firm, sup.person_name AS supervisor,
         ${IST('t.raised_at')} AS raised, ${IST('t.verified_at')} AS verified, ${IST('t.assigned_at')} AS assigned,
         ${IST('t.started_at')} AS started, ${IST('t.completed_claim_at')} AS claimed, ${IST('t.inspected_at')} AS inspected,
         ${IST('t.closed_at')} AS closed, round(t.sla_completion_minutes / 60.0, 1) AS sla_hours,
         round(t.contractor_minutes / 60.0, 1) AS contractor_hours,
         CASE t.completion_met WHEN true THEN 'Yes' WHEN false THEN 'No' END AS within_time,
         t.rework_count, t.reopened_count
    FROM ticket t
    JOIN premises_ref p ON p.premises_id = t.premises_id
    JOIN sub_category s ON s.id = t.sub_category_id
    JOIN category cat ON cat.id = s.category_id
    LEFT JOIN contract ct ON ct.id = t.contract_id
    LEFT JOIN actor_ref sup ON sup.actor_id = t.assigned_to`;

api.get('/tickets.csv', async (req, res, next) => {
  try {
    if (!CSV_LIST.includes(req.claims.role)) throw new Forbidden('This download is for the department and the contractor firm');
    const where = [], params = [];
    if (req.query.state) { params.push(String(req.query.state).split(',')); where.push(`t.state = ANY($${params.length}::ticket_state[])`); }
    if (req.query.contract_id) { params.push(req.query.contract_id); where.push(`t.contract_id = $${params.length}`); }
    if (req.query.supervisor_id) { params.push(req.query.supervisor_id); where.push(`t.assigned_to = $${params.length}`); }
    const out = await scoped(req, (c) => c.query(
      `${TICKET_CSV_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.raised_at DESC LIMIT 20000`, params));
    sendCsv(res, 'complaints.csv', TICKET_CSV, out.rows);
  } catch (e) { next(e); }
});

api.get('/search.csv', async (req, res, next) => {
  try {
    if (!CSV_SEARCH.includes(req.claims.role)) throw new Forbidden('This download is for the department');
    // the same filters as Search, every match (up to 20,000), the full record
    const { sql, params } = buildSearch({ ...req.query, page: 1, page_size: 200 });
    const ids = await scoped(req, async (c) => {
      const q = sql.replace(/LIMIT \$\d+ OFFSET \$\d+\s*$/, 'LIMIT 20000');
      const found = (await c.query(q, params.slice(0, -2))).rows.map((r) => r.id);
      return (await c.query(`${TICKET_CSV_SELECT} WHERE t.id = ANY($1::uuid[]) ORDER BY t.raised_at DESC`, [found])).rows;
    });
    sendCsv(res, 'search.csv', TICKET_CSV, ids);
  } catch (e) { next(e); }
});

/* What can be filtered on, so a client need not hard-code the list. */
api.get('/search/filters', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => ({
      categories: (await c.query(
        `SELECT cat.code, cat.name_en, cat.name_hi,
                json_agg(json_build_object('id', s.id, 'name_en', s.name_en)
                         ORDER BY s.display_order) AS sub_categories
           FROM category cat JOIN sub_category s ON s.category_id = cat.id
          WHERE cat.active GROUP BY cat.code, cat.name_en, cat.name_hi,
                cat.display_order ORDER BY cat.display_order`)).rows,
      states: (await c.query(
        `SELECT unnest(enum_range(NULL::ticket_state))::text AS state`)).rows
          .map((r) => r.state),
      quarter_types: ['A','B','C','D','MQ'],
      premises_types: (await c.query(
        `SELECT DISTINCT premises_type::text FROM premises_ref
          ORDER BY 1`)).rows.map((r) => r.premises_type),
      flags: ['is_emergency','overdue','missed_sla','had_objection',
              'was_reopened','had_rework'],
      archived: ['all','open','archived'],
      sort: ['raised_at','closed_at','ticket_no','escalation_level','premises']
    }));
    res.json(out);
  } catch (e) { next(e); }
});

api.get('/notifications', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => {
      const rows = await c.query(
        `SELECT id, event_type, title_en, body_en, title_hi, body_hi,
                created_at, (read_at IS NOT NULL) AS read, ticket_id
           FROM notification ORDER BY created_at DESC LIMIT 50`);
      const unread = await c.query(
        `SELECT count(*) n FROM notification WHERE read_at IS NULL`);
      return { items: rows.rows, unread_count: Number(unread.rows[0].n) };
    });
    res.json(out);
  } catch (e) { next(e); }
});

api.post('/notifications/read', async (req, res, next) => {
  try {
    await scoped(req, (c) => c.query(
      `UPDATE notification SET read_at = now() WHERE read_at IS NULL`));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------------------- write ---------------------------- */

api.post('/tickets', async (req, res, next) => {
  try {
    const { sub_category_id, description, is_emergency = false } = req.body;
    const premisesId = req.body.premises_id || req.claims.premises_id;
    if (!premisesId) throw new Unprocessable('No quarter or building is bound to this role');

    const out = await scoped(req, async (c) => {
      const sc = await c.query(
        `SELECT emergency_eligible, classification FROM sub_category WHERE id=$1`,
        [sub_category_id]);
      if (!sc.rowCount) throw new Unprocessable('Unknown sub-category');
      if (sc.rows[0].classification === 'EM') {
        throw new Unprocessable('Electrical complaints are handled by the E&M Department');
      }
      // Emergency is a property of the category, never a free choice.
      if (is_emergency && !sc.rows[0].emergency_eligible) {
        throw new Unprocessable('This complaint type cannot be reported as an emergency');
      }
      const dup = await c.query(
        `SELECT id, ticket_no FROM ticket
          WHERE premises_id=$1 AND sub_category_id=$2
            AND state IN ('RAISED','VERIFIED','ASSIGNED','IN_PROGRESS','REWORK')`,
        [premisesId, sub_category_id]);
      if (dup.rowCount) throw new Conflict(
        `An open complaint already exists: ${dup.rows[0].ticket_no}`);

      const p = await c.query(
        `SELECT area_id, area_code, scope_path, inspection_rank
           FROM premises_ref WHERE premises_id=$1`, [premisesId]);
      if (!p.rowCount) throw new Forbidden('Premises not visible to you');
      const pr = p.rows[0];

      // Number allocated inside this transaction, so a rollback consumes none.
      // The code comes from the Area master: they are not uniform in length
      // and not always the first three letters of the name.
      const area = pr.area_code;
      const yr = new Date().getFullYear();
      await c.query(
        `INSERT INTO ticket_sequence (area_code, year) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`, [area, yr]);
      const seq = await c.query(
        `UPDATE ticket_sequence SET last_value = last_value + 1
          WHERE area_code=$1 AND year=$2 RETURNING last_value`, [area, yr]);
      const ticketNo = `${area}/${yr}/${String(seq.rows[0].last_value).padStart(5, '0')}`;

      const t = await c.query(
        `INSERT INTO ticket (ticket_no, premises_id, area_id, scope_path, inspection_rank,
                             sub_category_id, description, is_emergency, raised_by, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'RAISED') RETURNING *`,
        [ticketNo, premisesId, pr.area_id, pr.scope_path, pr.inspection_rank,
         sub_category_id, description || null, is_emergency, req.claims.actor_id]);
      await logEvent(c, t.rows[0].id, req, null, 'RAISED', 'RAISED');
      const { search_vector, ...raised } = t.rows[0];   // the search index is the server's own
      return raised;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

/* Who hears about a state change. In-app is written for every recipient
   regardless of push, so nothing is lost to a disabled permission. */
const TRANSITION_NOTICE = {
  VERIFIED:  { occupant: ['Your complaint has been checked',
                          'It has been accepted and passed to the Area office.'],
               occupant_hi: ['आपकी शिकायत जाँची गई',
                             'यह स्वीकार कर क्षेत्रीय कार्यालय भेजी गई है।'] },
  REJECTED:  { occupant: ['Your complaint was not accepted', ''],
               occupant_hi: ['आपकी शिकायत स्वीकार नहीं हुई', ''] },
  ASSIGNED:  { occupant: ['Work has been given to the contractor', ''],
               occupant_hi: ['कार्य ठेकेदार को सौंपा गया', ''],
               role: 'CONTRACTOR_SUPERVISOR' },
  IN_PROGRESS: { occupant: ['Work has started at your quarter', ''],
                 occupant_hi: ['आपके क्वार्टर पर कार्य शुरू', ''] },
  WORK_COMPLETED: { occupant: ['The contractor says the work is done',
                               'The Overseer will inspect it.'],
                    occupant_hi: ['ठेकेदार ने कार्य पूर्ण बताया',
                                  'पर्यवेक्षक निरीक्षण करेंगे।'],
                    role: 'CIVIL_OVERSEER' },
  CLOSED:    { occupant: ['Your complaint is closed',
                          'If it is still not fixed, you can reopen it today.'],
               occupant_hi: ['आपकी शिकायत बंद की गई',
                             'यदि अब भी ठीक नहीं है तो आज ही पुनः खोल सकते हैं।'] },
  REWORK:    { occupant: ['The work was sent back', 'The Overseer did not accept it.'],
               occupant_hi: ['कार्य वापस भेजा गया', 'पर्यवेक्षक ने स्वीकार नहीं किया।'],
               role: 'CONTRACTOR_SUPERVISOR' },
  REOPENED:  { role: 'CIVIL_OVERSEER' }
};

async function notifyTransition(ticket, to, req) {
  const n = TRANSITION_NOTICE[to];
  if (!n || !ticket) return;
  if (n.occupant) {
    await notify({ premisesId: ticket.premises_id, event: to,
      en: [n.occupant[0], n.occupant[1] || ticket.ticket_no],
      hi: [n.occupant_hi[0], n.occupant_hi[1] || ticket.ticket_no] });
  }
  if (n.role) {
    await notify({ role: n.role, scope: ticket.scope_path, event: to,
      en: [`${ticket.ticket_no} — ${to.toLowerCase().replace(/_/g,' ')}`,
           `${ticket.identifier}`],
      hi: [`${ticket.ticket_no}`, `${ticket.identifier}`] });
  }
}

async function logEvent(c, ticketId, req, from, to, type, reason = null) {
  await c.query(
    `INSERT INTO ticket_event (ticket_id, from_state, to_state, event_type,
                               actor_id, actor_role, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ticketId, from, to, type, req.claims.actor_id, req.claims.role, reason]);
}

/** One handler shape for every lifecycle action. */
function transition({ to, type, extraSql = '', extraParams = () => [], before, after }) {
  return async (req, res, next) => {
    try {
      const out = await scoped(req, async (c) => {
        // the row is held while it moves, so two requests cannot both move it
        const cur = await c.query(`SELECT state FROM ticket WHERE id=$1 FOR UPDATE`, [req.params.id]);
        if (!cur.rowCount) throw new Forbidden('Ticket not visible to you');
        const from = cur.rows[0].state;
        if (from === to && to !== 'ASSIGNED') throw new Conflict(`The complaint is already ${from.toLowerCase().replace(/_/g, ' ')}`);
        if (before) await before(c, req, from);
        const params = [to, ...extraParams(req), req.params.id];
        const r = await c.query(
          `UPDATE ticket SET state = $1 ${extraSql}
            WHERE id = $${params.length} RETURNING id`, params);
        mustAffect(r, `Your role cannot move this complaint from ${from} to ${to}`);
        await logEvent(c, req.params.id, req, from, to, type, req.body?.reason ?? null);
        return loadTicket(c, req.params.id, req.claims.role);
      });
      await notifyTransition(out, to, req);
      if (after) await after(req);
      res.json(out);
    } catch (e) { next(e); }
  };
}

// The SLA snapshot is applied by a database trigger from sla_rule, not sent
// by this handler. No API caller can influence the deadline they are judged
// against, and ticket_field_authority assigns those columns to no human role.
api.post('/tickets/:id/verify', transition({
  to: 'VERIFIED', type: 'VERIFIED',
  extraSql: `, verified_at = now(), verified_by = $2`,
  extraParams: (req) => [req.claims.actor_id]
}));

api.post('/tickets/:id/reject', transition({
  to: 'REJECTED', type: 'REJECTED',
  before: (c, req) => {
    if (!req.body?.reason) throw new Unprocessable('A reason is required, and the resident sees it');
  }
}));

api.post('/tickets/:id/assign', transition({
  to: 'ASSIGNED', type: 'ASSIGNED',
  extraSql: `, assigned_at = now(), assigned_to = $2`,
  extraParams: (req) => [req.body.supervisor_id],
  before: async (c, req) => {
    const d = await c.query(
      `SELECT 1 FROM actor_ref WHERE actor_id=$1
        AND role='CONTRACTOR_SUPERVISOR' AND status='ACTIVE'`,
      [req.body?.supervisor_id]);
    if (!d.rowCount) throw new Unprocessable('Not an active contractor supervisor in your area');
  }
}));

api.post('/tickets/:id/start', transition({
  to: 'IN_PROGRESS', type: 'STARTED',
  extraSql: `, started_at = now(), workmen_assigned = $2`,
  extraParams: (req) => [req.body.workmen_assigned],
  before: (c, req) => {
    if (!req.body?.workmen_assigned) {
      throw new Unprocessable('Name the workmen allotted to this job');
    }
  }
}));

// The completion photograph is checked by the database (enforce_photo_gates):
// the assigned contractor's own, stored, and taken in the current round.
// It used to be checked here too, more loosely, and the looser check was
// the one that counted.
api.post('/tickets/:id/complete', transition({
  to: 'WORK_COMPLETED', type: 'COMPLETION_CLAIMED',
  extraSql: `, completed_claim_at = now()`
}));

api.post('/tickets/:id/inspect', async (req, res, next) => {
  try {
    const accepted = req.body?.accepted !== false;
    const to = accepted ? 'INSPECTED_ACCEPTED' : 'REWORK';
    const out = await scoped(req, async (c) => {
      const cur = await c.query(`SELECT state, assigned_to FROM ticket WHERE id=$1`,
        [req.params.id]);
      if (!cur.rowCount) throw new Forbidden('Ticket not visible to you');
      // The inspection photograph — in-app, geo-tagged, this Overseer's
      // own, taken after the claim — is checked by the database
      // (enforce_photo_gates), for this route and every other.

      // met/missed flags and the rework counter are derived by trigger
      const sets = accepted ? `, inspected_at = now(), inspected_by = $2` : ``;
      const params = accepted
        ? [to, req.claims.actor_id, req.params.id]
        : [to, req.params.id];
      const r = await c.query(
        `UPDATE ticket SET state=$1 ${sets} WHERE id=$${params.length} RETURNING id`, params);
      mustAffect(r, 'Only the Civil Overseer may record an inspection');
      await logEvent(c, req.params.id, req, cur.rows[0].state, to, 'INSPECTED',
        req.body?.remark ?? null);
      return loadTicket(c, req.params.id, req.claims.role);
    });
    await notifyTransition(out, to, req);
    res.json(out);
  } catch (e) { next(e); }
});

/* The Area Civil Staff Officer's remark on a complaint that reached the GM
   (level 4), without which it cannot be closed. Once, with who and when
   recorded by the database; into the complaint's history too. */
api.post('/tickets/:id/escalation-remark', async (req, res, next) => {
  try {
    if (req.claims.role !== 'STAFF_OFFICER_CIVIL') throw new Forbidden('The level-4 remark is the Area Civil Staff Officer\'s');
    const remark = String(req.body?.remark || '').trim();
    if (!remark) throw new Unprocessable('Write the remark');
    const out = await scoped(req, async (c) => {
      const e = await c.query(
        `SELECT id, remark FROM escalation_event WHERE ticket_id = $1 AND level = 4 ORDER BY triggered_at DESC LIMIT 1 FOR UPDATE`, [req.params.id]);
      if (!e.rowCount) throw new Unprocessable('This complaint has not reached level 4');
      if (e.rows[0].remark) throw new Conflict('The remark has been recorded already');
      await c.query(`UPDATE escalation_event SET remark = $1 WHERE id = $2`, [remark, e.rows[0].id]);
      await logEvent(c, req.params.id, req, null, null, 'L4_REMARK_RECORDED', remark);
      return loadTicket(c, req.params.id, req.claims.role);
    });
    res.json(out);
  } catch (e) { next(e); }
});

api.post('/tickets/:id/close', transition({
  to: 'CLOSED', type: 'CLOSED', extraSql: `, closed_at = now()`
}));

api.post('/tickets/:id/reopen', transition({
  to: 'REOPENED', type: 'REOPENED',
  after: (req) => notifyReferral(req.params.id),
  before: async (c, req, from) => {
    if (!req.body?.reason) throw new Unprocessable('Say what is still wrong');
    if ((await c.query(`SELECT ticket_final_decision($1) AS f`, [req.params.id])).rows[0]?.f) {
      throw new Conflict('This complaint has been decided by the Area Civil Staff Officer. ' +
        'Further disputes are not taken in the portal; you may write to the Area Civil Office.');
    }
    // accepted but not yet closed: the window has not started
    if (from !== 'CLOSED') return;
    // The window is short by departmental decision, so it is enforced
    // rather than assumed: a ticket reopened months later would distort
    // the contractor's record for work long since accepted.
    const r = await c.query(
      `SELECT t.closed_at,
              (SELECT value::integer FROM maint_config
                WHERE key='reopen_window_hours') AS hours
         FROM ticket t WHERE t.id = $1`, [req.params.id]);
    const { closed_at, hours } = r.rows[0] || {};
    if (closed_at && hours) {
      const elapsed = (Date.now() - new Date(closed_at).getTime()) / 36e5;
      if (elapsed > hours) throw new Conflict(
        `This complaint was closed more than ${hours} hours ago. ` +
        `Please raise a fresh complaint.`);
    }
  }
}));

/* Volume features. Without these the Incharge assigns one at a time and
   the queue never empties, and the Overseer opens a ticket per quarter on
   a walk that covers fifteen. Partial success is reported per ticket
   rather than failing the whole batch. */
api.post('/tickets/assign-bulk', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ticket_ids) ? req.body.ticket_ids : [];
    const supervisor = req.body?.supervisor_id;
    if (!ids.length) throw new Unprocessable('Select at least one complaint');
    const out = await scoped(req, async (c) => {
      // Authority first. Validating the payload before the caller's right
      // to act tells a resident their contractor choice was wrong, when
      // the truth is that they may not assign at all.
      const allowed = await c.query(
        `SELECT 1 FROM ticket_transition
          WHERE to_state='ASSIGNED' AND allowed_role=$1`, [req.claims.role]);
      if (!allowed.rowCount) throw new Forbidden('Your role cannot assign work');

      const cap = Number((await c.query(
        `SELECT value FROM maint_config WHERE key='bulk_assign_max'`)).rows[0]?.value || 200);
      if (ids.length > cap) throw new Unprocessable(`At most ${cap} at a time`);
      const d = await c.query(
        `SELECT 1 FROM actor_ref WHERE actor_id=$1
          AND role='CONTRACTOR_SUPERVISOR' AND status='ACTIVE'`, [supervisor]);
      if (!d.rowCount) throw new Unprocessable('Not an active contractor supervisor in your area');

      let assigned = 0; const failed = [];
      for (const id of ids) {
        // a savepoint per ticket, so one refusal does not abort the rest
        await c.query('SAVEPOINT item');
        try {
          const cur = await c.query(`SELECT state FROM ticket WHERE id=$1`, [id]);
          if (!cur.rowCount) { failed.push({ ticket_id: id, reason: 'not visible' }); continue; }
          const r = await c.query(
            `UPDATE ticket SET state='ASSIGNED', assigned_at=now(), assigned_to=$1
              WHERE id=$2 RETURNING id`, [supervisor, id]);
          if (!r.rowCount) { failed.push({ ticket_id: id, reason: 'not permitted' }); continue; }
          await logEvent(c, id, req, cur.rows[0].state, 'ASSIGNED', 'ASSIGNED');
          assigned++;
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT item');
          failed.push({ ticket_id: id, reason: e.message.slice(0, 120) });
        } finally {
          await c.query('RELEASE SAVEPOINT item');   // also on `continue`
        }
      }
      return { assigned, failed };
    });
    res.json(out);
  } catch (e) { next(e); }
});

api.post('/tickets/inspect-batch', async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.inspections) ? req.body.inspections : [];
    if (!items.length) throw new Unprocessable('Select at least one complaint');
    const out = await scoped(req, async (c) => {
      const allowed = await c.query(
        `SELECT 1 FROM ticket_transition
          WHERE to_state='INSPECTED_ACCEPTED' AND allowed_role=$1`, [req.claims.role]);
      if (!allowed.rowCount) throw new Forbidden('Your role cannot record an inspection');

      const cap = Number((await c.query(
        `SELECT value FROM maint_config WHERE key='batch_inspect_max'`)).rows[0]?.value || 50);
      if (items.length > cap) throw new Unprocessable(`At most ${cap} in one visit`);

      let accepted = 0; const failed = [];
      for (const item of items) {
        const id = item.ticket_id || item;
        // Batching the visit, never the evidence: each ticket still needs
        // its own photograph, which the database checks. A savepoint per
        // ticket, because one refusal otherwise aborts the transaction
        // and every ticket after it fails with it.
        await c.query('SAVEPOINT item');
        try {
          const cur = await c.query(`SELECT state FROM ticket WHERE id=$1`, [id]);
          if (!cur.rowCount) { failed.push({ ticket_id: id, reason: 'not visible' }); continue; }
          const r = await c.query(
            `UPDATE ticket SET state='INSPECTED_ACCEPTED', inspected_at=now(),
                    inspected_by=$1 WHERE id=$2 RETURNING id`,
            [req.claims.actor_id, id]);
          if (!r.rowCount) { failed.push({ ticket_id: id, reason: 'not permitted' }); continue; }
          await logEvent(c, id, req, cur.rows[0].state, 'INSPECTED_ACCEPTED', 'INSPECTED');
          accepted++;
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT item');
          failed.push({ ticket_id: id, reason: e.message.slice(0, 120) });
        } finally {
          await c.query('RELEASE SAVEPOINT item');   // also on `continue`
        }
      }
      return { accepted, failed };
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* The excluded-scope notice, with the Area contact numbers beside it.
   Public: a resident may need to read it before they have a device, and
   telling someone where else to go is not privileged information. */
export const publicMaint = express.Router();
publicMaint.get('/masters/excluded-scope', async (req, res, next) => {
  try {
    const out = await withSystem(maintPool, async (c) => ({
      sections: (await c.query(
        `SELECT heading_en, heading_hi, body_en, body_hi FROM excluded_scope
          WHERE active ORDER BY display_order`)).rows,
      area_contacts: (await c.query(
        `SELECT label_en, label_hi, phone FROM area_contact
          WHERE active ORDER BY display_order`)).rows
    }));
    res.json(out);
  } catch (e) { next(e); }
});
publicMaint.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ title: 'Error', status: 500 });
});

/* ---------------------------- administration ----------------------------
   Everything the design calls configurable needs somewhere to configure
   it. Administrator only; the database refuses the writes independently. */
api.get('/admin/config', async (req, res, next) => {
  try {
    // the Administration page's own readers; not every signed-in role
    // (a resident read it until the break-it pass, 2026-10-08)
    if (!['ADMINISTRATOR', 'MAINTENANCE_INCHARGE'].includes(req.claims.role)) throw new Forbidden('Settings are kept by the HQ System Administrator');
    const out = await scoped(req, (c) => c.query(
      `SELECT key, value, data_type, description FROM maint_config ORDER BY key`));
    res.json(out.rows);
  } catch (e) { next(e); }
});

api.put('/admin/config/:key', async (req, res, next) => {
  try {
    if (req.claims.role !== 'ADMINISTRATOR') throw new Forbidden('Administrator only');
    const out = await scoped(req, async (c) => {
      const r = await c.query(
        `UPDATE maint_config SET value=$1, updated_by=$2, updated_at=now()
          WHERE key=$3 RETURNING key, value`,
        [String(req.body.value), req.claims.actor_id, req.params.key]);
      mustAffect(r, 'No such setting');
      return r.rows[0];
    });
    res.json(out);
  } catch (e) { next(e); }
});

api.get('/admin/sla', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT s.id AS sub_category_id, s.name_en, s.name_hi, s.emergency_eligible,
              cat.name_en AS category, r.id AS rule_id,
              r.response_minutes, r.completion_minutes
         FROM sub_category s
         JOIN category cat ON cat.id = s.category_id
         LEFT JOIN sla_rule r ON r.sub_category_id = s.id AND r.premises_type IS NULL
        WHERE s.active AND s.classification='CIVIL'
        ORDER BY cat.display_order, s.display_order`));
    res.json(out.rows);
  } catch (e) { next(e); }
});

api.put('/admin/sla/:subCategoryId', async (req, res, next) => {
  try {
    // the Incharge is the job-assigning authority and may edit SLA too
    if (!['ADMINISTRATOR', 'MAINTENANCE_INCHARGE'].includes(req.claims.role)) {
      throw new Forbidden('Administrator or Maintenance Incharge only');
    }
    const { response_minutes, completion_minutes } = req.body;
    const out = await scoped(req, async (c) => {
      const prev = await c.query(
        `SELECT response_minutes, completion_minutes FROM sla_rule
          WHERE sub_category_id=$1 AND premises_type IS NULL`, [req.params.subCategoryId]);
      // prospective only: a new row with effective_from now, leaving every
      // already-verified ticket on the SLA it was given
      const r = await c.query(
        `UPDATE sla_rule SET response_minutes=$1, completion_minutes=$2,
                previous_response_minutes=$3, previous_completion_minutes=$4,
                effective_from=now(), changed_by=$5
          WHERE sub_category_id=$6 AND premises_type IS NULL
          RETURNING sub_category_id, response_minutes, completion_minutes`,
        [response_minutes, completion_minutes,
         prev.rows[0]?.response_minutes ?? null,
         prev.rows[0]?.completion_minutes ?? null,
         req.claims.actor_id, req.params.subCategoryId]);
      mustAffect(r, 'No such SLA rule');
      await c.query(
        `INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id,
             actor_role, before_value, after_value)
         VALUES ('SLA_CHANGED','sub_category',$1,$2,$3,$4,$5)`,
        [req.params.subCategoryId, req.claims.actor_id, req.claims.role,
         JSON.stringify(prev.rows[0] || {}),
         JSON.stringify({ response_minutes, completion_minutes })]);
      return r.rows[0];
    });
    res.json(out);
  } catch (e) { next(e); }
});

api.get('/admin/dashboard-cards', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT id, role, key, label_en, label_hi, display_order,
              warn_above, critical_above, active
         FROM dashboard_card ORDER BY role, display_order`));
    res.json(out.rows);
  } catch (e) { next(e); }
});

api.put('/admin/dashboard-cards/:id', async (req, res, next) => {
  try {
    if (req.claims.role !== 'ADMINISTRATOR') throw new Forbidden('Administrator only');
    const out = await scoped(req, async (c) => {
      const r = await c.query(
        `UPDATE dashboard_card
            SET warn_above=$1, critical_above=$2, active=$3, display_order=$4
          WHERE id=$5 RETURNING id, key, active`,
        [req.body.warn_above ?? null, req.body.critical_above ?? null,
         req.body.active !== false, req.body.display_order ?? 1, req.params.id]);
      mustAffect(r, 'No such card');
      return r.rows[0];
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* ---- A1: the SLA clock ----------------------------------------------
   Only a departmental officer may pause. The contractor can ask, but a
   contractor able to stop the clock they are measured against would make
   the whole SLA regime decorative. The database refuses it too. */
api.post('/tickets/:id/pause', async (req, res, next) => {
  try {
    const { clock = 'COMPLETION', attribution, reason } = req.body || {};
    if (!['OCCUPANT', 'FORCE_MAJEURE'].includes(attribution)) {
      throw new Unprocessable(
        'Only a locked premises or force majeure stops the clock. Want of ' +
        'material and want of labour are the contractor\'s obligation.');
    }
    if (!reason) throw new Unprocessable('A reason is required');
    const out = await scoped(req, async (c) => {
      const t = await c.query(`SELECT state FROM ticket WHERE id=$1`, [req.params.id]);
      if (!t.rowCount) throw new Forbidden('Ticket not visible to you');
      if (['CLOSED','REJECTED'].includes(t.rows[0].state)) {
        throw new Conflict('That complaint is finished');
      }
      const open = await c.query(
        `SELECT 1 FROM sla_pause WHERE ticket_id=$1 AND clock=$2 AND resumed_at IS NULL`,
        [req.params.id, clock]);
      if (open.rowCount) throw new Conflict('That clock is already paused');
      const r = await c.query(
        `INSERT INTO sla_pause (ticket_id, clock, attribution, reason,
             paused_by, paused_by_role)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, clock, attribution, paused_at`,
        [req.params.id, clock, attribution, reason,
         req.claims.actor_id, req.claims.role]);
      await logEvent(c, req.params.id, req, null, null, `CLOCK_PAUSED_${clock}`, reason);
      return r.rows[0];
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

api.post('/tickets/:id/resume', async (req, res, next) => {
  try {
    const clock = req.body?.clock || 'COMPLETION';
    const out = await scoped(req, async (c) => {
      // Resuming pushes the deadline forward by the paused interval. The
      // original deadline set at verification is left untouched, so both
      // "late against the promise" and "late allowing for access refusals"
      // stay reportable.
      const r = await c.query(
        `UPDATE sla_pause SET resumed_at = now(), resumed_by = $1
          WHERE ticket_id = $2 AND clock = $3 AND resumed_at IS NULL
          RETURNING id, paused_at, resumed_at`,
        [req.claims.actor_id, req.params.id, clock]);
      mustAffect(r, 'No paused clock to resume, or not permitted');
      const t = await c.query(
        `SELECT completion_deadline_at, original_completion_deadline_at,
                total_paused_minutes FROM ticket WHERE id=$1`, [req.params.id]);
      await logEvent(c, req.params.id, req, null, null, `CLOCK_RESUMED_${clock}`);
      return { ...r.rows[0], ...t.rows[0] };
    });
    res.json(out);
  } catch (e) { next(e); }
});

api.get('/tickets/:id/pauses', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT id, clock, attribution, reason, paused_at, resumed_at, paused_by_role
         FROM sla_pause WHERE ticket_id=$1 ORDER BY paused_at`, [req.params.id]));
    res.json(out.rows);
  } catch (e) { next(e); }
});

/* ---- A2: delay attribution ------------------------------------------
   Without this every breach reads as unattributed, and a performance
   report that cannot say whose delay it was becomes an argument rather
   than evidence. */
api.get('/breaches', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT b.id, b.ticket_id, b.clock, b.breached_at, b.attribution, b.note,
              t.ticket_no, p.identifier, s.name_en AS sub_category,
              round(extract(epoch FROM now() - b.breached_at)/3600) AS hours_since
         FROM sla_breach b
         JOIN ticket t ON t.id = b.ticket_id
         JOIN premises_ref p ON p.premises_id = t.premises_id
         JOIN sub_category s ON s.id = t.sub_category_id
        WHERE ($1::boolean IS NOT TRUE OR b.attribution IS NULL)
        ORDER BY b.breached_at DESC LIMIT 200`,
      [req.query.unattributed === 'true']));
    res.json({ items: out.rows, total: out.rows.length });
  } catch (e) { next(e); }
});

api.post('/breaches/:id/attribute', async (req, res, next) => {
  try {
    const { attribution, note } = req.body || {};
    const ALLOWED = ['CONTRACTOR','DEPARTMENT','OCCUPANT','FORCE_MAJEURE'];
    if (!ALLOWED.includes(attribution)) {
      throw new Unprocessable(`Attribution must be one of ${ALLOWED.join(', ')}`);
    }
    // The contractor is the party this decides against, so they do not get
    // to make it. Neither does the resident.
    if (!['CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL','ADMINISTRATOR']
          .includes(req.claims.role)) {
      throw new Forbidden('Only a departmental officer may attribute a delay');
    }
    const out = await scoped(req, async (c) => {
      const r = await c.query(
        `UPDATE sla_breach SET attribution=$1, note=$2,
                attributed_by=$3, attributed_at=now()
          WHERE id=$4 RETURNING id, ticket_id, clock, attribution`,
        [attribution, note ?? null, req.claims.actor_id, req.params.id]);
      mustAffect(r, 'No such breach, or not visible to you');
      // the audit entry is written by the database (sla_breach_audit), so a
      // write by any other route is logged too
      return r.rows[0];
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* ---- A3: answering an objection -------------------------------------- */
api.get('/objections', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT o.id, o.ticket_id, o.note, o.raised_at, o.response_deadline_at,
              o.responded_at, o.response_note, t.ticket_no, p.identifier,
              (o.responded_at IS NULL AND o.response_deadline_at < now()) AS overdue
         FROM ticket_objection o
         JOIN ticket t ON t.id = o.ticket_id
         JOIN premises_ref p ON p.premises_id = t.premises_id
        WHERE ($1::boolean IS NOT TRUE OR o.responded_at IS NULL)
        ORDER BY o.response_deadline_at`, [req.query.open === 'true']));
    res.json({ items: out.rows, total: out.rows.length });
  } catch (e) { next(e); }
});

api.post('/objections/:id/respond', async (req, res, next) => {
  try {
    if (!req.body?.response_note) throw new Unprocessable('A response is required');
    if (!['CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL']
          .includes(req.claims.role)) {
      throw new Forbidden('Only a departmental officer may answer an objection');
    }
    const out = await scoped(req, async (c) => {
      const r = await c.query(
        `UPDATE ticket_objection
            SET responded_by=$1, responded_at=now(), response_note=$2
          WHERE id=$3 AND responded_at IS NULL
          RETURNING id, ticket_id, response_note, responded_at`,
        [req.claims.actor_id, req.body.response_note, req.params.id]);
      mustAffect(r, 'No such objection, already answered, or not visible to you');
      return r.rows[0];
    });
    // the occupant who raised it hears back; that is the point of raising it
    const t = await withSystem(maintPool, (c) => c.query(
      `SELECT premises_id FROM ticket WHERE id=$1`, [out.ticket_id]));
    if (t.rowCount) {
      await notify({ premisesId: t.rows[0].premises_id, event: 'OBJECTION_ANSWERED',
        en: ['Your objection has been answered', req.body.response_note],
        hi: ['आपकी आपत्ति का उत्तर दिया गया', req.body.response_note] });
    }
    res.json(out);
  } catch (e) { next(e); }
});

/* ---- A4: referral out of the maintenance contract -------------------- */
api.post('/tickets/:id/refer-special-repair', transition({
  to: 'REFERRED_SPECIAL_REPAIR', type: 'REFERRED_SPECIAL_REPAIR',
  extraSql: `, referred_special_repair = true`,
  before: (c, req) => {
    if (!req.body?.reason) {
      throw new Unprocessable(
        'Say why this is beyond the maintenance contract; the Staff Officer sees it');
    }
  }
}));

api.put('/tickets/:id/inspection-priority', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => {
      const r = await c.query(
        `UPDATE ticket SET inspection_priority=$1, inspection_priority_note=$2
          WHERE id=$3 RETURNING id`,
        [req.body.priority ?? null, req.body.note ?? null, req.params.id]);
      mustAffect(r, 'Only the Overseer or Incharge may set inspection priority');
      return { ok: true };
    });
    res.json(out);
  } catch (e) { next(e); }
});

api.post('/tickets/:id/objections', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => {
      const t = await c.query(`SELECT state FROM ticket WHERE id=$1`, [req.params.id]);
      if (!t.rowCount) throw new Forbidden('Ticket not visible to you');
      if (t.rows[0].state !== 'IN_PROGRESS') {
        throw new Conflict('Objections can be raised only while work is under way');
      }
      const o = await c.query(
        `INSERT INTO ticket_objection (ticket_id, raised_by, note, response_deadline_at)
         VALUES ($1,$2,$3, now() + interval '24 hours') RETURNING *`,
        [req.params.id, req.claims.actor_id, req.body.note]);
      return o.rows[0];
    });
    const t = await scoped(req, (c) => c.query(
      `SELECT t.ticket_no, t.scope_path, p.identifier FROM ticket t
         JOIN premises_ref p ON p.premises_id = t.premises_id WHERE t.id=$1`,
      [req.params.id]));
    if (t.rowCount) {
      for (const role of ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE']) {
        await notify({ role, scope: t.rows[0].scope_path, event: 'OBJECTION_RAISED',
          en: [`Objection at ${t.rows[0].identifier}`,
               `${t.rows[0].ticket_no} — answer within 24 hours`],
          hi: [`${t.rows[0].identifier} पर आपत्ति`,
               `${t.rows[0].ticket_no} — 24 घंटे में उत्तर दें`] });
      }
    }
    res.status(201).json(out);
  } catch (e) { next(e); }
});

/* ---------------------------- photographs ----------------------------
   Two steps. The bytes never pass through this server: the client asks
   for a pre-signed URL, PUTs the image straight to object storage, then
   confirms. The confirm step is where integrity is established, because
   it is the only moment the server can compare what was claimed against
   what actually arrived. */
api.post('/media/upload-url', async (req, res, next) => {
  try {
    const { ticket_id, purpose, content_type = 'image/jpeg' } = req.body;
    if (!['COMPLAINT','BEFORE','COMPLETION','INSPECTION','OBJECTION'].includes(purpose)) {
      throw new Unprocessable('Unknown photograph purpose');
    }
    // Which role's act each photograph records. The database enforces the
    // same (media_purpose_authority); this gives the plainer refusal.
    const TAKEN_BY = {
      BEFORE: ['CONTRACTOR_SUPERVISOR'],
      COMPLETION: ['CONTRACTOR_SUPERVISOR'],
      INSPECTION: ['CIVIL_OVERSEER'],
      OBJECTION: ['RESIDENT', 'CUSTODIAN'],
      COMPLAINT: ['RESIDENT', 'CUSTODIAN', 'CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE']
    };
    if (!TAKEN_BY[purpose].includes(req.claims.role)) {
      throw new Forbidden(`A ${purpose.toLowerCase()} photograph is not yours to take`);
    }
    const ext = extensionFor(content_type);
    const out = await scoped(req, async (c) => {
      const t = await c.query(
        `SELECT t.id, t.premises_id, p.area_code FROM ticket t
           JOIN premises_ref p ON p.premises_id = t.premises_id
          WHERE t.id = $1`, [ticket_id]);
      if (!t.rowCount) throw new Forbidden('Ticket not visible to you');

      const mediaId = crypto.randomUUID();
      const key = objectKey({ areaCode: t.rows[0].area_code,
        premisesId: t.rows[0].premises_id, ticketId: ticket_id, purpose,
        mediaId, ext });

      // The row is created PENDING. Nothing in the lifecycle accepts it
      // until the bytes have arrived and been checked.
      const r = await c.query(
        `INSERT INTO ticket_media (id, ticket_id, purpose, storage_key, content_hash,
             captured_at, uploaded_by, purge_after, upload_state)
         VALUES ($1,$2,$3,$4,'', now(), $5,
                 now() + ((SELECT value FROM maint_config
                            WHERE key='media_retention_years') || ' years')::interval,
                 'PENDING')
         RETURNING id`,
        [mediaId, ticket_id, purpose, key, req.claims.actor_id]);
      return { media_id: r.rows[0].id, key };
    });
    const url = await driver.presignPut(out.key, content_type);
    res.json({ media_id: out.media_id, upload_url: url,
      expires_in: storageLimits.URL_TTL_SECONDS,
      max_bytes: storageLimits.MAX_BYTES });
  } catch (e) { next(e); }
});

api.post('/media/:id/confirm', async (req, res, next) => {
  try {
    const { captured_at, content_hash, capture_verified = false,
            latitude, longitude, gps_accuracy_m, content_type = 'image/jpeg' } = req.body;
    const out = await scoped(req, async (c) => {
      const m = await c.query(
        `SELECT id, storage_key, purpose, upload_state FROM ticket_media
          WHERE id = $1 AND uploaded_by = $2`, [req.params.id, req.claims.actor_id]);
      if (!m.rowCount) throw new Forbidden('Not your upload');
      if (m.rows[0].upload_state === 'STORED') throw new Conflict('Already confirmed');

      // Every photograph records where it was taken (user's decision,
      // 2026-10-12; before, only the inspection photograph had to). Refused
      // before the bytes are checked, and the upload marked failed.
      const located = Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))
        && latitude !== null && longitude !== null && latitude !== '' && longitude !== '';
      if (!located) {
        await c.query(`UPDATE ticket_media SET upload_state='FAILED' WHERE id=$1`, [req.params.id]);
        throw new Unprocessable('A photograph must record where it was taken. Allow the location and wait for it before taking the photograph.');
      }
      // An inspection photograph must have been taken in the app, at the
      // premises. This is the control the entire inspection gate rests on.
      if (m.rows[0].purpose === 'INSPECTION') {
        if (!capture_verified || latitude === undefined || longitude === undefined) {
          await c.query(`UPDATE ticket_media SET upload_state='FAILED' WHERE id=$1`,
            [req.params.id]);
          throw new Unprocessable(
            'An inspection photograph must be taken in the app at the premises');
        }
      }

      let checked;
      try {
        checked = await verifyUpload({ key: m.rows[0].storage_key,
          claimedHash: content_hash, contentType: content_type });
      } catch (e) {
        await c.query(`UPDATE ticket_media SET upload_state='FAILED' WHERE id=$1`,
          [req.params.id]);
        throw e;
      }

      const r = await c.query(
        `UPDATE ticket_media
            SET upload_state='STORED', content_hash=$1, size_bytes=$2,
                captured_at=$3, latitude=$4, longitude=$5, gps_accuracy_m=$6,
                capture_verified=$7
          WHERE id=$8 RETURNING id, purpose, size_bytes, capture_verified`,
        [checked.hash, checked.size, captured_at || new Date(),
         latitude ?? null, longitude ?? null, gps_accuracy_m ?? null,
         capture_verified, req.params.id]);
      return r.rows[0];
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* Serve a stored photograph. Scoped: an officer sees the images of
   tickets they can see, and nothing else. */
api.get('/media/:id/image', async (req, res, next) => {
  try {
    const m = await scoped(req, (c) => c.query(
      `SELECT storage_key, upload_state, bytes_purged_at, content_hash FROM ticket_media
        WHERE id = $1`, [req.params.id]));
    if (!m.rowCount) return res.status(404).json({ title: 'Not found', status: 404 });
    if (m.rows[0].bytes_purged_at) {
      return res.status(410).json({ title: 'Photograph purged', status: 410,
        detail: 'The image has passed its retention period. The record of the ' +
                'photograph, its hash and its location remains.' });
    }
    if (m.rows[0].upload_state !== 'STORED') {
      return res.status(404).json({ title: 'Not uploaded', status: 404 });
    }
    const buf = await driver.get(m.rows[0].storage_key);
    // Served only if it is still the picture that was fingerprinted at
    // upload — with S3 the bytes never pass through the portal on the way
    // in, so this is the check that catches a swap, as for contract documents.
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (hash !== m.rows[0].content_hash) {
      console.error(`photograph ${req.params.id}: stored bytes do not match the recorded fingerprint`);
      return res.status(409).json({ title: 'Photograph altered', status: 409,
        detail: 'The stored image no longer matches the fingerprint recorded when it was taken; it is not served.' });
    }
    res.type('image/jpeg').send(buf);
  } catch (e) { next(e); }
});

api.post('/admin/media/purge', async (req, res, next) => {
  try {
    if (req.claims.role !== 'ADMINISTRATOR') throw new Forbidden('Administrator only');
    const out = await withSystem(maintPool, (c) =>
      purgeExpiredBytes(c, { quiet: true }));
    res.json(out);
  } catch (e) { next(e); }
});

api.get('/admin/media/usage', async (req, res, next) => {
  try {
    const rows = await scoped(req, (c) => c.query(
      `SELECT purpose,
              count(*) FILTER (WHERE upload_state='STORED')  AS stored,
              count(*) FILTER (WHERE upload_state='PENDING') AS pending,
              count(*) FILTER (WHERE upload_state='FAILED')  AS failed,
              count(*) FILTER (WHERE bytes_purged_at IS NOT NULL) AS purged,
              coalesce(sum(size_bytes) FILTER (WHERE bytes_purged_at IS NULL),0)
                AS bytes_held
         FROM ticket_media GROUP BY purpose ORDER BY purpose`));
    const store = await driver.totalBytes();
    res.json({ by_purpose: rows.rows, store, driver: driver.name });
  } catch (e) { next(e); }
});

/* ---- A5: push registration ------------------------------------------
   Stored now; delivery arrives with the native apps. In-app notification
   is written for every event regardless, so nothing is lost meanwhile. */
api.put('/notifications/push-token', async (req, res, next) => {
  try {
    if (!req.body?.fcm_token) throw new Unprocessable('No token supplied');
    // push goes to a handset, so it needs a device sign-in, not a password
    if (!req.claims.actor_id) throw new Unprocessable('Push is registered from the app on a phone');
    await scoped(req, (c) => c.query(
      `INSERT INTO push_token (device_id, fcm_token) VALUES ($1,$2)
       ON CONFLICT (device_id) DO UPDATE SET fcm_token=EXCLUDED.fcm_token,
              updated_at=now()`, [req.claims.device_id, req.body.fcm_token]));
    res.status(204).end();
  } catch (e) { next(e); }
});

/* ---- A8: resident confirmation and rating ----------------------------
   Specified from the start and never implemented, which the conformance
   check found: avg_rating in the contract performance report was always
   empty. Runs in parallel with the Overseer's inspection, never instead
   of it. */
api.post('/tickets/:id/feedback', async (req, res, next) => {
  try {
    const { confirmed, rating, comment } = req.body || {};
    if (typeof confirmed !== 'boolean') {
      throw new Unprocessable('Say whether the work was done');
    }
    if (rating !== undefined && rating !== null &&
        (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      throw new Unprocessable('A rating is one to five');
    }
    const out = await scoped(req, async (c) => {
      const t = await c.query(
        `SELECT t.state, t.premises_id, p.occupancy_model
           FROM ticket t JOIN premises_ref p ON p.premises_id = t.premises_id
          WHERE t.id = $1`, [req.params.id]);
      if (!t.rowCount) throw new Forbidden('Ticket not visible to you');
      // A departmental building has no occupant to confirm anything; the
      // Overseer's inspection is the only gate there.
      if (t.rows[0].occupancy_model === 'DEPARTMENT_ONLY') {
        throw new Unprocessable('This building has no occupant to confirm the work');
      }
      if (!['RESIDENT','CUSTODIAN'].includes(req.claims.role)) {
        throw new Forbidden('Only the occupant confirms the work');
      }
      if (!['INSPECTED_ACCEPTED','CLOSED'].includes(t.rows[0].state)) {
        throw new Conflict('The work has not been inspected yet');
      }
      // Accepted but not closed, and the occupant says it is not done: it is
      // reopened, as a dispute after closure is, so the Overseer cannot close
      // it over the occupant's head (user's finding, 2026-10-07).
      if (confirmed === false && t.rows[0].state === 'INSPECTED_ACCEPTED' && !String(comment || '').trim()) {
        throw new Unprocessable('Say what is still wrong');
      }
      const win = await c.query(
        `SELECT value::integer AS hours FROM maint_config
          WHERE key='reopen_window_hours'`);
      const r = await c.query(
        `INSERT INTO ticket_feedback (ticket_id, confirmed, disputed, rating,
             comment, actor_id, reopen_window_ends_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval)
         ON CONFLICT (ticket_id) DO UPDATE
            SET confirmed=EXCLUDED.confirmed, disputed=EXCLUDED.disputed,
                rating=EXCLUDED.rating, comment=EXCLUDED.comment
         RETURNING ticket_id, confirmed, rating`,
        [req.params.id, confirmed, !confirmed, rating ?? null, comment ?? null,
         req.claims.actor_id, win.rows[0]?.hours ?? 24]);
      if (confirmed === false && t.rows[0].state === 'INSPECTED_ACCEPTED') {
        mustAffect(await c.query(`UPDATE ticket SET state = 'REOPENED' WHERE id = $1 RETURNING id`, [req.params.id]),
          'This complaint cannot be reopened');
        await logEvent(c, req.params.id, req, 'INSPECTED_ACCEPTED', 'REOPENED', 'REOPENED', String(comment).trim());
        r.rows[0].reopened = true;
      }
      return r.rows[0];
    });
    if (out.reopened) {
      await notifyReferral(req.params.id);
      const tk = await withSystem(maintPool, (c) => loadTicket(c, req.params.id, 'SYSTEM'));
      await notifyTransition(tk, 'REOPENED', req);
    }
    // a dispute is a quality signal, and goes to the Overseer not the contractor
    if (out.confirmed === false) {
      const t = await withSystem(maintPool, (c) => c.query(
        `SELECT t.ticket_no, t.scope_path::text AS scope, p.identifier
           FROM ticket t JOIN premises_ref p ON p.premises_id=t.premises_id
          WHERE t.id=$1`, [req.params.id]));
      if (t.rowCount) {
        await notify({ role: 'CIVIL_OVERSEER', scope: t.rows[0].scope,
          event: 'WORK_DISPUTED',
          en: [`Occupant disputes the work at ${t.rows[0].identifier}`, t.rows[0].ticket_no],
          hi: [`${t.rows[0].identifier} पर निवासी असहमत`, t.rows[0].ticket_no] });
      }
    }
    res.json(out);
  } catch (e) { next(e); }
});

api.get('/tickets/:id/feedback', async (req, res, next) => {
  try {
    // The occupant's own words and rating are not the contractor's to read,
    // as their answers are hidden from the contractor's timeline; the
    // scorecard's average rating stays (break-it pass, 2026-10-08).
    if (['CONTRACTOR', 'CONTRACTOR_SUPERVISOR'].includes(req.claims.role)) {
      return res.status(404).json({ title: 'Not found', status: 404 });
    }
    const out = await scoped(req, (c) => c.query(
      `SELECT confirmed, disputed, rating, comment, submitted_at,
              reopen_window_ends_at FROM ticket_feedback WHERE ticket_id=$1`,
      [req.params.id]));
    res.json(out.rows[0] || null);
  } catch (e) { next(e); }
});

/* The open jobs of one supervisor role — shown before that role is ended, so
   nothing is left where nobody can start it (user's finding, 2026-10-12).
   Those who end roles: the Area administrators, and the Incharge for
   supervisors; plus the officers who reassign. Row security keeps it to
   the caller's Area. */
api.get('/actors/:id/open-jobs', async (req, res, next) => {
  try {
    if (!['MAINTENANCE_INCHARGE', 'CIVIL_OVERSEER', 'STAFF_OFFICER_CIVIL', 'AREA_HR_ADMIN', 'AREA_SYS_ADMIN', 'ADMINISTRATOR'].includes(req.claims.role)) {
      throw new Forbidden('Only the Area office sees whose jobs are whose');
    }
    const out = await scoped(req, (c) => c.query(
      `SELECT t.id, t.ticket_no, t.state, p.identifier, s.name_en AS sub_category
         FROM ticket t
         JOIN sub_category s ON s.id = t.sub_category_id
         JOIN premises_ref p ON p.premises_id = t.premises_id
        WHERE t.assigned_to = $1 AND t.state IN ('ASSIGNED','IN_PROGRESS','REWORK','WORK_COMPLETED')
        ORDER BY t.raised_at`, [req.params.id]));
    res.json(out.rows);
  } catch (e) { next(e); }
});

api.get('/devices/assignable', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT d.actor_id, d.person_name, d.contract_id, ct.contractor_name,
              (SELECT count(*) FROM ticket t
                WHERE t.assigned_to = d.actor_id
                  AND t.state IN ('ASSIGNED','IN_PROGRESS','REWORK'))::int AS open_jobs
         FROM actor_ref d LEFT JOIN contract ct ON ct.id = d.contract_id
        WHERE d.role='CONTRACTOR_SUPERVISOR' AND d.status='ACTIVE'
        ORDER BY ct.contractor_name, d.person_name`));
    res.json(out.rows);
  } catch (e) { next(e); }
});

/* Errors: the database is the final authority, so its refusals are mapped
   rather than second-guessed. */
api.use((err, req, res, _next) => {
  const mapped = mapDbError(err);
  const status = err.status || mapped?.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({
    title: status === 403 ? 'Not permitted'
         : status === 409 ? 'Conflict'
         : status === 422 ? 'Cannot do that' : 'Error',
    status,
    detail: err.status ? err.message : (mapped?.detail || 'Unexpected error')
  });
});
