import express from 'express';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse
} from '@simplewebauthn/server';
import { identityPool, withScope, mapDbError } from './db.js';
import { requireAuth, checkPassword, roleToken, logSignIn, identityConfig } from './auth.js';

/**
 * Passkeys on the web (phase 8; README §5.5 Sign-in).
 *
 * An NCL employee may sign in with a passkey — a key held by their phone,
 * laptop or security key and unlocked by fingerprint, face or PIN — in
 * place of typing the web password. It is still a web session (amr
 * 'passkey'): accepting an inspection still needs the app.
 *
 * Adding one needs the web password again, so an unattended signed-in
 * screen cannot be used to plant a lasting way in. The verification of the
 * authenticator is the library's; who may hold, add, use and remove a
 * passkey is the database's (passkey_guard, row security).
 */
export const passkeys = express.Router();

const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173';
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'NCL Colony Maintenance Portal';
const ADMINS = ['AREA_HR_ADMIN', 'AREA_SYS_ADMIN', 'ADMINISTRATOR'];
const fail = (status, error) => Object.assign(new Error(error), { status });
// the sign-in service's own context: it alone writes challenges and passkeys
const service = (extra, fn) => withScope(identityPool, { role: 'AUTH', ...extra }, fn);
const scoped = (req, fn) => withScope(identityPool, req.claims, fn);

const challengeOf = (response) => {
  try { return JSON.parse(Buffer.from(response?.response?.clientDataJSON || '', 'base64url').toString()).challenge || null; }
  catch { return null; }
};
async function newChallenge(c, challenge, purpose, personId = null) {
  // only the latest registration request of a person stands: asking again
  // cancels the earlier one
  if (personId) {
    await c.query(`UPDATE identity.webauthn_challenge SET used_at = now()
                    WHERE person_id = $1 AND purpose = $2 AND used_at IS NULL`, [personId, purpose]);
  }
  await c.query(
    `INSERT INTO identity.webauthn_challenge (challenge, purpose, person_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '5 minutes')`, [challenge, purpose, personId]);
}
/* single use: taken, and marked, in one statement */
async function takeChallenge(c, challenge, purpose, personId = null) {
  if (!challenge) return null;
  return (await c.query(
    `UPDATE identity.webauthn_challenge SET used_at = now()
      WHERE challenge = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
        AND ($3::uuid IS NULL OR person_id = $3)
      RETURNING challenge`, [challenge, purpose, personId])).rows[0]?.challenge || null;
}
const COLS = `id, name, created_at, last_used_at, transports, removed_at, removal_reason`;

/* ------------------------------------------------------------ signing in */
passkeys.post('/auth/passkey/options', async (req, res, next) => {
  try {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'required', timeout: 60000 });
    await service({}, (c) => newChallenge(c, options.challenge, 'authenticate'));
    res.json({ options });
  } catch (e) { next(e); }
});

passkeys.post('/auth/passkey', async (req, res, next) => {
  try {
    const { response, role, assignment_id } = req.body || {};
    const out = await service({}, async (c) => {
      const refuse = async (error, detail, person_id) => {
        await logSignIn(c, { person_id, method: 'passkey', success: false, detail: detail || error });
        return { error };
      };
      const challenge = await takeChallenge(c, challengeOf(response), 'authenticate');
      if (!challenge) return refuse('That sign-in request has expired or was already used. Try again.', 'challenge expired or reused');
      const k = (await c.query(
        `SELECT k.*, p.is_employee, p.personnel_no FROM identity.passkey k JOIN identity.person p ON p.id = k.person_id
          WHERE k.credential_id = $1`, [String(response?.id || '')])).rows[0];
      if (!k) return refuse('This passkey is not registered with the portal', 'unknown passkey');
      if (k.removed_at) return refuse('This passkey has been removed', 'removed passkey', k.person_id);
      if (!k.is_employee || !k.personnel_no) return refuse('Passkeys are for NCL employees', 'not an employee', k.person_id);
      let v;
      try {
        v = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: ORIGIN,
          expectedRPID: RP_ID, requireUserVerification: true,
          credential: { id: k.credential_id, publicKey: new Uint8Array(k.public_key), counter: Number(k.counter),
            transports: k.transports || undefined } });
      } catch (err) {
        // a counter that does not move forward is the sign of a copied key
        const cloned = /counter/i.test(err.message);
        return refuse(cloned ? 'This passkey could not be trusted; it has been reported' : 'The passkey could not be verified. Try again.',
          cloned ? 'signature counter went backwards: possible copied key' : err.message, k.person_id);
      }
      if (!v.verified) return refuse('The passkey could not be verified. Try again.', 'not verified', k.person_id);
      await c.query(`UPDATE identity.passkey SET counter = $2, last_used_at = now() WHERE id = $1`,
        [k.id, v.authenticationInfo.newCounter]);
      const out = await roleToken(c, { person_id: k.person_id, device_id: null, amr: 'passkey', passkey_id: k.id }, { role, assignment_id });
      // proved, with the role still to choose: an access in its own right
      if (out.person_token) await logSignIn(c, { person_id: k.person_id, method: 'passkey', success: true, detail: 'identity proved; role to be chosen' });
      return out;
    });
    res.status(out.error ? 401 : 200).json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ the person's own */
passkeys.get('/passkeys', requireAuth, async (req, res, next) => {
  try {
    const out = await scoped(req, (c) => c.query(
      `SELECT ${COLS} FROM identity.passkey WHERE person_id = $1 ORDER BY created_at DESC`, [req.claims.person_id]));
    res.json(out.rows);
  } catch (e) { next(e); }
});

passkeys.post('/passkeys/options', requireAuth, async (req, res, next) => {
  try {
    const password = String(req.body?.password || '');
    const options = await service({ person_id: req.claims.person_id, actor_id: req.claims.actor_id }, async (c) => {
      const p = (await c.query(`SELECT * FROM identity.person WHERE id = $1`, [req.claims.person_id])).rows[0];
      if (!p || !p.is_employee || !p.personnel_no) throw fail(403, 'Passkeys are for NCL employees, who sign in on the web');
      if (!p.password_hash) throw fail(422, 'Set a web password first');
      if (p.locked_until && new Date(p.locked_until) > new Date()) throw fail(423, 'Too many wrong passwords. Try again later.');
      if (!checkPassword(password, p.password_hash)) {
        // the same lockout as signing in with the password
        const max = await identityConfig(c, 'password_max_failures', 5);
        const mins = await identityConfig(c, 'password_lock_minutes', 15);
        await c.query(
          `UPDATE identity.person SET failed_logins = failed_logins + 1,
                  locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval END
            WHERE id = $1`, [p.id, max, mins]);
        await logSignIn(c, { person_id: p.id, method: 'password', success: false, detail: 'wrong password when adding a passkey' });
        return { refused: true };
      }
      await c.query(`UPDATE identity.person SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [p.id]);
      const live = (await c.query(
        `SELECT credential_id, transports FROM identity.passkey WHERE person_id = $1 AND removed_at IS NULL`, [p.id])).rows;
      const max = await identityConfig(c, 'passkeys_max_per_person', 5);
      if (live.length >= max) throw fail(409, `You already have ${max} passkeys. Remove one first.`);
      const o = await generateRegistrationOptions({
        rpName: RP_NAME, rpID: RP_ID, userName: p.personnel_no, userDisplayName: p.name,
        userID: new TextEncoder().encode(p.id), attestationType: 'none', timeout: 60000,
        excludeCredentials: live.map((k) => ({ id: k.credential_id, transports: k.transports || undefined })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
      });
      await newChallenge(c, o.challenge, 'register', p.id);
      return o;
    });
    // a wrong password is recorded (and counted) before it is refused
    if (options.refused) throw fail(403, 'Your password is not right');
    res.json({ options });
  } catch (e) { next(e); }
});

passkeys.post('/passkeys', requireAuth, async (req, res, next) => {
  try {
    const { response } = req.body || {};
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 60) throw fail(422, 'Give the passkey a name of up to 60 characters, e.g. "Office laptop"');
    const out = await service({ person_id: req.claims.person_id, actor_id: req.claims.actor_id }, async (c) => {
      const challenge = await takeChallenge(c, challengeOf(response), 'register', req.claims.person_id);
      if (!challenge) return { status: 422, error: 'That request has expired or was already used. Start again.' };
      let v;
      try {
        v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: ORIGIN,
          expectedRPID: RP_ID, requireUserVerification: true });
      } catch (err) { return { status: 422, error: `The passkey could not be verified: ${err.message}` }; }
      if (!v.verified) return { status: 422, error: 'The passkey could not be verified' };
      const cred = v.registrationInfo.credential;
      if ((await c.query(`SELECT 1 FROM identity.passkey WHERE credential_id = $1`, [cred.id])).rowCount) {
        return { status: 409, error: 'This passkey is already registered' };
      }
      // the guard refuses a sixth live passkey and a non-employee, whatever route
      const row = (await c.query(
        `INSERT INTO identity.passkey (person_id, credential_id, public_key, counter, transports, aaguid, name)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
        [req.claims.person_id, cred.id, Buffer.from(cred.publicKey), cred.counter,
          response?.response?.transports || cred.transports || null, v.registrationInfo.aaguid || null, name])).rows[0];
      return { row };
    });
    if (out.error) throw fail(out.status, out.error);
    res.status(201).json(out.row);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ removal */
passkeys.post('/passkeys/:id/revoke', requireAuth, async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw fail(422, 'Give the reason for removing the passkey');
    const out = await scoped(req, async (c) => {
      // row security decides what the caller can see: their own, or an
      // administrator's people; anything else is simply not there
      const k = (await c.query(`SELECT id, person_id, removed_at FROM identity.passkey WHERE id = $1`, [req.params.id])).rows[0];
      if (!k || (k.person_id !== req.claims.person_id && !ADMINS.includes(req.claims.role))) throw fail(404, 'Not found');
      if (k.removed_at) throw fail(409, 'This passkey has already been removed');
      return (await c.query(
        `UPDATE identity.passkey SET removal_reason = $2 WHERE id = $1 RETURNING ${COLS}`, [k.id, reason])).rows[0];
    });
    res.json(out);
  } catch (e) { next(e); }
});

passkeys.get('/persons/:id/passkeys', requireAuth, async (req, res, next) => {
  try {
    if (!ADMINS.includes(req.claims.role)) throw fail(403, 'A person\'s passkeys are shown to Area administrators');
    const out = await scoped(req, async (c) => {
      if (!(await c.query(`SELECT 1 FROM identity.person WHERE id = $1`, [req.params.id])).rowCount) throw fail(404, 'Not found');
      return (await c.query(
        `SELECT ${COLS} FROM identity.passkey WHERE person_id = $1 ORDER BY created_at DESC`, [req.params.id])).rows;
    });
    res.json(out);
  } catch (e) { next(e); }
});

passkeys.use((err, req, res, _next) => {
  const mapped = mapDbError(err);
  const status = err.status || mapped?.status || (err.code === '22P02' ? 404 : 500);
  if (status === 500) console.error(err);
  const msg = err.status ? err.message : (mapped?.detail || (status === 404 ? 'Not found' : 'Unexpected error'));
  res.status(status).json({ error: msg, title: status === 403 ? 'Not permitted' : status === 404 ? 'Not found' : 'Cannot do that', status, detail: msg });
});
