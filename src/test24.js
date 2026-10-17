/**
 * Suite 24 — contractor staff on the web (user's decisions, 2026-10-16).
 *
 * Written before the code. Contractor staff were app-only (README §5.5); the
 * user decided that the firm and its supervisors may also sign in on the web,
 * with the mobile number and an OTP every time:
 *
 *   C1  sign-in: mobile + OTP, only for someone with an approved phone in the
 *       app, only into a role of the tab used (firm or supervisor); the OTP
 *       proves the mobile once; the sign-in is logged as 'otp'
 *   C2  such a session never reaches another kind of role (a Non-NCL
 *       resident's home stays app-only), and stops when the role ends or the
 *       phone is revoked (at its next refresh)
 *   C3  the supervisor on the web: reads its jobs and records or withdraws
 *       materials; starting work, the completion claim and every photograph
 *       stay on the phone (control 2) — refused by the database
 *   C4  the record says how each act was done: the history and material lines
 *       carry the sign-in method, so officers can see "from the web"
 *   C5  the firm on the web reads its own jobs, changes nothing, and downloads
 *       them as CSV; officers download theirs too; others are refused
 *
 * Needs a freshly reset and seeded database.
 */
import fs from 'node:fs';
import { signNonce } from './auth.js';
import { withSystem, maintPool, identityPool } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => { if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); } };
async function attempt(n, fn) { try { await fn(); } catch (e) { check(n, false, `threw: ${e.message}`.slice(0, 240)); } }

const json = { 'content-type': 'application/json' };
const post = (p, b, tok) => fetch(`${BASE}${p}`, { method: 'POST', headers: { ...json, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(b || {}) });
const get = (p, tok) => fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${tok}` } });
const call = (tok, p, method = 'GET', b) => fetch(`${BASE}/maintenance/v1${p}`, { method,
  headers: { ...json, authorization: `Bearer ${tok}` }, body: b ? JSON.stringify(b) : undefined });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const short = (x) => String(JSON.stringify(x)).slice(0, 240);
const list = (b) => (Array.isArray(b) ? b : b?.items || []);
const claimsOf = (tok) => { try { return JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString()); } catch { return {}; } };
const sysI = (sql, p) => withSystem(identityPool, (c) => c.query(sql, p));
const sysM = (sql, p) => withSystem(maintPool, (c) => c.query(sql, p));

async function as(key, extra = {}) {
  const d = devices[key];
  const ch = await (await post('/identity/v1/auth/challenge', { public_key: d.publicKey })).json();
  return (await post('/identity/v1/auth/token', { public_key: d.publicKey, nonce: ch.nonce,
    signature: signNonce(d.privateKey, ch.nonce), second_factor_satisfied: true, role: d.role, ...extra })).json();
}
/* The mobile proved by OTP, as the web's tab does it. */
async function proved(mobile) {
  const o = await j(await post('/identity/v1/auth/otp/request', { mobile }));
  const v = await j(await post('/identity/v1/auth/otp/verify', { mobile, code: o.dev_code }));
  return v.registration_token;
}
const mobileOf = async (name) => (await sysI(`SELECT mobile FROM identity.person WHERE name=$1`, [name])).rows[0]?.mobile;

async function run() {
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey');
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
  const resident = await as('RESIDENT:R. K. Singh');
  const supPhone = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const supMobile = await mobileOf('M/s Verma — Supr');
  const firmMobile = await mobileOf('M/s Jayant Constructions');
  const cats = await j(await call(resident.token, '/masters/categories'));
  const sub = cats.find((c) => c.classification !== 'EM' && !c.emergency_eligible) || cats[0];
  const assignable = await j(await call(inc.token, '/devices/assignable'));
  const verma = assignable.find((a) => a.person_name === 'M/s Verma — Supr');
  async function assigned(desc) {
    const t = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: sub.id, description: desc }));
    if (!t.id) throw new Error(`raise ${short(t)}`);
    let r = await call(ovr.token, `/tickets/${t.id}/verify`, 'POST');
    if (r.status !== 200) throw new Error(`verify ${r.status}`);
    r = await call(inc.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: verma.actor_id });
    if (r.status !== 200) throw new Error(`assign ${r.status}`);
    return t;
  }

  /* ------------------------------------------------------------ C1 */
  let web;     // the supervisor's web session
  await attempt('C1 sign-in', async () => {
    const tok = await proved(supMobile);
    check('C1 the supervisor proves the mobile by OTP', !!tok, '');
    let r = await post('/identity/v1/auth/contractor', { registration_token: tok, kind: 'CONTRACTOR_SUPERVISOR' });
    web = await j(r);
    check('C1 and signs in on the web as the supervisor', r.status === 200 && web.role === 'CONTRACTOR_SUPERVISOR' && !!web.token, `${r.status} ${short(web)}`);
    check('C1 the session says it was an OTP sign-in', claimsOf(web.token).amr === 'otp', short(claimsOf(web.token)));
    r = await post('/identity/v1/auth/contractor', { registration_token: tok, kind: 'CONTRACTOR_SUPERVISOR' });
    check('C1 the same OTP signs in only once', r.status === 401, `${r.status}`);
    r = await post('/identity/v1/auth/contractor', { registration_token: await proved(supMobile), kind: 'CONTRACTOR' });
    check('C1 the supervisor cannot use the firm’s tab', r.status === 401, `${r.status} ${short(await j(r))}`);
    r = await post('/identity/v1/auth/contractor', { registration_token: 'made-up', kind: 'CONTRACTOR_SUPERVISOR' });
    check('C1 a made-up proof is refused', r.status === 401, `${r.status}`);
    r = await post('/identity/v1/auth/contractor', { registration_token: await proved(supMobile), kind: 'CIVIL_OVERSEER' });
    check('C1 only the two contractor tabs exist', [401, 422].includes(r.status), `${r.status}`);
    const offMobile = await mobileOf('A. K. Dubey');
    r = await post('/identity/v1/auth/contractor', { registration_token: await proved(offMobile), kind: 'CONTRACTOR_SUPERVISOR' });
    check('C1 an officer holds no contractor role, so is refused', r.status === 401, `${r.status}`);
    const firm = await j(await post('/identity/v1/auth/contractor', { registration_token: await proved(firmMobile), kind: 'CONTRACTOR' }));
    check('C1 the firm signs in on its own tab', firm.role === 'CONTRACTOR' && !!firm.token, short(firm));
    const logged = (await sysI(`SELECT count(*)::int n FROM identity.sign_in_log WHERE method='otp' AND success`)).rows[0].n;
    check('C1 web sign-ins are logged as OTP', logged >= 2, `${logged}`);
  });

  await attempt('C1 no approved phone, no web sign-in', async () => {
    // a supervisor appointed by the Incharge, whose phone was never registered
    const contracts = await j(await call(inc.token, '/contracts'));
    const ct = list(contracts)[0] || contracts[0];
    const mobile = '9876501234';
    const r = await post('/identity/v1/supervisors', { contract_id: ct?.id, name: 'Suite 24 New Supr', mobile, reason: 'suite 24' }, inc.token);
    check('C1 (the Incharge appoints a supervisor with no phone)', [200, 201].includes(r.status), `${r.status} ${short(await j(r))}`);
    const s = await post('/identity/v1/auth/contractor', { registration_token: await proved(mobile), kind: 'CONTRACTOR_SUPERVISOR' });
    const b = await j(s);
    check('C1 is refused on the web until their phone is approved in the app', s.status === 401, `${s.status} ${short(b)}`);
    check('C1 and told so plainly', /app|phone/i.test(b.error || b.detail || ''), short(b));
  });

  /* ------------------------------------------------------------ C2 */
  await attempt('C2 the web session stays a contractor session', async () => {
    // the supervisor also asks for a home and has it approved: a resident role on the same person
    const colonies = await j(await fetch(`${BASE}/identity/v1/masters/colonies`));
    const jayant = colonies.find((c) => /jayant/i.test(`${c.area} ${c.name}`)) || colonies[0];
    const h = await j(await post('/identity/v1/me/homes', { colony_id: jayant.id, role: 'RESIDENT', identifier: 'C-24' }, supPhone.token));
    if (h.id) await post(`/identity/v1/home-requests/${h.id}/approve`, { quarter_type: 'C' }, inc.token);
    const again = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
    const home = (again.assignments || []).find((a) => a.role === 'RESIDENT');
    check('C2 (the supervisor now also holds a resident role)', !!home, short(again.assignments));
    const s = await j(await post('/identity/v1/auth/contractor', { registration_token: await proved(supMobile), kind: 'CONTRACTOR_SUPERVISOR' }));
    check('C2 the web offers only the supervisor’s role', s.role === 'CONTRACTOR_SUPERVISOR' || (s.assignments || []).every((a) => a.role === 'CONTRACTOR_SUPERVISOR'), short(s));
    web = s.token ? s : web;
    if (home) {
      const sw = await post('/identity/v1/auth/switch-role', { assignment_id: home.id }, web.token);
      check('C2 and cannot switch into the resident’s role (Non-NCL residents are app-only)', sw.status >= 400, `${sw.status} ${short(await j(sw))}`);
    }
    const rf = await j(await post('/identity/v1/auth/refresh', { refresh_token: web.refresh_token }));
    check('C2 the session renews while the role and phone hold', !!rf.token && claimsOf(rf.token).amr === 'otp' && rf.role === 'CONTRACTOR_SUPERVISOR', short(rf));
  });

  /* ------------------------------------------------------------ C3 */
  let job;
  await attempt('C3 the supervisor on the web', async () => {
    job = await assigned('Suite 24: plaster cracked');
    let rows = list(await j(await call(web.token, '/tickets')));
    check('C3 the web session reads its jobs', rows.some((x) => x.id === job.id), `${rows.length}`);
    let r = await call(web.token, `/tickets/${job.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
    check('C3 starting work is refused from the web', [403, 422].includes(r.status), `${r.status} ${short(await j(r))}`);
    r = await call(supPhone.token, `/tickets/${job.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' });
    check('C3 (the phone starts it)', r.status === 200, `${r.status} ${short(await j(r))}`);
    r = await call(web.token, '/media/upload-url', 'POST', { ticket_id: job.id, purpose: 'BEFORE', content_type: 'image/jpeg' });
    check('C3 a photograph cannot be sent from the web (control 2)', [403, 422].includes(r.status), `${r.status} ${short(await j(r))}`);
    const mats = await j(await call(web.token, '/materials'));
    r = await call(web.token, `/tickets/${job.id}/materials`, 'POST', { material_id: mats[0]?.id, qty_claimed: 2 });
    const line = await j(r);
    check('C3 materials are recorded from the web', [200, 201].includes(r.status) && !!line.id, `${r.status} ${short(line)}`);
    r = await call(web.token, `/tickets/${job.id}/materials/${line.id}/withdraw`, 'POST', { reason: 'Entered twice' });
    check('C3 and withdrawn from the web', r.status === 200, `${r.status} ${short(await j(r))}`);
    r = await call(web.token, `/tickets/${job.id}/materials`, 'POST', { material_id: mats[0]?.id, qty_claimed: 1 });
    check('C3 (claimed again)', [200, 201].includes(r.status), `${r.status}`);
    r = await call(web.token, `/tickets/${job.id}/complete`, 'POST');
    check('C3 the completion claim is refused from the web', [403, 422].includes(r.status), `${r.status} ${short(await j(r))}`);
    r = await call(supPhone.token, `/tickets/${job.id}/complete`, 'POST');
    check('C3 (the phone claims it)', r.status === 200, `${r.status} ${short(await j(r))}`);
  });

  /* ------------------------------------------------------------ C4 */
  await attempt('C4 how each act was done', async () => {
    const d = await j(await call(ovr.token, `/tickets/${job.id}`));
    const by = (to) => (d.history || []).find((h) => h.to_state === to);
    check('C4 the history says the start was made on the phone', by('IN_PROGRESS')?.via === 'device', short(by('IN_PROGRESS')));
    check('C4 and the verification on the phone too (the Overseer’s device session)', by('VERIFIED')?.via === 'device', short(by('VERIFIED')));
    const pw = await j(await post('/identity/v1/auth/password', { employee_id: '90222001', password: 'Portal@2026', role: 'CIVIL_OVERSEER' }));
    const t2 = await j(await call(resident.token, '/tickets', 'POST', { sub_category_id: sub.id, description: 'Suite 24: via the web' }));
    await call(pw.token, `/tickets/${t2.id}/verify`, 'POST');
    const d2 = await j(await call(ovr.token, `/tickets/${t2.id}`));
    check('C4 an officer’s act on the web says so', (d2.history || []).find((h) => h.to_state === 'VERIFIED')?.via === 'password', short(d2.history));
    const m = await j(await call(ovr.token, `/tickets/${job.id}/materials`));
    const live = (m.items || []).filter((l) => !l.withdrawn_at);
    check('C4 a material line says it was recorded from the web', live.length > 0 && live.every((l) => l.claimed_via === 'otp'), short(m.items));
  });

  /* ------------------------------------------------------------ C5 */
  await attempt('C5 the firm on the web, and CSV', async () => {
    const firm = await j(await post('/identity/v1/auth/contractor', { registration_token: await proved(firmMobile), kind: 'CONTRACTOR' }));
    const rows = list(await j(await call(firm.token, '/tickets')));
    check('C5 the firm reads its jobs on the web', rows.some((x) => x.id === job.id), `${rows.length}`);
    check('C5 and can do nothing to them', rows.every((x) => !(x.available_actions || []).length), short(rows.map((x) => x.available_actions)));
    let r = await call(firm.token, `/tickets/${job.id}/materials`, 'POST', { material_id: 'x', qty_claimed: 1 });
    check('C5 the firm cannot record materials', r.status >= 400, `${r.status}`);
    r = await fetch(`${BASE}/maintenance/v1/tickets.csv`, { headers: { authorization: `Bearer ${firm.token}` } });
    const csv = await r.text();
    check('C5 the firm downloads its jobs as CSV', r.status === 200 && /text\/csv/.test(r.headers.get('content-type') || ''), `${r.status} ${csv.slice(0, 160)}`);
    check('C5 the CSV carries the job and its supervisor', csv.includes(job.ticket_no) && /M\/s Verma/.test(csv), csv.slice(0, 300));
    r = await fetch(`${BASE}/maintenance/v1/tickets.csv?state=CLOSED`, { headers: { authorization: `Bearer ${firm.token}` } });
    check('C5 filtered to completed work', r.status === 200, `${r.status}`);
    r = await fetch(`${BASE}/maintenance/v1/tickets.csv`, { headers: { authorization: `Bearer ${ovr.token}` } });
    const oc = await r.text();
    check('C5 the Overseer downloads the Area’s complaints as CSV', r.status === 200 && oc.split('\n').length > 2, `${r.status} ${oc.slice(0, 120)}`);
    r = await fetch(`${BASE}/maintenance/v1/tickets.csv`, { headers: { authorization: `Bearer ${resident.token}` } });
    check('C5 a resident is refused the CSV', r.status === 403, `${r.status}`);
    r = await fetch(`${BASE}/maintenance/v1/tickets.csv`, { headers: { authorization: `Bearer ${supPhone.token}` } });
    check('C5 a supervisor is refused the CSV', r.status === 403, `${r.status}`);
    r = await fetch(`${BASE}/maintenance/v1/search.csv?q=Suite`, { headers: { authorization: `Bearer ${ovr.token}` } });
    const sc = await r.text();
    check('C5 Search downloads its results as CSV for officers', r.status === 200 && sc.split('\n').length > 2, `${r.status} ${sc.slice(0, 160)}`);
    r = await fetch(`${BASE}/maintenance/v1/search.csv?q=Suite`, { headers: { authorization: `Bearer ${resident.token}` } });
    check('C5 and refuses it to a resident', r.status === 403, `${r.status}`);
  });

  /* ------------------------------------------------------------ C2 (ends) */
  await attempt('C2 the web session ends with the role or the phone', async () => {
    // the phone is revoked: the web session is refused at its next refresh
    const dev = (await sysI(`SELECT d.id FROM identity.device d JOIN identity.person p ON p.id=d.person_id
                              WHERE p.name='M/s Verma — Supr' AND d.status='ACTIVE' LIMIT 1`)).rows[0];
    await sysI(`UPDATE identity.device SET status='REVOKED', revoked_at=now(), revocation_reason='suite 24' WHERE id=$1`, [dev.id]);
    const rf = await post('/identity/v1/auth/refresh', { refresh_token: web.refresh_token });
    check('C2 revoking the phone ends the web session at its next refresh', rf.status === 401, `${rf.status} ${short(await j(rf))}`);
    const s = await post('/identity/v1/auth/contractor', { registration_token: await proved(supMobile), kind: 'CONTRACTOR_SUPERVISOR' });
    check('C2 and the web sign-in stops the same day', s.status === 401, `${s.status}`);
  });
}

run().catch((e) => check('suite ran to the end', false, e.stack))
  .finally(async () => {
    for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n         ${d}` : ''}`);
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await maintPool.end().catch(() => {}); await identityPool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
