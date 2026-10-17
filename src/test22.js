/**
 * Suite 22 — response conformance.
 *
 * The Android client is generated from spec/*.yaml with kotlinx.serialization
 * (ignoreUnknownKeys): a field the server sends but the specification does
 * not declare is silently lost on the phone, and a wrong type crashes the
 * decoding. This suite drives the resident's journey against the real
 * server and checks every response body against the schema the
 * specification gives for that path, method and status.
 *
 * A problem is: a field sent but not declared, a required field missing,
 * a wrong type or format, a value outside an enum, a status the spec does
 * not document. One check per endpoint and status; the full list of
 * mismatches is printed again, grouped, at the end.
 *
 * Needs a freshly reset and seeded database (src/test-all.js does this).
 */
import fs from 'node:fs';
import YAML from 'yaml';
import crypto from 'node:crypto';
import { signNonce, generateDeviceKeypair } from './auth.js';
import { uploadCompletion, uploadInspection, makeJpeg, sha256 } from './testutil.js';
import { withSystem, maintPool, identityPool } from './db.js';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url)));
const SPEC = {
  identity: YAML.parse(fs.readFileSync(new URL('../spec/identity-api.yaml', import.meta.url), 'utf8')),
  maintenance: YAML.parse(fs.readFileSync(new URL('../spec/maintenance-api.yaml', import.meta.url), 'utf8'))
};

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = '') => { if (ok) { pass++; out.push([' ok ', n, '']); } else { fail++; out.push(['FAIL', n, d]); } };
async function attempt(n, fn) { try { await fn(); } catch (e) { check(n, false, `threw: ${e.message}`.slice(0, 300)); } }
const short = (x, n = 40) => { const s = typeof x === 'string' ? JSON.stringify(x) : JSON.stringify(x); return (s ?? 'undefined').slice(0, n); };

/* ---------------- the schema checker ---------------- */

function deref(svc, node) {
  let n = node, guard = 0;
  while (n && n.$ref && guard++ < 20) {
    n = n.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], SPEC[svc]);
  }
  return n;
}

/* Resolve $ref and merge allOf into one flat description. */
function flat(svc, schema) {
  const s = deref(svc, schema) || {};
  const m = {
    types: s.type === undefined ? [] : [].concat(s.type),
    nullable: !!s.nullable, enum: s.enum, format: s.format, items: s.items,
    properties: { ...(s.properties || {}) }, required: [...(s.required || [])],
    addl: s.additionalProperties, alts: [...(s.oneOf || []), ...(s.anyOf || [])]
  };
  for (const sub of s.allOf || []) {
    const f = flat(svc, sub);
    if (!m.types.length) m.types = f.types;
    m.nullable ||= f.nullable; m.enum ||= f.enum; m.format ||= f.format; m.items ||= f.items;
    Object.assign(m.properties, f.properties); m.required.push(...f.required);
    m.addl ??= f.addl; m.alts.push(...f.alts);
  }
  if (m.types.includes('null')) m.nullable = true;
  return m;
}
const isNullable = (svc, schema, d = 0) => {
  const f = flat(svc, schema);
  return f.nullable || (d < 4 && f.alts.some((a) => isNullable(svc, a, d + 1)));
};

const typeOk = (t, v) => ({
  string: typeof v === 'string', boolean: typeof v === 'boolean', number: typeof v === 'number',
  integer: Number.isInteger(v), array: Array.isArray(v),
  object: v !== null && typeof v === 'object' && !Array.isArray(v)
}[t] ?? true);
const jsType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const FORMATS = {
  'date-time': /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
};

function validate(svc, schema, val, path, errs) {
  const s = flat(svc, schema);
  if (val === null) {
    if (!isNullable(svc, schema)) errs.push(`${path}: null, but the spec does not make it nullable`);
    return;
  }
  if (s.alts.length) {
    let best = null;
    for (const alt of s.alts) {
      const e = [];
      validate(svc, alt, val, path, e);
      if (!e.length) { best = null; break; }
      if (!best || e.length < best.length) best = e;
    }
    if (best) errs.push(...best.map((x) => `(no oneOf/anyOf branch fits) ${x}`));
  }
  const hasProps = Object.keys(s.properties).length > 0;
  const types = s.types.filter((t) => t !== 'null');
  const eff = types.length ? types : hasProps ? ['object'] : s.items ? ['array'] : [];
  if (eff.length && !eff.some((t) => typeOk(t, val))) {
    errs.push(`${path}: spec says ${eff.join('|')}, server sent ${jsType(val)} ${short(val)}`);
    return;
  }
  if (s.enum && !s.enum.includes(val)) errs.push(`${path}: ${short(val)} is not in the spec's enum [${s.enum.join(', ')}]`);
  if (typeof val === 'string' && FORMATS[s.format] && !FORMATS[s.format].test(val)) {
    errs.push(`${path}: ${short(val)} is not a ${s.format}`);
  }
  if (Array.isArray(val)) {
    if (s.items) val.forEach((x) => validate(svc, s.items, x, `${path}[]`, errs));
    return;
  }
  if (val && typeof val === 'object') {
    if (hasProps) {
      for (const k of Object.keys(val)) {
        if (k in s.properties) continue;
        if (s.addl && typeof s.addl === 'object') { validate(svc, s.addl, val[k], `${path}.${k}`, errs); continue; }
        if (s.addl === true) continue;
        errs.push(`${path}.${k}: UNDECLARED, server sent ${jsType(val[k])}`);
      }
      for (const r of new Set(s.required)) if (!(r in val)) errs.push(`${path}.${r}: REQUIRED by the spec, missing from the response`);
      for (const k of Object.keys(s.properties)) if (k in val) validate(svc, s.properties[k], val[k], `${path}.${k}`, errs);
    } else if (s.addl && typeof s.addl === 'object') {
      for (const k of Object.keys(val)) validate(svc, s.addl, val[k], `${path}.${k}`, errs);
    }
  }
}

/* What the spec says the answer looks like. */
function schemaFor(svc, method, tpl, status) {
  const op = SPEC[svc].paths?.[tpl]?.[method.toLowerCase()];
  if (!op) return { err: `the spec has no ${method} ${tpl}` };
  const r0 = op.responses?.[String(status)] ?? op.responses?.default;
  if (!r0) return { err: `status ${status} is not documented (spec documents ${Object.keys(op.responses || {}).join(', ') || 'nothing'})` };
  const r = deref(svc, r0);
  if (!r?.content) return { none: true };
  const mt = r.content['application/json'] || r.content['application/problem+json'] || Object.values(r.content)[0];
  return mt?.schema ? { schema: mt.schema } : { none: true };
}

const fmt = (p, e) => `${p}${e.n > 1 ? `  (x${e.n})` : ''}${e.labels.size ? `  [${[...e.labels].slice(0, 3).join('; ')}]` : ''}`;
const problems = new Map();   // "svc METHOD tpl status" -> Map(problem -> times)
const notes = new Set();
const calls = new Map();
function conform(svc, method, tpl, status, data, label) {
  const key = `${svc} ${method} ${tpl} ${status}`;
  calls.set(key, (calls.get(key) || 0) + 1);
  if (!problems.has(key)) problems.set(key, new Map());
  const bag = problems.get(key);
  const add = (p) => {
    const e = bag.get(p) || { n: 0, labels: new Set() };
    e.n++; if (label) e.labels.add(label);
    bag.set(p, e);
  };
  const sch = schemaFor(svc, method, tpl, status);
  if (sch.err) { add(sch.err); return; }
  if (sch.none) {
    if (data !== undefined && status !== 204) notes.add(`${key}: spec declares no body; server sends ${short(data, 80)}`);
    return;
  }
  if (data === undefined) { add('empty body, but the spec declares a schema'); return; }
  if (data && data.__nonjson !== undefined) { add(`body is not JSON: ${data.__nonjson}`); return; }
  const errs = [];
  validate(svc, sch.schema, data, '$', errs);
  for (const e of errs) add(e);
}

const json = { 'content-type': 'application/json' };
async function hit(svc, tok, method, tpl, o = {}) {
  const path = tpl.replace('{line}', o.line ?? '').replace('{kind}', o.kind ?? '').replace('{action}', o.action ?? '').replace(/\{\w+\}/g, o.id ?? '');
  const res = await fetch(`${BASE}/${svc}/v1${path}${o.query || ''}`, {
    method, headers: { ...json, ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(o.headers || {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body)
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = { __nonjson: text.slice(0, 60) }; }
  conform(svc, method, tpl, res.status, data, o.label);
  return { status: res.status, body: data, ok: res.ok };
}
const I = (tok, method, tpl, o) => hit('identity', tok, method, tpl, o);
const M = (tok, method, tpl, o) => hit('maintenance', tok, method, tpl, o);
/* Plain calls (officer and contractor steps) are not validated. */
const call = (tok, p, method = 'GET', b) => fetch(`${BASE}/maintenance/v1${p}`, { method,
  headers: { ...json, authorization: `Bearer ${tok}` }, body: b ? JSON.stringify(b) : undefined });
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const sys = (sql, params) => withSystem(maintPool, (c) => c.query(sql, params));
const sysI = (sql, params) => withSystem(identityPool, (c) => c.query(sql, params));

/* Device sign-in through the validated endpoints. */
async function signIn(key, pick) {
  const d = devices[key];
  if (!d) throw new Error(`no seeded device for ${key}`);
  const ch = await I(null, 'POST', '/auth/challenge', { body: { public_key: d.publicKey } });
  return I(null, 'POST', '/auth/token', { body: { public_key: d.publicKey, nonce: ch.body.nonce,
    signature: signNonce(d.privateKey, ch.body.nonce), second_factor_satisfied: true, ...pick } });
}
async function plain(key) {
  const d = devices[key];
  const ch = await (await fetch(`${BASE}/identity/v1/auth/challenge`, { method: 'POST', headers: json,
    body: JSON.stringify({ public_key: d.publicKey }) })).json();
  const r = await (await fetch(`${BASE}/identity/v1/auth/token`, { method: 'POST', headers: json,
    body: JSON.stringify({ public_key: d.publicKey, nonce: ch.nonce, signature: signNonce(d.privateKey, ch.nonce),
      second_factor_satisfied: true, role: d.role }) })).json();
  if (!r.token) throw new Error(`sign-in failed for ${key}`);
  return r;
}

/* The resident's own photograph upload, step by step, each step checked. */
async function photo(tok, ticketId, purpose, label) {
  const buf = makeJpeg();
  const ask = await M(tok, 'POST', '/media/upload-url', { label,
    body: { ticket_id: ticketId, purpose, content_type: 'image/jpeg' } });
  if (!ask.body?.media_id) throw new Error(`upload-url ${ask.status} ${short(ask.body, 160)}`);
  const url = ask.body.upload_url.startsWith('http') ? ask.body.upload_url : BASE + ask.body.upload_url;
  await fetch(url, { method: 'PUT', body: buf, headers: { 'content-type': 'image/jpeg' } });
  const c = await M(tok, 'POST', '/media/{id}/confirm', { id: ask.body.media_id, label,
    // every photograph is located since 2026-10-12, as the app sends it
    body: { captured_at: new Date().toISOString(), content_hash: sha256(buf), capture_verified: true,
      latitude: 24.1102, longitude: 82.6531, gps_accuracy_m: 6 } });
  if (!c.ok) throw new Error(`confirm ${c.status} ${short(c.body, 160)}`);
  return ask.body.media_id;
}

async function run() {
  /* ---------- identity: masters, no sign-in needed ---------- */
  const colonies = (await I(null, 'GET', '/masters/colonies')).body || [];
  await I(null, 'GET', '/masters/areas');
  const jayant = colonies.find((c) => /jayant/i.test(`${c.area} ${c.name}`)) || colonies[0];
  await I(null, 'GET', '/masters/buildings', { query: `?colony_id=${jayant.id}` });
  await I(null, 'GET', '/masters/sectors', { query: `?colony_id=${jayant.id}` });

  /* ---------- identity: registering a new phone ---------- */
  await attempt('registration journey', async () => {
    const mobile = '9710099001';
    const o = await I(null, 'POST', '/auth/otp/request', { body: { mobile } });
    const v = await I(null, 'POST', '/auth/otp/verify', { body: { mobile, code: o.body?.dev_code } });
    const kp = generateDeviceKeypair();
    await I(null, 'POST', '/registrations', { headers: { 'x-registration-token': v.body?.registration_token },
      body: { public_key: kp.publicKey, name: 'Conformance Resident', colony_id: jayant.id, role: 'RESIDENT', identifier: 'B-234' } });
    // refused: no proof of the mobile
    await I(null, 'POST', '/registrations', { body: { public_key: kp.publicKey, name: 'x', colony_id: jayant.id, role: 'RESIDENT', identifier: 'B-234' } });
    // wrong code
    await I(null, 'POST', '/auth/otp/verify', { body: { mobile, code: '000000' } });
  });

  /* ---------- identity: the resident signs in ---------- */
  const R = 'RESIDENT:R. K. Singh';
  const resSign = await signIn(R, { role: devices[R].role });
  const res = resSign.body;
  if (!res?.token) throw new Error(`resident sign-in ${short(resSign.body, 200)}`);
  await I(res.token, 'GET', '/me', { label: 'resident' });
  await attempt('refresh', async () => { await I(null, 'POST', '/auth/refresh', { body: { refresh_token: res.refresh_token } }); });
  await attempt('refresh refused', async () => { await I(null, 'POST', '/auth/refresh', { body: { refresh_token: 'not-a-token' } }); });
  await attempt('sign-in refused', async () => {
    await I(null, 'POST', '/auth/challenge', { body: { public_key: generateDeviceKeypair().publicKey } });
  });

  /* An official who also lives in a quarter: the several-roles path. */
  await attempt('several roles', async () => {
    const D = 'CIVIL_OVERSEER:A. K. Dubey';
    const multi = (await signIn(D, {})).body;
    const resRole = multi.assignments?.find((a) => a.role === 'RESIDENT');
    const sel = (await I(null, 'POST', '/auth/select-role', { body: { person_token: multi.person_token, assignment_id: resRole.id } })).body;
    await I(sel.token, 'GET', '/me', { label: 'official in own resident role' });
    const offRole = multi.assignments.find((a) => a.role === 'CIVIL_OVERSEER');
    await I(sel.token, 'POST', '/auth/switch-role', { body: { assignment_id: offRole.id, second_factor_satisfied: true } });
    await I(sel.token, 'POST', '/auth/switch-role', { body: { assignment_id: devices['MAINTENANCE_INCHARGE:P. N. Mishra'].actor_id, second_factor_satisfied: true } });
  });

  /* ---------- maintenance: the resident ---------- */
  const ovr = await plain('CIVIL_OVERSEER:A. K. Dubey');
  const inc = await plain('MAINTENANCE_INCHARGE:P. N. Mishra');
  const so = await plain('STAFF_OFFICER_CIVIL:S. Tiwari');
  const sup = await plain('CONTRACTOR_SUPERVISOR:M/s Verma — Supr');
  const assignable = await j(await call(inc.token, '/devices/assignable'));
  const verma = assignable.find((a) => a.person_name === 'M/s Verma — Supr');
  const rt = res.token;

  const cats = (await M(rt, 'GET', '/masters/categories')).body;
  await M(rt, 'GET', '/masters/excluded-scope');
  await M(rt, 'GET', '/notifications', { label: 'before anything' });

  const detail = (id, label) => M(rt, 'GET', '/tickets/{id}', { id, label });
  const raise = async (sub, desc) => {
    const r = await M(rt, 'POST', '/tickets', { headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { sub_category_id: sub.id, description: desc } });
    if (!r.body?.id) throw new Error(`raise ${r.status} ${short(r.body, 200)}`);
    return r.body;
  };
  const verify = async (t) => { const r = await call(ovr.token, `/tickets/${t.id}/verify`, 'POST'); if (r.status !== 200) throw new Error(`verify ${r.status}`); };
  const assign = async (t) => {
    const r = await call(inc.token, `/tickets/${t.id}/assign`, 'POST', { supervisor_id: verma.actor_id });
    if (r.status !== 200) throw new Error(`assign ${r.status} ${short(await j(r), 160)}`);
  };
  const start = async (t) => { const r = await call(sup.token, `/tickets/${t.id}/start`, 'POST', { workmen_assigned: 'Ram Prasad' }); if (r.status !== 200) throw new Error(`start ${r.status}`); };
  const claim = async (t) => {
    await uploadCompletion(BASE, sup.token, t.id);
    const r = await call(sup.token, `/tickets/${t.id}/complete`, 'POST'); if (r.status !== 200) throw new Error(`complete ${r.status}`);
  };
  const accept = async (t) => {
    await uploadInspection(BASE, ovr.token, t.id);
    const r = await call(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: true }); if (r.status !== 200) throw new Error(`inspect ${r.status} ${short(await j(r), 160)}`);
  };
  const close = async (t) => { const r = await call(ovr.token, `/tickets/${t.id}/close`, 'POST'); if (r.status !== 200) throw new Error(`close ${r.status}`); };

  /* Ticket A: the whole way through, looked at in every state */
  await attempt('ticket A', async () => {
    const t = await raise(cats[0], 'Conformance A: tap leaking in the kitchen');
    await detail(t.id, 'A RAISED');
    await photo(rt, t.id, 'COMPLAINT', 'A');
    await M(rt, 'GET', '/tickets');
    await M(rt, 'GET', '/tickets', { query: '?state=RAISED&page=1&page_size=10' });
    await M(rt, 'GET', '/tickets/{id}/feedback', { id: t.id, label: 'A before any feedback' });
    // the same complaint again: the open-ticket conflict, which carries the existing one
    await M(rt, 'POST', '/tickets', { headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { sub_category_id: cats[0].id, description: 'Conformance A again' } });
    await verify(t); await detail(t.id, 'A VERIFIED');
    await assign(t); await detail(t.id, 'A ASSIGNED');
    await start(t); await detail(t.id, 'A IN_PROGRESS');
    const mid = await photo(rt, t.id, 'OBJECTION', 'A objection');
    await M(rt, 'POST', '/tickets/{id}/objections', { id: t.id, body: { note: 'The crew has left before finishing', media_ids: [mid] } });
    await detail(t.id, 'A IN_PROGRESS with an objection');
    // not a good moment for a second objection once the work is claimed
    await claim(t); await detail(t.id, 'A WORK_COMPLETED');
    await M(rt, 'POST', '/tickets/{id}/objections', { id: t.id, body: { note: 'Objection after the claim', media_ids: [] } });
    await accept(t); await detail(t.id, 'A INSPECTED_ACCEPTED');
    await close(t); await detail(t.id, 'A CLOSED');
    await M(rt, 'GET', '/tickets/{id}/feedback', { id: t.id, label: 'A closed, no answer yet' });
    await M(rt, 'POST', '/tickets/{id}/feedback', { id: t.id, body: { confirmed: true, rating: 4, comment: 'Done well' } });
    await M(rt, 'GET', '/tickets/{id}/feedback', { id: t.id, label: 'A after confirming' });
    await detail(t.id, 'A CLOSED and confirmed');
    await M(rt, 'GET', '/notifications', { label: 'after the whole job' });
    await M(rt, 'GET', '/notifications', { query: '?unread_only=true', label: 'unread only' });
  });

  /* Ticket C: closed, then reopened */
  await attempt('ticket C reopened', async () => {
    const t = await raise(cats[1], 'Conformance C: switch board loose');
    await verify(t); await assign(t); await start(t); await claim(t); await accept(t); await close(t);
    await detail(t.id, 'C CLOSED');
    await photo(rt, t.id, 'COMPLAINT', 'C reopen');
    await M(rt, 'POST', '/tickets/{id}/reopen', { id: t.id, body: { reason: 'The fault has come back' } });
    await detail(t.id, 'C REOPENED');
    await M(rt, 'GET', '/tickets/{id}/feedback', { id: t.id, label: 'C after reopening' });
  });

  /* Ticket D: a dispute before closure, recorded as "not fixed" */
  await attempt('ticket D dispute', async () => {
    const t = await raise(cats[2], 'Conformance D: window glass cracked');
    await verify(t); await assign(t); await start(t); await claim(t); await accept(t);
    await M(rt, 'POST', '/tickets/{id}/feedback', { id: t.id, body: { confirmed: false, comment: 'Still cracked' } });
    await M(rt, 'GET', '/tickets/{id}/feedback', { id: t.id, label: 'D disputed' });
    await detail(t.id, 'D after a dispute before closure');
  });

  /* Ticket B: rejected, contested, upheld, decided */
  await attempt('ticket B rejection and contest', async () => {
    const t = await raise(cats[3], 'Conformance B: door handle');
    const rj = await call(ovr.token, `/tickets/${t.id}/reject`, 'POST', { reason: 'Not a civil matter, as the form is filled' });
    if (rj.status !== 200) throw new Error(`reject ${rj.status}`);
    await detail(t.id, 'B REJECTED');
    await M(rt, 'POST', '/tickets/{id}/contest', { id: t.id, body: {} });          // 422: no reason
    const c = await M(rt, 'POST', '/tickets/{id}/contest', { id: t.id, body: { reason: 'The handle really is broken' } });
    await detail(t.id, 'B REJECTED, contested');
    await M(rt, 'GET', '/tickets/{id}/reviews', { id: t.id, label: 'B with officers' });
    await M(rt, 'POST', '/tickets/{id}/contest', { id: t.id, body: { reason: 'Again' } });   // 409
    if (c.body?.id) {
      await call(ovr.token, `/reviews/${c.body.id}/officer`, 'POST', { outcome: 'UPHOLD', note: 'Rejection stands' });
      await detail(t.id, 'B with the Staff Officer');
      await call(so.token, `/reviews/${c.body.id}/decide`, 'POST', { outcome: 'UPHOLD', decision: 'Upheld; the fitting is the allottee\'s' });
      await detail(t.id, 'B decided');
      await M(rt, 'GET', '/tickets/{id}/reviews', { id: t.id, label: 'B decided' });
    }
  });

  /* Errors */
  await attempt('errors', async () => {
    await M(rt, 'GET', '/tickets/{id}', { id: crypto.randomUUID(), label: 'unknown id' });
    await M(rt, 'GET', '/tickets/{id}', { id: 'not-a-uuid', label: 'malformed id' });
    await M(rt, 'POST', '/tickets', { headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { description: 'no sub-category' } });
    await M(rt, 'POST', '/media/upload-url', { body: { ticket_id: crypto.randomUUID(), purpose: 'COMPLAINT', content_type: 'image/jpeg' } });
    await M(null, 'GET', '/tickets');
  });

  await attempt('notifications and push token', async () => {
    await M(rt, 'POST', '/notifications/read', { body: { all: true } });
    await M(rt, 'PUT', '/notifications/push-token', { body: { fcm_token: 'conformance-token' } });
  });

  /* ---------- the contractor supervisor (phase A3 of the app) ---------- */
  await attempt('contractor supervisor', async () => {
    const S = 'CONTRACTOR_SUPERVISOR:M/s Verma — Supr';
    const ss = (await signIn(S, { role: devices[S].role })).body;
    if (!ss?.token) throw new Error('supervisor sign-in');
    const st = ss.token;
    await I(st, 'GET', '/me', { label: 'supervisor' });
    const t = await raise(cats[4] || cats[0], 'Conformance E: plaster falling off the wall');
    await verify(t); await assign(t);
    await M(st, 'GET', '/tickets', { label: 'supervisor' });
    await M(st, 'GET', '/tickets/{id}', { id: t.id, label: 'E ASSIGNED (supervisor)' });
    await M(st, 'POST', '/tickets/{id}/start', { id: t.id, body: { workmen_assigned: '' }, label: 'no workmen' });
    await M(st, 'POST', '/tickets/{id}/start', { id: t.id, body: { workmen_assigned: 'Ram Prasad, Sunil Kumar' } });
    await M(st, 'GET', '/tickets/{id}', { id: t.id, label: 'E IN_PROGRESS (supervisor)' });
    const mats = (await M(st, 'GET', '/materials', { label: 'supervisor' })).body || [];
    await M(st, 'GET', '/tickets/{id}/materials', { id: t.id, label: 'E before a claim' });
    const line = (await M(st, 'POST', '/tickets/{id}/materials', { id: t.id, body: { material_id: mats[0]?.id, qty_claimed: 2 } })).body;
    await M(st, 'POST', '/tickets/{id}/materials', { id: t.id, body: { material_id: mats[0]?.id, qty_claimed: 0 }, label: 'zero' });
    if (line?.id) await M(st, 'POST', '/tickets/{id}/materials/{line}/withdraw', { id: t.id, line: line.id, body: { reason: 'Entered twice' } });
    await M(st, 'POST', '/tickets/{id}/materials', { id: t.id, body: { material_id: mats[0]?.id, qty_claimed: 1.5 } });
    await M(st, 'GET', '/tickets/{id}/materials', { id: t.id, label: 'E with lines' });
    await photo(st, t.id, 'BEFORE', 'E before');
    await photo(st, t.id, 'COMPLETION', 'E after');
    await M(st, 'GET', '/tickets/{id}', { id: t.id, label: 'E with photographs (supervisor)' });
    await M(st, 'POST', '/tickets/{id}/complete', { id: t.id });
    await M(st, 'POST', '/tickets/{id}/complete', { id: t.id, label: 'claimed twice' });
    await M(st, 'GET', '/tickets/{id}', { id: t.id, label: 'E WORK_COMPLETED (supervisor)' });
    // sent back without a photograph (optional until HQ requires it), then redone
    const back = await call(ovr.token, `/tickets/${t.id}/inspect`, 'POST', { accepted: false, remark: 'Edges not finished' });
    if (back.status !== 200) throw new Error(`send back ${back.status} ${short(await j(back), 160)}`);
    await M(st, 'GET', '/tickets/{id}', { id: t.id, label: 'E REWORK (supervisor)' });
    await M(st, 'POST', '/tickets/{id}/start', { id: t.id, body: { workmen_assigned: 'Ram Prasad' }, label: 'resume after rework' });
    await M(st, 'POST', '/tickets/{id}/complete', { id: t.id, label: 'second round' });
    await accept(t);
    await M(st, 'GET', '/tickets/{id}', { id: t.id, label: 'E INSPECTED_ACCEPTED (supervisor)' });
    await M(st, 'GET', '/tickets/{id}/measurements', { id: t.id, label: 'supervisor' });
    await M(ovr.token, 'GET', '/tickets/{id}/job-card', { id: t.id, label: 'E with materials and a send-back' });
    // the supervisor's own measurement sheet and the MB record (2026-10-16)
    await M(st, 'GET', '/tickets/{id}/job-card', { id: t.id, label: 'supervisor' });
    const it = await M(st, 'POST', '/tickets/{id}/job-card/items', { id: t.id, body: { description: 'Plaster patch', unit: 'Sqm', qty_estimated: 2 }, label: 'supervisor' });
    await M(st, 'POST', '/tickets/{id}/measurements', { id: t.id, body: { item_id: it.body?.id, nos: 1, length: 2, breadth: 1 }, label: 'supervisor' });
    await M(st, 'GET', '/tickets/{id}/measurements', { id: t.id, label: 'supervisor, measured' });
    const mbJob = await M(ovr.token, 'GET', '/tickets/{id}/mb', { id: t.id, label: 'officer' });
    await M(st, 'GET', '/tickets/{id}/mb', { id: t.id, label: 'supervisor' });
    await M(ovr.token, 'GET', '/contracts/{id}/mb', { id: mbJob.body?.contract_id, label: 'officer' });
    await M(ovr.token, 'GET', '/contracts/{id}/mb', { id: mbJob.body?.contract_id, query: '?page_from=1&page_to=1', label: 'a page' });
    // working through a month's MB; finding it later (2026-10-16)
    await M(ovr.token, 'GET', '/mb/worklist', { query: `?contract_id=${mbJob.body?.contract_id}`, label: 'officer' });
    await M(ovr.token, 'GET', '/mb/worklist', { query: '?month=open&kind=materials', label: 'open, materials' });
    await M(ovr.token, 'GET', '/mb/search', { query: '?q=plaster', label: 'officer' });
    await M(st, 'GET', '/mb/search', { query: '?q=plaster', label: 'supervisor' });
    await M(ovr.token, 'GET', '/sheets/waiting', { label: 'officer' });
    await M(ovr.token, 'GET', '/search', { query: `?q=${encodeURIComponent(t.ticket_no)}`, label: 'with the MB reference' });
    // the contractor firm's own view of the job, read-only (its phone, 2026-10-15)
    const F = 'CONTRACTOR:M/s Jayant Constructions';
    const fs = (await signIn(F, { role: devices[F].role })).body;
    if (!fs?.token) throw new Error('firm sign-in');
    await I(fs.token, 'GET', '/me', { label: 'contractor firm' });
    await M(fs.token, 'GET', '/tickets', { label: 'contractor firm' });
    await M(fs.token, 'GET', '/tickets/{id}', { id: t.id, label: 'E INSPECTED_ACCEPTED (firm)' });
    await M(fs.token, 'GET', '/tickets/{id}/materials', { id: t.id, label: 'firm' });
    await M(fs.token, 'GET', '/tickets/{id}/measurements', { id: t.id, label: 'firm' });
    // the approval chain after the work (2026-10-16)
    await M(st, 'GET', '/tickets/{id}/sheets', { id: t.id, label: 'supervisor' });
    await M(ovr.token, 'GET', '/tickets/{id}/sheets', { id: t.id, label: 'officer' });
    await M(st, 'POST', '/tickets/{id}/sheets/{kind}/{action}', { id: t.id, kind: 'materials', action: 'submit', label: 'submit' });
    await M(st, 'GET', '/notifications', { label: 'supervisor' });

    // a home added from the supervisor's own phone (2026-10-13)
    await I(st, 'GET', '/me/homes', { label: 'none yet' });
    const h = (await I(st, 'POST', '/me/homes', { body: { colony_id: jayant.id, role: 'RESIDENT', identifier: 'E-17' } })).body;
    await I(st, 'POST', '/me/homes', { body: { colony_id: jayant.id, role: 'RESIDENT', identifier: 'E-18' }, label: 'second while waiting' });
    await I(st, 'POST', '/me/homes', { body: { colony_id: jayant.id, role: 'CIVIL_OVERSEER', identifier: 'E-18' }, label: 'official role' });
    await I(st, 'GET', '/me/homes', { label: 'waiting' });
    await I(inc.token, 'GET', '/home-requests', { label: 'Incharge' });
    if (h?.id) {
      await I(inc.token, 'POST', '/home-requests/{id}/approve', { id: h.id, body: { quarter_type: 'C' } });
      await I(st, 'GET', '/me/homes', { label: 'approved' });
    }
  });

  /* ---------- the Civil Overseer's inspection (phase A4 of the app) ---------- */
  await attempt('overseer inspection', async () => {
    const O = 'CIVIL_OVERSEER:A. K. Dubey';
    const multi = (await signIn(O, {})).body;
    const role = multi?.assignments?.find((a) => a.role === 'CIVIL_OVERSEER');
    const os = (await I(null, 'POST', '/auth/select-role', { body: { person_token: multi?.person_token, assignment_id: role?.id, second_factor_satisfied: true } })).body;
    if (!os?.token) throw new Error('overseer sign-in');
    const ot = os.token;
    const t = await raise(cats[5] || cats[0], 'Conformance F: door frame loose');
    await verify(t); await assign(t); await start(t); await claim(t);
    await M(ot, 'GET', '/inspections/queue', { label: 'one waiting' });
    await M(ot, 'GET', '/tickets/{id}', { id: t.id, label: 'F WORK_COMPLETED (overseer)' });
    await M(ot, 'GET', '/tickets/{id}/materials', { id: t.id, label: 'overseer' });
    await M(ot, 'POST', '/tickets/{id}/close', { id: t.id, label: 'close before inspection' });
    // sent back with a remark, no photograph (optional until HQ requires it)
    await M(ot, 'POST', '/tickets/{id}/inspect', { id: t.id, body: { accepted: false, remark: 'Hinges still loose' } });
    await M(ot, 'GET', '/tickets/{id}', { id: t.id, label: 'F REWORK (overseer)' });
    await start(t); await claim(t);
    await photo(ot, t.id, 'INSPECTION', 'F inspection');
    await M(ot, 'POST', '/tickets/{id}/inspect', { id: t.id, body: { accepted: true } });
    await M(ot, 'POST', '/tickets/{id}/inspect', { id: t.id, body: { accepted: true }, label: 'inspected twice' });
    await M(ot, 'GET', '/tickets/{id}', { id: t.id, label: 'F INSPECTED_ACCEPTED (overseer)' });
    await M(ot, 'POST', '/tickets/{id}/close', { id: t.id });
    await M(ot, 'GET', '/tickets/{id}', { id: t.id, label: 'F CLOSED (overseer)' });
    // the life of the job, every round, as the Overseer's phone shows it (2026-10-15)
    await M(ot, 'GET', '/tickets/{id}/job-card', { id: t.id, label: 'F closed, two rounds' });
    await M(ot, 'GET', '/inspections/queue', { label: 'after' });

    /* verifying, rejecting and assigning from the Overseer's phone (2026-10-15) */
    await M(ot, 'GET', '/tickets', { label: 'overseer' });
    const g = await raise(cats[6] || cats[0], 'Conformance G: kitchen slab cracked');
    await M(ot, 'GET', '/tickets/{id}', { id: g.id, label: 'G RAISED (overseer)' });
    await M(ot, 'POST', '/tickets/{id}/verify', { id: g.id, body: {} });
    await M(ot, 'POST', '/tickets/{id}/verify', { id: g.id, body: {}, label: 'verified twice' });
    const sups = (await M(ot, 'GET', '/devices/assignable', { label: 'overseer' })).body || [];
    await M(ot, 'POST', '/tickets/{id}/assign', { id: g.id, body: {}, label: 'no supervisor' });
    await M(ot, 'POST', '/tickets/{id}/assign', { id: g.id, body: { supervisor_id: sups[0]?.actor_id } });
    await M(ot, 'GET', '/tickets/{id}', { id: g.id, label: 'G ASSIGNED (overseer)' });
    await M(ot, 'GET', '/tickets/{id}/job-card', { id: g.id, label: 'G just assigned' });
    await M(ot, 'POST', '/tickets/{id}/assign', { id: g.id, body: { supervisor_id: sups[0]?.actor_id, reason: 'Given again' }, label: 'reassigned' });
    const h = await raise(cats[7] || cats[1], 'Conformance H: not a civil matter');
    await M(ot, 'POST', '/tickets/{id}/reject', { id: h.id, body: {}, label: 'no reason' });
    await M(ot, 'POST', '/tickets/{id}/reject', { id: h.id, body: { reason: 'Electrical — the E&M Department attends to it' } });
    await M(ot, 'GET', '/tickets/{id}', { id: h.id, label: 'H REJECTED (overseer)' });
  });

  /* ---------- the custodian ---------- */
  await attempt('custodian', async () => {
    const C = 'CUSTODIAN:Guest House Custodian';
    const cs = (await signIn(C, { role: devices[C].role })).body;
    await I(cs.token, 'GET', '/me', { label: 'custodian' });
    const t = await (async () => {
      const r = await M(cs.token, 'POST', '/tickets', { headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { sub_category_id: cats[0].id, description: 'Conformance custodian: leaking tap' } });
      if (!r.body?.id) throw new Error(`custodian raise ${r.status} ${short(r.body, 200)}`);
      return r.body;
    })();
    await M(cs.token, 'GET', '/tickets', { label: 'custodian' });
    await M(cs.token, 'GET', '/tickets/{id}', { id: t.id, label: 'custodian RAISED' });
    await M(cs.token, 'GET', '/tickets/{id}/feedback', { id: t.id, label: 'custodian' });
    await M(cs.token, 'GET', '/notifications', { label: 'custodian' });
  });
}

run().catch((e) => { check('suite ran to the end', false, e.stack); })
  .finally(async () => {
    const keys = [...problems.keys()].sort();
    for (const key of keys) {
      const bag = problems.get(key);
      const list = [...bag].map(([p, e]) => fmt(p, e));
      let detail = list.join('\n         ');
      if (detail.length > 1500) detail = `${detail.slice(0, 1500)}\n         … ${list.length} problems in all; full list below`;
      check(`${key}  (${calls.get(key)} response${calls.get(key) > 1 ? 's' : ''})`, list.length === 0, detail);
    }
    for (const [s, n, d] of out) console.log(`  ${s}  ${n}${d ? `\n         ${d}` : ''}`);
    if (notes.size) {
      console.log('\n  NOTES (not counted): the spec declares no body, the server sends one');
      for (const n of [...notes].sort()) console.log(`    ${n}`);
    }
    if (fail) {
      console.log('\n  ===== MISMATCH REPORT (complete) =====');
      for (const key of keys) {
        const bag = problems.get(key);
        if (!bag.size) continue;
        console.log(`\n  ${key}`);
        for (const [p, e] of bag) console.log(`     - ${fmt(p, e)}`);
      }
    }
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await maintPool.end().catch(() => {}); await identityPool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
