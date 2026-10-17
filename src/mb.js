import express from 'express';
import { maintPool, withScope, withSystem, mapDbError, Forbidden, Unprocessable } from './db.js';
import { requireAuth } from './auth.js';

/**
 * Measurement book (phase 5) — quantities only, never a bill (control 9).
 *
 * Civil measures each job-card work item once the work is accepted; the
 * entries come out as an MB-ready extract for a contract and period; the
 * MB number and page are recorded when they are written into the
 * department's Measurement Book, which freezes them; the Area Civil Staff
 * Officer check-measures a share of them. The database holds every rule;
 * this file gives the plain messages.
 */
export const mb = express.Router();
mb.use(requireAuth);

const scoped = (req, fn) => withScope(maintPool, req.claims, fn);
const notFound = () => Object.assign(new Error('Not found'), { status: 404 });
const withReason = (c, reason) => c.query(`SELECT set_config('app.reason', $1, true)`, [String(reason || '')]);
// the supervisor's own sheet first, then each officer at their step (2026-10-16) — the database decides
const MEASURERS = ['CONTRACTOR_SUPERVISOR', 'CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL'];
// the paper MB's own number and page, noted against an entry, stays the Overseer's or Incharge's
const RECORDERS = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE'];
const DEPARTMENT = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL', 'GM_CIVIL', 'HQ_EXECUTIVE', 'ADMINISTRATOR'];
const CONTRACTOR = ['CONTRACTOR', 'CONTRACTOR_SUPERVISOR'];
const requireRole = (req, roles, msg) => { if (!roles.includes(req.claims.role)) throw new Forbidden(msg); };
const num = (v) => (v === null || v === undefined ? null : Number(v));
const optional = (v, label) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Unprocessable(`${label} is a number above zero`);
  return n;
};
const quantity = (v) => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < 0) {
    throw new Unprocessable('The quantity is a number, zero or more');
  }
  return n;
};
const config = async (c, key, dflt) =>
  Number((await c.query(`SELECT value FROM maint_config WHERE key = $1`, [key])).rows[0]?.value ?? dflt);
const variance = (qty, check) => (check === null || !qty ? null : Math.round(((check - qty) / qty) * 1000) / 10);

const M_COLS = `m.id, m.item_id, m.nos, m.length, m.breadth, m.depth, m.qty, m.remark, m.measured_at,
       mb_.person_name AS measured_by_name, m.mb_no, m.mb_page, m.mb_recorded_at,
       m.check_qty, m.check_remark, m.checked_at, cb.person_name AS checked_by_name,
       ll.by_role AS last_by_role, la.person_name AS last_by_name, ll.at AS last_at`;
const M_JOINS = `LEFT JOIN actor_ref mb_ ON mb_.actor_id = m.measured_by
       LEFT JOIN actor_ref cb ON cb.actor_id = m.checked_by
       -- who measured it last: the latest line of the MB record (2026-10-16)
       LEFT JOIN LATERAL (SELECT by_role, by_actor, at FROM mb_line WHERE measurement_id = m.id ORDER BY line_no DESC LIMIT 1) ll ON true
       LEFT JOIN actor_ref la ON la.actor_id = ll.by_actor`;

/* One measurement as the caller may see it: the check-measurement is
   departmental, so the contractor's copy leaves it out. */
function toM(r, role) {
  const m = { id: r.id, item_id: r.item_id, nos: num(r.nos), length: num(r.length), breadth: num(r.breadth),
    depth: num(r.depth), qty: num(r.qty), remark: r.remark, measured_at: r.measured_at,
    measured_by_name: r.measured_by_name, mb_no: r.mb_no, mb_page: r.mb_page, mb_recorded_at: r.mb_recorded_at,
    last_by_role: r.last_by_role ?? null, last_by_name: r.last_by_name ?? null, last_at: r.last_at ?? null };
  if (CONTRACTOR.includes(role)) return m;
  const check = num(r.check_qty);
  return { ...m, check_qty: check, check_remark: r.check_remark, checked_at: r.checked_at,
    checked_by_name: r.checked_by_name, variance_percent: variance(num(r.qty), check) };
}

/* The ticket, if the caller may see its measurements at all. */
async function ticketFor(c, req, id = req.params.id) {
  const role = req.claims.role;
  if (!DEPARTMENT.includes(role) && !CONTRACTOR.includes(role)) return null;
  return (await c.query(`SELECT id, state FROM ticket WHERE id = $1`, [id])).rows[0] || null;
}
const one = async (c, req, mid) => toM((await c.query(`SELECT ${M_COLS} FROM measurement m ${M_JOINS} WHERE m.id = $1`, [mid])).rows[0], req.claims.role);

/* ------------------------------------------------------------ per complaint */
mb.get('/tickets/:id/measurements', async (req, res, next) => {
  try {
    const role = req.claims.role;
    const out = await scoped(req, async (c) => {
      const t = await ticketFor(c, req);
      if (!t) throw notFound();
      let items;
      // the supervisor reads the whole job card since 2026-10-16; the firm only what was measured
      if (role === 'CONTRACTOR') {
        // The job card itself is not the contractor's to read; only what was
        // measured on it, with the item's own words, for a complaint it sees.
        const ms = (await c.query(`SELECT ${M_COLS} FROM measurement m ${M_JOINS} WHERE m.ticket_id = $1`, [t.id])).rows;
        const names = ms.length ? (await withSystem(maintPool, (s) => s.query(
          `SELECT id, seq, description, unit FROM job_card_item WHERE id = ANY($1::uuid[])`, [ms.map((m) => m.item_id)]))).rows : [];
        const byId = new Map(names.map((n) => [n.id, n]));
        items = ms.map((m) => ({ item_id: m.item_id, seq: byId.get(m.item_id)?.seq, description: byId.get(m.item_id)?.description,
          unit: byId.get(m.item_id)?.unit, measurement: toM(m, role) })).sort((a, b) => a.seq - b.seq);
      } else {
        if (!(await c.query(`SELECT 1 FROM job_card WHERE ticket_id = $1`, [t.id])).rowCount) throw notFound();
        const rows = (await c.query(
          `SELECT i.id AS iid, i.seq, i.description, i.unit, i.qty_estimated, ${M_COLS}
             FROM job_card_item i
             LEFT JOIN measurement m ON m.item_id = i.id
             ${M_JOINS}
            WHERE i.ticket_id = $1 AND i.withdrawn_at IS NULL
            ORDER BY i.seq`, [t.id])).rows;
        items = rows.map((r) => ({ item_id: r.iid, seq: r.seq, description: r.description, unit: r.unit,
          qty_estimated: num(r.qty_estimated), measurement: r.id ? toM(r, role) : null }));
      }
      // the same rule as measurement_guard, so the screens offer only what it allows
      const stage = (await c.query(`SELECT sheet_stage_of($1, 'MEASUREMENTS')::text AS s`, [t.id])).rows[0].s || 'SUPERVISOR';
      const atStep = [['CIVIL_OVERSEER', 'OVERSEER'], ['MAINTENANCE_INCHARGE', 'INCHARGE'], ['STAFF_OFFICER_CIVIL', 'STAFF_OFFICER'],
        ['STAFF_OFFICER_CIVIL', 'APPROVED']].some(([r, st]) => r === role && st === stage);
      const mine = role === 'CONTRACTOR_SUPERVISOR' && stage === 'SUPERVISOR'
        && (await c.query(`SELECT 1 FROM ticket WHERE id = $1 AND assigned_to = $2`, [t.id, req.claims.actor_id])).rowCount > 0;
      return {
        items,
        stage,
        reason_needed: atStep,
        can_measure: (mine || atStep) && ['INSPECTED_ACCEPTED', 'CLOSED'].includes(t.state),
        can_check: role === 'STAFF_OFFICER_CIVIL',
        can_record: RECORDERS.includes(role)
      };
    });
    res.json(out);
  } catch (e) { next(e); }
});

const dims = (b) => [optional(b.nos, 'The number (Nos)'), optional(b.length, 'The length'),
  optional(b.breadth, 'The breadth'), optional(b.depth, 'The depth or height'),
  b.qty === undefined || b.qty === null || b.qty === '' ? null : quantity(b.qty), String(b.remark || '').trim() || null];

mb.post('/tickets/:id/measurements', async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await scoped(req, async (c) => {
      const t = await ticketFor(c, req);
      if (!t) throw notFound();
      requireRole(req, MEASURERS, 'Measurements are taken by the supervisor of the job, then by each officer at their step');
      if (!b.item_id) throw new Unprocessable('Choose the work item');
      const exists = await c.query(`SELECT 1 FROM measurement WHERE item_id = $1`, [b.item_id]);
      if (exists.rowCount) throw Object.assign(new Error('This work item is already measured; measure it again instead'), { status: 409 });
      const r = (await c.query(
        `INSERT INTO measurement (ticket_id, item_id, nos, length, breadth, depth, qty, remark, premises_id, area_id, scope_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 'ncl')
         RETURNING id`, [t.id, b.item_id, ...dims(b)])).rows[0];
      return one(c, req, r.id);
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

mb.put('/measurements/:mid', async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await scoped(req, async (c) => {
      requireRole(req, MEASURERS, 'Measurements are taken by the supervisor of the job, then by each officer at their step');
      if (!String(b.reason || '').trim()) throw new Unprocessable('Give the reason for measuring again');
      const v = dims(b);
      await withReason(c, b.reason);
      const r = await c.query(
        `UPDATE measurement SET nos = $2, length = $3, breadth = $4, depth = $5, qty = $6, remark = $7
          WHERE id = $1 RETURNING id`, [req.params.mid, ...v]);
      if (!r.rowCount) throw notFound();
      return one(c, req, req.params.mid);
    });
    res.json(out);
  } catch (e) { next(e); }
});

mb.post('/measurements/:mid/check', async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await scoped(req, async (c) => {
      requireRole(req, ['STAFF_OFFICER_CIVIL'], 'Check-measurement is done by the Area Civil Staff Officer');
      const q = quantity(b.check_qty);
      await withReason(c, b.reason);
      const r = await c.query(
        `UPDATE measurement SET check_qty = $2, check_remark = $3, checked_at = clock_timestamp()
          WHERE id = $1 RETURNING id`, [req.params.mid, q, String(b.remark || '').trim() || null]);
      if (!r.rowCount) throw notFound();
      return one(c, req, req.params.mid);
    });
    res.json(out);
  } catch (e) { next(e); }
});

mb.get('/tickets/:id/measurements/history', async (req, res, next) => {
  try {
    requireRole(req, DEPARTMENT, 'The measurement history is for the Civil Overseer and the officers above');
    const out = await scoped(req, async (c) => {
      const t = await ticketFor(c, req);
      if (!t) throw notFound();
      return (await c.query(
        `SELECT l.occurred_at, l.event_type, l.actor_role, l.before_value, l.after_value, l.reason,
                a.person_name AS actor_name
           FROM audit_log l LEFT JOIN actor_ref a ON a.actor_id = l.actor_id
          WHERE l.entity_type = 'measurement' AND l.entity_id = $1
          ORDER BY l.id DESC`, [t.id])).rows;
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ the Measurement Book */
// All or nothing: one entry that cannot be recorded leaves the batch unrecorded.
mb.post('/mb/record', async (req, res, next) => {
  try {
    const b = req.body || {};
    const ids = Array.isArray(b.measurement_ids) ? b.measurement_ids : [];
    const out = await scoped(req, async (c) => {
      requireRole(req, RECORDERS, 'Entries are written into the MB by the Civil Overseer or the Civil Incharge');
      if (!ids.length) throw new Unprocessable('Choose the entries written into the MB');
      if (!String(b.mb_no || '').trim() || !String(b.mb_page || '').trim()) throw new Unprocessable('Give the MB number and page');
      for (const id of ids) {
        const r = await c.query(`UPDATE measurement SET mb_no = $2, mb_page = $3 WHERE id = $1 RETURNING id`,
          [id, String(b.mb_no).trim(), String(b.mb_page).trim()]);
        if (!r.rowCount) throw notFound();
      }
      return { recorded: ids.length };
    });
    res.json(out);
  } catch (e) { next(e); }
});

const d = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);

async function extract(req) {
  requireRole(req, DEPARTMENT, 'The MB extract is for the Civil Overseer and the officers above');
  const contractId = req.query.contract_id || null;
  const from = d(req.query.from), to = d(req.query.to);
  const status = ['recorded', 'unrecorded'].includes(req.query.status) ? req.query.status : 'all';
  return scoped(req, async (c) => {
    const target = await config(c, 'check_measure_target_percent', 10);
    const tolerance = await config(c, 'check_measure_tolerance_percent', 5);
    const rows = (await c.query(
      `SELECT ${M_COLS}, i.seq, i.description, i.unit, i.qty_estimated,
              t.id AS ticket_id, t.ticket_no, t.closed_at, jc.jc_no, p.identifier, sc.name_en AS sub_category
         FROM measurement m
         JOIN job_card_item i ON i.id = m.item_id
         JOIN job_card jc ON jc.ticket_id = m.ticket_id
         JOIN ticket t ON t.id = m.ticket_id
         JOIN sub_category sc ON sc.id = t.sub_category_id
         LEFT JOIN premises_ref p ON p.premises_id = m.premises_id
         ${M_JOINS}
        WHERE ($1::uuid IS NULL OR m.contract_id = $1)
          AND ($2::date IS NULL OR m.measured_at >= $2::date)
          AND ($3::date IS NULL OR m.measured_at < $3::date + 1)
          AND ($4 = 'all' OR ($4 = 'recorded') = (m.mb_no IS NOT NULL))
        ORDER BY t.ticket_no, i.seq`, [contractId, from, to, status])).rows;
    const jobs = new Map();
    let checked = 0, flagged = 0, recorded = 0;
    for (const r of rows) {
      if (!jobs.has(r.ticket_id)) {
        jobs.set(r.ticket_id, { ticket_id: r.ticket_id, ticket_no: r.ticket_no, jc_no: r.jc_no, identifier: r.identifier,
          sub_category: r.sub_category, closed_at: r.closed_at, entries: [], materials: [] });
      }
      const qty = num(r.qty), check = num(r.check_qty), v = variance(qty, check);
      const flag = check !== null && (qty === 0 ? check > 0 : Math.abs(v) > tolerance);
      if (check !== null) checked++;
      if (flag) flagged++;
      if (r.mb_no) recorded++;
      jobs.get(r.ticket_id).entries.push({ id: r.id, seq: r.seq, description: r.description, unit: r.unit,
        nos: num(r.nos), length: num(r.length), breadth: num(r.breadth), depth: num(r.depth), qty,
        qty_estimated: num(r.qty_estimated), measured_at: r.measured_at, measured_by_name: r.measured_by_name,
        mb_no: r.mb_no, mb_page: r.mb_page, check_qty: check, checked_by_name: r.checked_by_name,
        variance_percent: v, flagged: flag });
    }
    if (jobs.size) {
      const mats = (await c.query(
        `SELECT c.ticket_id, m.code, m.name_en, m.unit, sum(c.qty_verified) AS qty_verified
           FROM material_claim c JOIN material m ON m.id = c.material_id
          WHERE c.ticket_id = ANY($1::uuid[]) AND c.withdrawn_at IS NULL AND c.qty_verified IS NOT NULL
          GROUP BY c.ticket_id, m.code, m.name_en, m.unit ORDER BY m.code`, [[...jobs.keys()]])).rows;
      for (const r of mats) jobs.get(r.ticket_id).materials.push({ code: r.code, name_en: r.name_en, unit: r.unit, qty_verified: num(r.qty_verified) });
    }
    const contract = contractId ? (await c.query(
      `SELECT id, contractor_name AS firm_name, agreement_no FROM contract WHERE id = $1`, [contractId])).rows[0] || null : null;
    return {
      period: { from, to }, contract,
      summary: { entries: rows.length, recorded, unrecorded: rows.length - recorded, checked,
        check_percent: rows.length ? Math.round((checked / rows.length) * 1000) / 10 : 0,
        target_percent: target, tolerance_percent: tolerance, flagged },
      jobs: [...jobs.values()]
    };
  });
}

mb.get('/mb/extract', async (req, res, next) => {
  try { res.json(await extract(req)); } catch (e) { next(e); }
});

mb.get('/mb/extract.csv', async (req, res, next) => {
  try {
    const x = await extract(req);
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const cols = ['ticket_no', 'jc_no', 'premises', 'item', 'description', 'unit', 'nos', 'length', 'breadth', 'depth', 'qty',
      'measured_on', 'measured_by', 'mb_no', 'mb_page', 'check_qty', 'variance_percent', 'flagged'];
    const lines = [cols.join(',')];
    for (const j of x.jobs) {
      for (const e of j.entries) {
        lines.push([j.ticket_no, j.jc_no, j.identifier, e.seq, e.description, e.unit, e.nos, e.length, e.breadth, e.depth, e.qty,
          new Date(e.measured_at).toISOString().slice(0, 10), e.measured_by_name, e.mb_no, e.mb_page, e.check_qty,
          e.variance_percent, e.flagged ? 'yes' : ''].map(esc).join(','));
      }
    }
    res.set('content-type', 'text/csv; charset=utf-8');
    res.set('content-disposition', 'attachment; filename="mb-extract.csv"');
    res.send(lines.join('\n') + '\n');
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ the MB reference record (2026-10-16) */
/* The paper Measurement Book stays official; the portal keeps the numbered
   record it is copied from: one MB number per contract, every version of a
   measurement on its own line, 25 lines to a page, a revision appended and
   the old line kept, marked superseded. Officers see who; the contractor the
   role. */
const MB_LINE = `SELECT l.line_no, l.page, l.ticket_id, l.measurement_id, l.item_seq, l.description, l.unit,
         l.nos, l.length, l.breadth, l.depth, l.qty, l.by_role, l.reason, l.correction, l.at, a.person_name AS by_name,
         t.ticket_no, EXISTS (SELECT 1 FROM mb_line x WHERE x.measurement_id = l.measurement_id AND x.line_no > l.line_no) AS superseded
    FROM mb_line l JOIN ticket t ON t.id = l.ticket_id LEFT JOIN actor_ref a ON a.actor_id = l.by_actor`;
const toLine = (r, role) => {
  const l = { line_no: r.line_no, page: r.page, ticket_id: r.ticket_id, ticket_no: r.ticket_no, measurement_id: r.measurement_id,
    item_seq: r.item_seq, description: r.description, unit: r.unit, nos: num(r.nos), length: num(r.length), breadth: num(r.breadth),
    depth: num(r.depth), qty: num(r.qty), by_role: r.by_role, reason: r.reason, correction: r.correction, at: r.at, superseded: r.superseded };
  return CONTRACTOR.includes(role) ? l : { ...l, by_name: r.by_name };
};

mb.get('/tickets/:id/mb', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => {
      const t = await ticketFor(c, req);
      if (!t) throw notFound();
      const tk = (await c.query(`SELECT contract_id FROM ticket WHERE id = $1`, [t.id])).rows[0];
      const book = tk?.contract_id ? (await c.query(`SELECT mb_no FROM mb_book WHERE contract_id = $1`, [tk.contract_id])).rows[0] : null;
      const sheet = (await c.query(`SELECT stage::text, approved_at FROM job_sheet WHERE ticket_id = $1 AND kind = 'MEASUREMENTS'`, [t.id])).rows[0];
      const lines = (await c.query(`${MB_LINE} WHERE l.ticket_id = $1 ORDER BY l.line_no`, [t.id])).rows.map((r) => toLine(r, req.claims.role));
      return { mb_no: book?.mb_no || null, contract_id: tk?.contract_id || null, stage: sheet?.stage || null,
        approved_at: sheet?.approved_at || null, lines_per_page: 25, lines };
    });
    res.json(out);
  } catch (e) { next(e); }
});

mb.get('/contracts/:id/mb', async (req, res, next) => {
  try {
    if (!DEPARTMENT.includes(req.claims.role) && !CONTRACTOR.includes(req.claims.role)) throw notFound();
    const out = await scoped(req, async (c) => {
      const book = (await c.query(`SELECT mb_no, opened_at, next_line FROM mb_book WHERE contract_id = $1`, [req.params.id])).rows[0];
      if (!book) throw notFound();
      // A contract's MB grows by a hundred or more pages a year, so it opens by
      // month or by page, never all at once (user's decision, 2026-10-16).
      const months = (await c.query(
        `SELECT to_char(l.at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month, min(l.page) AS first_page, max(l.page) AS last_page,
                count(DISTINCT l.ticket_id)::int AS jobs, count(*)::int AS lines
           FROM mb_line l WHERE l.contract_id = $1 GROUP BY 1 ORDER BY 1`, [req.params.id])).rows;
      const pages = (await c.query(`SELECT coalesce(max(page), 0) AS p FROM mb_line WHERE contract_id = $1`, [req.params.id])).rows[0].p;
      let where = '', args = [req.params.id];
      const pf = Number(req.query.page_from), pt = Number(req.query.page_to);
      if (pf || pt) { args.push(pf || 1, pt || pf || 1); where = `AND l.page BETWEEN $2 AND $3`; }
      else {
        const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : months.at(-1)?.month;
        if (month) { args.push(month); where = `AND to_char(l.at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $2`; }
      }
      const lines = (await c.query(`${MB_LINE} WHERE l.contract_id = $1 ${where} ORDER BY l.line_no`, args)).rows.map((r) => toLine(r, req.claims.role));
      // the index: each job shown, with every page its lines are on and where its sheet stands
      const ids = [...new Set(lines.map((l) => l.ticket_id))];
      const idx = ids.length ? (await c.query(
        `SELECT l.ticket_id, t.ticket_no, array_agg(DISTINCT l.page ORDER BY l.page) AS pages, s.stage::text, s.approved_at
           FROM mb_line l JOIN ticket t ON t.id = l.ticket_id
           LEFT JOIN job_sheet s ON s.ticket_id = l.ticket_id AND s.kind = 'MEASUREMENTS'
          WHERE l.ticket_id = ANY($1::uuid[]) GROUP BY l.ticket_id, t.ticket_no, s.stage, s.approved_at ORDER BY t.ticket_no`, [ids])).rows : [];
      return { mb_no: book.mb_no, contract_id: req.params.id, opened_at: book.opened_at, lines_per_page: 25,
        pages: Number(pages), months, jobs: idx.map((x) => ({ ...x, pages: x.pages.map(Number) })), lines };
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ working through a month's MB (2026-10-16) */
/* One worklist for each officer of the chain: for a contract and month (of the
   work's acceptance), what waits at their own step, what is still below them,
   sent back, approved, waiting too long; one row per job, and the Staff
   Officer's sample check. Row security decides which jobs appear. */
const STEP_OF = { CIVIL_OVERSEER: 'OVERSEER', MAINTENANCE_INCHARGE: 'INCHARGE', STAFF_OFFICER_CIVIL: 'STAFF_OFFICER' };
const ORDER = ['SUPERVISOR', 'OVERSEER', 'INCHARGE', 'STAFF_OFFICER', 'APPROVED'];
const WORKLIST_READERS = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL', 'GM_CIVIL', 'HQ_EXECUTIVE', 'ADMINISTRATOR'];

mb.get('/mb/worklist', async (req, res, next) => {
  try {
    requireRole(req, WORKLIST_READERS, 'The worklist is for the officers of the approval chain');
    const kind = req.query.kind === 'materials' ? 'MATERIALS' : 'MEASUREMENTS';
    const open = req.query.month === 'open';
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month
      : new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7);
    const out = await scoped(req, async (c) => {
      const waitDays = await config(c, 'sheet_waiting_days', 7);
      const target = await config(c, 'check_measure_target_percent', 10);
      const args = [];
      const cond = [`t.inspected_at IS NOT NULL`];
      if (open) cond.push(`(ms.stage <> 'APPROVED' OR mt.stage <> 'APPROVED')`);
      else { args.push(month); cond.push(`to_char(t.inspected_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $${args.length}`); }
      if (req.query.contract_id) { args.push(req.query.contract_id); cond.push(`t.contract_id = $${args.length}`); }
      const rows = (await c.query(
        `SELECT t.id AS ticket_id, t.ticket_no, t.state::text, t.contract_id, t.inspected_at, p.identifier, s.name_en AS sub_category,
                ct.contractor_name,
                ms.stage::text AS m_stage, ms.stage_since AS m_since, ms.approved_at AS m_approved,
                mt.stage::text AS t_stage, mt.stage_since AS t_since, mt.approved_at AS t_approved,
                (SELECT e.action FROM job_sheet_event e WHERE e.ticket_id = t.id AND e.kind = 'MEASUREMENTS' ORDER BY e.id DESC LIMIT 1) AS m_last,
                (SELECT e.action FROM job_sheet_event e WHERE e.ticket_id = t.id AND e.kind = 'MATERIALS' ORDER BY e.id DESC LIMIT 1) AS t_last,
                (SELECT count(*) FROM mb_line l WHERE l.ticket_id = t.id AND l.by_role <> 'CONTRACTOR_SUPERVISOR')::int AS m_changes,
                (SELECT count(*) FROM material_claim mc WHERE mc.ticket_id = t.id AND mc.withdrawn_at IS NULL
                    AND (mc.claimed_by IS DISTINCT FROM t.assigned_to OR (mc.qty_verified IS NOT NULL AND mc.qty_verified <> mc.qty_claimed)))::int AS t_changes,
                EXISTS (SELECT 1 FROM measurement m WHERE m.ticket_id = t.id AND m.check_qty IS NOT NULL) AS checked
           FROM ticket t
           JOIN job_sheet ms ON ms.ticket_id = t.id AND ms.kind = 'MEASUREMENTS'
           JOIN job_sheet mt ON mt.ticket_id = t.id AND mt.kind = 'MATERIALS'
           JOIN premises_ref p ON p.premises_id = t.premises_id
           JOIN sub_category s ON s.id = t.sub_category_id
           LEFT JOIN contract ct ON ct.id = t.contract_id
          WHERE ${cond.join(' AND ')}
          ORDER BY t.ticket_no`, args)).rows;
      const mine = STEP_OF[req.claims.role];
      const now = Date.now();
      const items = rows.map((r) => {
        const stage = kind === 'MATERIALS' ? r.t_stage : r.m_stage;
        const since = kind === 'MATERIALS' ? r.t_since : r.m_since;
        const days = Math.round(((now - Date.parse(since)) / 86_400_000) * 10) / 10;
        const at = ORDER.indexOf(stage);
        return {
          ticket_id: r.ticket_id, ticket_no: r.ticket_no, state: r.state, contract_id: r.contract_id, contractor_name: r.contractor_name,
          identifier: r.identifier, sub_category: r.sub_category, inspected_at: r.inspected_at,
          measurements_stage: r.m_stage, materials_stage: r.t_stage, stage, stage_since: since, days_at_step: days,
          approved_at: kind === 'MATERIALS' ? r.t_approved : r.m_approved,
          mine: !!mine && stage === mine,
          below: !!mine && stage !== 'APPROVED' && at < ORDER.indexOf(mine),
          sent_back: stage !== 'APPROVED' && (kind === 'MATERIALS' ? r.t_last : r.m_last) === 'RETURN',
          waiting_long: stage !== 'APPROVED' && (now - Date.parse(since)) / 86_400_000 > waitDays,
          changes: kind === 'MATERIALS' ? r.t_changes : r.m_changes,
          checked: r.checked
        };
      });
      const count = (f) => items.filter(f).length;
      // the sample check: at least the aim's share of each contract's jobs of the month check-measured on site
      const byContract = new Map();
      for (const i of items) {
        const s = byContract.get(i.contract_id) || { contract_id: i.contract_id, contractor_name: i.contractor_name, jobs: 0, checked: 0 };
        s.jobs++; if (i.checked) s.checked++; byContract.set(i.contract_id, s);
      }
      const sample = [...byContract.values()].map((s) => {
        const required = Math.ceil((s.jobs * target) / 100);
        return { ...s, target_percent: target, required, shortfall: Math.max(0, required - s.checked) };
      });
      return {
        month: open ? 'open' : month, kind, wait_days: waitDays, step: mine || null,
        tiles: { total: items.length, mine: count((i) => i.mine), below: count((i) => i.below), sent_back: count((i) => i.sent_back),
          approved: count((i) => i.stage === 'APPROVED'), waiting_long: count((i) => i.waiting_long) },
        sample, rows: items
      };
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ finding it later: the MB search (2026-10-16) */
/* Across a contract, or every contract the caller may see: by words of an item
   (word beginnings), the complaint number, the quarter or the fault; by the
   measurements' step, approval dates and MB page. One result per job, saying
   where in the MB its lines are. Row security decides what is found. */
mb.get('/mb/search', async (req, res, next) => {
  try {
    if (!DEPARTMENT.includes(req.claims.role) && !CONTRACTOR.includes(req.claims.role)) throw notFound();
    const q = req.query;
    const args = [], cond = [];
    const add = (sql, v) => { args.push(v); cond.push(sql.replaceAll('?', `$${args.length}`)); };
    if (q.contract_id) add('l.contract_id = ?', q.contract_id);
    if (q.q) {
      const words = String(q.q).match(/[\p{L}\p{N}/-]+/gu) || [];
      for (const w of words) {
        add(`(l.description ILIKE '%' || ? || '%' OR t.ticket_no ILIKE '%' || ? || '%' OR p.identifier ILIKE ? || '%'
              OR s.name_en ILIKE '%' || ? || '%' OR coalesce(s.name_hi, '') ILIKE '%' || ? || '%')`, w);
      }
    }
    if (q.stage) add('js.stage::text = ?', String(q.stage).toUpperCase());
    if (q.approved_from) add(`(js.approved_at AT TIME ZONE 'Asia/Kolkata')::date >= ?::date`, q.approved_from);
    if (q.approved_to) add(`(js.approved_at AT TIME ZONE 'Asia/Kolkata')::date <= ?::date`, q.approved_to);
    if (q.page_no) add(`EXISTS (SELECT 1 FROM mb_line x WHERE x.ticket_id = l.ticket_id AND x.page = ?::int)`, Number(q.page_no));
    const size = Math.min(Number(q.page_size) || 50, 200);
    const offset = ((Number(q.page) || 1) - 1) * size;
    args.push(size, offset);
    const out = await scoped(req, async (c) => {
      const rows = (await c.query(
        `SELECT l.ticket_id, t.ticket_no, p.identifier, s.name_en AS sub_category, l.contract_id, ct.contractor_name, b.mb_no,
                array_agg(DISTINCT l.page ORDER BY l.page) AS pages, min(l.line_no) AS first_line, max(l.line_no) AS last_line,
                js.stage::text AS stage, js.approved_at, count(*) OVER () AS total
           FROM mb_line l
           JOIN ticket t ON t.id = l.ticket_id
           JOIN premises_ref p ON p.premises_id = t.premises_id
           JOIN sub_category s ON s.id = t.sub_category_id
           JOIN mb_book b ON b.contract_id = l.contract_id
           LEFT JOIN contract ct ON ct.id = l.contract_id
           LEFT JOIN job_sheet js ON js.ticket_id = l.ticket_id AND js.kind = 'MEASUREMENTS'
          ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
          GROUP BY l.ticket_id, t.ticket_no, p.identifier, s.name_en, l.contract_id, ct.contractor_name, b.mb_no, js.stage, js.approved_at
          ORDER BY max(l.line_no) DESC
          LIMIT $${args.length - 1} OFFSET $${args.length}`, args)).rows;
      return { items: rows.map(({ total, ...r }) => ({ ...r, pages: r.pages.map(Number), first_line: Number(r.first_line), last_line: Number(r.last_line) })),
        total: rows.length ? Number(rows[0].total) : 0, page: Number(q.page) || 1, page_size: size };
    });
    res.json(out);
  } catch (e) { next(e); }
});

mb.use((err, req, res, _next) => {
  const mapped = mapDbError(err);
  const status = err.status || mapped?.status || (err.code === '22P02' ? 404 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({
    title: status === 403 ? 'Not permitted' : status === 404 ? 'Not found' : status === 409 ? 'Conflict' : status === 422 ? 'Cannot do that' : 'Error',
    status, detail: err.status ? err.message : (mapped?.detail || (status === 404 ? 'Not found' : 'Unexpected error')) });
});
