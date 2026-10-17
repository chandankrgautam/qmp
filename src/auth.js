import crypto from 'node:crypto';
import { identityPool, withSystem } from './db.js';

const TOKEN_SECRET = process.env.TOKEN_SECRET || 'dev-only-secret-change-in-production';
const ACCESS_TTL_SECONDS = 15 * 60;
const PERSON_TTL_SECONDS = 5 * 60;

/* ------------------------------------------------------------------ *
 * Tokens
 *
 * Signing in has two steps (decision 2026-09-30):
 *   1. prove WHO — the device's hardware key, or Employee ID + password.
 *      That yields a short "person" token and the list of the person's
 *      roles in force.
 *   2. choose the ROLE to act in. That yields the access token, carrying
 *      exactly one role assignment (the actor), its scope, premises and
 *      contract, and how the person signed in (amr).
 * These claims are the ONLY source of authorisation context; db.withScope
 * sets the database session from them. A client cannot assert its own.
 * ------------------------------------------------------------------ */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url');

export function issueToken(claims, ttl = ACCESS_TTL_SECONDS) {
  const body = { ...claims, exp: Math.floor(Date.now() / 1000) + ttl };
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64(body);
  return `${head}.${payload}.${sign(`${head}.${payload}`)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  // constant time: a plain !== leaks how many leading characters matched
  const expect = Buffer.from(sign(`${h}.${p}`));
  const got = Buffer.from(s);
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

/* ------------------------------------------------------------------ *
 * Roles in force for a person
 * ------------------------------------------------------------------ */
async function assignmentsFor(c, personId) {
  return (await c.query(
    `SELECT a.id, a.role::text, a.scope_path::text, a.premises_id, a.contract_id,
            a.designation, a.acting, a.valid_to, l.accountable, l.level,
            p.identifier AS premises, col.name AS colony, ar.name AS area
       FROM identity.role_assignment a
       JOIN identity.role_level l ON l.role = a.role
       LEFT JOIN identity.premises p ON p.id = a.premises_id
       LEFT JOIN identity.colony col ON col.id = p.colony_id
       LEFT JOIN identity.area ar ON a.scope_path <@ ar.scope_path
      WHERE a.person_id = $1 AND identity.assignment_in_force(a)
      ORDER BY (a.role IN ('RESIDENT','CUSTODIAN')), l.level DESC`, [personId])).rows;
}

const log = (c, row) => c.query(
  `INSERT INTO identity.sign_in_log (person_id, device_id, method, assignment_id, success, detail)
   VALUES ($1,$2,$3,$4,$5,$6)`,
  [row.person_id ?? null, row.device_id ?? null, row.method, row.assignment_id ?? null, row.success, row.detail ?? null]);

/* Pick the role and issue the access token. Accountable roles need the
   app's PIN/biometric unlock when signing in by device (decision 15); a
   password is itself the knowledge factor on the web. */
async function roleToken(c, { person_id, device_id, amr, second_factor_satisfied, passkey_id, only }, pick) {
  // a contractor's web sign-in (2026-10-16) reaches only the roles of its tab;
  // `only` rides in every token of that session, so neither picking, switching
  // nor renewing can step into another role (a Non-NCL resident stays app-only)
  const all = await assignmentsFor(c, person_id);
  const list = only ? all.filter((x) => only.includes(x.role)) : all;
  let a = null;
  if (pick?.assignment_id) a = list.find((x) => x.id === pick.assignment_id);
  else if (pick?.role) a = list.find((x) => x.role === pick.role);
  else if (list.length === 1) a = list[0];
  if (!a) {
    if ((pick?.assignment_id || pick?.role) || !list.length) {
      await log(c, { person_id, device_id, method: amr, success: false, detail: list.length ? 'role not held' : 'no role in force' });
      return { error: list.length ? 'That role is not assigned to you' : 'No role is assigned to you yet' };
    }
    // several roles: the client shows the role picker
    return {
      person_token: issueToken({ purpose: 'person', person_id, device_id, amr, sf: !!second_factor_satisfied, passkey_id: passkey_id ?? null,
        ...(only ? { only } : {}) }, PERSON_TTL_SECONDS),
      assignments: list
    };
  }
  if (a.accountable && amr === 'device' && !second_factor_satisfied) {
    await log(c, { person_id, device_id, method: amr, assignment_id: a.id, success: false, detail: 'second factor missing' });
    return { error: 'PIN or biometric unlock required for this role' };
  }
  await log(c, { person_id, device_id, method: amr, assignment_id: a.id, success: true });
  // passkey_id rides along so that removing the passkey stops this session at
  // its next refresh, as revoking a device does
  const claims = { actor_id: a.id, person_id, device_id: device_id ?? null, role: a.role,
    scope_path: a.scope_path, premises_id: a.premises_id, contract_id: a.contract_id, amr,
    ...(passkey_id ? { passkey_id } : {}), ...(only ? { only } : {}) };
  return { token: issueToken(claims), refresh_token: issueToken({ ...claims, purpose: 'refresh' }, 12 * 3600),
    role: a.role, scope_path: a.scope_path, premises_id: a.premises_id, actor_id: a.id, person_id,
    assignments: list };
}

/* ------------------------------------------------------------------ *
 * Device credentials
 *
 * The device holds an ECDSA P-256 keypair. On a handset the private key
 * lives in Android Keystore or the iOS Secure Enclave and cannot be
 * extracted. The server stores only the public key.
 * ------------------------------------------------------------------ */
export async function issueChallenge(publicKeyPem) {
  const nonce = crypto.randomBytes(24).toString('base64url');
  return withSystem(identityPool, async (c) => {
    const dev = await c.query(`SELECT id FROM identity.device WHERE public_key = $1`, [publicKeyPem]);
    if (!dev.rowCount) return { error: 'device not registered' };
    await c.query(
      `INSERT INTO identity.auth_challenge (nonce, device_id, expires_at)
       VALUES ($1,$2, now() + interval '2 minutes')`, [nonce, dev.rows[0].id]);
    return { nonce };
  });
}

export async function exchangeSignature({ public_key, nonce, signature, second_factor_satisfied, role, assignment_id }) {
  return withSystem(identityPool, async (c) => {
    const ch = await c.query(
      `SELECT device_id FROM identity.auth_challenge
        WHERE nonce=$1 AND consumed_at IS NULL AND expires_at > now()`, [nonce]);
    if (!ch.rowCount) return { error: 'challenge expired or already used' };
    const device = (await c.query(`SELECT * FROM identity.device WHERE id = $1`, [ch.rows[0].device_id])).rows[0];
    if (device.public_key !== public_key) return { error: 'key mismatch' };

    let ok = false;
    try {
      ok = crypto.verify('sha256', Buffer.from(nonce), { key: public_key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(String(signature || ''), 'base64'));
    } catch { ok = false; }
    if (!ok) {
      await log(c, { person_id: device.person_id, device_id: device.id, method: 'device', success: false, detail: 'bad signature' });
      return { error: 'bad signature' };
    }
    if (device.status !== 'ACTIVE') {
      await log(c, { person_id: device.person_id, device_id: device.id, method: 'device', success: false, detail: `device ${device.status}` });
      return { error: `device is ${device.status.toLowerCase()}` };
    }
    await c.query(`UPDATE identity.auth_challenge SET consumed_at = now() WHERE nonce=$1`, [nonce]);
    await c.query(`UPDATE identity.device SET last_seen_at = now() WHERE id=$1`, [device.id]);
    return roleToken(c, { person_id: device.person_id, device_id: device.id, amr: 'device', second_factor_satisfied },
      { role, assignment_id });
  });
}

/* ------------------------------------------------------------------ *
 * Employee ID + password (web; decision 2026-09-30)
 *
 * scrypt, a per-password salt, and a lock after repeated failures. A
 * Non-NCL resident has no Employee ID and so no password: app only.
 * ------------------------------------------------------------------ */
const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
};
const checkPassword = (pw, stored) => {
  const [, salt, key] = String(stored || '').split('$');
  if (!salt || !key) return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(key, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
async function cfg(c, key, dflt) {
  return Number((await c.query(`SELECT value FROM identity.config WHERE key=$1`, [key])).rows[0]?.value ?? dflt);
}

/** NCL's Employee ID: exactly 8 digits (decision 2026-09-30). */
export const EMPLOYEE_ID = /^[0-9]{8}$/;

export async function passwordSignIn({ employee_id, password, role, assignment_id }) {
  return withSystem(identityPool, async (c) => {
    if (!EMPLOYEE_ID.test(String(employee_id || ''))) return { error: 'The Employee ID is 8 digits, for example 90229456' };
    const p = (await c.query(`SELECT * FROM identity.person WHERE personnel_no = $1`, [String(employee_id || '')])).rows[0];
    // the same answer whether the ID or the password was wrong
    const refuse = { error: 'Employee ID or password is not right' };
    if (!p || !p.password_hash) { await log(c, { person_id: p?.id, method: 'password', success: false, detail: 'no password set' }); return refuse; }
    if (p.locked_until && new Date(p.locked_until) > new Date()) {
      await log(c, { person_id: p.id, method: 'password', success: false, detail: 'locked' });
      return { error: `Too many attempts. Try again after ${new Date(p.locked_until).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}, or reset your password with an OTP.` };
    }
    if (!checkPassword(String(password || ''), p.password_hash)) {
      const max = await cfg(c, 'password_max_failures', 5);
      const mins = await cfg(c, 'password_lock_minutes', 15);
      await c.query(
        `UPDATE identity.person SET failed_logins = failed_logins + 1,
                locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval END
          WHERE id=$1`, [p.id, max, mins]);
      await log(c, { person_id: p.id, method: 'password', success: false, detail: 'wrong password' });
      return refuse;
    }
    await c.query(`UPDATE identity.person SET failed_logins = 0, locked_until = NULL WHERE id=$1`, [p.id]);
    return roleToken(c, { person_id: p.id, device_id: null, amr: 'password' }, { role, assignment_id });
  });
}

const hasApprovedPhone = async (c, personId) =>
  (await c.query(`SELECT 1 FROM identity.device WHERE person_id=$1 AND status='ACTIVE' LIMIT 1`, [personId])).rowCount > 0;

/* Contractor staff on the web (user's decisions, 2026-10-16; README §5.5).
   They were app-only. Now the firm and its supervisors may sign in on the web
   with the mobile number and an OTP, every time — no password to share. Only
   someone whose phone is already approved in the app: the mobile was proved
   when that phone registered, and the person was checked then. The OTP's
   proof is spent here, so one OTP signs in once. The session reaches only the
   roles of the tab used, and the database refuses it the acts that stay on the
   phone (starting work, the completion claim, photographs). */
export const CONTRACTOR_KINDS = ['CONTRACTOR', 'CONTRACTOR_SUPERVISOR'];
export async function contractorSignIn({ registration_token, kind, assignment_id }) {
  if (!CONTRACTOR_KINDS.includes(kind)) return { status: 422, error: 'Sign in as the contractor firm or as a contractor supervisor' };
  const otp = verifyRegistrationToken(registration_token);
  if (!otp) return { error: 'Verify your mobile number with the OTP first' };
  return withSystem(identityPool, async (c) => {
    const p = (await c.query(`SELECT id FROM identity.person WHERE mobile=$1`, [otp.mobile])).rows[0];
    const refuse = async (detail, error) => { await log(c, { person_id: p?.id, method: 'otp', success: false, detail }); return { error }; };
    if (!p) return refuse('mobile not on record', 'This mobile number is not registered with the portal');
    if (!(await hasApprovedPhone(c, p.id))) {
      return refuse('no approved phone', 'Register the app on your phone first. The web sign-in is for those whose phone is approved.');
    }
    const roles = (await assignmentsFor(c, p.id)).filter((a) => a.role === kind);
    if (!roles.length) {
      return refuse('no role of this kind', kind === 'CONTRACTOR' ? 'You hold no contractor firm’s role' : 'You hold no contractor supervisor’s role');
    }
    if (!(await spendRegistrationToken(c, otp))) return refuse('otp used', 'That OTP has been used already. Ask for a new one.');
    return roleToken(c, { person_id: p.id, device_id: null, amr: 'otp', only: [kind] }, { assignment_id });
  });
}

/* Setting (or resetting) a web password needs the OTP to the mobile on
   record — enrolment and recovery are the only uses of OTP. */
export async function setPasswordWithOtp({ employee_id, registration_token, password }) {
  const otp = verifyRegistrationToken(registration_token);
  if (!otp) return { status: 422, error: 'Verify your mobile number first' };
  return withSystem(identityPool, async (c) => {
    const min = await cfg(c, 'password_min_length', 10);
    if (String(password || '').length < min) return { status: 422, error: `The password must be at least ${min} characters` };
    const p = (await c.query(`SELECT id, mobile, is_employee FROM identity.person WHERE personnel_no=$1`, [String(employee_id || '')])).rows[0];
    if (!p || p.mobile !== otp.mobile || !p.is_employee) {
      return { status: 422, error: 'That Employee ID is not registered to this mobile number' };
    }
    if (!(await spendRegistrationToken(c, otp))) return { status: 422, error: 'That verification has been used already. Verify your mobile number again.' };
    await c.query(`UPDATE identity.person SET password_hash=$2, password_set_at=now(), failed_logins=0, locked_until=NULL WHERE id=$1`,
      [p.id, hashPassword(String(password))]);
    await c.query(
      `INSERT INTO identity.audit_log (event_type, entity_type, entity_id, actor_person_id)
       VALUES ('PASSWORD_SET','person',$1,$1)`, [p.id]);
    return { ok: true };
  });
}
export { hashPassword, checkPassword, roleToken, log as logSignIn, cfg as identityConfig };

/* Step 2 on its own: a person holding several roles picks one. */
export async function selectRole({ person_token, assignment_id, role, second_factor_satisfied }) {
  const pt = verifyToken(person_token);
  if (!pt || pt.purpose !== 'person') return { error: 'Sign in again' };
  return withSystem(identityPool, (c) => roleToken(c,
    { person_id: pt.person_id, device_id: pt.device_id, amr: pt.amr, second_factor_satisfied: second_factor_satisfied ?? pt.sf,
      passkey_id: pt.passkey_id, only: pt.only },
    { assignment_id, role }));
}

/* Switching role while signed in: the same person, the same sign-in
   method, another of their own roles. Never someone else's. */
export async function switchRole(claims, { assignment_id, second_factor_satisfied }) {
  return withSystem(identityPool, (c) => roleToken(c,
    { person_id: claims.person_id, device_id: claims.device_id, amr: claims.amr, second_factor_satisfied,
      passkey_id: claims.passkey_id, only: claims.only },
    { assignment_id }));
}

/* A short-lived token proving a handset holds the mobile number it
   claimed. It carries no authority beyond registering or setting a password. */
export function issueRegistrationToken(mobile, otpId) {
  return issueToken({ purpose: 'registration', mobile, otp: otpId }, 30 * 60);
}
/* Spend a registration token, inside the transaction that uses it: a second
   use is refused, so one OTP registers one phone or sets one password. */
export async function spendRegistrationToken(c, claims) {
  if (!claims?.otp) return false;
  const r = await c.query(
    `UPDATE identity.otp_request SET token_used_at = now() WHERE id = $1 AND token_used_at IS NULL RETURNING id`, [claims.otp]);
  return r.rowCount === 1;
}
export function verifyRegistrationToken(token) {
  const c = verifyToken(token);
  return c && c.purpose === 'registration' ? c : null;
}

/* Renewing access. Revocation bites here: the assignment, the device and
   the person's lock are re-read, so a revoked role or device is refused at
   its next refresh rather than living as long as its token. */
export async function refreshAccess(refreshToken) {
  const claims = verifyToken(refreshToken);
  if (!claims?.actor_id) return { error: 'refresh token is not valid' };
  return withSystem(identityPool, async (c) => {
    if (claims.device_id) {
      const d = (await c.query(`SELECT status::text FROM identity.device WHERE id=$1`, [claims.device_id])).rows[0];
      if (!d || d.status !== 'ACTIVE') return { error: `device is ${(d?.status || 'unknown').toLowerCase()}` };
      await c.query(`UPDATE identity.device SET last_seen_at = now() WHERE id=$1`, [claims.device_id]);
    }
    if (claims.passkey_id) {
      const k = (await c.query(`SELECT removed_at FROM identity.passkey WHERE id=$1`, [claims.passkey_id])).rows[0];
      if (!k || k.removed_at) return { error: 'this passkey has been removed' };
    }
    // a contractor's web session holds only while the person still has an
    // approved phone (user's decision, 2026-10-16): revoked, the web stops too
    if (claims.amr === 'otp' && !(await hasApprovedPhone(c, claims.person_id))) {
      return { error: 'Your phone is no longer approved, so the web sign-in has ended' };
    }
    const r = await roleToken(c, { person_id: claims.person_id, device_id: claims.device_id, amr: claims.amr,
      second_factor_satisfied: true, passkey_id: claims.passkey_id, only: claims.only }, { assignment_id: claims.actor_id });
    return r.token ? r : { error: 'That role is no longer assigned to you' };
  });
}

/** Express middleware. Populates req.claims from an ACCESS token only. */
export function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const claims = verifyToken(hdr.startsWith('Bearer ') ? hdr.slice(7) : null);
  // person, refresh and registration tokens carry no role and act on nothing
  if (!claims || !claims.actor_id || claims.purpose) {
    return res.status(401).json({ title: 'Not authenticated', status: 401 });
  }
  req.claims = claims;
  next();
}

/** Generate a keypair the way a handset would, for seeding and tests. */
export function generateDeviceKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { publicKey, privateKey };
}

export function signNonce(privateKeyPem, nonce) {
  return crypto.sign('sha256', Buffer.from(nonce),
    { key: privateKeyPem, dsaEncoding: 'ieee-p1363' }).toString('base64');
}
