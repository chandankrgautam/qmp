/**
 * Suite 17 — the break-glass procedure (emergency database access).
 * README §5.5: server and database access is infrastructure access, a
 * separately logged procedure, not an app role.
 *
 * Written from the specification alone, to check the implementation
 * independently of whoever built it.
 *
 *   B1  refusals of `open`
 *   B2  a read session: what it can and cannot do, and appconn's exclusion
 *   B3  a write session: harmless updates only, no state change, no delete
 *   B4  close, and closing again
 *   B5  expiry and sweep
 *   B6  the register: events, chain, append-only, log file, tampering
 *   B7  notifications
 *
 * Runs against the scratch databases only (src/test-all.js sets them) and
 * refuses to run otherwise: it drops the register database at the start.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { signNonce } from './auth.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;

/* ---- guard: never touch the user's data ---- */
const MAINT_DB = process.env.MAINT_DB || '';
const IDENTITY_DB = process.env.IDENTITY_DB || '';
const BG_DB = process.env.BREAKGLASS_DB || '';
const BG_LOG_ENV = process.env.BREAKGLASS_LOG || '';
if (!MAINT_DB.endsWith('_test') || !BG_DB.endsWith('_test') || !IDENTITY_DB.endsWith('_test') || !BG_LOG_ENV) {
  console.error('Refusing to run: suite 17 needs IDENTITY_DB, MAINT_DB and BREAKGLASS_DB ending in _test, and BREAKGLASS_LOG set.\n'
    + `  IDENTITY_DB=${IDENTITY_DB} MAINT_DB=${MAINT_DB} BREAKGLASS_DB=${BG_DB} BREAKGLASS_LOG=${BG_LOG_ENV}\n`
    + '  Run it through: node src/test-all.js test17');
  process.exit(1);
}
const BG_LOG = path.resolve(root, BG_LOG_ENV);

const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

const PGHOST = process.env.PGHOST || (process.platform === 'win32' ? 'localhost' : '/var/run/postgresql');
const PGPORT = Number(process.env.PGPORT || 5432);
const SU = process.env.PG_SUPERUSER || 'postgres';
const SUPW = process.env.PG_SUPERUSER_PASSWORD ?? '';
const APPPW = process.env.APPCONN_PASSWORD;

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => { if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); } };
async function attempt(n, fn) { try { await fn(); } catch (e) { check(n, false, `threw: ${e.message}`.slice(0, 260)); } }
const short = (x) => (typeof x === 'string' ? x : JSON.stringify(x))?.slice(0, 300);

/* ---- database helpers ---- */
const connect = async (user, password, database) => {
  const c = new pg.Client({ host: PGHOST, port: PGPORT, user, password, database, connectionTimeoutMillis: 8000 });
  await c.connect();
  return c;
};
/** Run fn with a connected client, always closing it. */
async function withClient(user, password, database, fn) {
  const c = await connect(user, password, database);
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}
const asSuper = (database, fn) => withClient(SU, SUPW, database, fn);
/** null if the connection was made, otherwise the error. */
async function tryConnect(user, password, database) {
  try { await withClient(user, password, database, async () => {}); return null; }
  catch (e) { return e; }
}
/** { ok, err } for one statement on a fresh connection. */
async function tryQuery(creds, database, sql, params) {
  try {
    return await withClient(creds.role, creds.password, database, async (c) => ({ ok: true, res: await c.query(sql, params) }));
  } catch (e) { return { ok: false, err: e }; }
}
const denied = (r) => r && r.ok === false && r.err?.code === '42501';

/* ---- running the script ---- */
function bg(args) {
  const r = spawnSync(process.execPath, ['--env-file-if-exists=.env', 'src/break-glass.js', ...args],
    { cwd: root, env: process.env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}
const OPEN_OK = ['--operator', 'R. Operator', '--approver', 'S. Approver', '--reference', 'ORD/2026/17',
  '--reason', 'Investigating a stuck complaint in Jayant', '--json'];
const withOpt = (base, name, value) => {
  const a = [...base]; const i = a.indexOf(name);
  if (i >= 0) a.splice(i, 2);
  return value === undefined ? a : [...a, name, value];
};
const open = (extra = []) => {
  let a = [...OPEN_OK];
  for (let i = 0; i < extra.length; i += 2) a = withOpt(a, extra[i], extra[i + 1]);
  return bg(['open', ...a]);
};
const refused = (r) => r.status === 1 && /Refused:/.test(r.stderr);

/* ---- the portal API, for tickets and notifications ---- */
const jh = { 'content-type': 'application/json' };
async function device(key, pick = {}) {
  const d = devices[key];
  const ch = await (await fetch(`${BASE}/identity/v1/auth/challenge`, { method: 'POST', headers: jh,
    body: JSON.stringify({ public_key: d.publicKey }) })).json();
  return (await fetch(`${BASE}/identity/v1/auth/token`, { method: 'POST', headers: jh,
    body: JSON.stringify({ public_key: d.publicKey, nonce: ch.nonce, signature: signNonce(d.privateKey, ch.nonce),
      second_factor_satisfied: true, ...pick }) })).json();
}
const as = (key) => device(key, { role: devices[key].role });
const call = (tok, p, method = 'GET', b) => fetch(`${BASE}/maintenance/v1${p}`, { method,
  headers: { ...jh, authorization: `Bearer ${tok}` }, body: b ? JSON.stringify(b) : undefined });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const inbox = async (tok) => (await j(await call(tok.token, '/notifications'))).items || [];

async function run() {
  /* ---- start clean ---- */
  await asSuper('postgres', (c) => c.query(`DROP DATABASE IF EXISTS "${BG_DB}" WITH (FORCE)`));
  try { fs.rmSync(BG_LOG, { force: true }); } catch { /* none */ }
  check('setup: the register database and log file start clean', !fs.existsSync(BG_LOG));

  /* ---- complaints in two Areas, to prove cross-Area reading ---- */
  const resident = await as('RESIDENT:R. K. Singh');
  const nghRes = await as('RESIDENT:Nigahi resident');
  const gm = await as('GM_CIVIL:GM (Civil)');
  const admin = await as('ADMINISTRATOR:System Admin');
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey');
  const cats = await j(await call(resident.token, '/masters/categories'));
  const tag = `bgtest-${Date.now() % 1000000}`;
  const jnt = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: cats[0].id, description: `Break-glass ${tag} Jayant` }));
  const ngh = await j(await call(nghRes.token, '/tickets', 'POST', { sub_category_id: cats[0].id, description: `Break-glass ${tag} Nigahi` }));
  check('setup: a Jayant and a Nigahi complaint were raised', !!jnt.id && !!ngh.id, short({ jnt, ngh }));
  const ids = [jnt.id, ngh.id];

  /* ================= B1 — refusals ================= */
  await attempt('B1 refusals', async () => {
    for (const opt of ['--operator', '--approver', '--reference', '--reason']) {
      const r = open([opt, undefined]);
      check(`B1 missing ${opt} is refused`, r.status === 1 && r.stderr.length > 0, `${r.status} ${short(r.stderr)}`);
    }
    for (const [label, a] of [
      ['approver = operator', ['--operator', 'Same Person', '--approver', 'Same Person']],
      ['approver = operator, other case', ['--operator', 'Same Person', '--approver', 'SAME PERSON']],
      ['approver = operator, extra spaces', ['--operator', 'Same Person', '--approver', '  same person  ']]]) {
      const r = open(a);
      check(`B1 ${label} is refused`, refused(r), `${r.status} ${short(r.stderr)}`);
    }
    let r = open(['--reason', 'too short']);
    check('B1 a reason under 15 characters is refused', refused(r), `${r.status} ${short(r.stderr)}`);
    r = open(['--reason', '12345678901234']);
    check('B1 a 14-character reason is refused', refused(r), `${r.status} ${short(r.stderr)}`);
    r = open(['--minutes', '4']);
    check('B1 minutes 4 is refused', refused(r), `${r.status} ${short(r.stderr)}`);
    r = open(['--minutes', '241']);
    check('B1 minutes 241 is refused', refused(r), `${r.status} ${short(r.stderr)}`);
    r = open(['--mode', 'admin']);
    check('B1 a bad mode is refused', refused(r), `${r.status} ${short(r.stderr)}`);
    const leftovers = await asSuper('postgres', (c) => c.query(`SELECT count(*)::int n FROM pg_roles WHERE rolname LIKE 'bg\\_%'`));
    check('B1 no role was created by any refusal', leftovers.rows[0].n === 0, `${leftovers.rows[0].n}`);
  });

  /* ================= B2 — a read session ================= */
  let readS = null;
  await attempt('B2 open read', async () => {
    const r = open(['--mode', 'read', '--minutes', '30']);
    check('B2 open --mode read succeeds (exit 0, JSON)', r.status === 0 && !!r.json, `${r.status} ${short(r.stderr)} ${short(r.stdout)}`);
    readS = r.json;
    if (!readS) return;
    check('B2 the result carries session_id, role, password, valid_until, mode, databases, psql',
      !!(readS.session_id && readS.role && readS.password && readS.valid_until && readS.mode && readS.databases && readS.psql), short(Object.keys(readS)));
    check('B2 the role is named bg_<date>_<time>_<6 hex>', /^bg_\d{8}_\d{4}_[0-9a-f]{6}$/.test(readS.role), readS.role);
    check('B2 the password is at least 24 characters', String(readS.password).length >= 24, `${String(readS.password).length}`);
    check('B2 mode is read', readS.mode === 'read', readS.mode);
    const mins = (new Date(readS.valid_until) - Date.now()) / 60000;
    check('B2 valid_until is about 30 minutes ahead', mins > 28 && mins < 31, `${mins}`);
    check('B2 two databases are named', Array.isArray(readS.databases) && readS.databases.length === 2, short(readS.databases));

    const info = await asSuper('postgres', (c) => c.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolconnlimit, rolvaliduntil, rolconfig
         FROM pg_roles WHERE rolname=$1`, [readS.role]));
    const ro = info.rows[0];
    check('B2 the role exists', !!ro);
    if (ro) {
      check('B2 not superuser / createdb / createrole', !ro.rolsuper && !ro.rolcreatedb && !ro.rolcreaterole, short(ro));
      check('B2 BYPASSRLS, connection limit 3', ro.rolbypassrls === true && ro.rolconnlimit === 3, short(ro));
      check('B2 VALID UNTIL is set', !!ro.rolvaliduntil, short(ro));
      const cfg = (ro.rolconfig || []).join(' ');
      check('B2 log_statement = all is set on the role', /log_statement=all/.test(cfg), cfg);
      check('B2 application_name names the session', cfg.includes('break-glass') && cfg.includes(readS.session_id), cfg);
    }
    const creds = { role: readS.role, password: readS.password };

    for (const db of [IDENTITY_DB, MAINT_DB]) {
      const e = await tryConnect(creds.role, creds.password, db);
      check(`B2 the credentials connect to ${db}`, e === null, e?.message);
    }
    const sel = await tryQuery(creds, MAINT_DB, `SELECT id, ticket_no FROM maint.ticket WHERE id = ANY($1::uuid[])`, [ids]);
    check('B2 SELECT sees complaints of both Areas (RLS bypassed)', sel.ok && sel.res.rowCount === 2, short(sel.err?.message || sel.res?.rows));
    if (sel.ok && jnt.ticket_no && ngh.ticket_no) {
      const areas = new Set(sel.res.rows.map((x) => String(x.ticket_no).split('/')[0]));
      check('B2 those complaints belong to two different Areas', areas.size === 2, [...areas].join(','));
    }
    const all = await tryQuery(creds, MAINT_DB, `SELECT count(*)::int n FROM maint.ticket`);
    check('B2 the whole ticket table is readable', all.ok && all.res.rows[0].n >= 2, short(all.err?.message));
    const idn = await tryQuery(creds, IDENTITY_DB, `SELECT count(*)::int n FROM identity.person`);
    check('B2 the identity database is readable', idn.ok && idn.res.rows[0].n > 0, short(idn.err?.message));

    let q = await tryQuery(creds, MAINT_DB, `UPDATE maint.ticket SET description = description WHERE id = $1`, [jnt.id]);
    check('B2 UPDATE is refused (permission denied)', denied(q), short(q.err?.message || 'succeeded'));
    q = await tryQuery(creds, MAINT_DB, `INSERT INTO maint.audit_log DEFAULT VALUES`);
    check('B2 INSERT is refused (permission denied)', denied(q), short(q.err?.message || 'succeeded'));
    q = await tryQuery(creds, MAINT_DB, `DELETE FROM maint.ticket WHERE id = $1`, [jnt.id]);
    check('B2 DELETE is refused (permission denied)', denied(q), short(q.err?.message || 'succeeded'));
    q = await tryQuery(creds, MAINT_DB, `CREATE TABLE maint.bg_should_not_exist (x int)`);
    check('B2 CREATE TABLE is refused', q.ok === false, 'succeeded');

    /* the connection limit: three at once, a fourth refused */
    const held = [];
    try {
      for (let k = 0; k < 3; k++) held.push(await connect(creds.role, creds.password, MAINT_DB));
      const e = await tryConnect(creds.role, creds.password, MAINT_DB);
      check('B2 a fourth simultaneous connection is refused (limit 3)', e !== null, 'connected');
    } finally { for (const c of held) await c.end().catch(() => {}); }

    /* appconn is shut out of the register */
    const e = await tryConnect('appconn', APPPW, BG_DB);
    check('B2 appconn cannot connect to the register database', e !== null && /permission denied|not allowed|CONNECT/i.test(e.message), e?.message || 'connected');
    const own = await asSuper('postgres', (c) => c.query(
      `SELECT pg_get_userbyid(datdba) AS owner, has_database_privilege('appconn', datname, 'CONNECT') AS ok
         FROM pg_database WHERE datname = $1`, [BG_DB]));
    check('B2 the register database is owned by the superuser, appconn has no CONNECT',
      own.rows[0]?.owner === SU && own.rows[0]?.ok === false, short(own.rows[0]));
    const cE = await tryConnect(readS.role, readS.password, BG_DB);
    check('B2 the break-glass role cannot read the register either', cE !== null, 'connected');
  });

  /* ================= B3 — a write session ================= */
  let writeS = null;
  await attempt('B3 write session', async () => {
    const r = open(['--mode', 'write', '--minutes', '30', '--operator', 'W. Operator', '--approver', 'V. Approver', '--reference', 'ORD/2026/18']);
    check('B3 open --mode write succeeds', r.status === 0 && !!r.json && r.json.mode === 'write', `${r.status} ${short(r.stderr)}`);
    writeS = r.json;
    if (!writeS) return;
    const creds = { role: writeS.role, password: writeS.password };
    // The database's rules still hold: a change with no role stated is refused
    // (fail closed). The operator must state the capacity they act in, and that
    // statement goes to the server's log with everything else.
    const bare = await tryQuery(creds, MAINT_DB, `UPDATE maint.ticket SET description = $2 WHERE id = $1`, [jnt.id, `Break-glass ${tag} bare`]);
    check('B3 an UPDATE with no role stated is refused by the database (fail closed)', bare.ok === false && /app\.role/.test(bare.err?.message || ''), short(bare.err?.message || 'succeeded'));
    const upd = await tryQuery(creds, MAINT_DB,
      `WITH s AS (SELECT set_config('app.role', 'SYSTEM', true)) UPDATE maint.ticket SET description = $2 FROM s WHERE id = $1`,
      [jnt.id, `Break-glass ${tag} edited`]);
    check('B3 with the role stated, UPDATE of a harmless column (description) works', upd.ok && upd.res.rowCount === 1, short(upd.err?.message));
    const back = await asSuper(MAINT_DB, (c) => c.query(`SELECT description FROM maint.ticket WHERE id=$1`, [jnt.id]));
    check('B3 the change is really stored', back.rows[0]?.description === `Break-glass ${tag} edited`, short(back.rows[0]));

    let q = await tryQuery(creds, MAINT_DB, `UPDATE maint.ticket SET state = 'CLOSED' WHERE id = $1`, [jnt.id]);
    check('B3 changing a ticket state is refused', q.ok === false, 'succeeded');
    const st = await asSuper(MAINT_DB, (c) => c.query(`SELECT state FROM maint.ticket WHERE id=$1`, [jnt.id]));
    check('B3 the ticket state is unchanged', st.rows[0]?.state !== 'CLOSED', short(st.rows[0]));

    for (const t of ['ticket_event', 'audit_log', 'ticket']) {
      q = await tryQuery(creds, MAINT_DB, `DELETE FROM maint.${t}`);
      check(`B3 DELETE on maint.${t} is refused`, denied(q), short(q.err?.message || 'succeeded'));
      q = await tryQuery(creds, MAINT_DB, `TRUNCATE maint.${t} CASCADE`);
      check(`B3 TRUNCATE on maint.${t} is refused`, denied(q), short(q.err?.message || 'succeeded'));
    }
    q = await tryQuery(creds, MAINT_DB, `CREATE TABLE maint.bg_should_not_exist (x int)`);
    check('B3 CREATE TABLE is refused', q.ok === false, 'succeeded');
    q = await tryQuery(creds, MAINT_DB, `ALTER TABLE maint.ticket ADD COLUMN bg_x int`);
    check('B3 ALTER TABLE is refused', q.ok === false, 'succeeded');
    q = await tryQuery(creds, MAINT_DB, `DROP TABLE maint.audit_log`);
    check('B3 DROP TABLE is refused', q.ok === false, 'succeeded');
    const left = await asSuper(MAINT_DB, (c) => c.query(`SELECT count(*)::int n FROM maint.ticket WHERE id = ANY($1::uuid[])`, [ids]));
    check('B3 both complaints are still there', left.rows[0].n === 2, short(left.rows[0]));
  });

  /* ================= B7a — notifications after opening ================= */
  await attempt('B7 opened notifications', async () => {
    const g = await inbox(gm), a = await inbox(admin), o = await inbox(ovr), r = await inbox(resident);
    check('B7 the GM (Civil) has BREAK_GLASS_OPENED', g.some((n) => n.event_type === 'BREAK_GLASS_OPENED'), short(g.map((n) => n.event_type)));
    check('B7 the HQ System Administrator has BREAK_GLASS_OPENED', a.some((n) => n.event_type === 'BREAK_GLASS_OPENED'), short(a.map((n) => n.event_type)));
    const n = g.find((x) => x.event_type === 'BREAK_GLASS_OPENED');
    check('B7 the title is "Emergency database access opened"', n?.title_en === 'Emergency database access opened', short(n?.title_en));
    check('B7 the body names operator, approver and reference',
      /Operator/.test(n?.body_en || '') && /Approver/.test(n?.body_en || '') && /ORD\/2026\/1[78]/.test(n?.body_en || ''), short(n?.body_en));
    check('B7 the Jayant Overseer has no break-glass notification', !o.some((x) => /^BREAK_GLASS/.test(x.event_type)), short(o.map((x) => x.event_type)));
    check('B7 a resident has no break-glass notification', !r.some((x) => /^BREAK_GLASS/.test(x.event_type)), short(r.map((x) => x.event_type)));
  });

  /* ================= B4 — close ================= */
  await attempt('B4 close', async () => {
    for (const [label, s] of [['read', readS], ['write', writeS]]) {
      if (!s) { check(`B4 ${label} session exists`, false, 'not opened'); continue; }
      const r = bg(['close', '--session', s.session_id, '--note', `finished ${label} work`]);
      check(`B4 close of the ${label} session succeeds`, r.status === 0, `${r.status} ${short(r.stderr)}`);
      const e = await tryConnect(s.role, s.password, MAINT_DB);
      check(`B4 the ${label} credentials no longer connect`, e !== null, 'connected');
      const ex = await asSuper('postgres', (c) => c.query(`SELECT count(*)::int n FROM pg_roles WHERE rolname=$1`, [s.role]));
      check(`B4 the ${label} role no longer exists`, ex.rows[0].n === 0, short(ex.rows[0]));
      const again = bg(['close', '--session', s.session_id]);
      check(`B4 closing the ${label} session again is refused`, refused(again), `${again.status} ${short(again.stderr)}`);
    }
    const unk = bg(['close', '--session', crypto.randomUUID()]);
    check('B4 closing an unknown session is refused', refused(unk), `${unk.status} ${short(unk.stderr)}`);
  });

  /* ================= B5 — expiry and sweep ================= */
  let expS = null;
  await attempt('B5 expiry', async () => {
    const r = open(['--minutes', '5', '--mode', 'read', '--operator', 'E. Operator', '--approver', 'F. Approver', '--reference', 'ORD/2026/19']);
    check('B5 open --minutes 5 succeeds', r.status === 0 && !!r.json, `${r.status} ${short(r.stderr)}`);
    expS = r.json;
    if (!expS) return;
    check('B5 the fresh session connects', (await tryConnect(expS.role, expS.password, MAINT_DB)) === null);
    await asSuper('postgres', (c) => c.query(`ALTER ROLE "${expS.role}" VALID UNTIL '2020-01-01'`));
    const e = await tryConnect(expS.role, expS.password, MAINT_DB);
    check('B5 after expiry the login is refused', e !== null, 'connected');
    let l = bg(['list', '--json']);
    let rows = Array.isArray(l.json) ? l.json : (l.json?.sessions || []);
    let row = rows.find((x) => (x.session_id || x.id) === expS.session_id);
    check('B5 list shows the session as OVERDUE before the sweep', l.status === 0 && row?.status === 'OVERDUE', short(row));

    const s = bg(['sweep']);
    check('B5 sweep succeeds and prints a count', s.status === 0 && /\d/.test(s.stdout), `${s.status} ${short(s.stdout)} ${short(s.stderr)}`);
    const ex = await asSuper('postgres', (c) => c.query(`SELECT count(*)::int n FROM pg_roles WHERE rolname=$1`, [expS.role]));
    check('B5 the expired role is dropped by the sweep', ex.rows[0].n === 0, short(ex.rows[0]));
    l = bg(['list', '--json']);
    rows = Array.isArray(l.json) ? l.json : (l.json?.sessions || []);
    row = rows.find((x) => (x.session_id || x.id) === expS.session_id);
    check('B5 list shows it as EXPIRED after the sweep', row?.status === 'EXPIRED', short(row));
    const again = bg(['close', '--session', expS.session_id]);
    check('B5 an expired session cannot be closed again', refused(again), `${again.status} ${short(again.stderr)}`);
    const s2 = bg(['sweep']);
    check('B5 a second sweep finds nothing and succeeds', s2.status === 0, `${s2.status} ${short(s2.stderr)}`);
    check('B5 list shows both closed sessions as CLOSED',
      readS && writeS && [readS, writeS].every((x) => rows.find((y) => (y.session_id || y.id) === x.session_id)?.status === 'CLOSED'), short(rows.map((x) => x.status)));
  });

  /* ================= B6 — the register ================= */
  await attempt('B6 register', async () => {
    const ev = (await asSuper(BG_DB, (c) => c.query(`SELECT * FROM register.event ORDER BY id`))).rows;
    const names = ev.map((e) => e.event);
    check('B6 OPENED, CLOSED and EXPIRED events are present',
      ['OPENED', 'CLOSED', 'EXPIRED'].every((x) => names.includes(x)), names.join(','));
    check('B6 there are 3 OPENED, 2 CLOSED, 1 EXPIRED', names.filter((x) => x === 'OPENED').length === 3
      && names.filter((x) => x === 'CLOSED').length === 2 && names.filter((x) => x === 'EXPIRED').length === 1, names.join(','));
    const o1 = ev.find((e) => e.event === 'OPENED' && readS && e.session_id === readS.session_id);
    check('B6 the OPENED event records operator, approver, reference, reason, mode, role',
      o1?.operator === 'R. Operator' && o1?.approver === 'S. Approver' && o1?.reference === 'ORD/2026/17'
      && /stuck complaint/.test(o1?.reason || '') && o1?.mode === 'read' && o1?.role_name === readS.role, short(o1));
    check('B6 events record the machine and the OS user', ev.every((e) => e.host && e.os_user), short(ev[0]));
    const c1 = ev.find((e) => e.event === 'CLOSED' && readS && e.session_id === readS.session_id);
    check('B6 the CLOSED event carries the note and who it concerned',
      c1?.note === 'finished read work' && c1?.operator === 'R. Operator', short(c1));
    const x1 = ev.find((e) => e.event === 'EXPIRED');
    check('B6 the EXPIRED event is for the expired session', x1?.session_id === expS?.session_id, short(x1));
    check('B6 the first event starts from 64 zeros', ev[0]?.prev_hash === '0'.repeat(64), ev[0]?.prev_hash);
    check('B6 each event points to the hash before it', ev.every((e, k) => k === 0 || e.prev_hash === ev[k - 1].hash));
    check('B6 hashes are 64 hex characters and all differ', ev.every((e) => /^[0-9a-f]{64}$/.test(e.hash)) && new Set(ev.map((e) => e.hash)).size === ev.length);

    const v = bg(['verify', '--json']);
    check('B6 verify reports the register intact (exit 0)', v.status === 0 && v.json?.intact === true && v.json?.events === ev.length && !v.json?.problem, `${v.status} ${short(v.stdout)}`);
    const vt = bg(['verify']);
    check('B6 verify prints "register intact"', vt.status === 0 && /register intact/.test(vt.stdout), short(vt.stdout));

    const lines = fs.existsSync(BG_LOG) ? fs.readFileSync(BG_LOG, 'utf8').split('\n').filter((l) => l.trim()) : [];
    check('B6 the log file has as many lines as the register has events', lines.length === ev.length, `${lines.length} vs ${ev.length}`);
    let parsed = true; let same = true;
    try { lines.forEach((l, k) => { const o = JSON.parse(l); if (o.hash !== ev[k].hash) same = false; }); } catch { parsed = false; }
    check('B6 every line is JSON and carries the same hash as the register', parsed && same);

    /* append-only, even for the superuser */
    for (const [label, sql] of [
      ['UPDATE', `UPDATE register.event SET note = 'x' WHERE id = ${ev[0].id}`],
      ['DELETE', `DELETE FROM register.event WHERE id = ${ev[0].id}`],
      ['TRUNCATE', `TRUNCATE register.event`]]) {
      const q = await tryQuery({ role: SU, password: SUPW }, BG_DB, sql);
      check(`B6 ${label} on register.event is refused even for the superuser`, q.ok === false, 'succeeded');
    }
    const n = (await asSuper(BG_DB, (c) => c.query(`SELECT count(*)::int n FROM register.event`))).rows[0].n;
    check('B6 the register is unchanged by those attempts', n === ev.length, `${n}`);
    const v2 = bg(['verify', '--json']);
    check('B6 verify is still intact', v2.json?.intact === true, short(v2.stdout));

    /* deliberate tampering, in the test only */
    const target = ev[1].id;
    await asSuper(BG_DB, async (c) => {
      await c.query(`ALTER TABLE register.event DISABLE TRIGGER ALL`);
      try { await c.query(`UPDATE register.event SET operator = 'Somebody Else' WHERE id = $1`, [target]); }
      finally { await c.query(`ALTER TABLE register.event ENABLE TRIGGER ALL`); }
    });
    const bad = bg(['verify', '--json']);
    check('B6 after tampering, verify reports it broken (exit 1)', bad.status === 1 && bad.json?.intact === false, `${bad.status} ${short(bad.stdout)}`);
    check('B6 it names the problem', typeof bad.json?.problem === 'string' && bad.json.problem.length > 0, short(bad.json));
    const badT = bg(['verify']);
    check('B6 plain verify also exits 1 and does not say intact', badT.status === 1 && !/register intact/.test(badT.stdout), `${badT.status} ${short(badT.stdout)}`);
  });

  /* ================= B7b — notifications after closing ================= */
  await attempt('B7 closed notifications', async () => {
    const g = await inbox(gm), a = await inbox(admin), o = await inbox(ovr);
    check('B7 the GM (Civil) has BREAK_GLASS_CLOSED', g.some((n) => n.event_type === 'BREAK_GLASS_CLOSED'), short(g.map((n) => n.event_type)));
    check('B7 the HQ System Administrator has BREAK_GLASS_CLOSED', a.some((n) => n.event_type === 'BREAK_GLASS_CLOSED'), short(a.map((n) => n.event_type)));
    check('B7 the GM and administrator each have both OPENED and CLOSED',
      [g, a].every((x) => x.some((n) => n.event_type === 'BREAK_GLASS_OPENED') && x.some((n) => n.event_type === 'BREAK_GLASS_CLOSED')));
    check('B7 the Jayant Overseer still has none', !o.some((x) => /^BREAK_GLASS/.test(x.event_type)), short(o.map((x) => x.event_type)));
  });
}

try { await run(); } catch (e) { check('suite ran to the end', false, e.stack || e.message); }

for (const [s, n, d] of out) console.log(`${s}  ${n}${d ? `   — ${d}` : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
