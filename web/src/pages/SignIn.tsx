import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Fingerprint, KeyRound, Smartphone, ChevronRight, IdCard, Home, Building2, BadgeCheck, HardHat, Briefcase } from 'lucide-react';
import { Avatar, Button, Card, ErrorState, Field, Logo, Segmented, Skeleton, inputCls } from '../components/ui';
import { LangSwitch, ThemeToggle } from '../components/shell/Shells';
import { homeFor, deviceSignIn, passwordSignIn, passkeySignIn, selectRole, contractorSignIn, publicPost, ApiError, type Pending, type Session } from '../lib/api';
import { EMP_ID_HELP, OCCUPANT, ROLE_LABEL, isEmpId, roleTitle, toEmpId } from '../lib/domain';
import { initials } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { GovStrip } from '../components/shell/GovFrame';

/* Sign-in (decision 2026-09-30): prove who you are — this phone's key, or
   Employee ID + password on the web — then choose the role to act in.
   Since 2026-10-16 (user's decision) contractor staff may sign in on the web
   too, on two tabs of their own: the mobile number and an OTP every time.
   Every official also has their own quarter here as a role. OTP is used
   only to register a device and to set or reset a password. */

function BrandPanel() {
  return (
    <div className="hidden lg:flex flex-col justify-between text-white p-12 lg:sticky lg:top-0 lg:h-screen overflow-hidden"
      style={{ background: 'linear-gradient(170deg,var(--sidebar) 0%,var(--primary-dark) 100%)' }}>
      <Link to="/"><Logo /></Link>
      <div>
        <p className="font-quote text-[36px] leading-[1.2] font-semibold max-w-md">Well maintained colonies, stronger communities.</p>
        <div className="flex gap-10 mt-10">
          {[['15,000', 'Quarters'], ['13', 'Areas'], ['24 h', 'To reopen']].map(([v, l]) => (
            <div key={l}><div className="tnum text-2xl font-bold text-gold">{v}</div><div className="text-[13px] text-white/78">{l}</div></div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full flex flex-col">
    <GovStrip />
    <div className="flex-1 grid lg:grid-cols-[1fr_1fr]">
      <BrandPanel />
      <div className="flex flex-col p-6 md:p-10">
        <div className="flex justify-between lg:justify-end items-center gap-2">
          <Link to="/" className="lg:hidden"><div className="bg-sidebar rounded-2xl p-2"><Logo compact /></div></Link>
          <div className="flex gap-2"><LangSwitch /><ThemeToggle /></div>
        </div>
        <div className="flex-1 flex items-start lg:items-center justify-center py-8">
          <div className="w-full max-w-[520px]">{children}</div>
        </div>
      </div>
    </div>
    </div>
  );
}

/* The role picker — also what the header switcher shows. */
export function RoleList({ roles, onPick, busy }: { roles: { id: string; role: string; premises?: string | null; area?: string | null; designation?: string | null; scope_path?: string }[];
  onPick: (id: string) => void; busy?: string | null }) {
  return (
    <div className="flex flex-col gap-2.5">
      {roles.map((a) => {
        const occ = OCCUPANT.includes(a.role);
        return (
          <Card key={a.id} onClick={() => onPick(a.id)} className="p-3.5 flex items-center gap-3">
            <div className={'w-10 h-10 rounded-full grid place-items-center shrink-0 ' + (occ ? 'bg-tint text-primary' : 'bg-primary-btn text-on-primary')}>
              {a.role === 'RESIDENT' ? <Home size={18} /> : a.role === 'CUSTODIAN' ? <Building2 size={18} /> : <BadgeCheck size={18} />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{roleTitle(a)}</div>
              <div className="text-xs text-ink-muted">{occ ? 'Report and track complaints for your own home' : a.designation || ROLE_LABEL[a.role]}</div>
            </div>
            {busy === a.id ? <span className="text-xs text-ink-muted">Opening…</span> : <ChevronRight size={18} className="text-ink-muted" />}
          </Card>
        );
      })}
    </div>
  );
}

type Dev = { key: string; name: string; roles: string[]; employee_id?: string };

export default function SignIn() {
  const nav = useNavigate();
  const { t } = usePrefs();
  const [tab, setTab] = useState<'phone' | 'id' | 'firm' | 'supr'>('phone');
  const [devices, setDevices] = useState<Dev[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [emp, setEmp] = useState(''); const [pw, setPw] = useState('');

  const load = () => fetch('/demo/devices').then((r) => r.json()).then(setDevices)
    .catch(() => setErr('The demo device list is not available. Start the portal with `npm run web`.'));
  useEffect(() => { load(); }, []);

  const done = (r: Session | Pending) => {
    if ('token' in r) nav(homeFor(r.role)); else setPending(r);
  };
  const go = async (d: Dev) => {
    setBusy(d.key); setErr(null);
    try { done(await deviceSignIn(d.key)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Sign-in did not complete. Try again.'); }
    finally { setBusy(null); }
  };
  const byPassword = async () => {
    setBusy('pw'); setErr(null);
    try { done(await passwordSignIn(emp.trim(), pw)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Sign-in did not complete.'); }
    finally { setBusy(null); }
  };
  const byPasskey = async () => {
    setBusy('pk'); setErr(null);
    try { done(await passkeySignIn()); }
    catch (e) {
      const n = (e as { name?: string })?.name;
      setErr(n === 'NotAllowedError' || n === 'AbortError' ? 'Try again — the passkey prompt was closed or timed out.'
        : e instanceof ApiError && e.status === 401 ? (e.message && e.message !== 'Sign-in refused' ? e.message : 'This passkey was not accepted. Try again or use your password.')
        : e instanceof Error ? e.message : 'Sign-in did not complete. Try again.');
    }
    finally { setBusy(null); }
  };
  const pick = async (id: string) => {
    setBusy(id); setErr(null);
    try { const s = await selectRole(pending!, id); nav(homeFor(s.role)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'That role could not be opened.'); }
    finally { setBusy(null); }
  };

  if (pending) return (
    <AuthLayout>
      <h1 className="text-[30px] font-bold text-primary">Namaste{pending.name ? `, ${pending.name}` : ''}</h1>
      <p className="text-ink-muted mt-1">You hold more than one role. Choose how you want to work now — you can switch at any time from the top of the screen.</p>
      <div className="mt-6"><RoleList roles={pending.assignments} onPick={pick} busy={busy} /></div>
      {err && <div className="mt-4"><ErrorState message={err} /></div>}
      <Button variant="ghost" className="mt-5" onClick={() => setPending(null)}>Use another sign-in</Button>
    </AuthLayout>
  );

  return (
    <AuthLayout>
      <h1 className="text-[30px] font-bold text-primary">{t('Welcome back')}</h1>
      <p className="text-ink-muted mt-1">Sign in, then choose the role you are working in.</p>
      <Segmented className="mt-6 w-full grid! grid-cols-2" value={tab} onChange={(v) => { setTab(v); setErr(null); }}
        options={[{ value: 'phone', label: <span className="inline-flex items-center gap-2"><Smartphone size={16} />This phone</span> },
                  { value: 'id', label: <span className="inline-flex items-center gap-2"><IdCard size={16} />Employee ID</span> },
                  { value: 'firm', label: <span className="inline-flex items-center gap-2"><Briefcase size={16} />Contractor</span> },
                  { value: 'supr', label: <span className="inline-flex items-center gap-2"><HardHat size={16} />Supervisor</span> }]} />

      {tab === 'firm' || tab === 'supr' ? (
        <ContractorTab key={tab} kind={tab === 'firm' ? 'CONTRACTOR' : 'CONTRACTOR_SUPERVISOR'} onDone={done} />
      ) : tab === 'phone' ? (
        <>
          <div className="mt-5 flex items-start gap-3 rounded-card bg-tint p-3.5 text-[13px]">
            <KeyRound size={18} className="text-primary shrink-0 mt-0.5" />
            <div><b>The phone is the key.</b> An approved phone signs in with a key that never leaves it — no password.
              Inspections can be accepted only this way.
              <div className="text-ink-muted mt-0.5">Demo: each entry is a phone set up on this machine.</div></div>
          </div>
          <div className="mt-4 flex flex-col gap-2.5">
            {err && <ErrorState message={err} retry={load} />}
            {!devices && !err && [0, 1, 2].map((i) => <Skeleton key={i} className="h-[68px]" />)}
            {devices?.map((d) => (
              <Card key={d.key} onClick={() => go(d)} className="p-3.5 flex items-center gap-3">
                <Avatar text={initials(d.name)} />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{d.name}</div>
                  <div className="text-xs text-ink-muted truncate">{[...new Set(d.roles)].map((r) => ROLE_LABEL[r] || r).join(' · ')}</div>
                </div>
                {busy === d.key ? <span className="text-xs text-ink-muted">Signing in…</span> : <ChevronRight size={18} className="text-ink-muted" />}
              </Card>
            ))}
          </div>
        </>
      ) : (
        <form className="mt-5 grid gap-4" onSubmit={(e) => { e.preventDefault(); byPassword(); }}>
          <Field label="Employee ID" required help={EMP_ID_HELP}><input className={inputCls + ' tnum'} inputMode="numeric" maxLength={8} value={emp} onChange={(e) => setEmp(toEmpId(e.target.value))} placeholder="90229456" autoComplete="username" /></Field>
          <Field label="Password" required><input className={inputCls} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Field>
          {err && <ErrorState message={err} />}
          <div className="flex flex-wrap gap-3 items-center">
            <Button type="submit" loading={busy === 'pw'} disabled={!isEmpId(emp) || !pw}>Sign in</Button>
            <Link to="/password" className="text-[13px] text-primary font-semibold">Set or reset password</Link>
          </div>
          {browserSupportsWebAuthn() && (
            <div className="border-t border-line pt-4">
              <Button type="button" variant="secondary" icon={<Fingerprint size={18} />} loading={busy === 'pk'} onClick={byPasskey}>Sign in with a passkey</Button>
              <p className="text-xs text-ink-muted mt-2">Use your fingerprint, face or PIN — no Employee ID or password to type. Add a passkey under Passkeys after signing in.</p>
            </div>
          )}
          <p className="text-xs text-ink-muted">For NCL employees on the web. Non-NCL residents use the app. Demo: Employee ID <b className="tnum">90222002</b> (Incharge), password <b>Portal@2026</b>.</p>
        </form>
      )}

      <div className="mt-8 border-t border-line pt-6">
        <div className="font-semibold">New phone?</div>
        <p className="text-[13px] text-ink-muted mt-1">Register it with your mobile number. Residents and custodians are checked by the Civil Colony Incharge; officials' and contractors' phones by the Area administrator, who also assigns their roles.</p>
        <Button variant="secondary" className="mt-3" icon={<Smartphone size={18} />} onClick={() => nav('/register')}>{t('Register this device')}</Button>
      </div>
    </AuthLayout>
  );
}

/* ------------------------------------------------------------ contractor staff */
/* The firm or a supervisor: the mobile number and an OTP, every time — no
   password to share (user's decision, 2026-10-16). Only someone whose phone
   is already approved in the app; the server says so plainly otherwise. */
function ContractorTab({ kind, onDone }: { kind: 'CONTRACTOR' | 'CONTRACTOR_SUPERVISOR'; onDone: (r: Session | Pending) => void }) {
  const otp = useOtp();
  const firm = kind === 'CONTRACTOR';
  const [mobile, setMobile] = useState(''); const [code, setCode] = useState('');
  const [step, setStep] = useState<'mobile' | 'code'>('mobile');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setErr(null); setBusy(true); try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  return (
    <div className="mt-5 grid gap-4">
      <div className="flex items-start gap-3 rounded-card bg-tint p-3.5 text-[13px]">
        {firm ? <Briefcase size={18} className="text-primary shrink-0 mt-0.5" /> : <HardHat size={18} className="text-primary shrink-0 mt-0.5" />}
        <div><b>{firm ? 'For the contractor firm.' : 'For a contractor supervisor.'}</b> Your mobile number and a code sent to it, every time.
          Your phone must already be registered and approved in the app.
          <div className="text-ink-muted mt-0.5">{firm ? 'Read-only: your jobs, completed work, scorecard and work orders.'
            : 'Read your jobs and record materials here. Starting work, photographs and marking complete stay in the app.'}</div></div>
      </div>
      {step === 'mobile' ? (
        <>
          <Field label="Mobile number" required help="The number your phone was registered with">
            <input className={inputCls + ' tnum'} inputMode="numeric" maxLength={10} value={mobile} autoComplete="tel"
              onChange={(e) => setMobile(e.target.value.replace(/\D/g, ''))} placeholder="98xxxxxxxx" />
          </Field>
          {err && <ErrorState message={err} />}
          <Button loading={busy} disabled={mobile.length !== 10} onClick={() => run(async () => { await otp.send(mobile); setStep('code'); })}>Send me a code</Button>
        </>
      ) : (
        <>
          <otp.DevNote />
          <OtpBoxes value={code} onChange={setCode} />
          {err && <ErrorState message={err} />}
          <div className="flex flex-wrap gap-3 items-center">
            <Button loading={busy} disabled={code.length !== 6}
              onClick={() => run(async () => onDone(await contractorSignIn(await otp.verify(mobile, code), kind)))}>Sign in</Button>
            <otp.Resend mobile={mobile} onErr={setErr} />
            <button type="button" className="text-[13px] text-primary font-semibold" onClick={() => { setStep('mobile'); setCode(''); setErr(null); }}>Change number</button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ OTP boxes */
function OtpBoxes({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  return (
    <div className="flex gap-2" onPaste={(e) => { const p = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6); if (p) { onChange(p); e.preventDefault(); } }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <input key={i} ref={(el) => { refs.current[i] = el; }} inputMode="numeric" maxLength={1} aria-label={`Digit ${i + 1}`}
          value={value[i] || ''} className="w-11 h-[52px] rounded-input border-[1.5px] border-line-strong bg-surface text-center text-xl font-semibold tnum focus:border-primary focus:outline-none"
          onChange={(e) => {
            const d = e.target.value.replace(/\D/g, '').slice(-1);
            onChange((value.slice(0, i) + d + value.slice(i + 1)).slice(0, 6));
            if (d && i < 5) refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => { if (e.key === 'Backspace' && !value[i] && i > 0) refs.current[i - 1]?.focus(); }} />
      ))}
    </div>
  );
}

/* A mobile proved by OTP, used by registration and by password setting. */
function useOtp() {
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const send = async (mobile: string) => {
    if (!/^[6-9]\d{9}$/.test(mobile)) throw new Error('Enter the 10-digit mobile number, starting 6, 7, 8 or 9.');
    const r = await publicPost('/identity/v1/auth/otp/request', { mobile });
    setDevCode(r.dev_code || null); setResendAt(Date.now() + 30000);
  };
  const verify = async (mobile: string, code: string) => {
    try { return (await publicPost('/identity/v1/auth/otp/verify', { mobile, code })).registration_token as string; }
    catch (e: any) { throw new Error(/wrong|expired/i.test(e.message) ? 'That code is wrong or has expired. Check it, or tap Resend to get a new one.' : e.message); }
  };
  const Resend = ({ mobile, onErr }: { mobile: string; onErr: (m: string) => void }) => (
    <Button variant="ghost" disabled={now < resendAt} onClick={() => send(mobile).catch((e) => onErr(e.message))}>
      {now < resendAt ? `Resend in ${Math.ceil((resendAt - now) / 1000)}s` : 'Resend code'}</Button>
  );
  const DevNote = () => devCode ? <div className="mt-3 text-[13px] rounded-card bg-risk-bg text-risk p-3">Development only — no SMS gateway yet. The code is <b className="tnum">{devCode}</b>.</div> : null;
  return { send, verify, Resend, DevNote };
}

/* ------------------------------------------------------------ registration */
type Kind = 'RESIDENT' | 'CUSTODIAN' | 'OFFICIAL';
export function Register() {
  const nav = useNavigate();
  const otp = useOtp();
  const [colonies, setColonies] = useState<{ id: string; name: string; area: string }[]>([]);
  const [buildings, setBuildings] = useState<{ id: string; identifier: string; premises_type: string }[]>([]);
  const [kind, setKind] = useState<Kind>('RESIDENT');
  const [f, setF] = useState({ name: '', personnel_no: '', mobile: '', colony_id: '', sector: '', no_sector: false, identifier: '', category: 'NCL' });
  const [step, setStep] = useState<'form' | 'otp' | 'done'>('form');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => { fetch('/identity/v1/masters/colonies').then((r) => r.json()).then((c) => {
    setColonies(c); setF((x) => ({ ...x, colony_id: c.find((y: any) => y.area === 'Jayant')?.id || c[0]?.id || '' }));
  }); }, []);
  useEffect(() => { if (kind === 'CUSTODIAN' && f.colony_id) fetch(`/identity/v1/masters/buildings?colony_id=${f.colony_id}`).then((r) => r.json()).then(setBuildings); }, [kind, f.colony_id]);

  const sendCode = async () => {
    setErr(null);
    if (!f.name.trim()) return setErr('Enter your name.');
    if (f.personnel_no && !isEmpId(f.personnel_no)) return setErr('The Employee ID is 8 digits.');
    if (kind !== 'OFFICIAL' && !f.identifier.trim()) return setErr(kind === 'RESIDENT' ? 'Enter your quarter number.' : 'Choose your building.');
    setBusy(true);
    try { await otp.send(f.mobile); setStep('otp'); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const [owner, setOwner] = useState<string | null>(null);
  const verify = async () => {
    setErr(null); setBusy(true);
    try {
      const token = await otp.verify(f.mobile, code);
      const fields = { name: f.name, personnel_no: f.personnel_no || null, colony_id: f.colony_id, sector: f.sector,
        no_sector: f.no_sector, identifier: f.identifier || null, role: kind === 'OFFICIAL' ? null : kind,
        resident_category: f.category, platform: 'android' };
      const r = await fetch('/demo/register', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields, registration_token: token }) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.detail || 'Registration was not accepted.');
      setOwner(b.existing_person ? b.name : null);
      setStep('done');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <AuthLayout>
      <h1 className="text-[30px] font-bold text-primary">Register this phone</h1>
      {step === 'done' ? (
        <Card className="p-6 mt-6">
          <div className="font-semibold text-lg">Sent for checking</div>
          {owner && <p className="mt-2 rounded-input bg-risk-bg text-risk p-3 text-[13px]">This mobile number is <b>{owner}</b>'s on the portal's records, so the phone is registered to {owner}, not to the name typed. If that is wrong, ask the Area office to correct the mobile number.</p>}
          <p className="text-ink-muted mt-1">{kind === 'OFFICIAL'
            ? 'Your phone is approved by the Area administrator — or, for a contractor’s supervisor, by the Civil Colony Incharge who appointed you. Your roles are those already assigned to you.'
            : 'The Civil Colony Incharge will check your details and approve this phone.'} You can sign in once it is approved.</p>
          <Button className="mt-5" onClick={() => nav('/signin')}>Back to sign in</Button>
        </Card>
      ) : step === 'otp' ? (
        <div className="mt-6">
          <p className="text-ink-muted">Enter the 6-digit code sent to <b className="tnum text-ink">{f.mobile}</b>.</p>
          <otp.DevNote />
          <div className="mt-5"><OtpBoxes value={code} onChange={setCode} /></div>
          {err && <div className="mt-4"><ErrorState message={err} /></div>}
          <div className="flex flex-wrap gap-3 mt-6">
            <Button loading={busy} disabled={code.length !== 6} onClick={verify}>Verify and send for checking</Button>
            <otp.Resend mobile={f.mobile} onErr={setErr} />
          </div>
        </div>
      ) : (
        <div className="mt-6 grid gap-4">
          <Segmented className="w-full grid grid-cols-3" value={kind} onChange={(v) => { setKind(v); set('identifier', ''); }}
            options={[{ value: 'RESIDENT', label: 'Resident' }, { value: 'CUSTODIAN', label: 'Custodian' }, { value: 'OFFICIAL', label: 'Official / contractor' }]} />
          {kind === 'OFFICIAL' && <div className="text-[13px] rounded-card bg-tint p-3">Your roles are assigned by your Area HR office — or, for a contractor's supervisor, by the Civil Colony Incharge. Register your phone with the mobile number they hold for you; they approve it. Your own quarter is added by the HR office too.</div>}
          {kind === 'RESIDENT' && (
            <div className="flex gap-4 text-sm">
              {[['NCL', 'NCL employee'], ['NON_NCL', 'Non-NCL resident']].map(([v, l]) => (
                <label key={v} className="inline-flex items-center gap-2"><input type="radio" checked={f.category === v} onChange={() => set('category', v)} />{l}</label>))}
            </div>
          )}
          <Field label="Your name" required><input className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <div className="grid sm:grid-cols-2 gap-4">
            {(kind !== 'RESIDENT' || f.category === 'NCL') && (
              <Field label="Employee ID" help={EMP_ID_HELP}><input className={inputCls + ' tnum'} inputMode="numeric" maxLength={8} value={f.personnel_no} onChange={(e) => set('personnel_no', toEmpId(e.target.value))} /></Field>)}
            <Field label="Mobile" required help="A code will be sent to prove this phone holds it">
              <input className={inputCls + ' tnum'} inputMode="numeric" maxLength={10} value={f.mobile} onChange={(e) => set('mobile', e.target.value.replace(/\D/g, ''))} /></Field>
          </div>
          <Field label="Colony" required>
            <select className={inputCls} value={f.colony_id} onChange={(e) => set('colony_id', e.target.value)}>
              {colonies.map((c) => <option key={c.id} value={c.id}>{c.area} — {c.name}</option>)}
            </select>
          </Field>
          {kind === 'RESIDENT' && (<>
            <Field label="Sector" help={<label className="inline-flex items-center gap-2"><input type="checkbox" checked={f.no_sector} onChange={(e) => set('no_sector', e.target.checked)} />This colony has no sectors</label>}>
              <input className={inputCls} disabled={f.no_sector} value={f.sector} onChange={(e) => set('sector', e.target.value)} placeholder="Leave blank if none" />
            </Field>
            <Field label="Quarter number" required help="Write it as it is written on your quarter. The Incharge corrects the format if needed.">
              <input className={inputCls} value={f.identifier} onChange={(e) => set('identifier', e.target.value)} placeholder="e.g. B-234" />
            </Field>
          </>)}
          {kind === 'CUSTODIAN' && (
            <Field label="Building" required>
              <select className={inputCls} value={f.identifier} onChange={(e) => set('identifier', e.target.value)}>
                <option value="">Choose…</option>
                {buildings.map((b) => <option key={b.id} value={b.identifier}>{b.identifier} — {b.premises_type.replace('_', ' ').toLowerCase()}</option>)}
              </select>
            </Field>
          )}
          {err && <ErrorState message={err} />}
          <div className="flex gap-3"><Button loading={busy} onClick={sendCode}>Send me a code</Button>
            <Button variant="ghost" onClick={() => nav('/signin')}>Cancel</Button></div>
          {kind === 'RESIDENT' && f.category === 'NON_NCL' && <p className="text-xs text-ink-muted">Non-NCL residents use the app only; the Incharge verifies who you are before approving.</p>}
        </div>
      )}
    </AuthLayout>
  );
}

/* ------------------------------------------------------------ set / reset password */
export function SetPassword() {
  const nav = useNavigate();
  const otp = useOtp();
  const [emp, setEmp] = useState(''); const [mobile, setMobile] = useState('');
  const [code, setCode] = useState(''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [step, setStep] = useState<'ask' | 'set' | 'done'>('ask');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setErr(null); setBusy(true); try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  return (
    <AuthLayout>
      <h1 className="text-[30px] font-bold text-primary">Set or reset your password</h1>
      <p className="text-ink-muted mt-1">For the web. A code goes to the mobile number the Area HR office holds for you.</p>
      {step === 'done' ? (
        <Card className="p-6 mt-6"><div className="font-semibold text-lg">Password set</div>
          <Button className="mt-4" onClick={() => nav('/signin')}>Sign in</Button></Card>
      ) : step === 'ask' ? (
        <div className="grid gap-4 mt-6">
          <Field label="Employee ID" required help={EMP_ID_HELP}><input className={inputCls + ' tnum'} inputMode="numeric" maxLength={8} value={emp} onChange={(e) => setEmp(toEmpId(e.target.value))} /></Field>
          <Field label="Mobile on record" required><input className={inputCls + ' tnum'} inputMode="numeric" maxLength={10} value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, ''))} /></Field>
          {err && <ErrorState message={err} />}
          <Button loading={busy} disabled={!isEmpId(emp) || mobile.length !== 10} onClick={() => run(async () => { await otp.send(mobile); setStep('set'); })}>Send me a code</Button>
        </div>
      ) : (
        <div className="grid gap-4 mt-6">
          <otp.DevNote />
          <OtpBoxes value={code} onChange={setCode} />
          <Field label="New password" required help="At least 10 characters"><input className={inputCls} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
          <Field label="Type it again" required error={pw2 && pw !== pw2 ? 'The two passwords differ' : null}><input className={inputCls} type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>
          {err && <ErrorState message={err} />}
          <div className="flex gap-3">
            <Button loading={busy} disabled={code.length !== 6 || pw.length < 10 || pw !== pw2}
              onClick={() => run(async () => {
                const token = await otp.verify(mobile, code);
                await publicPost('/identity/v1/auth/password/set', { employee_id: emp.trim(), registration_token: token, password: pw });
                setStep('done');
              })}>Set password</Button>
            <otp.Resend mobile={mobile} onErr={setErr} />
          </div>
        </div>
      )}
    </AuthLayout>
  );
}
