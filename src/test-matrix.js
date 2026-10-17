/**
 * The four permission matrices, on their own scratch databases — never the
 * working ones (see test-all.js). Rebuilds them first; the matrices bring
 * their own data.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.env.IDENTITY_DB = process.env.TEST_IDENTITY_DB || 'ncl_identity_test';
process.env.MAINT_DB = process.env.TEST_MAINT_DB || 'ncl_maint_test';
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit' }).status;
if (run(process.execPath, ['src/db-reset.js']) !== 0) process.exit(1);
process.exit(run('python', ['sql/04_conformance_matrix.py']));
