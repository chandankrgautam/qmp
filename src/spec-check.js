/**
 * Specification conformance.
 *
 *   node src/spec-check.js
 *
 * Endpoints sat in the specification with no implementation for five
 * iterations without anyone noticing — including two that made delay
 * attribution unrecordable, and one that left the contract performance
 * report with an empty ratings column.
 *
 * A specification nobody checks is a wish. This runs in a second and fails
 * when the two drift apart.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const SPEC_DIR = process.env.SPEC_DIR || path.resolve(SRC, '../spec');
const SPECS = [
  ['maintenance', path.join(SPEC_DIR, 'maintenance-api.yaml')],
  ['identity',    path.join(SPEC_DIR, 'identity-api.yaml')]
];

/* Routes the application declares, read from source rather than from a
   running server, so this works in CI with no database. */
function declaredRoutes({ apiOnly = false } = {}) {
  const routes = new Set();
  const routers = apiOnly
    // the interface is not part of the API contract and would only add noise
    ? '(?:api|identityApi|publicApi|publicMaint|contracts|jobcards|materials|reviews|mb|hq|passkeys|notices|sheets)'
    : '(?:api|identityApi|publicApi|publicMaint|contracts|jobcards|materials|reviews|mb|hq|passkeys|notices|sheets|ui|app)';
  for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.js')) continue;
    if (apiOnly && (f === 'ui.js' || f.startsWith('test'))) continue;
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    const re = new RegExp(`\\b${routers}\\s*\\.\\s*(get|post|put|delete|patch)\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
    let m;
    while ((m = re.exec(src))) {
      // some routes sit on a router and some on the app with the full
      // path; strip the base so both forms compare equal
      const p = m[2].replace(/^\/(maintenance|identity)\/v1/, '');
      routes.add(`${m[1].toUpperCase()} ${normalise(p || '/')}`);
    }
  }
  return routes;
}

/* Express names a parameter; OpenAPI names it too, and they need not
   agree. Compare on shape rather than on the name, or a spec that says
   {key} and a route that says :key look like different endpoints. */
const normalise = (p) => p.replace(/\{[^}]+\}/g, ':p').replace(/:[A-Za-z_]\w*/g, ':p');

const declared = declaredRoutes();
const declaredApi = declaredRoutes({ apiOnly: true });
const allSpecified = new Set();
let problems = 0;

for (const [name, file] of SPECS) {
  if (!fs.existsSync(file)) {
    console.log(`  ${name}: specification not found at ${file}`);
    problems++;
    continue;
  }
  const doc = yaml.parse(fs.readFileSync(file, 'utf8'));
  const spec = new Set();
  for (const [p, ops] of Object.entries(doc.paths || {})) {
    for (const method of Object.keys(ops)) {
      if (['get','post','put','delete','patch'].includes(method)) {
        spec.add(`${method.toUpperCase()} ${normalise(p)}`);
      }
    }
  }
  for (const r of spec) allSpecified.add(r);
  const missing = [...spec].filter((r) => !declared.has(r)).sort();
  console.log(`\n  ${name}: ${spec.size} endpoints specified`);
  if (missing.length) {
    problems += missing.length;
    console.log(`  SPECIFIED BUT NOT IMPLEMENTED (${missing.length}):`);
    for (const r of missing) console.log(`      ${r}`);
  } else {
    console.log('      every specified endpoint is implemented');
  }
}

/* The other direction: a route the clients were never told about is a
   surface nobody reviewed. Not necessarily wrong — a convenience listing
   may be deliberate — but it should be a decision, not an accident. */
const undocumented = [...declaredApi]
  .filter((r) => !allSpecified.has(r))
  .filter((r) => !r.startsWith('PUT /media-upload'))   // driver-internal
  .sort();

if (undocumented.length) {
  console.log(`\n  IMPLEMENTED BUT NOT SPECIFIED (${undocumented.length}):`);
  for (const r of undocumented) console.log(`      ${r}`);
  console.log('      decide whether each belongs in the specification');
}

console.log(`\n  ${problems ? `${problems} gap(s)` : 'every specified endpoint is implemented'}` +
            `${undocumented.length ? `, ${undocumented.length} undocumented` : ''}\n`);
process.exit(problems ? 1 : 0);
