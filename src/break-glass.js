/**
 * Break-glass: emergency access to the databases, separately logged.
 *
 *   npm run break-glass -- open --operator "S. Rao" --approver "GM (Civil)"
 *        --reference "HQ/CIV/2026/117" --reason "complaint stuck after server crash" [--mode write] [--minutes 60]
 *   npm run break-glass -- close --session <id> [--note "..."]
 *   npm run break-glass -- sweep | list | verify
 *
 * Decision (README §5.5): inside the portal even the HQ System
 * Administrator is bound by controls 4 and 5. Server and database access is
 * infrastructure access, and when it is needed it goes through this
 * procedure, not through an application role. It runs with the database
 * superuser's credentials, so only someone with server access can use it.
 *
 * What it gives: a named login of its own for one person, for a stated
 * reason, approved by someone else, that expires by itself. Row security is
 * bypassed (the reason for coming here is usually to look across Areas), but
 * nothing is deleted, nothing is restructured, and the database's own
 * triggers still hold: history stays append-only and a complaint still
 * cannot change state outside the transition table. Every statement the
 * login runs goes to the server's log, and every opening and closing goes to
 * a register the portal cannot reach, hash-chained and copied to a file, and
 * is announced to the GM (Civil) and the HQ System Administrator.
 */
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const IDENTITY_DB = process.env.IDENTITY_DB || 'ncl_identity';
const MAINT_DB = process.env.MAINT_DB || 'ncl_maint';
const REGISTER_DB = process.env.BREAKGLASS_DB || 'ncl_breakglass';
const LOG_FILE = path.resolve(root, process.env.BREAKGLASS_LOG || 'logs/break-glass.log');
const HOST = process.env.PGHOST || (process.platform === 'win32' ? 'localhost' : '/var/run/postgresql');
const PORT = Number(process.env.PGPORT || 5432);
const su = (database) => new pg.Client({ host: HOST, port: PORT, database,
  user: process.env.PG_SUPERUSER || 'postgres', password: process.env.PG_SUPERUSER_PASSWORD });

class Refused extends Error {}
const refuse = (m) => { throw new Refused(m); };

/* ------------------------------------------------------------ arguments */
function parse(argv) {
  const [command, ...rest] = argv;
  const o = { _: command };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) refuse(`unexpected argument "${a}"`);
    const k = a.slice(2);
    if (k === 'json') { o.json = true; continue; }
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) refuse(`--${k} needs a value`);
    o[k] = v; i++;
  }
  return o;
}

async function withClient(db, fn) {
  const c = su(db);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/* ------------------------------------------------------------ the register */
// The register lives in a database of its own, owned by the superuser, with
// no CONNECT for anyone else: the application login cannot read it, let
// alone change it.
async function ensureRegister() {
  await withClient('postgres', async (c) => {
    const has = await c.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [REGISTER_DB]);
    if (!has.rowCount) await c.query(`CREATE DATABASE ${pg.escapeIdentifier(REGISTER_DB)}`);
    await c.query(`REVOKE ALL ON DATABASE ${pg.escapeIdentifier(REGISTER_DB)} FROM PUBLIC`);
  });
  await withClient(REGISTER_DB, async (c) => {
    await c.query(`
      CREATE SCHEMA IF NOT EXISTS register;
      CREATE TABLE IF NOT EXISTS register.event (
        id          bigserial PRIMARY KEY,
        session_id  uuid NOT NULL,
        event       text NOT NULL CHECK (event IN ('OPENED','CLOSED','EXPIRED')),
        at          timestamptz NOT NULL,
        operator    text NOT NULL,
        approver    text NOT NULL,
        reference   text NOT NULL,
        reason      text NOT NULL,
        mode        text NOT NULL,
        role_name   text NOT NULL,
        valid_until timestamptz NOT NULL,
        note        text NULL,
        host        text NOT NULL,
        os_user     text NOT NULL,
        prev_hash   text NOT NULL,
        hash        text NOT NULL UNIQUE);
      -- append-only, the superuser included; dropping this trigger is what
      -- the hash chain and the file copy are there to expose
      CREATE OR REPLACE FUNCTION register.append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'the break-glass register is append-only';
      END $$ LANGUAGE plpgsql;
      CREATE OR REPLACE TRIGGER event_append_only BEFORE UPDATE OR DELETE ON register.event
        FOR EACH ROW EXECUTE FUNCTION register.append_only();
      CREATE OR REPLACE TRIGGER event_no_truncate BEFORE TRUNCATE ON register.event
        FOR EACH STATEMENT EXECUTE FUNCTION register.append_only();`);
  });
}

const FIELDS = ['session_id', 'event', 'at', 'operator', 'approver', 'reference', 'reason', 'mode',
  'role_name', 'valid_until', 'note', 'host', 'os_user'];
const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
function canonical(e) {
  const o = {};
  for (const k of [...FIELDS].sort()) o[k] = k === 'at' || k === 'valid_until' ? iso(e[k]) : (e[k] ?? null);
  return JSON.stringify(o);
}
const hashOf = (prev, e) => crypto.createHash('sha256').update(`${prev}|${canonical(e)}`).digest('hex');
const ZERO = '0'.repeat(64);

async function append(e) {
  return withClient(REGISTER_DB, async (c) => {
    await c.query('BEGIN');
    try {
      // one writer at a time, or two events could chain from the same parent
      await c.query('LOCK TABLE register.event IN EXCLUSIVE MODE');
      const prev = (await c.query(`SELECT hash FROM register.event ORDER BY id DESC LIMIT 1`)).rows[0]?.hash || ZERO;
      const row = { ...e, host: os.hostname(), os_user: os.userInfo().username, note: e.note ?? null };
      row.prev_hash = prev;
      row.hash = hashOf(prev, row);
      await c.query(
        `INSERT INTO register.event (${[...FIELDS, 'prev_hash', 'hash'].join(', ')})
         VALUES (${[...FIELDS, 'prev_hash', 'hash'].map((_, i) => `$${i + 1}`).join(', ')})`,
        [...FIELDS, 'prev_hash', 'hash'].map((k) => (k === 'at' || k === 'valid_until' ? iso(row[k]) : row[k])));
      await c.query('COMMIT');
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, JSON.stringify({ ...JSON.parse(canonical(row)), prev_hash: row.prev_hash, hash: row.hash }) + '\n');
      return row;
    } catch (err) { await c.query('ROLLBACK'); throw err; }
  });
}

async function sessions() {
  await ensureRegister();
  const rows = (await withClient(REGISTER_DB, (c) => c.query(`SELECT * FROM register.event ORDER BY id`))).rows;
  const by = new Map();
  for (const r of rows) {
    if (r.event === 'OPENED') by.set(r.session_id, { ...r, opened_at: r.at, status: 'OPEN', closed_at: null });
    else if (by.has(r.session_id)) Object.assign(by.get(r.session_id), { status: r.event, closed_at: r.at, note: r.note });
  }
  // Overdue by whichever comes first: the expiry recorded in the register,
  // or the login's own VALID UNTIL in PostgreSQL — the one that actually
  // stops a login, and the one someone could change outside this script.
  const open = [...by.values()].filter((s) => s.status === 'OPEN');
  const live = open.length ? new Map((await withClient('postgres', (c) => c.query(
    `SELECT rolname, rolvaliduntil FROM pg_roles WHERE rolname = ANY($1)`, [open.map((s) => s.role_name)]))).rows
    .map((r) => [r.rolname, r.rolvaliduntil])) : new Map();
  const now = new Date();
  for (const s of open) {
    const pgUntil = live.get(s.role_name);
    if (new Date(s.valid_until) < now || (pgUntil && new Date(pgUntil) < now)) s.status = 'OVERDUE';
  }
  return [...by.values()];
}

/* ------------------------------------------------------------ notifying HQ */
// Straight into the portal's inbox of every GM (Civil) and HQ System
// Administrator, so the people above know the glass was broken.
async function announce(event, s, extra = '') {
  await withClient(MAINT_DB, async (c) => {
    const title = event === 'BREAK_GLASS_OPENED' ? 'Emergency database access opened' : 'Emergency database access closed';
    const body = `Operator: ${s.operator}. Approver: ${s.approver}. Reference: ${s.reference}. `
      + `${s.mode === 'write' ? 'Read and write' : 'Read only'}, until ${new Date(s.valid_until).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST. ${extra}`.trim();
    await c.query(
      `INSERT INTO maint.notification (actor_id, event_type, title_en, body_en, title_hi, body_hi)
       SELECT actor_id, $1, $2, $3, $4, $3 FROM maint.actor_ref WHERE role IN ('GM_CIVIL','ADMINISTRATOR') AND status = 'ACTIVE'`,
      [event, title, body, event === 'BREAK_GLASS_OPENED' ? 'आपात डेटाबेस पहुँच खोली गई' : 'आपात डेटाबेस पहुँच बंद की गई']);
  });
}

/* ------------------------------------------------------------ commands */
async function open(o) {
  for (const k of ['operator', 'approver', 'reference', 'reason']) {
    if (!String(o[k] || '').trim()) refuse(`--${k} is required`);
  }
  const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
  if (norm(o.operator) === norm(o.approver)) refuse('the approver must be someone other than the operator');
  if (String(o.reason).trim().length < 15) refuse('give the reason in a sentence (at least 15 characters)');
  const mode = o.mode || 'read';
  if (!['read', 'write'].includes(mode)) refuse('--mode is read or write');
  const minutes = o.minutes === undefined ? 60 : Number(o.minutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) refuse('--minutes is a whole number from 5 to 240');

  await ensureRegister();
  const session_id = crypto.randomUUID();
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const role = `bg_${stamp.slice(0, 8)}_${stamp.slice(8, 12)}_${crypto.randomBytes(3).toString('hex')}`;
  const password = crypto.randomBytes(24).toString('base64url');
  const validUntil = new Date(now.getTime() + minutes * 60000);

  await withClient('postgres', async (c) => {
    const ddl = (await c.query(
      `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L VALID UNTIL %L CONNECTION LIMIT 3 BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', $1::text, $2::text, $3::text) AS q`,
      [role, password, validUntil.toISOString()])).rows[0].q;
    await c.query(ddl);
    // every statement this login runs is written to the server's log
    await c.query(`ALTER ROLE ${pg.escapeIdentifier(role)} SET log_statement = 'all'`);
    // the portal's own search path: the database's triggers name their
    // helpers unqualified, and must fire exactly as they do for the portal
    // (found by suite 17: the search trigger failed in a bare session)
    await c.query(`ALTER ROLE ${pg.escapeIdentifier(role)} SET search_path = maint, identity, public`);
    await c.query(`ALTER ROLE ${pg.escapeIdentifier(role)} SET application_name = ${pg.escapeLiteral(`break-glass ${session_id}`)}`);
  });
  for (const db of [IDENTITY_DB, MAINT_DB]) {
    await withClient(db, async (c) => {
      const r = pg.escapeIdentifier(role);
      await c.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(db)} TO ${r}`);
      const schemas = (await c.query(
        `SELECT nspname FROM pg_namespace WHERE nspname IN ('identity','maint','public')`)).rows.map((x) => x.nspname);
      for (const s of schemas) {
        const n = pg.escapeIdentifier(s);
        await c.query(`GRANT USAGE ON SCHEMA ${n} TO ${r}`);
        // never DELETE, TRUNCATE or DDL: an emergency fix corrects, it does not remove
        await c.query(`GRANT ${mode === 'write' ? 'SELECT, INSERT, UPDATE' : 'SELECT'} ON ALL TABLES IN SCHEMA ${n} TO ${r}`);
        if (mode === 'write') await c.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${n} TO ${r}`);
      }
    });
  }
  const s = { session_id, event: 'OPENED', at: now, operator: o.operator.trim(), approver: o.approver.trim(),
    reference: o.reference.trim(), reason: o.reason.trim(), mode, role_name: role, valid_until: validUntil };
  await append(s);
  await announce('BREAK_GLASS_OPENED', s, `Reason: ${s.reason}`);
  const out = { session_id, role, password, valid_until: validUntil.toISOString(), mode, databases: [IDENTITY_DB, MAINT_DB],
    psql: `psql "host=${HOST} port=${PORT} dbname=${MAINT_DB} user=${role}"` };
  if (o.json) return console.log(JSON.stringify(out));
  console.log(`Emergency access opened (${mode === 'write' ? 'read and write' : 'read only'}) until ${validUntil.toISOString()}.
  session   ${session_id}
  login     ${role}
  password  ${password}
  connect   ${out.psql}   (also ${IDENTITY_DB})
Every statement is logged. The GM (Civil) and the HQ System Administrator have been told.
Close it when done:  npm run break-glass -- close --session ${session_id} --note "what was done"`);
}

async function end(s, event, note) {
  const r = pg.escapeIdentifier(s.role_name);
  await withClient('postgres', (c) => c.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [s.role_name]));
  for (const db of [IDENTITY_DB, MAINT_DB]) {
    await withClient(db, async (c) => {
      const exists = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [s.role_name]);
      if (exists.rowCount) await c.query(`DROP OWNED BY ${r}`);   // its grants in this database
    });
  }
  await withClient('postgres', async (c) => {
    // a database-level grant lives in pg_database, so revoke it before the drop
    for (const db of [IDENTITY_DB, MAINT_DB]) {
      await c.query(`REVOKE ALL ON DATABASE ${pg.escapeIdentifier(db)} FROM ${r}`).catch(() => {});
    }
    await c.query(`DROP ROLE IF EXISTS ${r}`);
  });
  const e = { ...s, event, at: new Date(), note: note ?? null };
  await append(e);
  await announce('BREAK_GLASS_CLOSED', s, event === 'EXPIRED' ? 'It expired and was closed by the sweep.' : (note ? `Note: ${note}` : ''));
}

async function close(o) {
  if (!o.session) refuse('--session is required');
  const s = (await sessions()).find((x) => x.session_id === o.session);
  if (!s) refuse('no such session');
  if (!['OPEN', 'OVERDUE'].includes(s.status)) refuse(`that session is already ${s.status.toLowerCase()}`);
  await end(s, 'CLOSED', o.note);
  console.log(o.json ? JSON.stringify({ session_id: s.session_id, status: 'CLOSED' }) : `Session ${s.session_id} closed; login ${s.role_name} removed.`);
}

async function sweep(o) {
  const due = (await sessions()).filter((s) => s.status === 'OVERDUE');
  for (const s of due) await end(s, 'EXPIRED');
  console.log(o.json ? JSON.stringify({ expired: due.length }) : `${due.length} expired session(s) closed.`);
}

async function list(o) {
  const all = await sessions();
  const rows = all.map((s) => ({ session_id: s.session_id, operator: s.operator, approver: s.approver, reference: s.reference,
    mode: s.mode, opened_at: iso(s.opened_at), valid_until: iso(s.valid_until), closed_at: s.closed_at ? iso(s.closed_at) : null, status: s.status }));
  if (o.json) return console.log(JSON.stringify(rows));
  if (!rows.length) return console.log('No emergency access has been opened.');
  for (const r of rows) console.log(`${r.status.padEnd(7)} ${r.opened_at}  ${r.operator} (approved by ${r.approver}, ${r.reference}) ${r.mode}  ${r.session_id}`);
}

async function verify(o) {
  await ensureRegister();
  const rows = (await withClient(REGISTER_DB, (c) => c.query(`SELECT * FROM register.event ORDER BY id`))).rows;
  let problem = null, prev = ZERO;
  for (const r of rows) {
    if (r.prev_hash !== prev) { problem = `event ${r.id}: does not follow the event before it`; break; }
    if (hashOf(prev, r) !== r.hash) { problem = `event ${r.id}: its contents no longer match its hash`; break; }
    prev = r.hash;
  }
  if (!problem) {
    const lines = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    if (lines.length !== rows.length) problem = `the log file has ${lines.length} event(s), the register ${rows.length}`;
    else {
      const i = lines.findIndex((l, k) => l.hash !== rows[k].hash);
      if (i >= 0) problem = `event ${rows[i].id}: differs from the log file`;
    }
  }
  if (o.json) console.log(JSON.stringify({ intact: !problem, events: rows.length, problem }));
  else console.log(problem ? `REGISTER BROKEN — ${problem}` : `register intact (${rows.length} events)`);
  if (problem) process.exitCode = 1;
}

const COMMANDS = { open, close, sweep, list, verify };
try {
  const o = parse(process.argv.slice(2));
  if (!COMMANDS[o._]) refuse('command is one of: open, close, sweep, list, verify');
  await COMMANDS[o._](o);
} catch (e) {
  console.error(e instanceof Refused ? `Refused: ${e.message}` : `Error: ${e.message}`);
  process.exitCode = 1;
}
