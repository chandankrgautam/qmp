import { useState } from 'react';
import { Plus, Search as SearchIcon, Smartphone, KeyRound } from 'lucide-react';
import { Button, Card, Chip, Dialog, EmptyState, ErrorState, Field, Segmented, Skeleton, StatusChip, inputCls, useToast } from '../../components/ui';
import { PageHeader } from '../../components/shell/Shells';
import { api, idApi, session } from '../../lib/api';
import { EMP_ID_HELP, OCCUPANT, ROLE_LABEL, areaFromScope, isEmpId, toEmpId } from '../../lib/domain';
import { shortDate, when } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { PersonPasskeys } from '../Passkeys';

/* People and roles — the Area HR and System administrators (decision
   2026-09-30, item 1). A role belongs to a person, not a phone. An Area
   administrator assigns only within their Area and only below their own
   rank, never to themselves; the database refuses anything else, so this
   screen only offers what the server will accept. Every change carries a
   reason and lands in the audit trail below. */

export default function People() {
  const [tab, setTab] = useState<'people' | 'audit'>('people');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const people = useLoad(() => idApi<any[]>(`/persons${query ? `?q=${encodeURIComponent(query)}` : ''}`), [query]);
  const person = people.data?.find((p) => p.id === open);
  return (
    <>
      <PageHeader title="People and roles" sub="Who holds which role in your Area. Roles are assigned to people; their phones are approved under Registrations."
        action={<Button icon={<Plus size={18} />} onClick={() => setAdding(true)}>Add person</Button>} />
      <Segmented className="mb-4" value={tab} onChange={setTab} options={[{ value: 'people', label: 'People' }, { value: 'audit', label: 'Audit trail' }]} />
      {tab === 'audit' ? <Audit /> : (
        <>
          <form className="flex gap-2 max-w-xl mb-4" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
            <div className="relative flex-1">
              <SearchIcon size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted" />
              <input className={inputCls + ' pl-10'} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, Employee ID or mobile" />
            </div>
            <Button type="submit" variant="secondary">Search</Button>
          </form>
          {people.error && <ErrorState message={people.error} retry={people.reload} />}
          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-4 items-start">
            <div className="bg-surface border border-line rounded-card overflow-hidden">
              {!people.data ? <Skeleton className="h-40 m-4" /> : people.data.length === 0 ? <EmptyState title="Nobody found" body="Add the person first, then assign their role." /> :
                people.data.map((p) => (
                  <button key={p.id} onClick={() => setOpen(p.id)}
                    className={'w-full text-left px-4 py-3 border-b border-line last:border-0 hover:bg-row-hover ' + (open === p.id ? 'bg-tint' : '')}>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold flex-1 truncate">{p.name}</span>
                      <span className="text-xs text-ink-muted tnum inline-flex items-center gap-1"><Smartphone size={13} />{Number(p.devices) + (Number(p.phones_elsewhere) || 0)}</span>
                    </div>
                    <div className="text-xs text-ink-muted tnum">{p.personnel_no || (p.resident_category === 'NON_NCL' ? 'Non-NCL' : 'No Employee ID')}{p.designation ? ` · ${p.designation}` : ''}</div>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {p.roles.length === 0 && <span className="text-xs text-ink-muted">No role</span>}
                      {p.roles.map((r: any) => <StatusChip key={r.id} tone={r.status === 'PENDING' ? 'await' : OCCUPANT.includes(r.role) ? 'neutral' : 'info'}>
                        {ROLE_LABEL[r.role]}{r.premises ? ` · ${r.premises}` : ''}{r.status === 'PENDING' ? ' (pending)' : ''}</StatusChip>)}
                    </div>
                  </button>
                ))}
            </div>
            {person ? <PersonPanel key={person.id} p={person} onChanged={people.reload} />
              : <Card className="p-6 text-ink-muted text-sm hidden lg:block">Choose a person to see and change their roles.</Card>}
          </div>
        </>
      )}
      {adding && <AddPerson onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); people.reload(); setOpen(id); }} />}
    </>
  );
}

/* A person's phones, told apart by when each was registered and last used,
   each revoked with a reason (user's finding, 2026-10-13: two phones of one
   person, and revoking was only on Administration → Devices, where they
   looked alike). Revoking a phone ends no role. */
const PHONE_STATE: Record<string, [string, 'ok' | 'await' | 'neutral' | 'bad']> = {
  ACTIVE: ['Approved', 'ok'], PENDING: ['Waiting for approval', 'await'], REJECTED: ['Not approved', 'neutral'], REVOKED: ['Revoked', 'bad']
};
function PersonPhones({ personId, name, self, elsewhere }: { personId: string; name: string; self: boolean; elsewhere: number }) {
  const toast = useToast();
  const list = useLoad(() => idApi<any[]>(`/devices?person_id=${personId}`), [personId]);
  const [rev, setRev] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await idApi(`/devices/${rev.id}/revoke`, { body: { reason } }); toast({ text: `Phone of ${name} revoked` }); setRev(null); list.reload(); }
    catch (e: any) { toast({ text: e.message, tone: 'bad' }); } finally { setBusy(false); }
  };
  const phones = (list.data || []).slice().sort((a, b) => (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1));
  return (
    <div>
      <div className="label mt-5 mb-2">Phones</div>
      {list.error && <ErrorState message={list.error} retry={list.reload} />}
      {!list.data && !list.error && <Skeleton className="h-12" />}
      {list.data && phones.length === 0 && !elsewhere && <div className="text-[13px] text-ink-muted">No phone registered.</div>}
      <div className="grid gap-2">
        {phones.map((d, i) => {
          const [label, tone] = PHONE_STATE[d.status] || [d.status, 'neutral'];
          return (
            <div key={d.id} className="rounded-card border border-line p-3 text-[13px]">
              <div className="flex items-center gap-2">
                <Smartphone size={16} className="text-ink-muted shrink-0" />
                <span className="font-medium">{d.platform === 'android' ? 'Android phone' : d.platform === 'ios' ? 'iPhone' : 'Web demo phone'}{phones.length > 1 ? ` ${i + 1}` : ''}</span>
                <span className="ml-auto"><StatusChip tone={tone}>{label}</StatusChip></span>
              </div>
              <div className="text-ink-muted mt-1">Registered {shortDate(d.created_at)} · last used {d.last_seen_at ? when(d.last_seen_at) : 'never'}</div>
              {d.status === 'REVOKED' && d.revocation_reason && <div className="text-ink-muted">“{d.revocation_reason}”</div>}
              {d.status === 'ACTIVE' && !self && <div className="flex justify-end mt-1"><Button size="sm" variant="ghost" onClick={() => { setRev(d); setReason(''); }}>Revoke</Button></div>}
            </div>
          );
        })}
      </div>
      {elsewhere > 0 && (
        <div className="mt-2 rounded-card border border-line p-3 text-[13px] flex items-start gap-2">
          <Smartphone size={16} className="text-ink-muted shrink-0 mt-0.5" />
          <div><span className="font-medium">{elsewhere} phone{elsewhere > 1 ? 's' : ''} registered in another Area</span>
            <div className="text-ink-muted">Managed there, or by the HQ System Administrator; its details are not shown here. To end {name}’s access in this Area, end the role above.</div></div>
        </div>
      )}
      <Dialog open={!!rev} title={`Revoke this phone of ${name}?`} onClose={() => setRev(null)}
        actions={<><Button variant="secondary" onClick={() => setRev(null)}>Cancel</Button><Button variant="destructive" disabled={!reason.trim()} loading={busy} onClick={go}>Revoke phone</Button></>}>
        <p className="text-[13px] text-ink-muted mb-3">Registered {shortDate(rev?.created_at)}, last used {rev?.last_seen_at ? when(rev.last_seen_at) : 'never'}. It stops signing in within 15 minutes. {name}’s roles and other phones are not affected. Recorded in the audit trail with your reason.</p>
        <Field label="Reason" required><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Registration lost on the handset; registered again" /></Field>
      </Dialog>
    </div>
  );
}

function PersonPanel({ p, onChanged }: { p: any; onChanged: () => void }) {
  const s = session.get()!;
  const self = p.id === s.person_id;
  const [assign, setAssign] = useState(false);
  const [edit, setEdit] = useState(false);
  return (
    <Card className="p-5">
      <div className="flex justify-between gap-3">
        <div>
          <div className="font-semibold text-lg">{p.name}</div>
          <div className="text-[13px] text-ink-muted tnum">{p.personnel_no || 'No Employee ID'} · {p.mobile}{p.email ? ` · ${p.email}` : ''}</div>
          <div className="text-[13px] text-ink-muted">{p.designation || 'No designation recorded'} · {p.resident_category === 'NON_NCL' ? 'Non-NCL' : 'NCL'}</div>
          <div className="text-xs text-ink-muted mt-1 inline-flex items-center gap-3">
            <span className="inline-flex items-center gap-1"><Smartphone size={13} />{p.devices} approved phone{p.devices === '1' || p.devices === 1 ? '' : 's'}{Number(p.phones_elsewhere) > 0 ? ` here · ${p.phones_elsewhere} in another Area` : ''}</span>
            <span className="inline-flex items-center gap-1"><KeyRound size={13} />{p.has_password ? 'Web password set' : 'No web password'}</span>
          </div>
        </div>
        {!self && <Button size="sm" variant="ghost" onClick={() => setEdit(true)}>Correct details</Button>}
      </div>
      {self && <div className="mt-3 text-[13px] rounded-card bg-tint p-3">This is you. Your own roles and record are changed by another administrator.</div>}

      <div className="label mt-5 mb-2">Roles</div>
      <div className="flex flex-col gap-2">
        {p.roles.length === 0 && <div className="text-[13px] text-ink-muted">No role yet.</div>}
        {p.roles.map((r: any) => <RoleRow key={r.id} r={r} self={self} onChanged={onChanged} />)}
      </div>
      <PersonPhones personId={p.id} name={p.name} self={self} elsewhere={Number(p.phones_elsewhere) || 0} />
      {p.is_employee && <PersonPasskeys personId={p.id} name={p.name} />}
      {!self && <Button className="mt-4" icon={<Plus size={18} />} onClick={() => setAssign(true)}>Assign a role</Button>}
      {assign && <AssignRole p={p} onClose={() => setAssign(false)} onDone={() => { setAssign(false); onChanged(); }} />}
      {edit && <EditPerson p={p} onClose={() => setEdit(false)} onDone={() => { setEdit(false); onChanged(); }} />}
    </Card>
  );
}

function RoleRow({ r, self, onChanged }: { r: any; self: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<null | 'edit' | 'revoke'>(null);
  const [f, setF] = useState({ valid_to: r.valid_to?.slice(0, 10) || '', designation: r.designation || '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (mode === 'revoke') await idApi(`/assignments/${r.id}/revoke`, { body: { reason: f.reason } });
      else await idApi(`/assignments/${r.id}`, { method: 'PUT', body: { valid_to: f.valid_to || null, designation: f.designation || null, reason: f.reason } });
      toast({ text: mode === 'revoke' ? 'Role ended' : 'Role changed' }); setMode(null); onChanged();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="border border-line rounded-input p-3">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-medium">{ROLE_LABEL[r.role]}{r.acting ? ' (acting)' : ''}{r.premises ? ` · ${r.premises}` : ''}</div>
          <div className="text-xs text-ink-muted">{areaFromScope(r.scope_path).name}{r.designation ? ` · ${r.designation}` : ''} · from {shortDate(r.valid_from)}{r.valid_to ? ` to ${shortDate(r.valid_to)}` : ''}</div>
        </div>
        {r.status === 'PENDING' ? <StatusChip tone="await">Pending check</StatusChip> : !self && !mode && (
          <div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setMode('edit')}>Change</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('revoke')}>End</Button></div>)}
      </div>
      {mode && (
        <div className="grid gap-3 mt-3">
          {mode === 'edit' && (
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Valid until"><input type="date" className={inputCls} value={f.valid_to} onChange={(e) => setF({ ...f, valid_to: e.target.value })} /></Field>
              <Field label="Designation"><input className={inputCls} value={f.designation} onChange={(e) => setF({ ...f, designation: e.target.value })} /></Field>
            </div>
          )}
          {mode === 'revoke' && r.role === 'CONTRACTOR_SUPERVISOR' && <OpenJobs actorId={r.id} />}
          <Field label="Reason — kept in the audit trail" required>
            <input className={inputCls} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder={mode === 'revoke' ? 'e.g. Transferred to Nigahi, order no. …' : 'e.g. Extension order no. …'} />
          </Field>
          {err && <ErrorState message={err} />}
          <div className="flex gap-2">
            <Button size="sm" variant={mode === 'revoke' ? 'destructive' : 'primary'} disabled={!f.reason.trim()} loading={busy} onClick={go}>{mode === 'revoke' ? 'End this role' : 'Save change'}</Button>
            <Button size="sm" variant="secondary" onClick={() => setMode(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AssignRole({ p, onClose, onDone }: { p: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const roles = useLoad(() => idApi<any[]>('/roles'));
  const [f, setF] = useState({ role: '', scope_path: '', premises_id: '', contract_id: '', designation: p.designation || '', acting: false, valid_from: '', valid_to: '', reason: '' });
  const [pq, setPq] = useState('');
  const occupant = OCCUPANT.includes(f.role);
  // The HQ portal administrator's own scope is all of NCL; a role below HQ is
  // held in one Area, so they choose it (the database refuses anything else).
  const wide = !session.get()!.scope_path.includes('.');
  const areas = useLoad(() => wide ? idApi<any[]>('/masters/areas') : Promise.resolve([]), [wide]);
  const needArea = wide && !occupant && !!f.role && (roles.data || []).some((r) => r.role === f.role && !r.hq);
  const contractor = ['CONTRACTOR', 'CONTRACTOR_SUPERVISOR'].includes(f.role);
  const prem = useLoad(() => occupant ? idApi<{ items: any[] }>(`/premises${pq ? `?q=${encodeURIComponent(pq)}` : ''}`) : Promise.resolve({ items: [] }), [occupant, pq]);
  const contracts = useLoad(() => contractor ? api<any[]>('/contracts') : Promise.resolve([]), [contractor]);
  const fit = (prem.data?.items || []).filter((x) => (f.role === 'RESIDENT') === (x.premises_type === 'QUARTER'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const ok = f.role && f.reason.trim() && (!occupant || f.premises_id) && (!contractor || f.contract_id) && (!needArea || f.scope_path);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      await idApi('/assignments', { body: { person_id: p.id, role: f.role, premises_id: f.premises_id || undefined,
        scope_path: needArea ? f.scope_path : undefined,
        contract_id: f.contract_id || undefined, designation: f.designation || undefined, acting: f.acting,
        valid_from: f.valid_from || undefined, valid_to: f.valid_to || undefined, reason: f.reason } });
      toast({ text: `${ROLE_LABEL[f.role]} assigned to ${p.name}` }); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const assignable = (roles.data || []).filter((r) => r.assignable);
  return (
    <Dialog open width={560} title={`Assign a role to ${p.name}`} onClose={onClose}
      actions={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!ok} loading={busy} onClick={go}>Assign role</Button></>}>
      <div className="grid gap-4">
        <div>
          <div className="text-[13px] font-medium mb-2">Role <span className="text-ink-muted font-normal">— only roles below your own rank are offered</span></div>
          <div className="flex flex-wrap gap-2">
            {roles.error && <ErrorState message={roles.error} />}
            {assignable.map((r) => <Chip key={r.role} selected={f.role === r.role} onClick={() => setF((x) => ({ ...x, role: r.role, premises_id: '', contract_id: '' }))}>{ROLE_LABEL[r.role]}</Chip>)}
          </div>
        </div>
        {needArea && (
          <Field label="Area" required help="The role is held in this Area only">
            <select className={inputCls} value={f.scope_path} onChange={(e) => setF((x) => ({ ...x, scope_path: e.target.value, contract_id: '' }))}>
              <option value="">Choose…</option>
              {(areas.data || []).map((a) => <option key={a.id} value={a.scope_path}>{a.name} ({a.ticket_code})</option>)}
            </select>
          </Field>
        )}
        {occupant && (
          <Field label={f.role === 'RESIDENT' ? 'Quarter' : 'Building'} required help="Search the premises register of your Area">
            <div className="grid gap-2">
              <input className={inputCls} value={pq} onChange={(e) => setPq(e.target.value)} placeholder="e.g. D-12" />
              <select className={inputCls} value={f.premises_id} onChange={(e) => set('premises_id', e.target.value)}>
                <option value="">Choose…</option>
                {fit.map((x) => <option key={x.id} value={x.id}>{x.identifier} — {x.colony}{x.quarter_type ? ` (type ${x.quarter_type})` : ''}</option>)}
              </select>
            </div>
          </Field>
        )}
        {contractor && (
          <Field label="Contract" required help="A contractor sees only this contract's jobs and record">
            <select className={inputCls} value={f.contract_id} onChange={(e) => set('contract_id', e.target.value)}>
              <option value="">Choose…</option>
              {(contracts.data || []).filter((c) => c.active && (!needArea || !c.scope_path || c.scope_path === f.scope_path || c.scope_path.startsWith(`${f.scope_path}.`))).map((c) => <option key={c.id} value={c.id}>{c.contractor_name} — {c.agreement_no}</option>)}
            </select>
          </Field>
        )}
        {!occupant && f.role && (
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Designation"><input className={inputCls} value={f.designation} onChange={(e) => set('designation', e.target.value)} /></Field>
            <label className="flex items-center gap-2 text-sm self-end h-11"><input type="checkbox" checked={f.acting} onChange={(e) => set('acting', e.target.checked)} />Acting (holding charge)</label>
          </div>
        )}
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="From"><input type="date" className={inputCls} value={f.valid_from} onChange={(e) => set('valid_from', e.target.value)} /></Field>
          <Field label="Until" help="Leave blank if open-ended"><input type="date" className={inputCls} value={f.valid_to} onChange={(e) => set('valid_to', e.target.value)} /></Field>
        </div>
        <Field label="Reason — kept in the audit trail" required><input className={inputCls} value={f.reason} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. Posting order no. …" /></Field>
        {err && <ErrorState message={err} />}
      </div>
    </Dialog>
  );
}

function AddPerson({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [f, setF] = useState({ name: '', personnel_no: '', mobile: '', designation: '', email: '', resident_category: 'NCL' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const go = async () => {
    setBusy(true); setErr(null);
    try { const r = await idApi<{ id: string }>('/persons', { body: f }); onDone(r.id); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Dialog open width={520} title="Add a person" onClose={onClose}
      actions={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.name || f.mobile.length !== 10 || (f.resident_category === 'NCL' ? !isEmpId(f.personnel_no) : !!f.personnel_no && !isEmpId(f.personnel_no))} onClick={go}>Add person</Button></>}>
      <div className="grid gap-4">
        <div className="flex gap-4 text-sm">
          {[['NCL', 'NCL employee'], ['NON_NCL', 'Non-NCL (contractor, occupant)']].map(([v, l]) => (
            <label key={v} className="inline-flex items-center gap-2"><input type="radio" checked={f.resident_category === v} onChange={() => set('resident_category', v)} />{l}</label>))}
        </div>
        <Field label="Name" required><input className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Employee ID" required={f.resident_category === 'NCL'} help={EMP_ID_HELP}><input className={inputCls + ' tnum'} inputMode="numeric" maxLength={8} value={f.personnel_no} onChange={(e) => set('personnel_no', toEmpId(e.target.value))} /></Field>
          <Field label="Mobile" required help="Their phone is registered and passwords reset with an OTP to this number">
            <input className={inputCls + ' tnum'} inputMode="numeric" maxLength={10} value={f.mobile} onChange={(e) => set('mobile', e.target.value.replace(/\D/g, ''))} /></Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Designation"><input className={inputCls} value={f.designation} onChange={(e) => set('designation', e.target.value)} /></Field>
          <Field label="Official email"><input className={inputCls} type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
        </div>
        {err && <ErrorState message={err} />}
      </div>
    </Dialog>
  );
}

function EditPerson({ p, onClose, onDone }: { p: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: p.name || '', personnel_no: p.personnel_no || '', mobile: p.mobile || '', designation: p.designation || '', email: p.email || '' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const changed = Object.fromEntries(Object.entries(f).filter(([k, v]) => (p[k] || '') !== v));
  const go = async () => {
    setBusy(true); setErr(null);
    try { await idApi(`/persons/${p.id}`, { method: 'PUT', body: { ...changed, reason } }); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Dialog open width={520} title={`Correct ${p.name}'s details`} onClose={onClose}
      actions={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!Object.keys(changed).length || !reason.trim()} onClick={go}>Save correction</Button></>}>
      <div className="grid gap-4">
        {(['name', 'personnel_no', 'mobile', 'designation', 'email'] as const).map((k) => (
          <Field key={k} label={{ name: 'Name', personnel_no: 'Employee ID', mobile: 'Mobile', designation: 'Designation', email: 'Official email' }[k]}>
            <input className={inputCls} value={f[k]} onChange={(e) => setF({ ...f, [k]: k === 'personnel_no' ? toEmpId(e.target.value) : e.target.value })} /></Field>
        ))}
        <Field label="Reason — kept in the audit trail" required><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {err && <ErrorState message={err} />}
      </div>
    </Dialog>
  );
}

const EVENT: Record<string, string> = {
  PERSON_CREATED: 'Person added', PERSON_CHANGED: 'Details corrected', ROLE_ASSIGNED: 'Role assigned',
  ROLE_CHANGED: 'Role changed', ROLE_REVOKED: 'Role ended', DEVICE_APPROVED: 'Phone approved',
  DEVICE_REJECTED: 'Registration rejected', DEVICE_REVOKED: 'Phone revoked', PREMISES_CREATED: 'Premises added'
};
function Audit() {
  const log = useLoad(() => idApi<any[]>('/audit'));
  if (log.error) return <ErrorState message={log.error} retry={log.reload} />;
  if (!log.data) return <Skeleton className="h-40" />;
  if (!log.data.length) return <Card><EmptyState title="Nothing recorded yet" /></Card>;
  return (
    <div className="bg-surface border border-line rounded-card overflow-auto">
      <table className="w-full text-[13px] min-w-[760px]">
        <thead className="bg-bg"><tr className="text-left">{['When', 'What', 'By', 'Reason', 'Detail'].map((h) => <th key={h} className="label px-4 py-3">{h}</th>)}</tr></thead>
        <tbody>{log.data.map((l, i) => (
          <tr key={i} className="border-t border-line align-top">
            <td className="px-4 py-2.5 text-ink-muted whitespace-nowrap">{when(l.occurred_at)}</td>
            <td className="px-4 py-2.5 font-medium">{EVENT[l.event_type] || l.event_type}</td>
            <td className="px-4 py-2.5">{l.actor_name || '—'}<div className="text-xs text-ink-muted">{ROLE_LABEL[l.actor_role] || l.actor_role}</div></td>
            <td className="px-4 py-2.5">{l.reason || '—'}</td>
            <td className="px-4 py-2.5 text-xs text-ink-muted max-w-[320px] break-words">{l.after_value?.role ? `${ROLE_LABEL[l.after_value.role] || l.after_value.role}` : ''}
              {l.after_value?.premises ? ` · ${l.after_value.premises}` : ''}{l.after_value?.name ? ` ${l.after_value.name}` : ''}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

/* Before a supervisor's role is ended, the jobs it still holds (user's
   finding, 2026-10-12: two complaints were left where nobody could start
   them). Ending is not refused; the jobs are listed so they get reassigned. */
function OpenJobs({ actorId }: { actorId: string }) {
  const jobs = useLoad(() => api<any[]>(`/actors/${actorId}/open-jobs`), [actorId]);
  if (jobs.error) return <ErrorState message={jobs.error} />;
  if (!jobs.data) return <Skeleton className="h-10" />;
  if (!jobs.data.length) return <div className="text-[13px] text-ink-muted">This supervisor holds no open jobs.</div>;
  return (
    <div className="rounded-input bg-bad-bg text-bad p-3 text-[13px]">
      <b>This supervisor still holds {jobs.data.length} open job{jobs.data.length > 1 ? 's' : ''}.</b> Once the role ends nobody can start or finish
      {jobs.data.length > 1 ? ' them' : ' it'} until reassigned from the work queue:
      <ul className="mt-1.5 list-disc pl-5">
        {jobs.data.map((j) => <li key={j.id} className="tnum">{j.ticket_no} · {j.identifier} · {j.sub_category} ({j.state.replace('_', ' ').toLowerCase()})</li>)}
      </ul>
    </div>
  );
}
