/**
 * The whole test run, from nothing:
 *
 *   npm run test:all
 *
 * Specification check first, then each of the eight suites against its
 * own freshly reset and seeded database, with its own server.
 *
 * Why a fresh database per suite: the suites change the record in ways
 * that cannot be undone, by design. test2 revokes the seeded contractor to
 * prove revocation works, and every later suite needs that contractor.
 * Ticket history is append-only, so there is nothing to "clean up" between
 * suites. The only honest way to run them is from a clean database each
 * time. Run one after another on a single database, suites 3 to 8 fail at
 * their first assignment.
 *
 * Needs no server running beforehand; it starts and stops its own on PORT.
 * Stop any server you have running first, since the reset drops the
 * databases under it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// The run uses its own databases, demo keys and port, never the working
// ones: someone may be using the portal on this machine while it runs
// (2026-10-07). Children inherit these.
process.env.IDENTITY_DB = process.env.TEST_IDENTITY_DB || 'ncl_identity_test';
process.env.MAINT_DB = process.env.TEST_MAINT_DB || 'ncl_maint_test';
process.env.DEVICES_FILE = process.env.TEST_DEVICES_FILE
  ? fileURLToPath(new URL(`../${process.env.TEST_DEVICES_FILE}`, import.meta.url))
  : fileURLToPath(new URL('../devices.test.json', import.meta.url));
process.env.PORT = process.env.TEST_PORT || '3100';
// the break-glass register is a database and a file of its own (phase 7)
process.env.BREAKGLASS_DB = process.env.TEST_BREAKGLASS_DB || 'ncl_breakglass_test';
process.env.BREAKGLASS_LOG = fileURLToPath(new URL(`../logs/${process.env.TEST_BREAKGLASS_LOG || 'break-glass.test.log'}`, import.meta.url));
const port = process.env.PORT;
const SUITES = ['test', 'test2', 'test3', 'test4', 'test5', 'test6', 'test7', 'test8', 'test9', 'test10', 'test11', 'test12', 'test13', 'test14', 'test15', 'test16', 'test17', 'test18', 'test19', 'test20', 'test21', 'test22', 'test23', 'test24', 'test25', 'test26', 'test27'];
const only = process.argv.slice(2);

// child processes inherit this process's environment, .env included
const node = (args, opts = {}) =>
  spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', ...opts });

async function waitForServer(ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { await fetch(`http://127.0.0.1:${port}/`); return true; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  return false;
}

// A server already on this port would answer in place of each suite's own
// fresh one, and every suite would quietly test the wrong database (it
// happened, 2026-10-08: a forgotten preview server on 3100). Refuse instead.
try {
  await fetch(`http://127.0.0.1:${port}/`);
  console.error(`port ${port} is already in use by another server; stop it (or set TEST_PORT) and run again`);
  process.exit(1);
} catch { /* free, as it should be */ }

const results = [];
if (!only.length && node(['src/spec-check.js']).status !== 0) {
  console.error('\nspecification check failed; suites not run');
  process.exit(1);
}

for (const suite of only.length ? only : SUITES) {
  console.log(`\n=== ${suite}: fresh database`);
  for (const step of ['src/db-reset.js', 'src/seed.js']) {
    const r = node([step], { stdio: 'pipe', encoding: 'utf8' });
    if (r.status !== 0) {
      console.error(`${step} failed:\n${r.stdout}${r.stderr}`);
      process.exit(1);
    }
  }
  const server = spawn(process.execPath, ['src/server.js'],
    { cwd: root, stdio: 'ignore' });
  try {
    if (!(await waitForServer())) {
      results.push([suite, 'server did not start']);
      continue;
    }
    const r = node([`src/${suite}.js`]);
    results.push([suite, r.status === 0 ? 'ok' : `FAILED (exit ${r.status})`]);
  } finally {
    server.kill();
  }
}

console.log('\n=== summary');
for (const [suite, outcome] of results) console.log(`  ${suite.padEnd(6)} ${outcome}`);
process.exit(results.every(([, o]) => o === 'ok') ? 0 : 1);
