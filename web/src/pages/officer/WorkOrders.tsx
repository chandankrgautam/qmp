import { useRef, useState } from 'react';
import { CalendarPlus, Download, FilePlus2, FileText, Pencil, Plus, UserPlus } from 'lucide-react';
import { Button, Card, Dialog, EmptyState, ErrorState, Field, Segmented, Skeleton, StatusChip, inputCls, useToast } from '../../components/ui';
import { PageHeader } from '../../components/shell/Shells';
import { api, idApi, session } from '../../lib/api';
import { shortDate, when } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

/* Work orders (decision 2026-09-30, item 6). The Civil Incharge fills them
   in; the Staff Officer may too; everyone else in the Area reads. An Area
   may have several contractors. Every change asks for a reason, and the
   database — not this screen — writes the record of it. The completion
   date moves only by a numbered extension. */

const WRITERS = ['MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL'];
const KIND: Record<string, string> = { CONTRACT_COPY: 'Contract copy', EXTENSION_ORDER: 'Extension order', OTHER: 'Other' };
const EVENT: Record<string, string> = {
  CONTRACT_AWARDED: 'Work order entered', CONTRACT_CHANGED: 'Details changed', CONTRACT_EXTENDED: 'Completion date extended',
  CONTRACT_SUPERVISOR_NAMED: 'Supervisor named', CONTRACT_DOCUMENT_ATTACHED: 'Document attached', CONTRACT_HANDOVER: 'Handed over'
};
const FIELD: Record<string, string> = {
  contractor_name: 'Firm', firm_address: 'Firm address', contract_no: 'Contract / LOA no.', agreement_no: 'Agreement no.',
  work_name: 'Name of work', awarded_on: 'Awarded on', period_years: 'Period (years)', site_handover_on: 'Site handed over on',
  starts_on: 'Starts on', expires_on: 'Completion date', remarks: 'Remarks'
};

function termTone(c: any) {
  if (!c.active) return { tone: 'neutral' as const, text: c.handover_cutoff_at ? 'Handed over' : 'Ended' };
  const d = Number(c.days_remaining);
  if (d < 0) return { tone: 'bad' as const, text: 'Past completion date' };
  if (d <= 30) return { tone: 'risk' as const, text: `${d} days left` };
  return { tone: 'ok' as const, text: `${d} days left` };
}

export default function WorkOrders() {
  const s = session.get()!;
  const writer = WRITERS.includes(s.role);
  const list = useLoad(() => api<any[]>('/contracts'));
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const pick = open || list.data?.[0]?.id || null;
  return (
    <>
      <PageHeader title="Work orders" sub={writer ? 'The contracts in your Area. You fill these in; every change asks for a reason and is kept.' : 'The contracts in your scope, with their term, extensions and documents.'}
        action={writer ? <Button icon={<Plus size={18} />} onClick={() => setAdding(true)}>New work order</Button> : undefined} />
      {list.error && <ErrorState message={list.error} retry={list.reload} />}
      <div className="grid lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)] gap-4 items-start">
        <div className="flex flex-col gap-2.5">
          {!list.data && !list.error && [0, 1].map((i) => <Skeleton key={i} className="h-28" />)}
          {list.data?.length === 0 && <Card><EmptyState title="No work orders yet" body={writer ? 'Enter the first one with New work order.' : undefined} /></Card>}
          {list.data?.map((c) => {
            const t = termTone(c);
            return (
              <Card key={c.id} onClick={() => setOpen(c.id)} className={'p-4 ' + (pick === c.id ? 'shadow-[inset_3px_0_0_var(--primary)]' : '')}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">{c.contractor_name}</div>
                    <div className="text-xs text-ink-muted tnum truncate">{c.contract_no || '—'} · {c.agreement_no}</div>
                  </div>
                  <StatusChip tone={t.tone}>{t.text}</StatusChip>
                </div>
                {c.work_name && <div className="text-[13px] mt-1.5 line-clamp-2">{c.work_name}</div>}
                <div className="text-xs text-ink-muted mt-2 tnum">
                  {shortDate(c.starts_on)} → {shortDate(c.expires_on)}
                  {c.original_expires_on && c.original_expires_on !== c.expires_on && <span className="text-risk"> · extended (awarded to {shortDate(c.original_expires_on)})</span>}
                  {' · '}{c.open_tickets} open · {c.active_supervisors} supervisor{Number(c.active_supervisors) === 1 ? '' : 's'}
                </div>
              </Card>
            );
          })}
        </div>
        {pick ? <Detail key={pick} id={pick} writer={writer} onChanged={list.reload} /> : null}
      </div>
      {adding && <EditOrder onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); list.reload(); setOpen(id); }} />}
    </>
  );
}

function Detail({ id, writer, onChanged }: { id: string; writer: boolean; onChanged: () => void }) {
  const c = useLoad(() => api<any>(`/contracts/${id}`), [id]);
  const [tab, setTab] = useState<'order' | 'history'>('order');
  const [dlg, setDlg] = useState<null | 'edit' | 'extend' | 'supervisor'>(null);
  const reload = () => { c.reload(); onChanged(); };
  if (c.error) return <ErrorState message={c.error} retry={c.reload} />;
  if (!c.data) return <Skeleton className="h-96" />;
  const w = c.data;
  const open = writer && w.active;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-lg">{w.contractor_name}</div>
          <div className="text-[13px] text-ink-muted">{w.firm_address || 'No address recorded'}</div>
        </div>
        <Segmented value={tab} onChange={setTab} options={[{ value: 'order', label: 'Work order' }, { value: 'history', label: 'History' }]} />
      </div>
      {tab === 'history' ? <History id={id} /> : (<>
        <Section title="Details" action={open && <Button size="sm" variant="ghost" icon={<Pencil size={16} />} onClick={() => setDlg('edit')}>Correct details</Button>}>
          <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
            {['contract_no', 'agreement_no', 'work_name', 'awarded_on', 'site_handover_on', 'starts_on', 'period_years', 'remarks'].map((k) => (
              <div key={k} className={k === 'work_name' || k === 'remarks' ? 'sm:col-span-2' : ''}>
                <dt className="text-xs text-ink-muted">{FIELD[k]}</dt>
                <dd className="tnum">{k.endsWith('_on') ? shortDate(w[k]) : (w[k] ?? '—')}</dd>
              </div>))}
          </dl>
        </Section>

        <Section title="Term and extensions" action={open && <Button size="sm" variant="ghost" icon={<CalendarPlus size={16} />} onClick={() => setDlg('extend')}>Record extension</Button>}>
          <div className="grid sm:grid-cols-3 gap-3 text-[13px]">
            <Fact label="Completion as awarded" value={shortDate(w.original_expires_on)} />
            <Fact label="Completion in force" value={shortDate(w.expires_on)} strong />
            <Fact label="Status" value={termTone(w).text} />
          </div>
          {w.extensions.length > 0 && (
            <ol className="mt-3 flex flex-col gap-2">
              {w.extensions.map((e: any) => (
                <li key={e.id} className="border border-line rounded-input p-3 text-[13px]">
                  <div className="font-medium">Extension {e.seq}: {shortDate(e.previous_expires_on)} → {shortDate(e.extended_to)}</div>
                  <div className="text-xs text-ink-muted">{e.order_no || 'No order no.'}{e.granted_on ? ` dated ${shortDate(e.granted_on)}` : ''} · recorded by {e.recorded_by_name || '—'} {when(e.recorded_at)}</div>
                  <div className="mt-1">{e.reason}</div>
                </li>))}
            </ol>)}
        </Section>

        <Section title="Supervisors" action={open && <Button size="sm" variant="ghost" icon={<UserPlus size={16} />} onClick={() => setDlg('supervisor')}>Name a supervisor</Button>}>
          {w.supervisors.length === 0 ? <div className="text-[13px] text-ink-muted">None named. Work given to a supervisor counts against the contract they are named on.</div> : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {w.supervisors.map((p: any) => (
                <li key={p.actor_id} className="flex items-center gap-2"><span className="flex-1">{p.person_name}</span>
                  <span className="text-xs text-ink-muted">{p.role === 'CONTRACTOR' ? 'Firm' : 'Supervisor'}</span>
                  {p.status !== 'ACTIVE' && <StatusChip tone="neutral">Ended</StatusChip>}</li>))}
            </ul>)}
        </Section>

        <Section title="Documents" action={open && <Upload id={id} onDone={reload} />}>
          {w.documents.length === 0 ? <div className="text-[13px] text-ink-muted">No contract copy attached yet.</div> : (
            <ul className="flex flex-col gap-2">
              {w.documents.map((d: any) => (
                <li key={d.id} className="flex items-center gap-3 border border-line rounded-input p-2.5 text-[13px]">
                  <FileText size={18} className="text-primary shrink-0" />
                  <div className="flex-1 min-w-0"><div className="font-medium truncate">{d.file_name}</div>
                    <div className="text-xs text-ink-muted">{KIND[d.kind]} · {Math.max(1, Math.round(d.size_bytes / 1024))} KB · {d.uploaded_by_name || '—'} {when(d.uploaded_at)}</div>
                    <div className="text-[11px] text-ink-muted font-mono truncate" title="SHA-256 fingerprint, checked on every download">{d.content_hash}</div></div>
                  <Button size="sm" variant="secondary" icon={<Download size={16} />} onClick={() => openDoc(id, d.id)}>Open</Button>
                </li>))}
            </ul>)}
        </Section>
      </>)}
      {dlg === 'edit' && <EditOrder current={w} onClose={() => setDlg(null)} onDone={() => { setDlg(null); reload(); }} />}
      {dlg === 'extend' && <Extend w={w} onClose={() => setDlg(null)} onDone={() => { setDlg(null); reload(); }} />}
      {dlg === 'supervisor' && <NameSupervisor w={w} onClose={() => setDlg(null)} onDone={() => { setDlg(null); reload(); }} />}
    </Card>
  );
}

const Section = ({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) => (
  <section className="mt-5 pt-4 border-t border-line">
    <div className="flex items-center justify-between gap-2 mb-2"><div className="label">{title}</div>{action}</div>
    {children}
  </section>
);
const Fact = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <div className="rounded-input bg-bg p-3"><div className="text-xs text-ink-muted">{label}</div><div className={'tnum ' + (strong ? 'font-semibold text-base' : '')}>{value}</div></div>
);

async function openDoc(id: string, doc: string) {
  const s = session.get();
  const r = await fetch(`/maintenance/v1/contracts/${id}/documents/${doc}`, { headers: { authorization: `Bearer ${s?.token}` } });
  if (!r.ok) { alert((await r.json().catch(() => ({}))).detail || 'The document could not be opened'); return; }
  const url = URL.createObjectURL(await r.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function Upload({ id, onDone }: { id: string; onDone: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState('CONTRACT_COPY');
  const [busy, setBusy] = useState(false);
  const send = async (f: File) => {
    setBusy(true);
    try {
      const s = session.get();
      const r = await fetch(`/maintenance/v1/contracts/${id}/documents?file_name=${encodeURIComponent(f.name)}&kind=${kind}`,
        { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream', authorization: `Bearer ${s?.token}` }, body: f });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.detail || 'Not attached');
      toast({ text: `${f.name} attached` }); onDone();
    } catch (e: any) { toast({ text: e.message, tone: 'bad' }); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return (
    <div className="flex items-center gap-2">
      <select className={inputCls + ' h-9 w-auto text-[13px]'} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind of document">
        {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <input ref={input} type="file" accept="application/pdf,image/jpeg" hidden onChange={(e) => e.target.files?.[0] && send(e.target.files[0])} />
      <Button size="sm" variant="ghost" icon={<FilePlus2 size={16} />} loading={busy} onClick={() => input.current?.click()}>Attach</Button>
    </div>
  );
}

const Reason = ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
  <Field label="Reason — kept in the record" required>
    <input className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || 'e.g. Letter no. … dated …'} />
  </Field>
);

function EditOrder({ current, onClose, onDone }: { current?: any; onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const keys = ['contractor_name', 'firm_address', 'contract_no', 'agreement_no', 'work_name', 'awarded_on', 'site_handover_on', 'starts_on', ...(current ? [] : ['expires_on']), 'period_years', 'remarks'];
  const init = Object.fromEntries(keys.map((k) => [k, current?.[k] ?? '']));
  const [f, setF] = useState<Record<string, any>>(init);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const changed = Object.fromEntries(Object.entries(f).filter(([k, v]) => String(init[k] ?? '') !== String(v ?? '')));
  const ok = current ? Object.keys(changed).length > 0 && reason.trim() : f.contractor_name && f.agreement_no && f.starts_on && f.expires_on;
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const body = Object.fromEntries(Object.entries(current ? changed : f).map(([k, v]) => [k, v === '' ? null : k === 'period_years' && v ? Number(v) : v]));
      const r = current
        ? await api(`/contracts/${current.id}`, { method: 'PUT', body: { ...body, reason } })
        : await api('/contracts', { body: { ...body, reason: reason || undefined } });
      toast({ text: current ? 'Work order corrected' : 'Work order entered' }); onDone(r.id);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const input = (k: string, type = 'text') => (
    <Field key={k} label={FIELD[k]} required={['contractor_name', 'agreement_no', 'starts_on', 'expires_on'].includes(k)}
      help={k === 'expires_on' ? 'As awarded. Later changes are recorded as extensions.' : undefined}>
      {k === 'period_years'
        ? <select className={inputCls} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })}><option value="">—</option><option value="1">1</option><option value="2">2</option></select>
        : <input type={type} className={inputCls} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}
    </Field>
  );
  return (
    <Dialog open width={640} title={current ? 'Correct the work order' : 'New work order'} onClose={onClose}
      actions={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!ok} loading={busy} onClick={go}>{current ? 'Save correction' : 'Enter work order'}</Button></>}>
      <div className="grid gap-4">
        <div className="grid sm:grid-cols-2 gap-3">{input('contractor_name')}{input('firm_address')}</div>
        <div className="grid sm:grid-cols-2 gap-3">{input('contract_no')}{input('agreement_no')}</div>
        {input('work_name')}
        <div className="grid sm:grid-cols-3 gap-3">{input('awarded_on', 'date')}{input('site_handover_on', 'date')}{input('starts_on', 'date')}</div>
        <div className="grid sm:grid-cols-3 gap-3">{!current && input('expires_on', 'date')}{input('period_years')}</div>
        {input('remarks')}
        {current && <Reason value={reason} onChange={setReason} />}
        {err && <ErrorState message={err} />}
      </div>
    </Dialog>
  );
}

function Extend({ w, onClose, onDone }: { w: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ extended_to: '', order_no: '', granted_on: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const e = await api(`/contracts/${w.id}/extensions`, { body: { ...f, order_no: f.order_no || undefined, granted_on: f.granted_on || undefined } });
      toast({ text: `Extension ${e.seq} recorded` }); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Dialog open width={520} title={`Extension ${w.extensions.length + 1}`} onClose={onClose}
      actions={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!f.extended_to || !f.reason.trim()} loading={busy} onClick={go}>Record extension</Button></>}>
      <div className="grid gap-4">
        <p className="text-[13px] text-ink-muted">Completion date in force: <b className="tnum text-ink">{shortDate(w.expires_on)}</b>. An extension cannot be changed once recorded; attach the order under Documents.</p>
        <Field label="Extended to" required><input type="date" className={inputCls} min={w.expires_on} value={f.extended_to} onChange={(e) => setF({ ...f, extended_to: e.target.value })} /></Field>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Order no."><input className={inputCls} value={f.order_no} onChange={(e) => setF({ ...f, order_no: e.target.value })} /></Field>
          <Field label="Order dated"><input type="date" className={inputCls} value={f.granted_on} onChange={(e) => setF({ ...f, granted_on: e.target.value })} /></Field>
        </div>
        <Reason value={f.reason} onChange={(v) => setF({ ...f, reason: v })} placeholder="Why the term is extended" />
        {err && <ErrorState message={err} />}
      </div>
    </Dialog>
  );
}

/* The Incharge names an existing supervisor on this work order, or
   appoints a new one directly (decision 2026-09-30). The new person then
   registers their phone with that mobile, and the Incharge approves it. */
function NameSupervisor({ w, onClose, onDone }: { w: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const canAppoint = session.get()?.role === 'MAINTENANCE_INCHARGE';
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const sups = useLoad(() => api<any[]>('/devices/assignable'));
  const [pick, setPick] = useState('');
  const [p, setP] = useState({ name: '', mobile: '', designation: 'Site supervisor' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = reason.trim() && (mode === 'existing' ? !!pick : p.name.trim() && /^[6-9][0-9]{9}$/.test(p.mobile));
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (mode === 'existing') await api(`/contracts/${w.id}/supervisors`, { body: { actor_id: pick, reason } });
      else await idApi('/supervisors', { body: { ...p, contract_id: w.id, reason } });
      toast({ text: mode === 'existing' ? 'Supervisor named on the work order' : `${p.name} appointed. They register their phone with ${p.mobile}; approve it under Registrations.` });
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Dialog open width={520} title={mode === 'existing' ? 'Name a supervisor' : 'Appoint a new supervisor'} onClose={onClose}
      actions={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!ok} loading={busy} onClick={go}>{mode === 'existing' ? 'Name supervisor' : 'Appoint supervisor'}</Button></>}>
      <div className="grid gap-4">
        {canAppoint && <Segmented className="w-full grid grid-cols-2" value={mode} onChange={(v) => { setMode(v); setErr(null); }}
          options={[{ value: 'existing', label: 'Existing supervisor' }, { value: 'new', label: 'New supervisor' }]} />}
        {mode === 'new' ? (<>
          <p className="text-[13px] text-ink-muted">Appointed on <b>{w.contractor_name}</b>'s work order. They then register their phone with this mobile number, and you approve it under Registrations.</p>
          <Field label="Name" required><input className={inputCls} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Mobile" required><input className={inputCls + ' tnum'} inputMode="numeric" maxLength={10} value={p.mobile} onChange={(e) => setP({ ...p, mobile: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label="Designation"><input className={inputCls} value={p.designation} onChange={(e) => setP({ ...p, designation: e.target.value })} /></Field>
          </div>
        </>) : (<>
        <p className="text-[13px] text-ink-muted">Contractor supervisors of your Area.{canAppoint ? ' Someone not listed can be appointed under New supervisor.' : ''}</p>
        <div className="flex flex-col gap-2">
          {sups.error && <ErrorState message={sups.error} />}
          {sups.data?.length === 0 && <EmptyState title="No contractor supervisors in your Area yet" />}
          {sups.data?.map((c) => (
            <label key={c.actor_id} className={'flex items-center gap-3 p-3 rounded-input border cursor-pointer ' + (pick === c.actor_id ? 'border-primary bg-tint' : 'border-line')}>
              <input type="radio" name="s" checked={pick === c.actor_id} onChange={() => setPick(c.actor_id)} />
              <span className="flex-1 min-w-0"><span className="font-medium">{c.person_name}</span>
                <span className="block text-xs text-ink-muted truncate">{c.contract_id === w.id ? 'Already on this work order' : c.contractor_name ? `Now on: ${c.contractor_name}` : 'On no work order'}</span></span>
            </label>))}
        </div>
        </>)}
        <Reason value={reason} onChange={setReason} placeholder="e.g. Deployed by the firm, letter dated …" />
        {err && <ErrorState message={err} />}
      </div>
    </Dialog>
  );
}

function History({ id }: { id: string }) {
  const h = useLoad(() => api<any[]>(`/contracts/${id}/history`), [id]);
  if (h.error) return <div className="mt-4"><ErrorState message={h.error} /></div>;
  if (!h.data) return <Skeleton className="h-40 mt-4" />;
  if (!h.data.length) return <div className="mt-4 text-[13px] text-ink-muted">Nothing recorded, or not visible to your role.</div>;
  return (
    <ol className="mt-4 flex flex-col gap-2">
      {h.data.map((l, i) => {
        const keys = Object.keys(l.after_value || {}).filter((k) => FIELD[k]);
        return (
          <li key={i} className="border border-line rounded-input p-3 text-[13px]">
            <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{EVENT[l.event_type] || l.event_type}</span>
              <span className="text-xs text-ink-muted">{l.actor_name || l.actor_role || 'System'} · {when(l.occurred_at)}</span></div>
            {l.event_type === 'CONTRACT_CHANGED' || l.event_type === 'CONTRACT_EXTENDED' ? keys.map((k) => (
              <div key={k} className="text-xs mt-1"><span className="text-ink-muted">{FIELD[k]}:</span> <s className="text-ink-muted">{fmt(l.before_value?.[k])}</s> → <b>{fmt(l.after_value?.[k])}</b></div>
            )) : l.after_value?.file_name ? <div className="text-xs mt-1">{l.after_value.file_name}</div>
              : l.after_value?.supervisor ? <div className="text-xs mt-1">{l.after_value.supervisor}</div> : null}
            {l.reason && <div className="mt-1">“{l.reason}”</div>}
          </li>);
      })}
    </ol>
  );
}
const fmt = (v: any) => v == null || v === '' ? '—' : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? shortDate(v) : String(v);
