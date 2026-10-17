import crypto from 'node:crypto';
import express from 'express';
import { maintPool, identityPool, withScope, withSystem, mustAffect,
         mapDbError, Forbidden, Conflict, Unprocessable } from './db.js';
import { requireAuth } from './auth.js';
import { notify } from './notify.js';
import { driver } from './storage.js';

export const contracts = express.Router();
contracts.use(requireAuth);

const scoped = (req, fn) => withScope(maintPool, req.claims, fn);

/* Who writes a work order (decision 2026-09-30): the Civil Incharge fills
   it in, and the Staff Officer above them may too. The database refuses
   anyone else (policies contract_write_*), so this is only the plain
   message. */
const MANAGES = ['MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL'];
const requireManager = (req) => {
  if (!MANAGES.includes(req.claims.role)) {
    throw new Forbidden('The Civil Incharge or Staff Officer (Civil) fills in work orders');
  }
};
const needReason = (req) => {
  const r = String(req.body?.reason || '').trim();
  if (!r) throw new Unprocessable('Give the reason for this change; it is kept in the record');
  return r;
};
/* The reason travels to the database's own audit trigger. */
const withReason = (c, reason) => c.query(`SELECT set_config('app.reason', $1, true)`, [reason]);

const EDITABLE = ['contractor_name', 'firm_address', 'contract_no', 'agreement_no', 'work_name',
  'awarded_on', 'period_years', 'site_handover_on', 'starts_on', 'remarks'];

/* ------------------------------------------------------------------ *
 * Contract master
 * ------------------------------------------------------------------ */
contracts.get('/contracts', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT ct.*, 
              (ct.expires_on - current_date) AS days_remaining,
              (SELECT count(*) FROM ticket t
                WHERE t.contract_id = ct.id
                  AND t.state NOT IN ('CLOSED','REJECTED')) AS open_tickets,
              (SELECT count(*) FROM actor_ref d
                WHERE d.contract_id = ct.id AND d.status = 'ACTIVE') AS active_supervisors
         FROM contract ct
        ORDER BY ct.active DESC, ct.expires_on`));
    res.json(out.rows);
  } catch (e) { next(e); }
});

contracts.post('/contracts', async (req, res, next) => {
  try {
    requireManager(req);
    const b = req.body || {};
    if (!b.contractor_name || !b.agreement_no || !b.starts_on || !b.expires_on) {
      throw new Unprocessable('Firm, agreement number, start and completion dates are required');
    }
    if (b.period_years != null && ![1, 2].includes(Number(b.period_years))) {
      throw new Unprocessable('Contract period is one or two years');
    }
    const out = await scoped(req, async (c) => {
      // A work order is for the officer's own Area. Several may be live in
      // one Area: each complaint counts against the contract of the
      // supervisor it went to, which the database derives.
      const mine = (await c.query(
        `SELECT DISTINCT area_id FROM premises_ref
          WHERE subpath(scope_path, 0, 2) = $1::ltree LIMIT 1`, [req.claims.scope_path])).rows[0];
      if (!mine) throw new Unprocessable('Your Area has no premises registered yet');
      if (b.area_id !== undefined && b.area_id !== mine.area_id) {
        throw new Unprocessable('A work order is for your own Area');
      }
      if (b.reason) await withReason(c, String(b.reason));
      const r = await c.query(
        `INSERT INTO contract (area_id, scope_path, contractor_name, firm_address, contract_no, agreement_no,
             work_name, awarded_on, period_years, site_handover_on, starts_on, expires_on, remarks)
         VALUES ($1,$2::ltree,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [mine.area_id, req.claims.scope_path, b.contractor_name, b.firm_address || null, b.contract_no || null,
         b.agreement_no, b.work_name || null, b.awarded_on || b.starts_on, b.period_years || null,
         b.site_handover_on || null, b.starts_on, b.expires_on, b.remarks || null]);
      return r.rows[0];
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

/* One work order with everything on it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
contracts.get('/contracts/:id', async (req, res, next) => {
  // /contracts/comparison is registered further down
  if (!UUID.test(req.params.id)) return next('route');
  try {
    const out = await scoped(req, async (c) => {
      const ct = (await c.query(
        `SELECT ct.*, (ct.expires_on - current_date) AS days_remaining,
                (SELECT count(*) FROM ticket t WHERE t.contract_id = ct.id
                   AND t.state NOT IN ('CLOSED','REJECTED')) AS open_tickets
           FROM contract ct WHERE ct.id = $1`, [req.params.id])).rows[0];
      if (!ct) return null;
      const extensions = (await c.query(
        `SELECT e.id, e.seq, e.previous_expires_on, e.extended_to, e.order_no, e.granted_on, e.reason,
                e.recorded_at, a.person_name AS recorded_by_name
           FROM contract_extension e LEFT JOIN actor_ref a ON a.actor_id = e.recorded_by
          WHERE e.contract_id = $1 ORDER BY e.seq`, [req.params.id])).rows;
      const supervisors = (await c.query(
        `SELECT actor_id, person_name, role, status FROM actor_ref
          WHERE contract_id = $1 AND role IN ('CONTRACTOR','CONTRACTOR_SUPERVISOR')
          ORDER BY role, person_name`, [req.params.id])).rows;
      const documents = (await c.query(
        `SELECT d.id, d.kind, d.file_name, d.content_type, d.size_bytes, d.content_hash, d.note,
                d.uploaded_at, a.person_name AS uploaded_by_name
           FROM contract_document d LEFT JOIN actor_ref a ON a.actor_id = d.uploaded_by
          WHERE d.contract_id = $1 ORDER BY d.uploaded_at`, [req.params.id])).rows;
      return { ...ct, extensions, supervisors, documents };
    });
    if (!out) return res.status(404).json({ title: 'Not found', status: 404 });
    res.json(out);
  } catch (e) { next(e); }
});

/* Correct or complete a work order. The completion date is not here: it
   moves only by an extension. */
contracts.put('/contracts/:id', async (req, res, next) => {
  try {
    requireManager(req);
    const b = req.body || {};
    if ('expires_on' in b || 'original_expires_on' in b) {
      throw new Unprocessable('The completion date moves only by recording an extension');
    }
    const reason = needReason(req);
    const fields = EDITABLE.filter((k) => k in b);
    if (!fields.length) throw new Unprocessable('Nothing to change');
    if ('period_years' in b && b.period_years != null && ![1, 2].includes(Number(b.period_years))) {
      throw new Unprocessable('Contract period is one or two years');
    }
    const out = await scoped(req, async (c) => {
      await withReason(c, reason);
      const r = await c.query(
        `UPDATE contract SET ${fields.map((k, i) => `${k} = $${i + 2}`).join(', ')}
          WHERE id = $1 RETURNING *`,
        [req.params.id, ...fields.map((k) => (b[k] === '' ? null : b[k]))]);
      if (!r.rowCount) throw Object.assign(new Error('Not found'), { status: 404 });
      return r.rows[0];
    });
    res.json(out);
  } catch (e) { next(e); }
});

contracts.post('/contracts/:id/extensions', async (req, res, next) => {
  try {
    requireManager(req);
    const reason = needReason(req);
    const { extended_to, order_no = null, granted_on = null } = req.body || {};
    if (!extended_to) throw new Unprocessable('Give the date the contract is extended to');
    const out = await scoped(req, async (c) => {
      const ct = await c.query(`SELECT id FROM contract WHERE id=$1`, [req.params.id]);
      if (!ct.rowCount) throw Object.assign(new Error('Not found'), { status: 404 });
      return (await c.query(
        `INSERT INTO contract_extension (contract_id, extended_to, order_no, granted_on, reason,
             seq, previous_expires_on)
         VALUES ($1,$2,$3,$4,$5, 0, $2) RETURNING *`,
        [req.params.id, extended_to, order_no || null, granted_on || null, reason])).rows[0];
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

/* The contract copy and orders: PDF or a scanned JPEG, straight to the
   store, fingerprinted on the way in and checked on the way out. */
const DOC_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg' };
const DOC_MAX = 10 * 1024 * 1024;
const looksLike = (buf, type) => type === 'application/pdf'
  ? buf.slice(0, 5).toString('ascii') === '%PDF-'
  : buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

contracts.post('/contracts/:id/documents',
  express.raw({ type: () => true, limit: DOC_MAX }),
  async (req, res, next) => {
    try {
      requireManager(req);
      const type = String(req.get('content-type') || '').split(';')[0].trim();
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!DOC_TYPES[type] || !buf.length || !looksLike(buf, type)) {
        throw new Unprocessable('Attach the contract as a PDF, or as a scanned JPEG');
      }
      const fileName = String(req.query.file_name || `document.${DOC_TYPES[type]}`).slice(0, 200);
      const kind = ['CONTRACT_COPY', 'EXTENSION_ORDER', 'OTHER'].includes(req.query.kind) ? req.query.kind : 'CONTRACT_COPY';
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      const out = await scoped(req, async (c) => {
        const ct = (await c.query(`SELECT id, area_id FROM contract WHERE id=$1`, [req.params.id])).rows[0];
        if (!ct) throw Object.assign(new Error('Not found'), { status: 404 });
        const id = crypto.randomUUID();
        const key = `contracts/${ct.area_id}/${ct.id}/${id}.${DOC_TYPES[type]}`;
        await driver.put(key, buf);
        const d = (await c.query(
          `INSERT INTO contract_document (id, contract_id, kind, file_name, content_type, storage_key,
               content_hash, size_bytes, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, kind, file_name, content_type, content_hash, size_bytes, uploaded_at`,
          [id, ct.id, kind, fileName, type, key, hash, buf.length, req.query.note || null])).rows[0];
        await c.query(
          `INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id, actor_role,
               area_id, after_value, reason)
           VALUES ('CONTRACT_DOCUMENT_ATTACHED','contract',$1,$2,$3,$4,$5,$6,$7)`,
          [ct.id, req.claims.actor_id, req.claims.person_id, req.claims.role, ct.area_id,
           JSON.stringify({ document_id: id, kind, file_name: fileName, content_hash: hash }), req.query.note || null]);
        return d;
      });
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

contracts.get('/contracts/:id/documents/:doc', async (req, res, next) => {
  try {
    const d = await scoped(req, async (c) => (await c.query(
      `SELECT d.* FROM contract_document d WHERE d.id=$1 AND d.contract_id=$2`,
      [req.params.doc, req.params.id])).rows[0]);
    if (!d) return res.status(404).json({ title: 'Not found', status: 404 });
    const buf = await driver.get(d.storage_key);
    // a document that no longer matches its fingerprint is not served as
    // if it were the original
    if (crypto.createHash('sha256').update(buf).digest('hex') !== d.content_hash) {
      return res.status(409).json({ title: 'Conflict', status: 409,
        detail: 'This document no longer matches the one attached. Report it to the Area System Administrator.' });
    }
    res.set('content-type', d.content_type);
    res.set('content-disposition', `inline; filename="${d.file_name.replace(/"/g, '')}"`);
    res.send(buf);
  } catch (e) { next(e); }
});

/* Every change to the work order, newest first, with its reason. */
contracts.get('/contracts/:id/history', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => {
      const ct = await c.query(`SELECT id FROM contract WHERE id=$1`, [req.params.id]);
      if (!ct.rowCount) return null;
      return (await c.query(
        `SELECT l.occurred_at, l.event_type, l.actor_role, l.before_value, l.after_value, l.reason,
                a.person_name AS actor_name
           FROM audit_log l LEFT JOIN actor_ref a ON a.actor_id = l.actor_id
          WHERE l.entity_type = 'contract' AND l.entity_id = $1
          ORDER BY l.id DESC`, [req.params.id])).rows;
    });
    if (!out) return res.status(404).json({ title: 'Not found', status: 404 });
    res.json(out);
  } catch (e) { next(e); }
});

/* Name a contractor's supervisor on the work order (decision 2026-09-30:
   the Incharge fills this in). The person and their supervisor role are
   entered by the Area HR office; this says which contract their work
   counts against. */
contracts.post('/contracts/:id/supervisors', async (req, res, next) => {
  try {
    requireManager(req);
    const reason = needReason(req);
    const { actor_id } = req.body;
    const out = await scoped(req, async (c) => {
      const ct = await c.query(`SELECT id, area_id FROM contract WHERE id=$1`, [req.params.id]);
      if (!ct.rowCount) throw new Forbidden('Contract not visible to you');
      const before = (await c.query(`SELECT contract_id FROM actor_ref WHERE actor_id=$1`, [actor_id])).rows[0];
      const d = await c.query(
        `UPDATE actor_ref SET contract_id=$1
          WHERE actor_id=$2 AND role='CONTRACTOR_SUPERVISOR' AND status='ACTIVE'
          RETURNING actor_id, person_name`, [req.params.id, actor_id]);
      mustAffect(d, 'Not an active contractor supervisor in your area');
      await c.query(
        `INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id, actor_role,
             area_id, before_value, after_value, reason)
         VALUES ('CONTRACT_SUPERVISOR_NAMED','contract',$1,$2,$3,$4,$5,$6,$7,$8)`,
        [req.params.id, req.claims.actor_id, req.claims.person_id, req.claims.role, ct.rows[0].area_id,
         JSON.stringify({ contract_id: before?.contract_id ?? null }),
         JSON.stringify({ supervisor: d.rows[0].person_name, actor_id }), reason]);
      return d.rows[0];
    });
    // keep the identity record in step; production replicates this
    await withSystem(identityPool, (c) => c.query(
      `UPDATE identity.role_assignment SET contract_id=$1 WHERE id=$2`,
      [req.params.id, actor_id]));
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ *
 * Performance
 *
 * This produces the evidence on which a penalty or liquidated damages
 * decision may be based. It does not compute or apply one; that judgement
 * stays with the department.
 * ------------------------------------------------------------------ */
contracts.get('/contracts/:id/performance', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => {
      const ct = await c.query(
        `SELECT id, contractor_name, agreement_no, starts_on, expires_on,
                handover_cutoff_at, active
           FROM contract WHERE id = $1`, [req.params.id]);
      if (!ct.rowCount) return null;

      const params = [req.params.id];
      let dateFilter = '';
      if (req.query.from) { params.push(req.query.from); dateFilter += ` AND month >= $${params.length}`; }
      if (req.query.to)   { params.push(req.query.to);   dateFilter += ` AND month <= $${params.length}`; }

      const months = await c.query(
        `SELECT * FROM contract_performance
          WHERE contract_id = $1 ${dateFilter}
          ORDER BY month`, params);

      // the whole period, not the sum of monthly percentages
      const overall = await c.query(
        `SELECT count(*) AS tickets_received,
                count(*) FILTER (WHERE t.state='CLOSED') AS tickets_closed,
                count(*) FILTER (WHERE t.state NOT IN ('CLOSED','REJECTED')) AS tickets_open,
                round(100.0 * count(*) FILTER (WHERE t.completion_met)
                      / nullif(count(*) FILTER (WHERE t.completion_met IS NOT NULL),0),1)
                  AS sla_compliance_pct,
                round(avg(extract(epoch FROM t.closed_at - t.verified_at)/3600)::numeric,1)
                  AS avg_closure_hours,
                round(100.0 * count(*) FILTER (WHERE t.rework_count>0)
                      / nullif(count(*),0),1) AS rejection_rate_pct,
                round(100.0 * count(*) FILTER (WHERE t.objection_count>0)
                      / nullif(count(*),0),1) AS objection_rate_pct,
                round(100.0 * count(*) FILTER (WHERE t.reopened_count>0)
                      / nullif(count(*),0),1) AS reopen_rate_pct,
                round(avg(fb.rating)::numeric,2) AS avg_rating
           FROM ticket t
           LEFT JOIN ticket_feedback fb ON fb.ticket_id = t.id
          WHERE t.contract_id = $1`, [req.params.id]);

      const attribution = await c.query(
        `SELECT coalesce(b.attribution::text,'UNATTRIBUTED') AS attribution,
                count(*) AS breaches
           FROM sla_breach b JOIN ticket t ON t.id = b.ticket_id
          WHERE t.contract_id = $1
          GROUP BY 1 ORDER BY 2 DESC`, [req.params.id]);

      const worst = await c.query(
        // every time the fault was reported: each complaint and each
        // reopening of one (user's finding, 2026-10-07 — a complaint
        // reopened four times did not appear when only complaints counted)
        `SELECT p.identifier, s.name_en AS sub_category,
                count(*)::int AS complaints,
                sum(t.reopened_count)::int AS reopenings,
                (count(*) + sum(t.reopened_count))::int AS reports,
                bool_or(EXISTS (SELECT 1 FROM ticket_review r WHERE r.ticket_id = t.id
                                 AND r.kind = 'REPEAT_DISPUTE' AND r.stage = 'WITH_STAFF_OFFICER')) AS pending_staff_officer
           FROM ticket t
           JOIN premises_ref p ON p.premises_id = t.premises_id
           JOIN sub_category s ON s.id = t.sub_category_id
          WHERE t.contract_id = $1
          GROUP BY p.identifier, s.name_en
         HAVING count(*) + sum(t.reopened_count) >= 3
          ORDER BY 5 DESC LIMIT 20`, [req.params.id]);

      return {
        contract: ct.rows[0],
        overall: overall.rows[0],
        by_month: months.rows,
        delay_attribution: attribution.rows,
        repeat_complaints: worst.rows,
        note: 'Evidence only. Penalty and liquidated damages decisions rest ' +
              'with the department.'
      };
    });
    if (!out) return res.status(404).json({ title: 'Not found', status: 404 });
    res.json(out);
  } catch (e) { next(e); }
});

/* CSV, because this goes into a file and onto a desk. */
contracts.get('/contracts/:id/performance.csv', async (req, res, next) => {
  try {
    const rows = await scoped(req, (c) => c.query(
      `SELECT * FROM contract_performance WHERE contract_id=$1 ORDER BY month`,
      [req.params.id]));
    if (!rows.rowCount) return res.status(404).send('No data');
    const cols = Object.keys(rows.rows[0]);
    const esc = (v) => v === null ? ''
      : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const csv = [cols.join(','), ...rows.rows.map((r) => cols.map((k) => esc(r[k])).join(','))]
      .join('\n');
    res.type('text/csv')
       .set('Content-Disposition', `attachment; filename="contract-performance.csv"`)
       .send(csv);
  } catch (e) { next(e); }
});

/* Every Area's live contract side by side — the GM's view. */
contracts.get('/contracts/comparison', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT ct.id, ct.contractor_name, ct.agreement_no, ct.expires_on,
              (ct.expires_on - current_date) AS days_remaining,
              coalesce(p.tickets, 0) AS tickets,
              p.sla_compliance_pct, p.rejection_rate_pct, p.reopen_rate_pct,
              p.avg_rating,
              (SELECT count(*) FROM ticket t
                WHERE t.contract_id = ct.id AND t.state = 'WORK_COMPLETED')
                AS awaiting_inspection
         FROM contract ct
         LEFT JOIN LATERAL (
           SELECT count(*) AS tickets,
                  round(100.0 * count(*) FILTER (WHERE t.completion_met)
                        / nullif(count(*) FILTER (WHERE t.completion_met IS NOT NULL),0),1)
                    AS sla_compliance_pct,
                  round(100.0 * count(*) FILTER (WHERE t.rework_count>0)
                        / nullif(count(*),0),1) AS rejection_rate_pct,
                  round(100.0 * count(*) FILTER (WHERE t.reopened_count>0)
                        / nullif(count(*),0),1) AS reopen_rate_pct,
                  round(avg(fb.rating)::numeric,2) AS avg_rating
             FROM ticket t LEFT JOIN ticket_feedback fb ON fb.ticket_id = t.id
            WHERE t.contract_id = ct.id
         ) p ON true
        WHERE ct.active
        ORDER BY p.sla_compliance_pct NULLS LAST`));
    res.json(out.rows);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ *
 * Handover
 *
 * On expiry or change of contractor, open tickets move to the incoming
 * contract with a clean cut-off. The outgoing record is frozen at that
 * moment and cannot be affected by anything the incoming contractor does
 * — which is the point: a contractor must not inherit blame, or credit.
 * ------------------------------------------------------------------ */
contracts.post('/contracts/:id/handover', async (req, res, next) => {
  try {
    requireManager(req);
    const { to_contract_id } = req.body;
    if (!to_contract_id) throw new Unprocessable('Name the incoming contract');
    if (to_contract_id === req.params.id) throw new Unprocessable('Same contract');

    // Authority and visibility are settled in the caller's own context…
    const checked = await scoped(req, async (c) => {
      const from = await c.query(
        `SELECT id, area_id, contractor_name, handover_cutoff_at
           FROM contract WHERE id=$1`, [req.params.id]);
      const to = await c.query(
        `SELECT id, area_id, contractor_name FROM contract WHERE id=$1`, [to_contract_id]);
      if (!from.rowCount || !to.rowCount) throw new Forbidden('Contract not visible to you');
      if (from.rows[0].handover_cutoff_at) throw new Conflict('Already handed over');
      if (from.rows[0].area_id !== to.rows[0].area_id) {
        throw new Unprocessable('Both contracts must be for the same Area');
      }
      return { from: from.rows[0], to: to.rows[0] };
    });

    // …and the transfer itself runs as the system, because contract
    // attribution belongs to no human role: a ticket's contract is
    // derived, never chosen. The audit entry names the officer who
    // instructed it, which is what makes the act accountable.
    const out = await withSystem(maintPool, async (c) => {
      const from = checked.from, to = checked.to;
      const cutoff = new Date();
      const moved = await c.query(
        `UPDATE ticket SET contract_id = $1
          WHERE contract_id = $2
            AND state NOT IN ('CLOSED','REJECTED')
          RETURNING id`, [to_contract_id, req.params.id]);

      const r = await c.query(
        `UPDATE contract SET handover_cutoff_at = $1, active = false
          WHERE id = $2 RETURNING id`, [cutoff, req.params.id]);
      mustAffect(r, 'Not permitted');

      await c.query(
        `INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id,
             actor_role, area_id, before_value, after_value, reason)
         VALUES ('CONTRACT_HANDOVER','contract',$1,$2,$3,$4,$5,$6,$7)`,
        [req.params.id, req.claims.actor_id, req.claims.role, from.area_id,
         JSON.stringify({ contractor: from.contractor_name }),
         JSON.stringify({ contractor: to.contractor_name,
                          tickets_transferred: moved.rowCount, cutoff }),
         req.body.reason || null]);

      return { from: from.contractor_name, to: to.contractor_name,
        tickets_transferred: moved.rowCount, cutoff_at: cutoff };
    });

    // the outgoing contractor's roles end; their phones stay theirs
    const revoked = await revokeContractRoles(req.params.id, 'Contract handed over');
    res.json({ ...out, roles_revoked: revoked });
  } catch (e) { next(e); }
});

/* A contract ending ends the contractor's and their supervisors' ROLES
   under it. Their devices are untouched: a supervisor who also lives in a
   colony keeps their resident page. */
async function revokeContractRoles(contractId, reason) {
  const roles = await withSystem(maintPool, (c) => c.query(
    `UPDATE actor_ref SET status='REVOKED'
      WHERE contract_id=$1 AND status='ACTIVE' RETURNING actor_id`, [contractId]));
  for (const r of roles.rows) {
    await withSystem(identityPool, (c) => c.query(
      `UPDATE identity.role_assignment
          SET status='REVOKED', revoked_at=now(), revocation_reason=$1
        WHERE id=$2 AND status='ACTIVE'`, [reason, r.actor_id]));
  }
  return roles.rowCount;
}

/* ------------------------------------------------------------------ *
 * Expiry sweep
 *
 * Warns at thirty days, and revokes on the day. A contractor whose
 * agreement has ended should not still be able to claim completions.
 * ------------------------------------------------------------------ */
export async function runContractSweep({ quiet = false } = {}) {
  const warned = await withSystem(maintPool, (c) => c.query(
    `SELECT id, area_id, scope_path::text AS scope, contractor_name, agreement_no,
            expires_on, (expires_on - current_date) AS days
       FROM contract
      WHERE active AND expires_on BETWEEN current_date AND current_date + 30`));
  for (const ct of warned.rows) {
    for (const role of ['STAFF_OFFICER_CIVIL', 'MAINTENANCE_INCHARGE', 'GM_CIVIL']) {
      await notify({ role, scope: ct.scope, event: 'CONTRACT_EXPIRING',
        en: [`Contract expiring in ${ct.days} days`,
             `${ct.contractor_name} — ${ct.agreement_no}`],
        hi: [`संविदा ${ct.days} दिन में समाप्त`,
             `${ct.contractor_name} — ${ct.agreement_no}`] });
    }
  }

  const expired = await withSystem(maintPool, (c) => c.query(
    `UPDATE contract SET active = false
      WHERE active AND expires_on < current_date
      RETURNING id, contractor_name, scope_path::text AS scope`));
  let revoked = 0;
  for (const ct of expired.rows) {
    revoked += await revokeContractRoles(ct.id, 'Contract expired');
    await notify({ role: 'STAFF_OFFICER_CIVIL', scope: ct.scope,
      event: 'CONTRACT_EXPIRED',
      en: ['Contract expired', `${ct.contractor_name}. Contractor roles ended.`],
      hi: ['संविदा समाप्त', `${ct.contractor_name}। ठेकेदार भूमिकाएँ समाप्त।`] });
  }

  const summary = { expiring_soon: warned.rowCount, expired: expired.rowCount,
    roles_revoked: revoked };
  if (!quiet) console.log('[contract-sweep]', JSON.stringify(summary));
  return summary;
}

contracts.use((err, req, res, _next) => {
  const mapped = mapDbError(err);
  const status = err.status || mapped?.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({
    title: status === 403 ? 'Not permitted' : status === 404 ? 'Not found'
         : status === 422 ? 'Cannot do that' : 'Error', status,
    detail: err.status ? err.message : (mapped?.detail || 'Unexpected error') });
});
