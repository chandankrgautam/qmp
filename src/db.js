import pg from 'pg';

// A calendar date (contract dates, validity) stays a calendar date.
// Turned into a JavaScript Date it becomes midnight IST, which is the
// previous evening in UTC — a completion date of 9 August read back as
// "2027-08-08T18:30Z". Found 2026-09-30 on work orders.
pg.types.setTypeParser(1082, (v) => v);

// Always appconn, never the owning role: row-level security does not apply
// to a table's owner. Host and password come from the environment (.env in
// development). Windows PostgreSQL listens on TCP only, not a Unix socket.
export const appConnection = {
  host: process.env.PGHOST
    || (process.platform === 'win32' ? 'localhost' : '/var/run/postgresql'),
  port: Number(process.env.PGPORT || 5432),
  user: 'appconn',
  password: process.env.APPCONN_PASSWORD
};

// Which databases. The test runner points these at its own scratch
// databases, so a test run never wipes the data someone is working with
// (2026-10-07: a run during user testing would have destroyed it).
export const IDENTITY_DB = process.env.IDENTITY_DB || 'ncl_identity';
export const MAINT_DB = process.env.MAINT_DB || 'ncl_maint';

// Two pools, because identity and maintenance are separate databases.
// The application never joins across them.
export const identityPool = new pg.Pool({
  ...appConnection, database: IDENTITY_DB, max: 6
});
export const maintPool = new pg.Pool({
  ...appConnection, database: MAINT_DB, max: 6
});

/**
 * THE SECURITY BOUNDARY OF THE WHOLE APPLICATION.
 *
 * Every query runs inside a transaction whose session variables are set
 * from the caller's *token claims* and from nothing else. Row-level
 * security reads those variables. A request body can never influence them.
 *
 * SET LOCAL is used deliberately: the values die with the transaction, so
 * a pooled connection cannot carry one user's scope into the next user's
 * request. Using SET instead of SET LOCAL here would be a cross-tenant
 * data leak the moment the pool reuses a connection.
 */
export async function withScope(pool, claims, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path TO maint, identity, public');
    // One role assignment per request (decision 2026-09-30): the actor is
    // the assignment acted in; person, device and sign-in method ride
    // along for the two-key check and the app-only inspection rule.
    const vars = [['app.role', claims.role], ['app.scope_path', claims.scope_path],
      ['app.actor_id', claims.actor_id], ['app.person_id', claims.person_id],
      ['app.premises_id', claims.premises_id], ['app.contract_id', claims.contract_id],
      ['app.device_id', claims.device_id], ['app.auth_method', claims.amr]];
    // one round trip for all of them
    await client.query(`SELECT ${vars.map((_, i) => `set_config($${2 * i + 1},$${2 * i + 2},true)`).join(',')}`,
      vars.flatMap(([k, v]) => [k, v ?? '']));
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Trusted background context: the SLA sweep, escalation, migrations. */
export function withSystem(pool, fn) {
  return withScope(pool, { role: 'SYSTEM', scope_path: 'ncl' }, fn);
}

/**
 * A write blocked by a RESTRICTIVE policy affects zero rows and raises
 * nothing. Reporting that as success would tell an officer their action
 * worked when it did not, so every write goes through here.
 */
export class Forbidden extends Error {
  constructor(msg = 'Not permitted for your role or area') {
    super(msg); this.status = 403;
  }
}
export class Conflict extends Error {
  constructor(msg) { super(msg); this.status = 409; }
}
export class Unprocessable extends Error {
  constructor(msg) { super(msg); this.status = 422; }
}

export function mustAffect(result, msg) {
  if (!result.rowCount) throw new Forbidden(msg);
  return result;
}

/** Postgres error codes the triggers and constraints raise, mapped to HTTP. */
export function mapDbError(e) {
  if (e.code === '42501') return { status: 403, detail: e.message };       // insufficient_privilege
  if (e.code === '23505') return { status: 409, detail: e.message };       // unique_violation
  if (e.code === '23514') return { status: 422, detail: e.message };       // check_violation
  if (e.code === '23503') return { status: 422, detail: e.message };       // fk_violation
  // a malformed id is simply not there (it was a 500 until the 2026-10-08 break-it pass)
  if (e.code === '22P02') return /uuid/i.test(e.message) ? { status: 404, detail: 'Not found' } : { status: 422, detail: e.message };
  return null;
}
