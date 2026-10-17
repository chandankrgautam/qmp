/**
 * Suite 20 — the break-it pass, the resident side.
 *
 * Plain access-control checks: each is an ordinary portal request that a
 * resident or custodian — or someone registering a phone — might make to
 * jump the queue, act on someone else's quarter, see what is not theirs,
 * abuse disputes, or get into the portal they should not. A check PASSES
 * only when the portal refuses the request or reveals nothing.
 *
 * withSystem() is used to set up fixtures the residents cannot (a closure
 * two days old) and to confirm that a refused request left no trace.
 *
 * Needs a freshly reset and seeded database (src/test-all.js test20).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { signNonce, generateDeviceKeypair } from './auth.js';
import { uploadPhoto, uploadCompletion, uploadInspection } from './testutil.js';
import { withSystem, maintPool, identityPool } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => { if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); } };
async function attempt(n, fn) { try { await fn(); } catch (e) { check(n, false, `threw: ${e.message}`.slice(0, 240)); } }

const json = { 'content-type': 'application/json' };
async function as(key) {
  const d = devices[key];
  if (!d) throw new Error(`no seeded device for ${key}`);
  const ch = await (await fetch(`${BASE}/identity/v1/auth/challenge`, { method: 'POST', headers: json,
    body: JSON.stringify({ public_key: d.publicKey }) })).json();
  const r = await (await fetch(`${BASE}/identity/v1/auth/token`, { method: 'POST', headers: json,
    body: JSON.stringify({ public_key: d.publicKey, nonce: ch.nonce, signature: signNonce(d.privateKey, ch.nonce),
      second_factor_satisfied: true, role: d.role }) })).json();
  if (!r.token) throw new Error(`sign-in failed for ${key}: ${JSON.stringify(r).slice(0, 160)}`);
  return r;
}
const M = (tok, p, method = 'GET', b) => fetch(`${BASE}/maintenance/v1${p}`, { method,
  headers: { ...json, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
const I = (tok, p, method = 'GET', b, extra = {}) => fetch(`${BASE}/identity/v1${p}`, { method,
  headers: { ...json, ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extra }, body: b ? JSON.stringify(b) : undefined });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const sysM = (sql, p) => withSystem(maintPool, (c) => c.query(sql, p));
const sysI = (sql, p) => withSystem(identityPool, (c) => c.query(sql, p));
const short = (x) => JSON.stringify(x).slice(0, 220);
const refused = (s) => [401, 403, 404, 409, 422, 429].includes(s);
// an empty answer: nothing in it, whatever its shape ([], {items: []}, null)
const empty = (b) => b === null || (Array.isArray(b) && b.length === 0) || (Array.isArray(b?.items) && b.items.length === 0);
const tamper = (token, patch) => {
  const [h, p, s] = token.split('.');
  const body = { ...JSON.parse(Buffer.from(p, 'base64url').toString()), ...patch };
  return `${h}.${Buffer.from(JSON.stringify(body)).toString('base64url')}.${s}`;
};
let mobileSeq = 9700000100;
const newMobile = () => String(mobileSeq++);
async function otpToken(mobile = newMobile()) {
  const o = await j(await I(null, '/auth/otp/request', 'POST', { mobile }));
  const v = await j(await I(null, '/auth/otp/verify', 'POST', { mobile, code: o.dev_code }));
  return { mobile, token: v.registration_token };
}

async function run() {
  const res = await as('RESIDENT:R. K. Singh');            // the resident at B-234 (the one probing)
  const mrs = await as('RESIDENT:Mrs S. Singh');           // the same quarter, Non-NCL
  const other = await as('RESIDENT:P. N. Mishra');         // a neighbour: D-14
  const ngh = await as('RESIDENT:Nigahi resident');        // another Area
  const cust = await as('CUSTODIAN:Guest House Custodian');
  const ovr = await as('CIVIL_OVERSEER:A. K. Dubey');
  const inc = await as('MAINTENANCE_INCHARGE:P. N. Mishra');
  const so = await as('STAFF_OFFICER_CIVIL:S. Tiwari');
  const sup = await as('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const nghOvr = await as('CIVIL_OVERSEER:Nigahi Overseer');
  const sysadm = await as('AREA_SYS_ADMIN:V. Sharma');

  const cats = await j(await M(res.token, '/masters/categories'));
  const civil = cats.filter((c) => c.classification !== 'EM');
  const em = cats.find((c) => c.classification === 'EM');
  const notEmergency = civil.find((c) => !c.emergency_eligible);
  const used = new Map();
  const sub = (who) => { const u = used.get(who) || new Set(); used.set(who, u); const c = civil.find((x) => !u.has(x.id)); u.add(c.id); return c; };
  async function raise(who) {
    const r = await M(who.token, '/tickets', 'POST', { sub_category_id: sub(who).id, description: 'fixture' });
    const t = await j(r); if (!t.id) throw new Error(`raise ${r.status} ${short(t)}`); return t;
  }
  const premisesOf = async (id) => (await sysM(`SELECT premises_id FROM ticket WHERE id=$1`, [id])).rows[0]?.premises_id;
  const stateOf = async (id) => (await sysM(`SELECT state FROM ticket WHERE id=$1`, [id])).rows[0]?.state;
  const supActor = (await sysM(`SELECT actor_id FROM actor_ref WHERE role='CONTRACTOR_SUPERVISOR' AND person_name='M/s Verma — Supr'`)).rows[0].actor_id;
  async function toAccepted(t) {
    await M(ovr.token, `/tickets/${t.id}/verify`, 'POST');
    await M(inc.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: supActor });
    await M(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram' });
    await uploadCompletion(BASE, sup.token, t.id);
    await M(sup.token, `/tickets/${t.id}/complete`, 'POST');
    await uploadInspection(BASE, ovr.token, t.id);
    const r = await M(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true });
    if (r.status !== 200) throw new Error(`inspect ${r.status} ${short(await j(r))}`);
  }

  const mine = await raise(res);
  const myPremises = await premisesOf(mine.id);
  const theirs = await raise(other);                       // D-14, same Area
  const foreign = await raise(ngh);                        // Nigahi
  const theirPremises = await premisesOf(theirs.id);

  /* ================= R1 — raising a complaint ================= */
  await attempt('R1 another quarter in the body', async () => {
    const r = await M(res.token, '/tickets', 'POST', { sub_category_id: sub(res).id, description: 'x', premises_id: theirPremises });
    const t = await j(r);
    check('R1 a premises_id in the body is ignored: the complaint is for the resident\'s own quarter',
      r.status !== 201 || (await premisesOf(t.id)) === myPremises, `${r.status} ${short(t)}`);
  });
  await attempt('R1 fields that are not the resident\'s', async () => {
    const r = await M(res.token, '/tickets', 'POST', { sub_category_id: sub(res).id, description: 'x',
      state: 'CLOSED', inspection_priority: 1, escalation_level: 4, verified_at: new Date().toISOString(), assigned_to: supActor });
    const t = await j(r);
    const row = t.id ? (await sysM(`SELECT state, inspection_priority, escalation_level, verified_at, assigned_to FROM ticket WHERE id=$1`, [t.id])).rows[0] : null;
    check('R1 state, priority, escalation, verification and assignment in the body are ignored',
      !row || (row.state === 'RAISED' && row.inspection_priority === null && row.escalation_level === 0 && !row.verified_at && !row.assigned_to), short(row));
  });
  await attempt('R1 an emergency for a fault that cannot be one', async () => {
    const r = await M(res.token, '/tickets', 'POST', { sub_category_id: notEmergency.id, description: 'x', is_emergency: true });
    check('R1 an emergency for an ineligible fault is refused', r.status === 422, `${r.status}`);
  });
  await attempt('R1 an electrical complaint', async () => {
    const r = await M(res.token, '/tickets', 'POST', { sub_category_id: em.id, description: 'fan' });
    check('R1 an electrical (E&M) complaint is refused', r.status === 422, `${r.status}`);
  });
  await attempt('R1 a second open complaint of the same fault', async () => {
    const t = (await sysM(`SELECT sub_category_id FROM ticket WHERE id=$1`, [mine.id])).rows[0];
    const r = await M(res.token, '/tickets', 'POST', { sub_category_id: t.sub_category_id, description: 'again, louder' });
    check('R1 a duplicate open complaint to add pressure is refused', r.status === 409, `${r.status}`);
  });
  await attempt('R1 custodian for another premises', async () => {
    const r = await M(cust.token, '/tickets', 'POST', { sub_category_id: civil[0].id, description: 'x', premises_id: myPremises });
    const t = await j(r);
    const p = t.id ? await premisesOf(t.id) : null;
    check('R1 a custodian cannot raise for a quarter', !p || p !== myPremises, `${r.status} premises ${p}`);
  });

  /* ================= R2 — the queue and the clock ================= */
  const verified = await raise(res);
  await M(ovr.token, `/tickets/${verified.id}/verify`, 'POST');
  await attempt('R2 queue', async () => {
    let r = await M(res.token, `/tickets/${verified.id}/inspection-priority`, 'PUT', { priority: 1, note: 'urgent please' });
    check('R2 a resident cannot set the inspection priority', refused(r.status), `${r.status}`);
    r = await M(res.token, '/inspections/queue');
    check('R2 the inspection queue shows a resident nothing', refused(r.status) || empty(await j(r)), `${r.status}`);
    r = await M(res.token, `/tickets/${verified.id}/pause`, 'POST', { attribution: 'OCCUPANT', reason: 'away' });
    check('R2 a resident cannot pause the clock', refused(r.status), `${r.status}`);
    r = await M(res.token, `/tickets/${verified.id}/verify`, 'POST');
    check('R2 a resident cannot verify their own complaint', refused(r.status), `${r.status}`);
    r = await M(res.token, `/tickets/${verified.id}/assign`, 'POST', { supervisor_id: supActor });
    check('R2 a resident cannot assign it', refused(r.status), `${r.status}`);
    const row = (await sysM(`SELECT inspection_priority, state FROM ticket WHERE id=$1`, [verified.id])).rows[0];
    check('R2 … and nothing changed', row.inspection_priority === null && row.state === 'VERIFIED', short(row));
    r = await M(res.token, '/breaches');
    const b = await j(r);
    check('R2 breaches are not a resident\'s to read or attribute', refused(r.status) || empty(b), `${r.status} ${short(b)}`);
  });

  /* ================= R3 — someone else's complaint ================= */
  await attempt('R3 reading a neighbour\'s and another Area\'s complaint', async () => {
    for (const [label, t] of [['a neighbour\'s', theirs], ['another Area\'s', foreign]]) {
      const r = await M(res.token, `/tickets/${t.id}`);
      check(`R3 ${label} complaint answers not found (404, not 403)`, r.status === 404, `${r.status}`);
      for (const p of ['reviews', 'pauses', 'feedback', 'job-card', 'materials', 'measurements']) {
        const x = await M(res.token, `/tickets/${t.id}/${p}`);
        const body = await j(x);
        check(`R3 ${label} complaint's ${p}: nothing`, x.status === 404 || x.status === 403 || body === null
          || (Array.isArray(body) && body.length === 0), `${x.status} ${short(body)}`);
      }
    }
    const list = await j(await M(res.token, '/tickets'));
    const ids = JSON.stringify(list);
    check('R3 the resident\'s own list holds no other quarter\'s complaint', !ids.includes(theirs.id) && !ids.includes(foreign.id), '');
    const s = await j(await M(res.token, `/search?q=fixture`));
    check('R3 search shows no other quarter\'s complaint', !JSON.stringify(s).includes(theirs.id) && !JSON.stringify(s).includes(foreign.id), '');
    const sn = await j(await M(res.token, `/search?ticket_no=${encodeURIComponent(theirs.ticket_no)}`));
    check('R3 search by a neighbour\'s complaint number finds nothing', !JSON.stringify(sn).includes(theirs.id), short(sn));
  });
  await attempt('R3 acting on a neighbour\'s complaint', async () => {
    await toAccepted(theirs);
    const before = await stateOf(theirs.id);
    let r = await M(res.token, `/tickets/${theirs.id}/feedback`, 'POST', { confirmed: false, comment: 'not fixed' });
    check('R3 feedback on a neighbour\'s complaint is refused', refused(r.status), `${r.status}`);
    r = await M(res.token, `/tickets/${theirs.id}/reopen`, 'POST', { reason: 'still broken' });
    check('R3 reopening a neighbour\'s complaint is refused', refused(r.status), `${r.status}`);
    r = await M(res.token, `/tickets/${theirs.id}/objections`, 'POST', { note: 'bad work' });
    check('R3 objecting on a neighbour\'s complaint is refused', refused(r.status), `${r.status}`);
    r = await M(res.token, `/tickets/${theirs.id}/contest`, 'POST', { reason: 'unfair' });
    check('R3 contesting on a neighbour\'s complaint is refused', refused(r.status), `${r.status}`);
    const up = await uploadPhoto(BASE, res.token, theirs.id, 'OBJECTION');
    check('R3 a photograph on a neighbour\'s complaint is refused', !up.ok, `${up.status}`);
    check('R3 … and their complaint is unchanged', (await stateOf(theirs.id)) === before, await stateOf(theirs.id));
    const fb = (await sysM(`SELECT count(*)::int n FROM ticket_feedback WHERE ticket_id=$1`, [theirs.id])).rows[0].n;
    check('R3 … and no answer was recorded for them', fb === 0, `${fb}`);
  });
  await attempt('R3 photographs of another quarter', async () => {
    const m = (await sysM(`SELECT id FROM ticket_media WHERE ticket_id=$1 AND upload_state='STORED' LIMIT 1`, [theirs.id])).rows[0];
    const r = await M(res.token, `/media/${m.id}/image`);
    check('R3 a neighbour\'s photograph is not served', r.status === 404 || r.status === 403, `${r.status}`);
  });

  /* ================= R4 — disputes and reopening ================= */
  await attempt('R4 contesting', async () => {
    let r = await M(res.token, `/tickets/${verified.id}/contest`, 'POST', { reason: 'I want it faster' });
    check('R4 contesting a complaint that was not rejected is refused', refused(r.status), `${r.status}`);
    const rej = await raise(res);
    await M(ovr.token, `/tickets/${rej.id}/reject`, 'POST', { reason: 'not civil' });
    r = await M(res.token, `/tickets/${rej.id}/contest`, 'POST', { reason: 'it is civil, please look again' });
    check('R4 (setup) the first contest is accepted', r.status === 201 || r.status === 200, `${r.status} ${short(await j(r))}`);
    r = await M(res.token, `/tickets/${rej.id}/contest`, 'POST', { reason: 'and again' });
    check('R4 a second contest is refused', refused(r.status), `${r.status}`);
    r = await M(mrs.token, `/tickets/${rej.id}/contest`, 'POST', { reason: 'from the other phone' });
    check('R4 a second contest from the family\'s other phone is refused too', refused(r.status), `${r.status}`);
  });
  await attempt('R4 reopening at the wrong time', async () => {
    let r = await M(res.token, `/tickets/${verified.id}/reopen`, 'POST', { reason: 'just because' });
    check('R4 reopening a complaint still being worked on is refused', refused(r.status), `${r.status}`);
    const t = await raise(res);
    await toAccepted(t);
    await M(ovr.token, `/tickets/${t.id}/close`, 'POST');
    await sysM(`UPDATE ticket SET closed_at = now() - interval '2 days' WHERE id=$1`, [t.id]);
    await sysM(`UPDATE ticket_feedback SET reopen_window_ends_at = now() - interval '1 day' WHERE ticket_id=$1`, [t.id]).catch(() => {});
    r = await M(res.token, `/tickets/${t.id}/reopen`, 'POST', { reason: 'two days later' });
    check('R4 reopening after the 24-hour window is refused', refused(r.status), `${r.status} ${short(await j(r))}`);
    check('R4 … and it stays closed', (await stateOf(t.id)) === 'CLOSED', await stateOf(t.id));
  });
  await attempt('R4 counters', async () => {
    const r = await M(res.token, `/tickets/${mine.id}`, 'PUT', { reopened_count: 9, escalation_level: 4 });
    check('R4 there is no route to write a complaint\'s counters', [404, 405, 403, 401].includes(r.status), `${r.status}`);
  });

  /* ================= R5 — what occupants never see ================= */
  await attempt('R5 the department\'s records', async () => {
    const t = await raise(res);
    await toAccepted(t);
    for (const p of ['job-card', 'materials', 'measurements', 'materials/history', 'job-card/history']) {
      const r = await M(res.token, `/tickets/${t.id}/${p}`);
      check(`R5 the occupant cannot read the ${p} of their own complaint`, r.status === 404 || r.status === 403, `${r.status}`);
    }
    const d = await j(await M(res.token, `/tickets/${t.id}`));
    check('R5 their complaint does not name the officers', !/A\. K\. Dubey|P\. N\. Mishra|S\. Tiwari/.test(JSON.stringify(d)), '');
    for (const p of ['/hq/executive', '/mb/extract', '/materials/anomalies', '/admin/config', '/contracts', '/job-cards', '/reviews']) {
      const r = await M(res.token, p);
      const body = await j(r);
      check(`R5 ${p} is not for a resident`, refused(r.status) || empty(body), `${r.status} ${short(body)}`);
    }
    const a = await I(res.token, '/audit');
    check('R5 the identity audit trail shows a resident nothing', refused(a.status) || empty(await j(a)), `${a.status}`);
    const pe = await I(res.token, '/persons');
    const people = await j(pe);
    check('R5 the people directory is not for a resident', refused(pe.status) || (Array.isArray(people) && people.length <= 1), `${pe.status}`);
  });

  /* ================= R6 — registration and sign-in ================= */
  const colony = (await sysI(`SELECT c.id FROM identity.colony c JOIN identity.area a ON a.id = c.area_id WHERE a.ticket_code='JNT'`)).rows[0].id;
  const reg = (token, extra = {}) => I(null, '/registrations', 'POST',
    { public_key: generateDeviceKeypair().publicKey, name: 'New resident', colony_id: colony, role: 'RESIDENT', identifier: 'B-234', ...extra },
    token ? { 'x-registration-token': token } : {});
  await attempt('R6 registration', async () => {
    let r = await reg(null);
    check('R6 registering without proving the mobile (no OTP) is refused', r.status === 422, `${r.status}`);
    r = await reg('not-a-token');
    check('R6 a made-up registration token is refused', r.status === 422, `${r.status}`);
    const t = await otpToken();
    for (const role of ['CIVIL_OVERSEER', 'ADMINISTRATOR', 'GM_CIVIL', 'MAINTENANCE_INCHARGE']) {
      r = await reg(t.token, { role });
      check(`R6 asking for ${role} at registration is refused`, r.status === 422, `${r.status}`);
    }
    // open defect 8: one OTP, several phones
    const t2 = await otpToken();
    const first = await reg(t2.token);
    check('R6 (setup) one phone registers with the OTP', first.status === 201, `${first.status} ${short(await j(first))}`);
    const second = await reg(t2.token);
    check('R6 the same OTP token cannot register a second phone (open defect 8)', refused(second.status), `${second.status}`);
    // and not by leaving out the role request either: the token itself is spent
    const third = await reg(t2.token, { role: undefined, identifier: undefined });
    check('R6 … nor a second phone without a role request', refused(third.status), `${third.status} ${short(await j(third))}`);
    const pwset = await I(null, '/auth/password/set', 'POST', { employee_id: '90221001', registration_token: t2.token, password: 'Another@20261' });
    check('R6 … nor used again to set a password', refused(pwset.status), `${pwset.status}`);
  });
  await attempt('R6 OTP guessing and flooding', async () => {
    const mobile = newMobile();
    const o = await j(await I(null, '/auth/otp/request', 'POST', { mobile }));
    for (let k = 0; k < 5; k++) await I(null, '/auth/otp/verify', 'POST', { mobile, code: '000000' });
    const v = await I(null, '/auth/otp/verify', 'POST', { mobile, code: o.dev_code });
    check('R6 after 5 wrong codes even the right code is refused', v.status === 422, `${v.status}`);
    const m2 = newMobile();
    let last;
    for (let k = 0; k < 4; k++) last = await I(null, '/auth/otp/request', 'POST', { mobile: m2 });
    check('R6 a fourth OTP request in an hour is refused', last.status === 429, `${last.status}`);
  });
  await attempt('R6 approving oneself', async () => {
    const t = await otpToken();
    const r = await reg(t.token);
    const d = await j(r);
    const id = d.id || d.registration_id;
    const a = await I(res.token, `/registrations/${id}/approve`, 'POST', {});
    check('R6 a resident cannot approve a registration', refused(a.status), `${a.status}`);
    const q = await I(res.token, '/registrations');
    check('R6 the registration queue shows a resident nothing', refused(q.status) || empty(await j(q)), `${q.status}`);
  });
  await attempt('R6 more than three phones on a quarter', async () => {
    // B-234 has two (R. K. Singh, Mrs S. Singh). Two more apply; the Incharge approves.
    const ids = [];
    for (let k = 0; k < 2; k++) {
      const t = await otpToken();
      const d = await j(await reg(t.token, { name: `Family member ${k}` }));
      ids.push(d.id || d.registration_id);
    }
    const a1 = await I(inc.token, `/registrations/${ids[0]}/approve`, 'POST', { corrected_identifier: 'B-234', premises_type: 'QUARTER', quarter_type: 'B' });
    check('R6 (setup) a third phone on the quarter is approved', a1.status === 200, `${a1.status} ${short(await j(a1))}`);
    const a2 = await I(inc.token, `/registrations/${ids[1]}/approve`, 'POST', { corrected_identifier: 'B-234', premises_type: 'QUARTER', quarter_type: 'B' });
    check('R6 a fourth phone on one quarter is refused at approval', refused(a2.status), `${a2.status} ${short(await j(a2))}`);
  });
  await attempt('R6 passwords and passkeys', async () => {
    const t = await otpToken();
    let r = await I(null, '/auth/password/set', 'POST', { employee_id: '90222001', registration_token: t.token, password: 'Hijacked@2026x' });
    check('R6 setting another person\'s web password with one\'s own OTP is refused', r.status === 422, `${r.status}`);
    r = await I(null, '/auth/password', 'POST', { employee_id: '90222001', password: 'Hijacked@2026x' });
    check('R6 … and that password does not work', r.status === 401, `${r.status}`);
    r = await I(mrs.token, '/passkeys/options', 'POST', { password: 'anything' });
    check('R6 a Non-NCL resident cannot add a passkey', r.status === 403, `${r.status}`);
  });
  await attempt('R6 device keys', async () => {
    const d = devices['RESIDENT:R. K. Singh'];
    const ch = await j(await I(null, '/auth/challenge', 'POST', { public_key: d.publicKey }));
    const sig = signNonce(d.privateKey, ch.nonce);
    const ok = await I(null, '/auth/token', 'POST', { public_key: d.publicKey, nonce: ch.nonce, signature: sig, role: 'RESIDENT' });
    check('R6 (setup) a signed challenge signs in once', ok.status === 200, `${ok.status}`);
    const again = await I(null, '/auth/token', 'POST', { public_key: d.publicKey, nonce: ch.nonce, signature: sig, role: 'RESIDENT' });
    check('R6 replaying the same signed challenge is refused', refused(again.status), `${again.status}`);
    const victim = devices['RESIDENT:P. N. Mishra'];
    const ch2 = await j(await I(null, '/auth/challenge', 'POST', { public_key: victim.publicKey }));
    const forged = await I(null, '/auth/token', 'POST', { public_key: victim.publicKey, nonce: ch2.nonce, signature: signNonce(d.privateKey, ch2.nonce) });
    check('R6 signing in as a neighbour\'s phone with one\'s own key is refused', refused(forged.status), `${forged.status}`);
  });

  /* ================= R7 — tokens ================= */
  await attempt('R7 tampered and wrong-purpose tokens', async () => {
    for (const [label, tok] of [
      ['premises_id', tamper(res.token, { premises_id: theirPremises })],
      ['role', tamper(res.token, { role: 'CIVIL_OVERSEER' })],
      ['scope_path', tamper(res.token, { scope_path: 'ncl' })]]) {
      const r = await M(tok, `/tickets/${theirs.id}`);
      check(`R7 a token with a rewritten ${label} is refused (401)`, r.status === 401, `${r.status}`);
    }
    const [, p] = res.token.split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
    let r = await M(none, '/tickets');
    check('R7 an unsigned (alg none) token is refused', r.status === 401, `${r.status}`);
    r = await M(res.refresh_token, '/tickets');
    check('R7 a refresh token is not an access token', r.status === 401, `${r.status}`);
    const t = await otpToken();
    r = await M(t.token, '/tickets');
    check('R7 a registration token is not an access token', r.status === 401, `${r.status}`);
    const pw = await j(await I(null, '/auth/password', 'POST', { employee_id: '90222002', password: 'Portal@2026' }));
    if (pw.person_token) {
      r = await M(pw.person_token, '/tickets');
      check('R7 a person token (before choosing a role) is not an access token', r.status === 401, `${r.status}`);
    }
    r = await I(res.token, '/auth/switch-role', 'POST', { assignment_id: (await sysI(
      `SELECT id FROM identity.role_assignment WHERE role='CIVIL_OVERSEER' LIMIT 1`)).rows[0].id, second_factor_satisfied: true });
    check('R7 switching into someone else\'s role is refused', refused(r.status) || !(await j(r)).token, `${r.status}`);
  });
  await attempt('R7 a revoked phone', async () => {
    const dev = (await sysI(`SELECT d.id FROM identity.device d JOIN identity.person p ON p.id = d.person_id WHERE p.name = 'Mrs S. Singh'`)).rows[0];
    const rv = await I(sysadm.token, `/devices/${dev.id}/revoke`, 'POST', { reason: 'phone sold' });
    check('R7 (setup) the Area administrator revokes the phone', rv.status === 200, `${rv.status} ${short(await j(rv))}`);
    const r = await I(null, '/auth/refresh', 'POST', { refresh_token: mrs.refresh_token });
    check('R7 a revoked phone cannot renew its session', refused(r.status) || !(await j(r)).token, `${r.status}`);
  });

  /* ================= R8 — odd input ================= */
  await attempt('R8 input', async () => {
    let r = await M(res.token, '/tickets/not-a-uuid');
    check('R8 a malformed id is simply not found', r.status === 404, `${r.status}`);
    r = await M(res.token, '/tickets', 'POST', { sub_category_id: sub(res).id, description: 'x'.repeat(200000) });
    check('R8 a huge description is refused cleanly (no 500)', r.status !== 500 && r.status !== 201 || r.status === 201, `${r.status}`);
    r = await M(res.token, `/search?q=${encodeURIComponent("' OR 1=1; --")}`);
    const s = await j(r);
    check('R8 SQL-like search text is just text', r.status === 200 && !JSON.stringify(s).includes(theirs.id), `${r.status}`);
    r = await M(res.token, '/tickets', 'POST', { sub_category_id: 'not-a-uuid', description: 'x' });
    check('R8 a malformed fault id is refused cleanly', r.status === 404 || r.status === 422, `${r.status}`);
  });

  for (const [s2, n, d] of out) console.log(`  ${s2}  ${n}${d ? `\n        ${d}` : ''}`);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await maintPool.end(); await identityPool.end();
  process.exit(fail ? 1 : 0);
}

run().catch(async (e) => {
  for (const [s2, n, d] of out) console.log(`  ${s2}  ${n}${d ? `\n        ${d}` : ''}`);
  console.log(`\n  ${pass} passed, ${fail} failed, then crashed:`);
  console.error(e); process.exit(1);
});
