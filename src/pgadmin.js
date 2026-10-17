/**
 * Superuser access to PostgreSQL, for the scripts that build databases:
 * db-reset, the load simulation and the conformance matrices.
 *
 * The application itself never uses this. It connects as appconn, which
 * owns nothing, because row-level security does not apply to a table's
 * owner (see db.js).
 *
 * This replaced `su postgres -c "..."`, which only worked on Linux with
 * peer authentication. Here every call names the host, the user and the
 * password explicitly, and arguments are passed without a shell, so a
 * path containing a space cannot split into two arguments.
 *
 * Also usable from the command line, to load one SQL file:
 *   node src/pgadmin.js <database> <file.sql>
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PG_HOST = process.env.PGHOST
  || (process.platform === 'win32' ? 'localhost' : '/var/run/postgresql');
export const PG_PORT = process.env.PGPORT || '5432';
export const PG_ADMIN_USER = process.env.PG_SUPERUSER || 'postgres';

/* PGCLIENTENCODING: on Windows psql otherwise takes the console code page
   (WIN1252) as the file's encoding. The schemas are UTF-8 and carry Hindi,
   so the load either failed outright or, worse, stored garbled Hindi. */
const env = { ...process.env, PGPASSWORD: process.env.PG_SUPERUSER_PASSWORD ?? '',
  PGCLIENTENCODING: 'UTF8' };
const conn = ['-h', PG_HOST, '-p', PG_PORT, '-U', PG_ADMIN_USER, '-w'];

function run(bin, args, { quiet = false } = {}) {
  execFileSync(bin, args, { env, stdio: ['ignore', quiet ? 'ignore' : 'inherit', 'inherit'] });
}

/* --force ends any connection still open, such as a running server's pool.
   Without it the drop fails whenever the server was left running. */
export const dropdb = (db) => run('dropdb', [...conn, '--if-exists', '--force', db]);
export const createdb = (db) => run('createdb', [...conn, db]);

export const psqlFile = (db, file) =>
  run('psql', [...conn, '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', file]);
export const psqlCommand = (db, sql, opts) =>
  run('psql', [...conn, '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], opts);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [db, file] = process.argv.slice(2);
  if (!db || !file) {
    console.error('usage: node src/pgadmin.js <database> <file.sql>');
    process.exit(2);
  }
  psqlFile(db, path.resolve(file));
}
