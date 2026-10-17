import { startAuthentication } from '@simplewebauthn/browser';

/* API client. Every call carries the access token for ONE role (decision
   2026-09-30); the server decides visibility and authority from it. The
   screens never filter by Area themselves (control 3). */

export type Assignment = { id: string; role: string; scope_path: string; premises?: string | null; colony?: string | null;
  area?: string | null; designation?: string | null; acting?: boolean };
export type Session = {
  token: string; refresh_token?: string; role: string; scope_path: string; premises_id: string | null;
  actor_id: string; person_id: string; name: string; amr: 'device' | 'password' | 'passkey' | 'otp';
  key?: string; employee_id?: string; assignments: Assignment[];
};
export type Pending = { person_token: string; assignments: Assignment[]; name: string; amr: 'device' | 'password' | 'passkey' | 'otp'; key?: string };

const KEY = 'cp-session';
export const session = {
  get(): Session | null {
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; }
  },
  set(s: Session) { sessionStorage.setItem(KEY, JSON.stringify(s)); },
  clear() { sessionStorage.removeItem(KEY); }
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const toSession = (b: any, extra: Partial<Session>): Session => ({
  token: b.token, refresh_token: b.refresh_token, role: b.role, scope_path: b.scope_path, premises_id: b.premises_id,
  actor_id: b.actor_id, person_id: b.person_id, assignments: b.assignments || [], name: '', amr: 'device', ...extra
} as Session);

/** Sign in with this phone's key (development helper stands in for the app). */
export async function deviceSignIn(key: string, pick: { role?: string; assignment_id?: string } = {}): Promise<Session | Pending> {
  const r = await fetch('/demo/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, ...pick }) });
  const b = await r.json();
  if (!r.ok) throw new ApiError(r.status, b.detail || 'Sign-in refused');
  if (!b.token) return { person_token: b.person_token, assignments: b.assignments, name: b.name, amr: 'device', key };
  const s = toSession(b, { name: b.name, amr: 'device', key });
  session.set(s);
  return s;
}

/** Employee ID + password (web). */
export async function passwordSignIn(employee_id: string, password: string): Promise<Session | Pending> {
  const r = await fetch('/identity/v1/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ employee_id, password }) });
  const b = await r.json();
  if (!r.ok) throw new ApiError(r.status, b.error || b.detail || 'Sign-in refused');
  const name = await nameOf(b);
  if (!b.token) return { person_token: b.person_token, assignments: b.assignments, name, amr: 'password' };
  const s = toSession(b, { name, amr: 'password', employee_id });
  session.set(s);
  return s;
}

/** Contractor staff on the web (2026-10-16): the mobile proved by OTP, every
    time; only into the role of the tab used (firm or supervisor). */
export async function contractorSignIn(registration_token: string, kind: 'CONTRACTOR' | 'CONTRACTOR_SUPERVISOR'): Promise<Session | Pending> {
  const r = await fetch('/identity/v1/auth/contractor', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ registration_token, kind }) });
  const b = await r.json();
  if (!r.ok) throw new ApiError(r.status, b.error || b.detail || 'Sign-in refused');
  const name = await nameOf(b);
  if (!b.token) return { person_token: b.person_token, assignments: b.assignments, name, amr: 'otp' };
  const s = toSession(b, { name, amr: 'otp' });
  session.set(s);
  return s;
}

/** A passkey on the web: the browser asks for fingerprint, face or PIN.
    No Employee ID is typed — the key says who it belongs to. */
export async function passkeySignIn(): Promise<Session | Pending> {
  const o = await fetch('/identity/v1/auth/passkey/options', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const ob = await o.json().catch(() => ({}));
  if (!o.ok) throw new ApiError(o.status, ob.error || ob.detail || 'Passkey sign-in is not available');
  const response = await startAuthentication({ optionsJSON: ob.options });
  const r = await fetch('/identity/v1/auth/passkey', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, b.error || b.detail || 'Sign-in refused');
  const name = await nameOf(b);
  if (!b.token) return { person_token: b.person_token, assignments: b.assignments, name, amr: 'passkey' };
  const s = toSession(b, { name, amr: 'passkey' });
  session.set(s);
  return s;
}

/** The role picker's choice. */
export async function selectRole(p: Pending, assignment_id: string): Promise<Session> {
  const r = await fetch('/identity/v1/auth/select-role', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person_token: p.person_token, assignment_id, second_factor_satisfied: true }) });
  const b = await r.json();
  if (!r.ok) throw new ApiError(r.status, b.error || 'That role could not be opened');
  const s = toSession(b, { name: p.name || await nameOf(b), amr: p.amr, key: p.key });
  session.set(s);
  return s;
}

/** Switch to another of one's own roles. The app asks for the PIN or
    biometric before an official role; the demo asserts it. */
export async function switchRole(assignment_id: string): Promise<Session> {
  const cur = session.get()!;
  const b = await api('/auth/switch-role', { prefix: '/identity/v1', body: { assignment_id, second_factor_satisfied: true } });
  const s = toSession(b, { name: cur.name, amr: cur.amr, key: cur.key, employee_id: cur.employee_id });
  session.set(s);
  return s;
}

async function nameOf(b: any) {
  if (!b.token) return '';
  try {
    const r = await fetch('/identity/v1/me', { headers: { authorization: `Bearer ${b.token}` } });
    return (await r.json()).person_name || '';
  } catch { return ''; }
}

/* Tokens live 15 minutes. On a 401 the session is renewed once with the
   refresh token — which re-reads the role, so a revoked role stops here. */
async function renew(s: Session): Promise<Session | null> {
  if (!s.refresh_token) return null;
  const r = await fetch('/identity/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: s.refresh_token }) });
  if (!r.ok) return null;
  const b = await r.json();
  const n = { ...s, token: b.token, refresh_token: b.refresh_token, assignments: b.assignments || s.assignments };
  session.set(n);
  return n;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; prefix?: string } = {}): Promise<T> {
  const doFetch = (tok: string | undefined) => fetch((opts.prefix ?? '/maintenance/v1') + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let s = session.get();
  let r = await doFetch(s?.token);
  if (r.status === 401 && s) {
    s = await renew(s);
    if (!s) { session.clear(); throw new ApiError(401, 'Your session has ended. Sign in again.'); }
    r = await doFetch(s.token);
  }
  if (r.status === 204) return undefined as T;
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, b.detail || b.error || b.title || `Request failed (${r.status})`);
  return b as T;
}
export const idApi = <T = any>(path: string, o: { method?: string; body?: unknown } = {}) =>
  api<T>(path, { ...o, prefix: '/identity/v1' });

/** A CSV download, fetched with the token (a plain link would send none). */
export async function downloadCsv(path: string, filename: string) {
  let s = session.get();
  let r = await fetch(path, { headers: { authorization: `Bearer ${s?.token}` } });
  if (r.status === 401 && s) { s = await renew(s); if (s) r = await fetch(path, { headers: { authorization: `Bearer ${s.token}` } }); }
  if (!r.ok) throw new ApiError(r.status, r.status === 403 ? 'This download is not open to your role' : 'The download did not complete. Try again.');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob());
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Public identity calls that need no token (OTP, colonies). */
export async function publicPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, b.detail || b.error || b.title || 'Request failed');
  return b;
}

/** Where each role lands. */
export function homeFor(role: string) {
  switch (role) {
    case 'RESIDENT': case 'CUSTODIAN': return '/m/home';
    // on the web (mobile + OTP) the supervisor works in the office layout, as the Overseer does (2026-10-16)
    case 'CONTRACTOR_SUPERVISOR': return session.get()?.amr === 'otp' ? '/w/jobs' : '/m/jobs';
    case 'CONTRACTOR': return '/w/jobs';
    case 'CIVIL_OVERSEER': case 'MAINTENANCE_INCHARGE': return '/w/queue';
    case 'STAFF_OFFICER_CIVIL': return '/w/area';
    case 'AREA_HR_ADMIN': case 'AREA_SYS_ADMIN': return '/w/people';
    case 'GM_CIVIL': case 'HQ_EXECUTIVE': return '/w/hq';
    case 'ADMINISTRATOR': return '/w/admin';
    default: return '/signin';
  }
}
