import express from 'express';
import { identityPool, maintPool, withScope, withSystem, mustAffect,
         mapDbError, Forbidden, Conflict, Unprocessable } from './db.js';
import crypto from 'node:crypto';
import { requireAuth, issueRegistrationToken, verifyRegistrationToken, spendRegistrationToken, switchRole, EMPLOYEE_ID } from './auth.js';
import { notify } from './notify.js';

export const identityApi = express.Router();
const scoped = (req, fn) => withScope(identityPool, req.claims, fn);

/* Who approves what (decisions 2026-09-25 and 2026-09-30):
   - a person registers a DEVICE, and may ask for an OCCUPANT role at a
     quarter or building. The Incharge verifies occupants (FRS 4.4); the
     Area administrators may too.
   - every other role is ASSIGNED by an Area administrator, below their
     own rank and within their Area — never self-requested. The database
     enforces the same (enforce_assignment_authority). */
const OCCUPANT_ROLES = ['RESIDENT', 'CUSTODIAN'];
const AREA_ADMINS = ['AREA_HR_ADMIN', 'AREA_SYS_ADMIN', 'ADMINISTRATOR'];
const OCCUPANT_APPROVERS = ['MAINTENANCE_INCHARGE', ...AREA_ADMINS];

async function audit(c, req, event, entityType, entityId, { before, after, reason, areaId } = {}) {
  await c.query(
    `INSERT INTO identity.audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id,
         actor_role, area_id, before_value, after_value, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [event, entityType, entityId, req?.claims?.actor_id ?? null, req?.claims?.person_id ?? null,
     req?.claims?.role ?? null, areaId ?? null, before ? JSON.stringify(before) : null,
     after ? JSON.stringify(after) : null, reason ?? null]);
}
const areaOfScope = (c, scope) => c.query(
  `SELECT id FROM identity.area WHERE $1::ltree <@ scope_path LIMIT 1`, [scope]).then((r) => r.rows[0]?.id ?? null);

/* ------------------------------------------------------------------ *
 * Public: colonies, registration, OTP
 * ------------------------------------------------------------------ */
export const publicApi = express.Router();

publicApi.get('/masters/colonies', async (req, res, next) => {
  try {
    const out = await withSystem(identityPool, (c) => c.query(
      `SELECT col.id, col.name, a.name AS area,
              EXISTS (SELECT 1 FROM identity.sector s WHERE s.colony_id = col.id AND s.verified) AS has_sectors
         FROM identity.colony col JOIN identity.area a ON a.id = col.area_id ORDER BY a.name`));
    res.json(out.rows);
  } catch (e) { next(e); }
});

/* The thirteen Areas, with the scope a role in each is held at. Public, like
   the colonies: names and codes the department already prints on files. */
publicApi.get('/masters/areas', async (req, res, next) => {
  try {
    const out = await withSystem(identityPool, (c) => c.query(
      `SELECT id, code, ticket_code, name, scope_path::text FROM identity.area ORDER BY name`));
    res.json(out.rows);
  } catch (e) { next(e); }
});

/* Buildings a custodian may register against (decision 2026-09-30). */
publicApi.get('/masters/buildings', async (req, res, next) => {
  try {
    if (!req.query.colony_id) throw new Unprocessable('Which colony?');
    const out = await withSystem(identityPool, (c) => c.query(
      `SELECT id, identifier, premises_type::text FROM identity.premises
        WHERE colony_id = $1 AND premises_type <> 'QUARTER' ORDER BY identifier`, [req.query.colony_id]));
    res.json(out.rows);
  } catch (e) { next(e); }
});

publicApi.post('/registrations', async (req, res, next) => {
  try {
    const { public_key, platform = 'android', name, personnel_no, colony_id, sector, no_sector,
            identifier, premises_type = 'QUARTER', role = null, resident_category } = req.body;
    if (!public_key || !name || !colony_id) throw new Unprocessable('Name and colony are required');
    // Only an occupant role can be asked for; every other role is assigned
    // by an Area administrator (decision 2026-09-30).
    if (role && !OCCUPANT_ROLES.includes(role)) {
      throw new Unprocessable('Only a resident or custodian role can be asked for here. Official roles are assigned by your Area administrator.');
    }
    if (role && !identifier) throw new Unprocessable('Give the quarter number or building');
    checkEmployeeId(personnel_no);
    // FRS 4.4 step 2: the handset proves it holds the mobile number.
    const otp = verifyRegistrationToken(req.get('x-registration-token'));
    if (!otp) throw new Unprocessable('Verify your mobile number first');
    const mobile = otp.mobile;

    const out = await withScope(identityPool, { role: 'AUTH' }, async (c) => {
      const dup = await c.query(`SELECT id FROM identity.device WHERE public_key = $1`, [public_key]);
      if (dup.rowCount) throw new Conflict('This device is already registered');
      // one OTP, one phone (open defect 8)
      if (!(await spendRegistrationToken(c, otp))) throw new Unprocessable('That verification has been used already. Verify your mobile number again.');
      const col = (await c.query(`SELECT id, scope_path::text FROM identity.colony WHERE id = $1`, [colony_id])).rows[0];
      if (!col) throw new Unprocessable('Unknown colony');

      // A person the Area HR office has already entered is found by the
      // mobile they proved; anyone else becomes a new person.
      // The name typed is then not the person's: answer, and notify, in the
      // real name, and say the phone joined them (user's finding, 2026-10-12)
      let person = (await c.query(`SELECT id, name FROM identity.person WHERE mobile = $1 ORDER BY created_at LIMIT 1`, [mobile])).rows[0];
      const existing = !!person;
      if (!person) {
        const cat = resident_category || (personnel_no ? 'NCL' : 'NON_NCL');
        person = (await c.query(
          `INSERT INTO identity.person (name, personnel_no, mobile, is_employee, resident_category)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [name, personnel_no || null, mobile, cat === 'NCL', cat])).rows[0];
        person.name = name;
      }
      const d = (await c.query(
        `INSERT INTO identity.device (public_key, platform, person_id, scope_path, status)
         VALUES ($1,$2,$3,$4,'PENDING') RETURNING id, status`,
        [public_key, platform, person.id, col.scope_path])).rows[0];
      if (role) {
        await c.query(
          `INSERT INTO identity.role_assignment (person_id, role, scope_path, status,
               submitted_colony_id, submitted_sector, submitted_identifier)
           VALUES ($1,$2,$3,'PENDING',$4,$5,$6)`,
          [person.id, role, col.scope_path, colony_id, no_sector ? null : (sector || null), identifier]);
      }
      return { ...d, name: person.name, existing_person: existing, role, scope: col.scope_path, submitted: { identifier, sector: no_sector ? null : sector } };
    });

    await notify({ role: role ? 'MAINTENANCE_INCHARGE' : 'AREA_SYS_ADMIN', scope: out.scope,
      event: 'REGISTRATION_SUBMITTED',
      en: [`New registration: ${out.name}`, role ? `${identifier} — waiting for your check` : 'A device waiting for approval'],
      hi: [`नया पंजीकरण: ${out.name}`, role ? `${identifier} — आपकी जाँच बाकी है` : 'डिवाइस अनुमोदन हेतु'] });
    delete out.scope;
    res.status(201).json(out);
  } catch (e) { next(e); }
});

publicApi.post('/auth/otp/request', async (req, res, next) => {
  try {
    const mobile = String(req.body?.mobile || '');
    if (!/^[6-9][0-9]{9}$/.test(mobile)) throw new Unprocessable('Not a mobile number');
    const out = await withSystem(identityPool, async (c) => {
      const recent = await c.query(
        `SELECT count(*) n FROM identity.otp_request WHERE mobile=$1 AND created_at > now() - interval '1 hour'`, [mobile]);
      if (Number(recent.rows[0].n) >= 3) {
        throw Object.assign(new Error('Too many requests. Try again later.'), { status: 429 });
      }
      const code = String(crypto.randomInt(100000, 1000000));
      const hash = crypto.createHash('sha256').update(code).digest('hex');
      const ttl = Number((await c.query(`SELECT value FROM identity.config WHERE key='otp_ttl_minutes'`)).rows[0]?.value || 10);
      await c.query(
        `INSERT INTO identity.otp_request (mobile, code_hash, expires_at)
         VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`, [mobile, hash, ttl]);
      // No SMS gateway yet: outside production the code comes back so the
      // flow can be exercised. This must go when a gateway is connected.
      return { sent: true, expires_in_minutes: ttl, dev_code: process.env.NODE_ENV === 'production' ? undefined : code };
    });
    res.status(202).json(out);
  } catch (e) { next(e); }
});

publicApi.post('/auth/otp/verify', async (req, res, next) => {
  try {
    const { mobile, code } = req.body || {};
    const out = await withSystem(identityPool, async (c) => {
      const hash = crypto.createHash('sha256').update(String(code || '')).digest('hex');
      const r = await c.query(
        `UPDATE identity.otp_request SET consumed_at = now()
          WHERE id = (SELECT id FROM identity.otp_request
                       WHERE mobile=$1 AND code_hash=$2 AND consumed_at IS NULL
                         AND expires_at > now() AND attempts < 5
                       ORDER BY created_at DESC LIMIT 1)
          RETURNING id`, [mobile, hash]);
      if (!r.rowCount) {
        // Counted, and the count is kept: the refusal is returned, not
        // thrown, so the transaction commits. Thrown, it rolled the count
        // back and the five-attempt limit never bit — a six-digit code could
        // be guessed without end (break-it pass, 2026-10-08).
        await c.query(`UPDATE identity.otp_request SET attempts = attempts + 1 WHERE mobile=$1 AND consumed_at IS NULL`, [mobile]);
        return { wrong: true };
      }
      return { registration_token: issueRegistrationToken(mobile, r.rows[0].id), expires_at: new Date(Date.now() + 30 * 60_000).toISOString() };
    });
    if (out.wrong) throw new Unprocessable('That code is wrong or has expired');
    res.json(out);
  } catch (e) { next(e); }
});

publicApi.get('/masters/sectors', async (req, res, next) => {
  try {
    if (!req.query.colony_id) throw new Unprocessable('Which colony?');
    const out = await withSystem(identityPool, (c) => c.query(
      `SELECT id, name FROM identity.sector WHERE colony_id=$1 AND verified ORDER BY name`, [req.query.colony_id]));
    res.json(out.rows);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ *
 * Signed in
 * ------------------------------------------------------------------ */
identityApi.use(requireAuth);

/* Who am I, in which role, and what other roles can I switch to. */
identityApi.get('/me', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => {
      const me = (await c.query(
        `SELECT p.id AS person_id, p.name AS person_name, p.personnel_no, p.designation, p.resident_category,
                p.mobile, (p.password_hash IS NOT NULL) AS has_password
           FROM identity.person p WHERE p.id = $1`, [req.claims.person_id])).rows[0];
      if (!me) return null;
      const roles = (await c.query(
        `SELECT a.id, a.role::text, a.scope_path::text, a.designation, a.acting, a.valid_to,
                pr.identifier, pr.premises_type::text, pr.quarter_type::text, col.name AS colony, ar.name AS area,
                ar.ticket_code
           FROM identity.role_assignment a
           LEFT JOIN identity.premises pr ON pr.id = a.premises_id
           LEFT JOIN identity.colony col ON col.id = pr.colony_id
           LEFT JOIN identity.area ar ON a.scope_path <@ ar.scope_path
          WHERE a.person_id = $1 AND identity.assignment_in_force(a)
          ORDER BY (a.role IN ('RESIDENT','CUSTODIAN')) DESC, a.role`, [req.claims.person_id])).rows
        // a contractor's web session lists only the roles it can reach (2026-10-16)
        .filter((r) => !req.claims.only || req.claims.only.includes(r.role));
      const current = roles.find((r) => r.id === req.claims.actor_id) || {};
      return { ...me, actor_id: req.claims.actor_id, role: req.claims.role, scope_path: req.claims.scope_path,
        auth_method: req.claims.amr, device_id: req.claims.device_id,
        premises_id: req.claims.premises_id, identifier: current.identifier, premises_type: current.premises_type,
        quarter_type: current.quarter_type, colony: current.colony, area: current.area, ticket_code: current.ticket_code,
        designation: current.designation || me.designation, roles,
        // accountable roles unlock with PIN or biometric in the app (decision 15)
        requires_second_factor: (await c.query(
          `SELECT accountable FROM identity.role_level WHERE role::text = $1`, [req.claims.role])).rows[0]?.accountable ?? false,
        // every official has a resident page (decision 2026-09-30): say so
        // plainly when no quarter has been recorded yet
        resident_page: roles.some((r) => OCCUPANT_ROLES.includes(r.role)) ? 'available'
          : me.resident_category === 'NCL' && roles.length ? 'no quarter recorded — ask your Area HR office' : 'none' };
    });
    if (!out) return res.status(404).json({ title: 'Not found', status: 404 });
    res.json(out);
  } catch (e) { next(e); }
});

/* Switch to another of one's own roles, on the same sign-in. */
identityApi.post('/auth/switch-role', async (req, res, next) => {
  try {
    const r = await switchRole(req.claims, req.body || {});
    res.status(r.token ? 200 : 403).json(r.token ? r : { title: 'Not permitted', status: 403, detail: r.error });
  } catch (e) { next(e); }
});

identityApi.get('/devices', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT d.id, d.platform, d.scope_path::text, d.status::text, d.person_id, d.last_seen_at,
              d.created_at, d.approved_at, d.revoked_at,
              d.revocation_reason, pe.name AS person_name, pe.personnel_no,
              (SELECT string_agg(a.role::text, ', ' ORDER BY a.role) FROM identity.role_assignment a
                WHERE a.person_id = d.person_id AND identity.assignment_in_force(a)) AS roles
         FROM identity.device d JOIN identity.person pe ON pe.id = d.person_id
        WHERE ($1::uuid IS NULL OR d.person_id = $1)
          AND ($2::text IS NULL OR d.status::text = $2)
        ORDER BY d.created_at DESC LIMIT 300`,
      [req.query.person_id || null, req.query.status || null]));
    res.json(out.rows);
  } catch (e) { next(e); }
});

identityApi.get('/premises', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT p.id, p.identifier, p.premises_type::text, p.quarter_type::text,
              p.occupancy_model::text, p.verified, col.name AS colony, col.id AS colony_id,
              a.name AS area, a.ticket_code
         FROM identity.premises p
         JOIN identity.colony col ON col.id = p.colony_id
         JOIN identity.area a ON a.id = p.area_id
        WHERE ($1::text IS NULL OR p.identifier ILIKE '%' || $1 || '%')
          AND ($2::uuid IS NULL OR p.colony_id = $2)
        ORDER BY p.identifier LIMIT 300`,
      [req.query.q || null, req.query.colony_id || null]));
    res.json({ items: out.rows, total: out.rows.length });
  } catch (e) { next(e); }
});

identityApi.get('/premises/:id', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT p.*, col.name AS colony, a.name AS area, a.ticket_code
         FROM identity.premises p
         JOIN identity.colony col ON col.id = p.colony_id
         JOIN identity.area a ON a.id = p.area_id
        WHERE p.id = $1`, [req.params.id]));
    if (!out.rowCount) return res.status(404).json({ title: 'Not found', status: 404 });
    res.json(out.rows[0]);
  } catch (e) { next(e); }
});

/* Quarters and buildings are kept by the Area HR office too. */
identityApi.post('/premises', async (req, res, next) => {
  try {
    const { colony_id, identifier, premises_type = 'QUARTER', quarter_type = null, occupancy_model } = req.body || {};
    if (!colony_id || !identifier) throw new Unprocessable('Colony and identifier are required');
    const occ = occupancy_model || (premises_type === 'QUARTER' ? 'RESIDENT_BOUND' : 'DEPARTMENT_ONLY');
    const out = await scoped(req, async (c) => {
      const col = (await c.query(`SELECT id, area_id, scope_path FROM identity.colony WHERE id=$1`, [colony_id])).rows[0];
      if (!col) throw new Unprocessable('Unknown colony');
      const r = (await c.query(
        `INSERT INTO identity.premises (area_id, colony_id, scope_path, identifier, premises_type, quarter_type,
             occupancy_model, verified, verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,now()) RETURNING id, identifier`,
        [col.area_id, colony_id, col.scope_path, identifier.trim(), premises_type, quarter_type, occ])).rows[0];
      await audit(c, req, 'PREMISES_CREATED', 'premises', r.id, { after: { identifier, premises_type, quarter_type, occ }, areaId: col.area_id });
      return r;
    });
    await syncPremises(out.id);
    res.status(201).json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ *
 * Registration queue — devices and occupant requests
 * ------------------------------------------------------------------ */
identityApi.get('/registrations', async (req, res, next) => {
  try {
    const status = req.query.status || 'PENDING';
    const role = req.claims.role;
    if (!OCCUPANT_APPROVERS.includes(role)) return res.json({ items: [], total: 0 });
    const out = await scoped(req, (c) => c.query(
      `SELECT d.id, d.status::text, d.created_at, d.platform, d.scope_path::text,
              a.id AS assignment_id, a.role::text AS role, a.submitted_sector, a.submitted_identifier,
              p.name, p.personnel_no, p.mobile, p.resident_category,
              col.name AS colony, col.id AS colony_id,
              (SELECT string_agg(x.role::text, ', ') FROM identity.role_assignment x
                WHERE x.person_id = p.id AND identity.assignment_in_force(x)) AS existing_roles,
              round(extract(epoch FROM now() - d.created_at)/3600) AS waiting_hours,
              EXISTS (SELECT 1 FROM identity.premises pr
                       JOIN identity.role_assignment oa ON oa.premises_id = pr.id AND oa.status='ACTIVE'
                      WHERE pr.colony_id = a.submitted_colony_id
                        AND lower(pr.identifier) = lower(a.submitted_identifier)) AS already_claimed
         FROM identity.device d
         JOIN identity.person p ON p.id = d.person_id
         LEFT JOIN identity.role_assignment a ON a.person_id = d.person_id AND a.status = 'PENDING'
         LEFT JOIN identity.colony col ON col.id = coalesce(a.submitted_colony_id,
              (SELECT id FROM identity.colony WHERE scope_path = d.scope_path))
        WHERE d.status::text = $1
          -- the Incharge verifies occupants and the phones of the
          -- contractor supervisors they appointed; every other official's
          -- phone goes to the Area administrators
          AND ($2 OR a.role IN ('RESIDENT','CUSTODIAN')
               OR (a.id IS NULL AND EXISTS (SELECT 1 FROM identity.role_assignment s
                     WHERE s.person_id = d.person_id AND s.status = 'ACTIVE' AND s.role = 'CONTRACTOR_SUPERVISOR'
                       AND s.scope_path <@ identity.current_scope())))
        ORDER BY d.created_at`, [status, AREA_ADMINS.includes(role)]));
    res.json({ items: out.rows, total: out.rows.length });
  } catch (e) { next(e); }
});

identityApi.post('/registrations/:id/refer-site-check', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => {
      const r = await c.query(
        `SELECT a.submitted_identifier, col.scope_path::text AS scope
           FROM identity.device d
           JOIN identity.role_assignment a ON a.person_id = d.person_id AND a.status='PENDING'
           LEFT JOIN identity.colony col ON col.id = a.submitted_colony_id
          WHERE d.id=$1 AND d.status='PENDING'`, [req.params.id]);
      if (!r.rowCount) throw new Forbidden('Not a pending registration you can act on');
      return r.rows[0];
    });
    await notify({ role: 'CIVIL_OVERSEER', scope: out.scope, event: 'SITE_CHECK_REQUESTED',
      en: ['Site check requested', `Confirm quarter ${out.submitted_identifier}`],
      hi: ['स्थल जाँच अपेक्षित', `क्वार्टर ${out.submitted_identifier} की पुष्टि करें`] });
    res.json({ ok: true, referred: out.submitted_identifier });
  } catch (e) { next(e); }
});

/* The quarter or building an occupant role is bound to, as the approving
   Incharge confirms it: a quarter is recorded (verified) if new; a custodian
   is bound to a building already on the list. Shared by a new phone's
   registration and a home added by someone already signed in. */
async function bindOccupant(c, role, colonyId, colonyScope, areaId, submittedIdentifier, submittedSector,
                            { corrected_identifier, corrected_sector, premises_type, quarter_type }) {
  let premises;
  const ptype = premises_type || (role === 'CUSTODIAN' ? null : 'QUARTER');
  const identifier = (corrected_identifier || submittedIdentifier).trim();
  const sector = corrected_sector ?? submittedSector;
  let sectorId = null;
  if (sector && role === 'RESIDENT') {
    sectorId = (await c.query(
      `INSERT INTO identity.sector (colony_id, name, scope_path, verified) VALUES ($1,$2,$3,true)
       ON CONFLICT (colony_id, name) DO UPDATE SET verified = true RETURNING id`,
      [colonyId, sector.trim(),
       `${colonyScope}.${sector.trim().toLowerCase().replace(/[^a-z0-9]/g, '')}`])).rows[0].id;
  }
  if (role === 'RESIDENT') {
    if (!quarter_type) throw new Unprocessable('Give the quarter type (A, B, C, D or MQ)');
    premises = (await c.query(
      `INSERT INTO identity.premises (area_id, colony_id, sector_id, scope_path, identifier,
       premises_type, quarter_type, occupancy_model, verified, verified_at)
       VALUES ($1,$2,$3,$4,$5,'QUARTER',$6,'RESIDENT_BOUND',true,now())
       ON CONFLICT (colony_id, identifier) DO UPDATE SET verified = true, verified_at = now()
       RETURNING id, identifier`,
      [areaId, colonyId, sectorId, colonyScope, identifier, quarter_type])).rows[0];
  } else {
    // a custodian is bound to an existing building, which becomes
    // custodian-bound (decision 2026-09-30)
    const b = (await c.query(
      `UPDATE identity.premises SET occupancy_model = 'CUSTODIAN_BOUND'
        WHERE colony_id = $1 AND lower(identifier) = lower($2) AND premises_type <> 'QUARTER'
        RETURNING id, identifier`, [colonyId, identifier])).rows[0];
    if (!b) throw new Unprocessable(`No building named “${identifier}” in this colony. Add it first, or correct the name.`);
    premises = b;
    void ptype;
  }
  return premises;
}

identityApi.post('/registrations/:id/approve', async (req, res, next) => {
  try {
    const { corrected_identifier, corrected_sector, premises_type, quarter_type = null } = req.body || {};
    const out = await scoped(req, async (c) => {
      const d = (await c.query(
        `SELECT d.*, a.id AS assignment_id, a.role::text AS req_role, a.submitted_colony_id, a.submitted_sector,
                a.submitted_identifier, col.area_id, col.scope_path::text AS colony_scope
           FROM identity.device d
           LEFT JOIN identity.role_assignment a ON a.person_id = d.person_id AND a.status = 'PENDING'
           LEFT JOIN identity.colony col ON col.id = a.submitted_colony_id
          WHERE d.id = $1 AND d.status = 'PENDING'`, [req.params.id])).rows[0];
      if (!d) throw new Forbidden('Not a pending registration you can act on');
      if (d.person_id === req.claims.person_id) throw new Forbidden('Nobody may approve their own registration');
      const occupant = OCCUPANT_ROLES.includes(d.req_role);
      // the Incharge may approve a supervisor's phone; the database checks
      // that the person holds no other official role
      if (!occupant && !AREA_ADMINS.includes(req.claims.role) && req.claims.role !== 'MAINTENANCE_INCHARGE') {
        throw new Forbidden('Devices of officials and contractors are approved by the Area administrator');
      }
      if (occupant && !OCCUPANT_APPROVERS.includes(req.claims.role)) throw new Forbidden('Not a registration you can approve');

      let premises = null;
      if (occupant) {
        premises = await bindOccupant(c, d.req_role, d.submitted_colony_id, d.colony_scope, d.area_id,
          d.submitted_identifier, d.submitted_sector, { corrected_identifier, corrected_sector, premises_type, quarter_type });
        mustAffect(await c.query(
          `UPDATE identity.role_assignment SET status='ACTIVE', premises_id=$1, approved_by=$2, approved_at=now()
            WHERE id=$3 AND status='PENDING' RETURNING id`, [premises.id, req.claims.actor_id, d.assignment_id]),
          'Not permitted to approve this role');
      }
      mustAffect(await c.query(
        `UPDATE identity.device SET status='ACTIVE', approved_at=now(), approved_by=$1
          WHERE id=$2 AND status='PENDING' RETURNING id`, [req.claims.actor_id, req.params.id]),
        'Not permitted to approve this device');
      await audit(c, req, 'DEVICE_APPROVED', 'device', req.params.id,
        { after: { role: d.req_role, premises: premises?.identifier,
                   corrected: premises && premises.identifier !== d.submitted_identifier }, areaId: d.area_id });
      return { id: req.params.id, person_id: d.person_id, role: d.req_role, premises,
        corrected: !!premises && premises.identifier !== d.submitted_identifier };
    });
    await syncPerson(out.person_id);
    await notifyPerson(out.person_id, 'REGISTRATION_APPROVED',
      ['Your registration is approved', out.premises ? `${out.premises.identifier} — you can now report problems` : 'This device is now active'],
      ['आपका पंजीकरण स्वीकृत', out.premises ? `${out.premises.identifier} — अब आप शिकायत दर्ज कर सकते हैं` : 'यह डिवाइस अब सक्रिय है']);
    res.json(out);
  } catch (e) { next(e); }
});

identityApi.post('/registrations/:id/reject', async (req, res, next) => {
  try {
    if (!req.body?.reason) throw new Unprocessable('A reason is required, and the applicant sees it');
    const personId = await scoped(req, async (c) => {
      const d = (await c.query(
        `SELECT d.person_id, a.role::text AS req_role FROM identity.device d
           LEFT JOIN identity.role_assignment a ON a.person_id = d.person_id AND a.status='PENDING'
          WHERE d.id=$1 AND d.status='PENDING'`, [req.params.id])).rows[0];
      if (!d) throw new Forbidden('Not a pending registration you can act on');
      const occupant = OCCUPANT_ROLES.includes(d.req_role);
      if (!(occupant ? OCCUPANT_APPROVERS : AREA_ADMINS).includes(req.claims.role)) {
        throw new Forbidden('Not a registration you can act on');
      }
      mustAffect(await c.query(
        `UPDATE identity.device SET status='REJECTED', rejected_reason=$1 WHERE id=$2 AND status='PENDING' RETURNING id`,
        [req.body.reason, req.params.id]), 'Not permitted to reject this registration');
      await c.query(`UPDATE identity.role_assignment SET status='REJECTED', rejected_reason=$1
                      WHERE person_id=$2 AND status='PENDING'`, [req.body.reason, d.person_id]);
      await audit(c, req, 'DEVICE_REJECTED', 'device', req.params.id, { reason: req.body.reason });
      return d.person_id;
    });
    await notifyPerson(personId, 'REGISTRATION_REJECTED',
      ['Your registration was not accepted', req.body.reason], ['आपका पंजीकरण स्वीकार नहीं हुआ', req.body.reason]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ *
 * A home added by someone already signed in (user's request, 2026-10-13):
 * a contractor supervisor of one Area who lives, as a Non-NCL resident, in
 * another; an official whose quarter is in another colony. Their phone is
 * approved already, so no new phone and no new OTP: they ask for the
 * occupant role, and the Incharge (or Area administrator) of that colony's
 * Area checks the quarter and approves the role alone, as for a new
 * resident. Only an occupant role can be asked for; official roles stay
 * with the Area administrators.
 * ------------------------------------------------------------------ */
const HOME_COLS = `a.id, a.role::text AS role, a.status::text AS status, a.submitted_identifier AS identifier,
       a.submitted_sector AS sector, a.rejected_reason, a.created_at, a.approved_at,
       col.name AS colony, ar.name AS area, pr.identifier AS premises`;
const HOME_FROM = `FROM identity.role_assignment a
       LEFT JOIN identity.colony col ON col.id = a.submitted_colony_id
       LEFT JOIN identity.area ar ON ar.id = col.area_id
       LEFT JOIN identity.premises pr ON pr.id = a.premises_id`;

identityApi.get('/me/homes', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT ${HOME_COLS} ${HOME_FROM}
        WHERE a.person_id = identity.current_person() AND a.role IN ('RESIDENT','CUSTODIAN')
          AND a.submitted_colony_id IS NOT NULL
        ORDER BY a.created_at DESC`));
    res.json({ items: out.rows });
  } catch (e) { next(e); }
});

identityApi.post('/me/homes', async (req, res, next) => {
  try {
    const { colony_id, role = 'RESIDENT', identifier, sector, no_sector } = req.body || {};
    if (!OCCUPANT_ROLES.includes(role)) {
      throw new Unprocessable('Only a home can be added here: a resident\'s quarter or a custodian\'s building. Official roles are assigned by the Area administrator.');
    }
    if (!identifier || !String(identifier).trim()) throw new Unprocessable('Give the quarter number or building');
    if (!colony_id) throw new Unprocessable('Choose the colony');
    const personId = req.claims.person_id;
    const where = String(identifier).trim();
    const out = await withScope(identityPool, { role: 'AUTH' }, async (c) => {
      const col = (await c.query(`SELECT id, name, scope_path::text FROM identity.colony WHERE id::text = $1`, [String(colony_id)])).rows[0];
      if (!col) throw new Unprocessable('Unknown colony');
      const waiting = await c.query(
        `SELECT 1 FROM identity.role_assignment WHERE person_id = $1 AND status = 'PENDING' AND role IN ('RESIDENT','CUSTODIAN')`, [personId]);
      if (waiting.rowCount) throw new Conflict('A request for a home is already waiting for approval');
      const held = await c.query(
        `SELECT 1 FROM identity.role_assignment a JOIN identity.premises p ON p.id = a.premises_id
          WHERE a.person_id = $1 AND identity.assignment_in_force(a) AND p.colony_id = $2 AND lower(p.identifier) = lower($3)`,
        [personId, col.id, where]);
      if (held.rowCount) throw new Conflict('This is already one of your homes');
      const a = (await c.query(
        `INSERT INTO identity.role_assignment (person_id, role, scope_path, status, reason,
             submitted_colony_id, submitted_sector, submitted_identifier)
         VALUES ($1,$2,$3,'PENDING','Home added by the person',$4,$5,$6) RETURNING id, created_at`,
        [personId, role, col.scope_path, col.id, no_sector ? null : (sector || null), where])).rows[0];
      return { id: a.id, status: 'PENDING', role, colony: col.name, identifier: where, created_at: a.created_at, scope: col.scope_path };
    });
    await notify({ role: 'MAINTENANCE_INCHARGE', scope: out.scope, event: 'REGISTRATION_SUBMITTED',
      en: ['A home to approve', `${out.identifier} — asked for by someone already registered`],
      hi: ['स्वीकृति हेतु आवास', `${out.identifier} — पहले से पंजीकृत व्यक्ति का अनुरोध`] });
    const { scope, ...body } = out; void scope;
    res.status(201).json(body);
  } catch (e) { next(e); }
});

/* The approver's list: homes asked for in the caller's Area by people
   already registered (a new phone's request stays in /registrations). */
identityApi.get('/home-requests', async (req, res, next) => {
  try {
    if (!OCCUPANT_APPROVERS.includes(req.claims.role)) return res.json({ items: [] });
    const out = await scoped(req, (c) => c.query(
      `SELECT ${HOME_COLS}, a.submitted_colony_id AS colony_id, p.name, p.mobile, p.resident_category,
              (SELECT string_agg(x.role::text, ', ') FROM identity.role_assignment x
                WHERE x.person_id = p.id AND identity.assignment_in_force(x)
                  AND x.scope_path <@ identity.current_scope()) AS existing_roles,
              EXISTS (SELECT 1 FROM identity.premises pp
                       JOIN identity.role_assignment oa ON oa.premises_id = pp.id AND oa.status='ACTIVE'
                      WHERE pp.colony_id = a.submitted_colony_id
                        AND lower(pp.identifier) = lower(a.submitted_identifier)) AS already_claimed
         ${HOME_FROM}
         JOIN identity.person p ON p.id = a.person_id
        WHERE a.status = 'PENDING' AND a.role IN ('RESIDENT','CUSTODIAN')
          AND a.scope_path <@ identity.current_scope()
          AND a.person_id <> identity.current_person()
          AND NOT EXISTS (SELECT 1 FROM identity.device d WHERE d.person_id = a.person_id AND d.status = 'PENDING')
        ORDER BY a.created_at`));
    res.json({ items: out.rows });
  } catch (e) { next(e); }
});

async function pendingHome(c, req) {
  if (!OCCUPANT_APPROVERS.includes(req.claims.role)) throw new Forbidden('Not a request you can act on');
  const a = (await c.query(
    `SELECT a.*, a.role::text AS role, col.area_id, col.scope_path::text AS colony_scope
       FROM identity.role_assignment a JOIN identity.colony col ON col.id = a.submitted_colony_id
      WHERE a.id::text = $1 AND a.status = 'PENDING' AND a.role IN ('RESIDENT','CUSTODIAN')
        AND a.scope_path <@ identity.current_scope()`, [req.params.id])).rows[0];
  if (!a) throw new Forbidden('Not a request you can act on');
  if (a.person_id === req.claims.person_id) throw new Forbidden('Nobody may approve their own request');
  return a;
}

identityApi.post('/home-requests/:id/approve', async (req, res, next) => {
  try {
    const { corrected_identifier, corrected_sector, quarter_type = null } = req.body || {};
    const out = await scoped(req, async (c) => {
      const a = await pendingHome(c, req);
      const premises = await bindOccupant(c, a.role, a.submitted_colony_id, a.colony_scope, a.area_id,
        a.submitted_identifier, a.submitted_sector, { corrected_identifier, corrected_sector, quarter_type });
      mustAffect(await c.query(
        `UPDATE identity.role_assignment SET status='ACTIVE', premises_id=$1, approved_by=$2, approved_at=now()
          WHERE id=$3 AND status='PENDING' RETURNING id`, [premises.id, req.claims.actor_id, a.id]),
        'Not permitted to approve this role');
      await audit(c, req, 'HOME_APPROVED', 'role_assignment', a.id,
        { after: { role: a.role, premises: premises.identifier, corrected: premises.identifier !== a.submitted_identifier }, areaId: a.area_id });
      return { id: a.id, person_id: a.person_id, role: a.role, premises,
        corrected: premises.identifier !== a.submitted_identifier };
    });
    await syncPerson(out.person_id);
    await notifyPerson(out.person_id, 'REGISTRATION_APPROVED',
      ['Your home is approved', `${out.premises.identifier} — choose it from your roles to report problems`],
      ['आपका आवास स्वीकृत', `${out.premises.identifier} — शिकायत दर्ज करने के लिए इसे अपनी भूमिकाओं में चुनें`]);
    const { person_id, ...body } = out; void person_id;
    res.json(body);
  } catch (e) { next(e); }
});

identityApi.post('/home-requests/:id/reject', async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw new Unprocessable('A reason is required, and the applicant sees it');
    const personId = await scoped(req, async (c) => {
      const a = await pendingHome(c, req);
      mustAffect(await c.query(
        `UPDATE identity.role_assignment SET status='REJECTED', rejected_reason=$1 WHERE id=$2 AND status='PENDING' RETURNING id`,
        [reason, a.id]), 'Not permitted to refuse this request');
      await audit(c, req, 'HOME_REJECTED', 'role_assignment', a.id, { reason, areaId: a.area_id });
      return a.person_id;
    });
    await notifyPerson(personId, 'REGISTRATION_REJECTED', ['Your home was not accepted', reason], ['आपका आवास स्वीकार नहीं हुआ', reason]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* Revoking a DEVICE stops that handset only; the person's roles stay. */
identityApi.post('/devices/:id/revoke', async (req, res, next) => {
  try {
    if (!req.body?.reason) throw new Unprocessable('A reason is required');
    await scoped(req, async (c) => {
      mustAffect(await c.query(
        `UPDATE identity.device SET status='REVOKED', revoked_at=now(), revoked_by=$1, revocation_reason=$2
          WHERE id=$3 AND status='ACTIVE' RETURNING id`, [req.claims.actor_id, req.body.reason, req.params.id]),
        'Not permitted, or the device is not active');
      await audit(c, req, 'DEVICE_REVOKED', 'device', req.params.id, { reason: req.body.reason });
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* A transfer or a change of contractor ends several ROLES at once. */
identityApi.post('/devices/revoke-bulk', async (req, res, next) => {
  try {
    const { premises_id, contract_id, role, reason } = req.body || {};
    if (!reason) throw new Unprocessable('A reason is required');
    if ([premises_id, contract_id, role].filter(Boolean).length !== 1) {
      throw new Unprocessable('Give exactly one of premises, contract or role');
    }
    const r = await scoped(req, async (c) => {
      const rows = (await c.query(
        `UPDATE identity.role_assignment
            SET status='REVOKED', revoked_at=now(), revoked_by=$1, revocation_reason=$2
          WHERE status='ACTIVE' AND person_id <> $6
            AND ($3::uuid IS NULL OR premises_id = $3)
            AND ($4::uuid IS NULL OR contract_id = $4)
            AND ($5::text IS NULL OR role::text = $5)
          RETURNING id, person_id`,
        [req.claims.actor_id, reason, premises_id || null, contract_id || null, role || null, req.claims.person_id])).rows;
      for (const x of rows) await audit(c, req, 'ROLE_REVOKED', 'role_assignment', x.id, { reason });
      return rows;
    });
    for (const x of r) await syncPerson(x.person_id);
    res.json({ revoked_count: r.length });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ *
 * People and role assignments — the Area HR / System administrators
 * (decision 2026-09-30). Every change is audit-logged with its reason.
 * ------------------------------------------------------------------ */
// the database refuses it too (employee_id_8_digits); this gives the plain message
function checkEmployeeId(v) {
  if (v && !EMPLOYEE_ID.test(String(v))) throw new Unprocessable('The Employee ID is 8 digits, for example 90229456');
}
const requireAreaAdmin = (req) => {
  if (!AREA_ADMINS.includes(req.claims.role)) throw new Forbidden('Area HR or System Administrator only');
};

identityApi.get('/roles', async (req, res, next) => {
  try {
    const out = await scoped(req, async (c) => {
      const mine = (await c.query(`SELECT level FROM identity.role_level WHERE role::text = $1`, [req.claims.role])).rows[0]?.level ?? 0;
      const all = (await c.query(`SELECT role::text, level, hq, accountable, occupant FROM identity.role_level ORDER BY level, role`)).rows;
      return all.map((r) => ({ ...r, assignable: AREA_ADMINS.includes(req.claims.role) && r.level < mine }));
    });
    res.json(out);
  } catch (e) { next(e); }
});

identityApi.get('/persons', async (req, res, next) => {
  try {
    requireAreaAdmin(req);
    const out = await scoped(req, (c) => c.query(
      `SELECT p.id, p.name, p.personnel_no, p.designation, p.mobile, p.email, p.resident_category, p.is_employee,
              (p.password_hash IS NOT NULL) AS has_password,
              coalesce(json_agg(json_build_object('id', a.id, 'role', a.role, 'scope_path', a.scope_path::text,
                  'premises', pr.identifier, 'designation', a.designation, 'acting', a.acting,
                  'valid_from', a.valid_from, 'valid_to', a.valid_to, 'status', a.status))
                FILTER (WHERE a.id IS NOT NULL), '[]') AS roles,
              (SELECT count(*) FROM identity.device d WHERE d.person_id = p.id AND d.status='ACTIVE') AS devices,
              -- phones registered in another Area: the number only (2026-10-13)
              identity.phones_elsewhere(p.id) AS phones_elsewhere
         FROM identity.person p
         LEFT JOIN identity.role_assignment a ON a.person_id = p.id AND a.status IN ('ACTIVE','PENDING')
         LEFT JOIN identity.premises pr ON pr.id = a.premises_id
        WHERE ($1::text IS NULL OR p.name ILIKE '%'||$1||'%' OR p.personnel_no ILIKE '%'||$1||'%' OR p.mobile LIKE '%'||$1||'%')
          -- row security decides who is visible (Area, or not yet attached)
        GROUP BY p.id ORDER BY p.name LIMIT 300`, [req.query.q || null]));
    res.json(out.rows);
  } catch (e) { next(e); }
});

identityApi.post('/persons', async (req, res, next) => {
  try {
    requireAreaAdmin(req);
    const { name, personnel_no, mobile, designation, email, resident_category = 'NCL' } = req.body || {};
    if (!name || !/^[6-9][0-9]{9}$/.test(String(mobile || ''))) throw new Unprocessable('Name and a 10-digit mobile number are required');
    if (resident_category === 'NCL' && !personnel_no) throw new Unprocessable('An NCL employee needs an Employee ID');
    checkEmployeeId(personnel_no);
    const out = await scoped(req, async (c) => {
      const r = (await c.query(
        `INSERT INTO identity.person (name, personnel_no, mobile, designation, email, is_employee, resident_category)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, personnel_no`,
        [name.trim(), personnel_no || null, mobile, designation || null, email || null, resident_category === 'NCL', resident_category])).rows[0];
      await audit(c, req, 'PERSON_CREATED', 'person', r.id,
        { after: { name, personnel_no, mobile, designation, resident_category }, areaId: await areaOfScope(c, req.claims.scope_path) });
      return r;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

identityApi.put('/persons/:id', async (req, res, next) => {
  try {
    requireAreaAdmin(req);
    const { reason, ...patch } = req.body || {};
    if (!reason) throw new Unprocessable('A reason is required for every change');
    const fields = ['name', 'personnel_no', 'mobile', 'designation', 'email'].filter((k) => k in patch);
    checkEmployeeId(patch.personnel_no);
    if (!fields.length) throw new Unprocessable('Nothing to change');
    const out = await scoped(req, async (c) => {
      const before = (await c.query(`SELECT ${fields.join(',')} FROM identity.person WHERE id=$1`, [req.params.id])).rows[0];
      if (!before) throw new Forbidden('Not a person you can edit');
      if (req.params.id === req.claims.person_id) throw new Forbidden('Your own record is edited by another administrator');
      const r = await c.query(
        `UPDATE identity.person SET ${fields.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id=$1 RETURNING id`,
        [req.params.id, ...fields.map((k) => patch[k] || null)]);
      mustAffect(r, 'Not permitted to edit this person');
      await audit(c, req, 'PERSON_CHANGED', 'person', req.params.id, { before, after: patch, reason });
      return { id: req.params.id };
    });
    await syncPerson(req.params.id);
    res.json(out);
  } catch (e) { next(e); }
});

identityApi.post('/assignments', async (req, res, next) => {
  try {
    requireAreaAdmin(req);
    const { person_id, role, scope_path, premises_id = null, contract_id = null, designation = null,
            acting = false, valid_from = null, valid_to = null, reason } = req.body || {};
    if (!person_id || !role || !reason) throw new Unprocessable('Person, role and a reason are required');
    const out = await scoped(req, async (c) => {
      let scope = scope_path || req.claims.scope_path;
      // A role below HQ is held in one Area. Never fall back to the
      // assigner's own scope when that is all of NCL: the HQ portal
      // administrator must choose the Area (the database refuses it too).
      const hqRole = (await c.query(`SELECT hq FROM identity.role_level WHERE role::text = $1`, [role])).rows[0]?.hq;
      if (hqRole === undefined) throw new Unprocessable('No such role');
      if (!hqRole && !OCCUPANT_ROLES.includes(role)) {
        const inArea = (await c.query(
          `SELECT 1 FROM identity.area WHERE $1::ltree <@ scope_path`, [scope])).rowCount;
        if (!inArea) throw new Unprocessable('Choose the Area this role is held in');
      }
      if (OCCUPANT_ROLES.includes(role)) {
        if (!premises_id) throw new Unprocessable('A resident or custodian role needs a quarter or building');
        const pr = (await c.query(`SELECT scope_path::text, premises_type::text FROM identity.premises WHERE id=$1`, [premises_id])).rows[0];
        if (!pr) throw new Unprocessable('That quarter or building is not in your Area');
        if ((role === 'RESIDENT') !== (pr.premises_type === 'QUARTER')) {
          throw new Unprocessable(role === 'RESIDENT' ? 'A resident is bound to a quarter' : 'A custodian is bound to a building, not a quarter');
        }
        scope = pr.scope_path;
        if (role === 'CUSTODIAN') await c.query(`UPDATE identity.premises SET occupancy_model='CUSTODIAN_BOUND' WHERE id=$1`, [premises_id]);
      }
      const r = (await c.query(
        `INSERT INTO identity.role_assignment (person_id, role, scope_path, premises_id, contract_id, designation,
             acting, valid_from, valid_to, status, assigned_by, reason, approved_by, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8::date,current_date),$9,'ACTIVE',$10,$11,$10,now())
         RETURNING id, role::text, scope_path::text`,
        [person_id, role, scope, premises_id, contract_id, designation, !!acting, valid_from, valid_to,
         req.claims.actor_id, reason])).rows[0];
      await audit(c, req, 'ROLE_ASSIGNED', 'role_assignment', r.id,
        { after: { person_id, role, scope, premises_id, contract_id, designation, acting, valid_from, valid_to },
          reason, areaId: await areaOfScope(c, scope) });
      return r;
    });
    await syncPerson(person_id);
    res.status(201).json(out);
  } catch (e) { next(e); }
});

identityApi.put('/assignments/:id', async (req, res, next) => {
  try {
    requireAreaAdmin(req);
    const { reason, valid_to, designation, contract_id } = req.body || {};
    if (!reason) throw new Unprocessable('A reason is required for every change');
    const out = await scoped(req, async (c) => {
      const before = (await c.query(
        `SELECT person_id, valid_to, designation, contract_id, scope_path::text FROM identity.role_assignment WHERE id=$1`,
        [req.params.id])).rows[0];
      if (!before) throw new Forbidden('Not an assignment you can change');
      mustAffect(await c.query(
        `UPDATE identity.role_assignment
            SET valid_to = CASE WHEN $2 THEN $3::date ELSE valid_to END,
                designation = CASE WHEN $4 THEN $5 ELSE designation END,
                contract_id = CASE WHEN $6 THEN $7::uuid ELSE contract_id END
          WHERE id=$1 AND status='ACTIVE' RETURNING id`,
        [req.params.id, 'valid_to' in req.body, valid_to || null, 'designation' in req.body, designation || null,
         'contract_id' in req.body, contract_id || null]), 'Not permitted to change this assignment');
      await audit(c, req, 'ROLE_CHANGED', 'role_assignment', req.params.id,
        { before, after: { valid_to, designation, contract_id }, reason, areaId: await areaOfScope(c, before.scope_path) });
      return before.person_id;
    });
    await syncPerson(out);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

identityApi.post('/assignments/:id/revoke', async (req, res, next) => {
  try {
    const incharge = req.claims.role === 'MAINTENANCE_INCHARGE';
    if (!incharge) requireAreaAdmin(req);
    if (!req.body?.reason) throw new Unprocessable('A reason is required');
    const personId = await scoped(req, async (c) => {
      if (incharge) {
        // the Incharge ends only the supervisor roles they may appoint
        const role = (await c.query(`SELECT role::text FROM identity.role_assignment WHERE id=$1`, [req.params.id])).rows[0]?.role;
        if (role !== 'CONTRACTOR_SUPERVISOR') throw new Forbidden('The Incharge ends contractor supervisor roles only');
      }
      const r = (await c.query(
        `UPDATE identity.role_assignment
            SET status='REVOKED', revoked_at=now(), revoked_by=$1, revocation_reason=$2
          WHERE id=$3 AND status IN ('ACTIVE','PENDING') RETURNING person_id, scope_path::text`,
        [req.claims.actor_id, req.body.reason, req.params.id])).rows[0];
      if (!r) throw new Forbidden('Not permitted, or the role is not active');
      await audit(c, req, 'ROLE_REVOKED', 'role_assignment', req.params.id,
        { reason: req.body.reason, areaId: await areaOfScope(c, r.scope_path) });
      return r.person_id;
    });
    await syncPerson(personId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* The Civil Incharge appoints a contractor's supervisor directly, on a
   live work order of their Area (decision 2026-09-30). The person is found
   by mobile or entered; the role is that one role, on that contract. The
   database refuses the Incharge any other role or Area. */
identityApi.post('/supervisors', async (req, res, next) => {
  try {
    if (!['MAINTENANCE_INCHARGE', ...AREA_ADMINS].includes(req.claims.role)) {
      throw new Forbidden('The Civil Incharge appoints contractor supervisors');
    }
    const { name, mobile, designation = null, contract_id } = req.body || {};
    const reason = String(req.body?.reason || '').trim();
    if (!name || !/^[6-9][0-9]{9}$/.test(String(mobile || ''))) throw new Unprocessable('Name and a 10-digit mobile number are required');
    if (!reason) throw new Unprocessable('Give the reason, e.g. the firm\'s deployment letter');
    // a live work order the caller can see
    const ct = await withScope(maintPool, req.claims, (c) => c.query(
      `SELECT id FROM contract WHERE id = $1 AND active`, [contract_id])).catch(() => ({ rows: [] }));
    if (!ct.rows[0]) throw new Unprocessable('Choose a live work order of your Area');
    // A mobile already in the directory belongs to that person. If they are
    // outside the caller's sight (someone of another Area), refuse rather
    // than create a second person with the same mobile.
    const existing = (await withSystem(identityPool, (c) => c.query(
      `SELECT id FROM identity.person WHERE mobile = $1 ORDER BY created_at LIMIT 1`, [mobile]))).rows[0];
    const out = await scoped(req, async (c) => {
      const areaId = await areaOfScope(c, req.claims.scope_path);
      let personId = existing?.id;
      if (existing) {
        const seen = await c.query(`SELECT id FROM identity.person WHERE id = $1`, [existing.id]);
        if (!seen.rowCount) throw new Conflict('This mobile number belongs to someone registered outside your Area. Ask the Area HR office.');
      } else {
        personId = (await c.query(
          `INSERT INTO identity.person (name, mobile, designation, is_employee, resident_category)
           VALUES ($1,$2,$3,false,'NON_NCL') RETURNING id`, [name.trim(), mobile, designation])).rows[0].id;
        await audit(c, req, 'PERSON_CREATED', 'person', personId, { after: { name, mobile, designation }, reason, areaId });
      }
      const a = (await c.query(
        `INSERT INTO identity.role_assignment (person_id, role, scope_path, contract_id, designation,
             valid_from, status, assigned_by, reason, approved_by, approved_at)
         VALUES ($1,'CONTRACTOR_SUPERVISOR',$2,$3,$4,current_date,'ACTIVE',$5,$6,$5,now())
         RETURNING id, role::text, person_id`,
        [personId, req.claims.scope_path, contract_id, designation, req.claims.actor_id, reason])).rows[0];
      await audit(c, req, 'ROLE_ASSIGNED', 'role_assignment', a.id,
        { after: { person_id: personId, role: 'CONTRACTOR_SUPERVISOR', contract_id, designation }, reason, areaId });
      return a;
    });
    await syncPerson(out.person_id);
    res.status(201).json(out);
  } catch (e) { next(e); }
});

/* The audit trail of people and roles, for the Area administrators and
   the Staff Officer. */
identityApi.get('/audit', async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT l.occurred_at, l.event_type, l.entity_type, l.entity_id, l.actor_role, l.reason,
              l.before_value, l.after_value, p.name AS actor_name
         FROM identity.audit_log l LEFT JOIN identity.person p ON p.id = l.actor_person_id
        ORDER BY l.id DESC LIMIT 200`));
    res.json(out.rows);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ *
 * Projections into the maintenance database. Production uses logical
 * replication; the build refreshes them by call.
 * ------------------------------------------------------------------ */
export async function syncPremises(premisesId) {
  const p = (await withSystem(identityPool, (c) => c.query(
    `SELECT p.id, p.area_id, a.ticket_code, p.colony_id, p.scope_path, p.identifier,
            p.premises_type, p.quarter_type, p.occupancy_model, coalesce(r.rank,99) AS rank
       FROM identity.premises p
       JOIN identity.area a ON a.id = p.area_id
       LEFT JOIN identity.inspection_sort_rank r
              ON r.premises_type = p.premises_type
             AND (r.quarter_type = p.quarter_type OR (r.quarter_type IS NULL AND p.quarter_type IS NULL))
      WHERE p.id = $1`, [premisesId]))).rows[0];
  if (!p) return;
  await withSystem(maintPool, (c) => c.query(
    `INSERT INTO premises_ref (premises_id, area_id, area_code, colony_id, scope_path,
         identifier, premises_type, quarter_type, occupancy_model, inspection_rank)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (premises_id) DO UPDATE SET identifier=EXCLUDED.identifier, area_code=EXCLUDED.area_code,
         occupancy_model=EXCLUDED.occupancy_model, inspection_rank=EXCLUDED.inspection_rank, synced_at=now()`,
    [p.id, p.area_id, p.ticket_code, p.colony_id, p.scope_path, p.identifier,
     p.premises_type, p.quarter_type, p.occupancy_model, p.rank]));
}

export async function syncPerson(personId) {
  const rows = (await withSystem(identityPool, (c) => c.query(
    `SELECT a.id, a.person_id, pe.name, a.role::text, a.scope_path::text, a.premises_id, a.contract_id,
            CASE WHEN identity.assignment_in_force(a) THEN 'ACTIVE' ELSE a.status::text END AS status
       FROM identity.role_assignment a JOIN identity.person pe ON pe.id = a.person_id
      WHERE a.person_id = $1`, [personId]))).rows;
  for (const r of rows) if (r.premises_id) await syncPremises(r.premises_id);
  await withSystem(maintPool, async (c) => {
    for (const r of rows) {
      await c.query(
        `INSERT INTO actor_ref (actor_id, person_id, person_name, role, scope_path, premises_id, contract_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (actor_id) DO UPDATE SET person_name=EXCLUDED.person_name, status=EXCLUDED.status,
             premises_id=EXCLUDED.premises_id, contract_id=EXCLUDED.contract_id, scope_path=EXCLUDED.scope_path,
             synced_at=now()`,
        [r.id, r.person_id, r.name, r.role, r.scope_path, r.premises_id, r.contract_id, r.status]);
    }
  });
}

/* A person hears about their own registration in every role they hold. */
async function notifyPerson(personId, event, en, hi) {
  await withSystem(maintPool, async (c) => {
    const actors = (await c.query(`SELECT actor_id FROM actor_ref WHERE person_id=$1 AND status='ACTIVE'`, [personId])).rows;
    for (const a of actors) {
      await c.query(
        `INSERT INTO notification (actor_id, event_type, title_en, body_en, title_hi, body_hi)
         VALUES ($1,$2,$3,$4,$5,$6)`, [a.actor_id, event, en[0], en[1], hi[0], hi[1]]);
    }
  });
}

const errors = (err, req, res, _next) => {
  const mapped = mapDbError(err);
  const status = err.status || mapped?.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ title: status === 403 ? 'Not permitted' : 'Error', status,
    detail: err.status ? err.message : (mapped?.detail || 'Unexpected error') });
};
identityApi.use(errors);
publicApi.use(errors);
