/**
 * Suite 18 — passkeys on the web (WebAuthn), written from the specification.
 *
 *   P1  options for registration: token, password again, lockout, who may
 *   P2  registering a passkey: name, user verification, duplicates, replay
 *   P3  signing in with a passkey: both routes, every refusal, the log
 *   P4  a passkey session is a web session: inspection acceptance refused
 *   P5  at most five live passkeys
 *   P6  own list, own removal, removed passkeys and their refresh tokens
 *   P7  Area administrators and everyone else
 *   P8  Non-NCL people and contractor staff cannot hold a passkey
 *
 * Uses the software authenticator (src/softauth.js). Needs a freshly reset
 * and seeded database (test-all.js gives each suite one).
 */
import fs from 'node:fs';
import { SoftAuthenticator } from './softauth.js';
import { uploadCompletion, uploadInspection } from './testutil.js';
import { withSystem, maintPool, identityPool } from './db.js';
import { signNonce } from './auth.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => { if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); } };
async function attempt(n, fn) { try { await fn(); } catch (e) { check(n, false, `threw: ${e.message}`.slice(0, 220)); } }

const json = { 'content-type': 'application/json' };
const post = (p, b, tok) => fetch(`${BASE}${p}`, { method: 'POST',
  headers: { ...json, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(b || {}) });
const get = (p, tok) => fetch(`${BASE}${p}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const sys = (pool, sql, params) => withSystem(pool, (c) => c.query(sql, params));
const I = '/identity/v1';
const PW = 'Portal@2026';
const short = (x) => JSON.stringify(x).slice(0, 220);

async function device(key, pick = {}) {
  const d = devices[key];
  const ch = await j(await post(`${I}/auth/challenge`, { public_key: d.publicKey }));
  return j(await post(`${I}/auth/token`, { public_key: d.publicKey, nonce: ch.nonce,
    signature: signNonce(d.privateKey, ch.nonce), second_factor_satisfied: true, ...pick }));
}
const as = (key) => device(key, { role: devices[key].role });
const pwLogin = async (emp, role) => j(await post(`${I}/auth/password`, { employee_id: emp, password: PW, ...(role ? { role } : {}) }));
const claimsOf = (tok) => { try { return JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString()); } catch { return null; } };

/* registration helpers */
const regOptions = (tok, password = PW) => post(`${I}/passkeys/options`, { password }, tok);
async function addPasskey(tok, auth, name, opts = {}) {
  const o = await regOptions(tok);
  const ob = await j(o);
  if (o.status !== 200) return { status: o.status, body: ob, step: 'options' };
  const resp = auth.register(ob.options, opts);
  const r = await post(`${I}/passkeys`, { response: resp, name }, tok);
  return { status: r.status, body: await j(r), resp, options: ob.options, step: 'register' };
}
/* sign-in helpers: the counter always rises unless a test says otherwise */
let ctr = 0;
async function pkOptions() { const r = await post(`${I}/auth/passkey/options`, {}); return { status: r.status, body: await j(r) }; }
async function pkSignIn(auth, credId, o = {}, extra = {}) {
  const { body } = await pkOptions();
  const asr = auth.authenticate(body.options, { credentialId: credId, counter: o.counter ?? ++ctr, uv: o.uv, origin: o.origin });
  const r = await post(`${I}/auth/passkey`, { response: asr, ...extra }, undefined);
  return { status: r.status, body: await j(r), asr };
}
const failedPasskeyRows = async () => Number((await sys(identityPool,
  `SELECT count(*) n FROM identity.sign_in_log WHERE method='passkey' AND success=false`)).rows[0].n);

async function run() {
  const mishraPerson = devices['MAINTENANCE_INCHARGE:P. N. Mishra'].person_id;
  const auth = new SoftAuthenticator();

  /* ================= P1 — options for registration ================= */
  let mishra = await pwLogin('90222002', 'MAINTENANCE_INCHARGE');
  check('P1 (setup) the Incharge signs in by password', !!mishra.token, short(mishra));

  let r = await post(`${I}/passkeys/options`, { password: PW });
  check('P1 registration options need a token', r.status === 401, `${r.status}`);
  r = await post(`${I}/passkeys/options`, { password: 'not-the-password' }, mishra.token);
  check('P1 a wrong password is refused with 403', r.status === 403, `${r.status} ${short(await j(r))}`);
  r = await post(`${I}/passkeys/options`, {}, mishra.token);
  check('P1 no password in the request is refused', r.status === 403 || r.status === 422, `${r.status}`);

  // a person with no web password
  await attempt('P1 no web password', async () => {
    const sharma = await as('AREA_SYS_ADMIN:V. Sharma');
    let cleared = true;
    try { await sys(identityPool, `UPDATE identity.person SET password_hash = NULL WHERE personnel_no='90222005'`); } catch { cleared = false; }
    if (!cleared) { check('P1 (skipped) could not clear the password of V. Sharma', true); return; }
    const x = await regOptions(sharma.token);
    check('P1 a person with no web password is refused with 422', x.status === 422, `${x.status} ${short(await j(x))}`);
  });

  // contractor staff / Non-NCL: see also P8
  const sup = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  r = await regOptions(sup.token);
  check('P1 a contractor supervisor (no Employee ID) gets 403', r.status === 403, `${r.status}`);

  // lockout, on a person not needed later
  await attempt('P1 lockout', async () => {
    const nig = await as('CIVIL_OVERSEER:Nigahi Overseer');
    let statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await regOptions(nig.token, 'wrong-password-' + i)).status);
    check('P1 wrong passwords are refused (403, or 423 once locked)', statuses.every((s) => s === 403 || s === 423) && statuses[0] === 403, statuses.join(','));
    const pwr = await j(await post(`${I}/auth/password`, { employee_id: '90223001', password: PW }));
    check('P1 five wrong passwords lock sign-in, even for the right password', !pwr.token, short(pwr));
    const lk = await regOptions(nig.token);
    check('P1 and the right password at registration is refused while locked', lk.status === 423 || lk.status === 403, `${lk.status}`);
  });

  // good options
  r = await regOptions(mishra.token);
  let ob = await j(r);
  const o = ob.options || {};
  check('P1 good request: 200 with options', r.status === 200 && !!o.challenge, `${r.status} ${short(ob)}`);
  check('P1 relying party id is localhost', o.rp?.id === 'localhost', short(o.rp));
  check('P1 user.name is the Employee ID', o.user?.name === '90222002', short(o.user));
  check('P1 residentKey is required', o.authenticatorSelection?.residentKey === 'required', short(o.authenticatorSelection));
  check('P1 userVerification is required', o.authenticatorSelection?.userVerification === 'required', short(o.authenticatorSelection));
  check('P1 ES256 (-7) is among the accepted algorithms', (o.pubKeyCredParams || []).some((p) => p.alg === -7), short(o.pubKeyCredParams));
  check('P1 with no passkey yet, nothing is excluded', (o.excludeCredentials || []).length === 0, short(o.excludeCredentials));

  /* ================= P2 — registering ================= */
  let a = await addPasskey(mishra.token, auth, '');
  check('P2 no name is refused with 422', a.status === 422, `${a.status} ${short(a.body)}`);
  a = await addPasskey(mishra.token, auth, 'x'.repeat(61));
  check('P2 a 61-character name is refused with 422', a.status === 422, `${a.status} ${short(a.body)}`);
  a = await addPasskey(mishra.token, auth, 'Office laptop', { uv: false });
  check('P2 a response without user verification is refused with 422', a.status === 422, `${a.status} ${short(a.body)}`);
  a = await addPasskey(mishra.token, auth, 'Office laptop', { origin: 'http://evil.example' });
  check('P2 a response from the wrong origin is refused with 422', a.status === 422, `${a.status} ${short(a.body)}`);

  a = await addPasskey(mishra.token, auth, 'x'.repeat(60));
  check('P2 a 60-character name is accepted', a.status === 201, `${a.status} ${short(a.body)}`);
  // that was a throw-away; remove it so the count below is easy to follow
  await post(`${I}/passkeys/${a.body.id}/revoke`, { reason: 'test clean-up' }, mishra.token);

  a = await addPasskey(mishra.token, auth, 'Office laptop');
  const pk1 = a.body;
  check('P2 a good registration: 201 with id and name', a.status === 201 && !!pk1.id && pk1.name === 'Office laptop', `${a.status} ${short(a.body)}`);
  const cred1 = a.resp?.id;

  // the same response again: the challenge is used
  let rr = await post(`${I}/passkeys`, { response: a.resp, name: 'Again' }, mishra.token);
  check('P2 a challenge already used is refused with 422', rr.status === 422, `${rr.status} ${short(await j(rr))}`);

  // the same credential with a fresh challenge: 409. "none" attestation has
  // no signature, so only clientDataJSON needs the new challenge.
  const o2 = (await j(await regOptions(mishra.token))).options;
  const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: o2.challenge, origin: auth.origin, crossOrigin: false })).toString('base64url');
  const dup = { ...a.resp, response: { ...a.resp.response, clientDataJSON: cd } };
  rr = await post(`${I}/passkeys`, { response: dup, name: 'Duplicate' }, mishra.token);
  check('P2 the same credential registered again is refused with 409', rr.status === 409, `${rr.status} ${short(await j(rr))}`);
  check('P2 excludeCredentials lists the live passkey', (o2.excludeCredentials || []).some((c) => c.id === cred1), short(o2.excludeCredentials));

  // an older challenge is not accepted once a newer one is issued
  const oldO = (await j(await regOptions(mishra.token))).options;
  const newO = (await j(await regOptions(mishra.token))).options;
  const staleResp = auth.register(oldO);
  rr = await post(`${I}/passkeys`, { response: staleResp, name: 'Stale' }, mishra.token);
  check('P2 only the latest challenge issued to the person is accepted', rr.status === 422, `${rr.status}`);
  void newO;

  const added = (await sys(identityPool, `SELECT * FROM identity.audit_log WHERE event_type='PASSKEY_ADDED'`)).rows;
  check('P2 adding is in the audit log as PASSKEY_ADDED, with the name',
    added.some((x) => JSON.stringify(x).includes('Office laptop')), `${added.length} rows`);

  /* ================= P3 — signing in ================= */
  const po = await pkOptions();
  check('P3 passkey options need no token and have the right shape',
    po.status === 200 && !!po.body.options?.challenge && po.body.options.rpId === 'localhost' && po.body.options.userVerification === 'required',
    short(po.body));

  let s = await pkSignIn(auth, cred1);
  check('P3 a person with two roles gets a person token and the role list, not a role',
    s.status === 200 && !s.body.token && !!s.body.person_token && s.body.assignments?.length === 2, `${s.status} ${short(s.body)}`);
  const incA = (s.body.assignments || []).find((x) => x.role === 'MAINTENANCE_INCHARGE');
  const sel = await j(await post(`${I}/auth/select-role`, { person_token: s.body.person_token, assignment_id: incA?.id }));
  check('P3 select-role gives an access token', sel.role === 'MAINTENANCE_INCHARGE' && !!sel.token, short(sel));
  const cl = claimsOf(sel.token);
  check('P3 the access token carries amr "passkey" and the passkey id', cl?.amr === 'passkey' && !!cl?.passkey_id, short(cl));
  const me = await j(await get(`${I}/me`, sel.token));
  check('P3 /me reports the method as passkey, not device', me.auth_method === 'passkey', short(me).slice(0, 200));

  // role chosen in the same call
  s = await pkSignIn(auth, cred1, {}, { role: 'MAINTENANCE_INCHARGE' });
  check('P3 a role may be chosen in the sign-in call itself', s.status === 200 && s.body.role === 'MAINTENANCE_INCHARGE' && !!s.body.token && !!s.body.refresh_token, `${s.status} ${short(s.body)}`);

  // refusals
  const before = await failedPasskeyRows();
  s = await pkSignIn(auth, cred1);
  const okAsr = s.asr;
  rr = await post(`${I}/auth/passkey`, { response: okAsr });
  check('P3 a challenge already used is refused with 401 and {error}', rr.status === 401 && !!(await j(rr)).error, `${rr.status}`);
  s = await pkSignIn(auth, cred1, { uv: false });
  check('P3 a response without user verification is refused with 401', s.status === 401 && !!s.body.error, `${s.status} ${short(s.body)}`);
  s = await pkSignIn(auth, cred1, { origin: 'http://evil.example' });
  check('P3 a response from the wrong origin is refused with 401', s.status === 401 && !!s.body.error, `${s.status} ${short(s.body)}`);

  // a counter going backwards
  ctr += 100;
  s = await pkSignIn(auth, cred1, { counter: ctr });
  check('P3 (setup) a sign-in with a high counter succeeds', s.status === 200, `${s.status} ${short(s.body)}`);
  const beforeBack = await failedPasskeyRows();
  s = await pkSignIn(auth, cred1, { counter: 3 });
  check('P3 a signature counter that goes backwards is refused with 401', s.status === 401 && !!s.body.error, `${s.status} ${short(s.body)}`);
  const backRows = (await sys(identityPool,
    `SELECT * FROM identity.sign_in_log WHERE method='passkey' AND success=false ORDER BY id DESC LIMIT 1`)).rows[0];
  check('P3 the backwards counter is logged as a failed passkey sign-in', (await failedPasskeyRows()) === beforeBack + 1 && !!backRows, short(backRows));
  check('P3 the log entry says what happened (counter / copy)', /counter|clone|copied/i.test(backRows?.detail || ''), short(backRows));
  ctr += 100;

  // unknown credential: registered against options but never POSTed
  const stranger = new SoftAuthenticator();
  const ro = (await j(await regOptions(mishra.token))).options;
  stranger.register(ro);
  s = await pkSignIn(stranger, undefined);
  check('P3 an unknown passkey is refused with 401', s.status === 401 && !!s.body.error, `${s.status} ${short(s.body)}`);
  check('P3 refused passkey sign-ins are logged', (await failedPasskeyRows()) >= before + 4, `${before} -> ${await failedPasskeyRows()}`);

  const okRows = Number((await sys(identityPool,
    `SELECT count(*) n FROM identity.sign_in_log WHERE method='passkey' AND success=true AND person_id=$1`, [mishraPerson])).rows[0].n);
  check('P3 successful sign-ins are logged with method passkey', okRows >= 3, `${okRows}`);

  // a one-role person: a token straight away (GM)
  await attempt('P3 GM', async () => {
    const gm = await pwLogin('90229001');
    check('P3 (setup) the GM signs in by password', !!gm.token, short(gm));
    const g = await addPasskey(gm.token, auth, 'GM phone');
    check('P3 the GM adds a passkey', g.status === 201, `${g.status} ${short(g.body)}`);
    const gs = await pkSignIn(auth, g.resp?.id);
    check('P3 a person with one role gets the token directly', gs.status === 200 && gs.body.role === 'GM_CIVIL' && !!gs.body.token && !gs.body.person_token, `${gs.status} ${short(gs.body)}`);
    const gcl = claimsOf(gs.body.token);
    check('P3 and its claims say passkey', gcl?.amr === 'passkey' && !!gcl?.passkey_id, short(gcl));
  });

  /* ================= P4 — inspection stays app-only ================= */
  await attempt('P4', async () => {
    const du = await pwLogin('90222001', 'CIVIL_OVERSEER');
    const d = await addPasskey(du.token, auth, 'Overseer laptop');
    check('P4 (setup) the Overseer adds a passkey', d.status === 201, `${d.status} ${short(d.body)}`);
    let ps = await pkSignIn(auth, d.resp?.id);
    const ovA = (ps.body.assignments || []).find((x) => x.role === 'CIVIL_OVERSEER');
    const ovS = await j(await post(`${I}/auth/select-role`, { person_token: ps.body.person_token, assignment_id: ovA?.id }));
    check('P4 the Overseer\'s passkey session is a passkey session, not a device one',
      claimsOf(ovS.token)?.amr === 'passkey' && claimsOf(ovS.token)?.amr !== 'device', short(claimsOf(ovS.token)));

    const resident = await as('RESIDENT:R. K. Singh');
    const overseer = await as('CIVIL_OVERSEER:A. K. Dubey');
    const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
    const contractor = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
    const cats = await j(await get('/maintenance/v1/masters/categories', resident.token));
    const supv = (await j(await get('/maintenance/v1/devices/assignable', inc.token)))[0];
    const sub = cats.find((c) => c.name_en.startsWith('Leaking tap'));
    const t = await j(await post('/maintenance/v1/tickets', { sub_category_id: sub.id }, resident.token));
    await post(`/maintenance/v1/tickets/${t.id}/verify`, {}, overseer.token);
    let x = await post(`/maintenance/v1/tickets/${t.id}/assign`, { supervisor_id: supv.actor_id }, inc.token);
    if (x.status !== 200) throw new Error(`assign ${x.status}`);
    await post(`/maintenance/v1/tickets/${t.id}/start`, { workmen_assigned: 'Ram Prasad' }, contractor.token);
    await uploadCompletion(BASE, contractor.token, t.id);
    x = await post(`/maintenance/v1/tickets/${t.id}/complete`, {}, contractor.token);
    if (x.status !== 200) throw new Error(`complete ${x.status}`);

    await uploadInspection(BASE, ovS.token, t.id);
    x = await post(`/maintenance/v1/tickets/${t.id}/inspect`, { accepted: true }, ovS.token);
    check('P4 accepting an inspection in a passkey session is refused', x.status === 403 || x.status === 422, `${x.status} ${short(await j(x))}`);
    await uploadInspection(BASE, overseer.token, t.id);
    x = await post(`/maintenance/v1/tickets/${t.id}/inspect`, { accepted: true }, overseer.token);
    check('P4 the same Overseer on his phone still can', x.status === 200, `${x.status} ${short(await j(x))}`);
  });

  /* ================= P5 — at most five live passkeys ================= */
  const names = ['Home laptop', 'Tablet', 'Security key', 'Spare phone'];
  const mine = [{ id: pk1.id, cred: cred1, name: 'Office laptop' }];
  for (const n of names) {
    const x = await addPasskey(mishra.token, auth, n);
    if (x.status === 201) mine.push({ id: x.body.id, cred: x.resp.id, name: n });
    check(`P5 passkey "${n}" is accepted (live: ${mine.length})`, x.status === 201, `${x.status} ${short(x.body)}`);
  }
  r = await regOptions(mishra.token);
  check('P5 options for a sixth live passkey are refused with 409', r.status === 409, `${r.status} ${short(await j(r))}`);

  /* ================= P6 — own list and removal ================= */
  r = await get(`${I}/passkeys`, mishra.token);
  let list = await j(r);
  // five live, plus the throw-away removed in P2: removed passkeys stay listed
  check('P6 the own list has five live entries (and the removed one) with the documented fields',
    r.status === 200 && Array.isArray(list) && list.filter((x) => !x.removed_at).length === 5 && list.length === 6
    && ['id', 'name', 'created_at', 'last_used_at', 'transports', 'removed_at', 'removal_reason'].every((k) => k in list[0]), `${r.status} ${short(list)}`);
  const times = list.map((x) => Date.parse(x.created_at));
  check('P6 newest first', times.every((t, i) => i === 0 || times[i - 1] >= t), times.join(','));
  check('P6 a used passkey shows when it was last used', !!list.find((x) => x.id === pk1.id)?.last_used_at);

  const victim = mine[4];   // "Spare phone"
  const vs = await pkSignIn(auth, victim.cred, {}, { role: 'MAINTENANCE_INCHARGE' });
  check('P6 (setup) a session by the passkey to be removed', vs.status === 200 && !!vs.body.refresh_token, `${vs.status} ${short(vs.body)}`);
  const rf = await post(`${I}/auth/refresh`, { refresh_token: vs.body.refresh_token });
  check('P6 its refresh token works while the passkey is live', rf.status === 200, `${rf.status} ${short(await j(rf))}`);

  r = await post(`${I}/passkeys/${victim.id}/revoke`, {}, mishra.token);
  check('P6 removing without a reason is refused with 422', r.status === 422, `${r.status}`);
  r = await post(`${I}/passkeys/${victim.id}/revoke`, { reason: 'Phone lost' }, mishra.token);
  let rb = await j(r);
  check('P6 removing with a reason: 200 with removed_at', r.status === 200 && !!rb.removed_at, `${r.status} ${short(rb)}`);
  r = await post(`${I}/passkeys/${victim.id}/revoke`, { reason: 'Again' }, mishra.token);
  check('P6 removing again is refused with 409', r.status === 409, `${r.status}`);

  list = await j(await get(`${I}/passkeys`, mishra.token));
  const gone = list.find((x) => x.id === victim.id);
  check('P6 a removed passkey stays listed, with its reason', list.filter((x) => !x.removed_at).length === 4 && !!gone?.removed_at && gone?.removal_reason === 'Phone lost', short(gone));

  s = await pkSignIn(auth, victim.cred);
  check('P6 a removed passkey cannot sign in (401)', s.status === 401 && !!s.body.error, `${s.status} ${short(s.body)}`);
  const rf2 = await post(`${I}/auth/refresh`, { refresh_token: vs.body.refresh_token });
  check('P6 the refresh token of its session is refused once it is removed', rf2.status === 401 || rf2.status === 403, `${rf2.status}`);

  const removedAudit = (await sys(identityPool, `SELECT * FROM identity.audit_log WHERE event_type='PASSKEY_REMOVED'`)).rows;
  check('P6 removal is in the audit log with the reason',
    removedAudit.some((x) => JSON.stringify(x).includes('Phone lost')), `${removedAudit.length} rows`);

  // a slot is free again
  const again = await addPasskey(mishra.token, auth, 'Replacement phone');
  check('P6 once one is removed a new one can be added', again.status === 201, `${again.status} ${short(again.body)}`);
  if (again.status === 201) mine.push({ id: again.body.id, cred: again.resp.id, name: 'Replacement phone' });

  /* ================= P7 — administrators and everyone else ================= */
  const kumar = await as('AREA_HR_ADMIN:R. Kumar');
  r = await get(`${I}/persons/${mishraPerson}/passkeys`, kumar.token);
  list = await j(r);
  check('P7 the Area HR administrator lists a Jayant person\'s passkeys', r.status === 200 && Array.isArray(list) && list.length >= 5, `${r.status} ${short(list)}`);
  const target = mine[3];
  r = await post(`${I}/passkeys/${target.id}/revoke`, {}, kumar.token);
  check('P7 the administrator needs a reason too (422)', r.status === 422, `${r.status}`);
  r = await post(`${I}/passkeys/${target.id}/revoke`, { reason: 'Handset stolen, reported to HR' }, kumar.token);
  check('P7 the administrator removes a passkey of a person in the Area', r.status === 200 && !!(await j(r)).removed_at, `${r.status}`);
  s = await pkSignIn(auth, target.cred);
  check('P7 and that passkey no longer signs in', s.status === 401, `${s.status}`);

  const nig = await as('CIVIL_OVERSEER:Nigahi Overseer');
  const gmS = await as('GM_CIVIL:GM (Civil)');
  const incS = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
  for (const [who, tok] of [['the Nigahi Overseer', nig.token], ['the GM', gmS.token], ['the Incharge', incS.token]]) {
    r = await get(`${I}/persons/${mishraPerson}/passkeys`, tok);
    check(`P7 ${who} cannot list another person's passkeys (403)`, r.status === 403, `${r.status}`);
  }
  r = await post(`${I}/passkeys/${mine[2].id}/revoke`, { reason: 'Not mine to remove' }, nig.token);
  check('P7 a non-administrator removing someone else\'s passkey gets 404', r.status === 404, `${r.status}`);
  r = await post(`${I}/passkeys/${mine[2].id}/revoke`, { reason: 'Not mine to remove' }, gmS.token);
  check('P7 so does the GM', r.status === 404, `${r.status}`);
  s = await pkSignIn(auth, mine[2].cred);
  check('P7 and that passkey is untouched (still signs in)', s.status === 200, `${s.status} ${short(s.body)}`);
  // An administrator for someone outside their Area: the seed has no second
  // Area's administrator, and the HQ administrator spans every Area, so that
  // 404 cannot be driven through the API here (skipped).

  /* ================= P8 — people who cannot hold a passkey ================= */
  const mrs = await as('RESIDENT:Mrs S. Singh');
  r = await regOptions(mrs.token);
  check('P8 a Non-NCL / no-Employee-ID resident gets 403', r.status === 403, `${r.status}`);
  r = await regOptions(sup.token);
  check('P8 contractor staff get 403', r.status === 403, `${r.status}`);
  r = await get(`${I}/passkeys`, mrs.token);
  const mrsList = await j(r);
  check('P8 such a person has an empty own list', r.status === 200 && Array.isArray(mrsList) && mrsList.length === 0, `${r.status} ${short(mrsList)}`);

  for (const [s2, n, d] of out) console.log(`  ${s2}  ${n}${d ? `\n        ${d}` : ''}`);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await identityPool.end(); await maintPool.end();
  process.exit(fail ? 1 : 0);
}

// a crash part-way must still show what was checked before it
run().catch((e) => {
  for (const [s2, n, d] of out) console.log(`  ${s2}  ${n}${d ? `
        ${d}` : ''}`);
  console.log(`
  ${pass} passed, ${fail} failed, then crashed:`);
  console.error(e); process.exit(1);
});
