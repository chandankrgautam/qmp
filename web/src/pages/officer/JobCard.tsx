import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ClipboardList, History as HistoryIcon, Pencil, Plus, Printer, Search as SearchIcon, Undo2 } from 'lucide-react';
import { BrandMark, Button, Card, Chip, EmptyState, ErrorState, SectionLabel, Skeleton, StatusChip, inputCls, useToast } from '../../components/ui';
import { PageHeader } from '../../components/shell/Shells';
import { ApiError, api, session } from '../../lib/api';
import { STATE } from '../../lib/domain';
import { absTime, shortDate, when } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { JobPhotos } from '../../components/Photographs';

/* The job card (decision 2026-09-30, item 5). Prepared by the database
   when the complaint is first assigned; read by the Overseer and everyone
   above; changed only by the Overseer or the Civil Incharge. Filling a
   blank needs no reason, correcting what is written does, and items are
   withdrawn, never deleted. Since 2026-10-16 the supervisor of the job reads
   it in full and changes it too, and the card follows the job's measurement
   sheet up the chain until the MB is approved, then only the Staff Officer
   corrects it, with a reason. The server says whether the caller may change
   it now (`editable`); the database enforces all of it. */

const EDITORS = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'CONTRACTOR_SUPERVISOR', 'STAFF_OFFICER_CIVIL'];
const UNITS = ['No.', 'Set', 'Rm', 'Sqm', 'Cum', 'Kg', 'Litre', 'Job'];
const EVENT: Record<string, string> = {
  JOB_CARD_PREPARED: 'Job card prepared', JOB_CARD_CHANGED: 'Card changed', JOB_CARD_ITEM_ADDED: 'Item added',
  JOB_CARD_ITEM_CHANGED: 'Item changed', JOB_CARD_ITEM_WITHDRAWN: 'Item withdrawn'
};
const LABEL: Record<string, string> = { scope_of_work: 'Scope of work', site_notes: 'Site notes' };
const qty = (v: any) => (v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 }));

function useCard(id: string, state?: string, refresh = 0) {
  // reloaded when the complaint moves, so a new round shows at once, and on
  // the panel's refresh: the occupant's answer changes no state but does
  // change the card's status (user's finding, 2026-10-10)
  return useLoad(() => api<any>(`/tickets/${id}/job-card`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }), [id, state, refresh]);
}

/* ------------------------------------------------------------ the life of the job */
/* Every round from the first (user's finding, 2026-10-07): who had it, the
   workmen, the materials, the claim, the inspection, the closure, and the
   complainant's answers. The job ends only when the complainant is
   satisfied. Read from the append-only history; nothing here is editable. */
const LIFE: Record<string, { label: string; tone: 'ok' | 'risk' | 'bad' | 'info' | 'neutral' | 'reopen' | 'await' }> = {
  IN_HAND: { label: 'Work in hand', tone: 'info' },
  AWAITING_CONFIRMATION: { label: 'Awaiting the complainant', tone: 'await' },
  DISPUTED: { label: 'Complainant not satisfied', tone: 'reopen' },
  SATISFIED: { label: 'Complainant satisfied — job complete', tone: 'ok' },
  CLOSED_NO_DISPUTE: { label: 'Closed — no dispute within the reopen window', tone: 'ok' },
  CLOSED_ON_INSPECTION: { label: 'Closed on inspection (no occupant)', tone: 'ok' },
  REJECTED: { label: 'Rejected', tone: 'neutral' },
  REFERRED: { label: 'Referred for special repair', tone: 'neutral' }
};
const CAUSE: Record<string, string> = { ASSIGNED: 'Assigned', SENT_BACK: 'Sent back by the Overseer', REOPENED: 'Reopened by the complainant' };
const dt = (v?: string | null) => (v ? when(v) : '—');

export function Lifecycle({ life, print = false }: { life: any; print?: boolean }) {
  if (!life?.rounds?.length) return null;
  // on paper a relative time ("2 h ago") means nothing: absolute only
  const D = (v?: string | null) => (!v ? '—' : print ? absTime(v) : dt(v));
  const st = LIFE[life.status] || { label: life.status, tone: 'info' as const };
  return (
    <div className={print ? 'mt-4' : 'mt-4'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={print ? 'font-semibold' : 'text-xs text-ink-muted'}>Life of the job — {life.rounds.length} round{life.rounds.length > 1 ? 's' : ''}</div>
        {print ? <span className="font-semibold">{st.label}</span> : <StatusChip tone={st.tone}>{st.label}</StatusChip>}
      </div>
      <ol className="mt-2 flex flex-col gap-2">
        {life.rounds.map((r: any) => (
          <li key={r.n} className={'border border-line rounded-input p-3 text-[13px] ' + (print ? 'break-inside-avoid' : 'bg-surface')}>
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-semibold">Round {r.n} · {CAUSE[r.cause?.type] || r.cause?.type}</span>
              <span className="text-xs text-ink-muted">{D(r.began_at)}</span>
            </div>
            {r.cause?.reason && <div className="text-xs mt-0.5">{r.cause.type === 'REOPENED' ? 'Complainant' : 'Overseer'}: “{r.cause.reason}”</div>}
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-2 gap-y-0.5 mt-2">
              <dt className="text-ink-muted">Supervisor</dt><dd>{r.supervisor_name || '—'}</dd>
              <dt className="text-ink-muted">Work started</dt><dd className="tnum">{D(r.started_at)}</dd>
              <dt className="text-ink-muted">Workmen</dt><dd>{r.workmen || '—'}</dd>
              <dt className="text-ink-muted">Materials</dt>
              <dd>{r.materials.length === 0 ? 'None recorded' : r.materials.map((m: any, i: number) => (
                <div key={i} className={m.withdrawn ? 'line-through text-ink-muted' : ''}>
                  {m.name_en}: {m.qty_claimed} {m.unit} claimed{m.withdrawn ? ` (withdrawn: ${m.withdrawal_reason})` : m.qty_verified == null ? ', not verified' : `, ${m.qty_verified} verified`}
                </div>))}</dd>
              {r.photos && <><dt className="text-ink-muted">Photographs</dt><dd>Before {r.photos.before ?? 0} · After {r.photos.after ?? 0}</dd></>}
              <dt className="text-ink-muted">Completion claimed</dt><dd className="tnum">{D(r.claimed_at)}</dd>
              <dt className="text-ink-muted">Inspection</dt>
              <dd>{!r.inspection ? '—' : r.inspection.result === 'ACCEPTED'
                ? <>Accepted · {r.inspection.by} · {D(r.inspection.at)}</>
                : <span className="text-bad">Sent back · {r.inspection.by} · {D(r.inspection.at)}{r.inspection.remark ? ` — “${r.inspection.remark}”` : ''}</span>}</dd>
              {r.closed_at && <><dt className="text-ink-muted">Closed</dt><dd className="tnum">{D(r.closed_at)}</dd></>}
              {r.feedback.map((f: any, i: number) => (
                <Fragment key={i}><dt className="text-ink-muted">Complainant</dt>
                  <dd className={f.confirmed === false ? 'text-reopen' : f.confirmed ? 'text-ok' : ''}>
                    {f.confirmed === true ? 'Satisfied' : f.confirmed === false ? 'Not satisfied' : 'No response'}
                    {f.rating ? ` · ${f.rating}/5` : ''}{f.comment ? ` — “${f.comment}”` : ''} · {D(f.at)}</dd></Fragment>))}
              {r.reopened && <><dt className="text-ink-muted">Reopened</dt><dd className="text-reopen">{D(r.reopened.at)} — “{r.reopened.reason}”</dd></>}
            </dl>
          </li>))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------ in the complaint panel */
export function JobCardSection({ ticketId, state, refresh = 0, media }: { ticketId: string; state: string; refresh?: number; media?: any[] }) {
  const s = session.get()!;
  const card = useCard(ticketId, state, refresh);
  const [hist, setHist] = useState(false);
  const editor = EDITORS.includes(s.role) && !!card.data?.editable;
  if (card.error) return <ErrorState message={card.error} retry={card.reload} />;
  if (card.data === null) {
    return ['RAISED', 'VERIFIED'].includes(state)
      ? <><SectionLabel className="mt-6 mb-3">Job card</SectionLabel><Card className="p-4 text-[13px] text-ink-muted">Prepared automatically when the complaint is assigned.</Card></>
      : null;
  }
  if (!card.data) return <Skeleton className="h-32 mt-6" />;
  const c = card.data;
  return (
    <>
      <div className="flex items-center justify-between mt-6 mb-3">
        <SectionLabel>Job card</SectionLabel>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" icon={<HistoryIcon size={16} />} onClick={() => setHist(!hist)}>{hist ? 'Hide changes' : 'Changes'}</Button>
          {s.role !== 'CONTRACTOR_SUPERVISOR' && <Link to={`/w/job-cards/${ticketId}`} target="_blank"><Button size="sm" variant="ghost" icon={<Printer size={16} />}>Print</Button></Link>}
        </div>
      </div>
      <Card className="p-4">
        <div className="flex justify-between gap-2 text-[13px]">
          <span className="font-semibold tnum">{c.jc_no}</span>
          <span className="text-xs text-ink-muted">Prepared {shortDate(c.prepared_at)}{!c.editable && (c.stage === 'APPROVED' ? ' · MB approved: the Staff Officer alone corrects it' : ' · with another step of the chain')}</span>
        </div>
        <TextField ticketId={ticketId} field="scope_of_work" value={c.scope_of_work} editor={editor} always={!!c.reason_always} onDone={card.reload}
          placeholder="What is to be done — as assessed on site" />
        <TextField ticketId={ticketId} field="site_notes" value={c.site_notes} editor={editor} always={!!c.reason_always} onDone={card.reload}
          placeholder="Access, occupant availability, anything the contractor must know" />
        <Items ticketId={ticketId} items={c.items} editor={editor} onDone={card.reload} />
        {c.updated_at && <div className="text-xs text-ink-muted mt-3">Last changed by {c.updated_by_name || '—'} {when(c.updated_at)}</div>}
        <Lifecycle life={c.lifecycle} />
        <JobPhotos media={media} />
      </Card>
      {hist && <JobCardHistory ticketId={ticketId} />}
    </>
  );
}

function TextField({ ticketId, field, value, editor, always, onDone, placeholder }:
  { ticketId: string; field: 'scope_of_work' | 'site_notes'; value: string | null; editor: boolean; always?: boolean; onDone: () => void; placeholder: string }) {
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(value || '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // after the MB approval every change is a correction, with a reason
  const correcting = !!value?.trim() || !!always;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api(`/tickets/${ticketId}/job-card`, { method: 'PUT', body: { [field]: text, reason: reason || undefined } });
      toast({ text: `${LABEL[field]} saved` }); setEdit(false); setReason(''); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between"><div className="text-xs text-ink-muted">{LABEL[field]}</div>
        {editor && !edit && <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => { setText(value || ''); setEdit(true); }}>{correcting ? 'Correct' : 'Fill in'}</Button>}</div>
      {!edit ? <div className="text-sm whitespace-pre-wrap">{value || <span className="text-ink-muted">Not filled in yet</span>}</div> : (
        <div className="grid gap-2 mt-1">
          <textarea className={inputCls + ' h-auto min-h-[76px] py-2'} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} />
          {correcting && <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for the correction — kept in the record" />}
          {err && <ErrorState message={err} />}
          <div className="flex gap-2"><Button size="sm" loading={busy} disabled={text === (value || '') || (correcting && !reason.trim())} onClick={save}>Save</Button>
            <Button size="sm" variant="secondary" onClick={() => setEdit(false)}>Cancel</Button></div>
        </div>
      )}
    </div>
  );
}

function Items({ ticketId, items, editor, onDone }: { ticketId: string; items: any[]; editor: boolean; onDone: () => void }) {
  const toast = useToast();
  const [row, setRow] = useState<null | { id?: string; mode: 'add' | 'edit' | 'withdraw' }>(null);
  const [f, setF] = useState({ description: '', unit: 'No.', qty_estimated: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = (mode: 'add' | 'edit' | 'withdraw', it?: any) => {
    setErr(null); setRow({ id: it?.id, mode });
    setF({ description: it?.description || '', unit: it?.unit || 'No.', qty_estimated: String(it?.qty_estimated ?? ''), reason: '' });
  };
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const base = `/tickets/${ticketId}/job-card/items`;
      if (row?.mode === 'add') await api(base, { body: { description: f.description, unit: f.unit, qty_estimated: f.qty_estimated === '' ? null : Number(f.qty_estimated) } });
      else if (row?.mode === 'edit') await api(`${base}/${row.id}`, { method: 'PUT', body: { description: f.description, unit: f.unit, qty_estimated: f.qty_estimated === '' ? null : Number(f.qty_estimated), reason: f.reason } });
      else await api(`${base}/${row!.id}/withdraw`, { body: { reason: f.reason } });
      toast({ text: row?.mode === 'add' ? 'Item added' : row?.mode === 'edit' ? 'Item changed' : 'Item withdrawn' }); setRow(null); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const form = (
    <div className="grid gap-2 border border-line rounded-input p-3 mt-2">
      {row?.mode !== 'withdraw' && (<>
        <input className={inputCls} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Item of work, e.g. Replace pillar cock, 15 mm" />
        <div className="grid grid-cols-2 gap-2">
          <input className={inputCls} list="jc-units" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="Unit" aria-label="Unit" />
          <input className={inputCls + ' tnum'} inputMode="decimal" value={f.qty_estimated} onChange={(e) => setF({ ...f, qty_estimated: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="Estimated quantity" aria-label="Estimated quantity" />
        </div>
      </>)}
      {row?.mode !== 'add' && <input className={inputCls} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder={row?.mode === 'withdraw' ? 'Why is it withdrawn? — kept in the record' : 'Reason for the change — kept in the record'} />}
      {err && <ErrorState message={err} />}
      <div className="flex gap-2">
        <Button size="sm" variant={row?.mode === 'withdraw' ? 'destructive' : 'primary'} loading={busy}
          disabled={row?.mode === 'withdraw' ? !f.reason.trim() : !f.description.trim() || !f.unit.trim() || (row?.mode === 'edit' && !f.reason.trim())}
          onClick={save}>{row?.mode === 'add' ? 'Add item' : row?.mode === 'edit' ? 'Save change' : 'Withdraw item'}</Button>
        <Button size="sm" variant="secondary" onClick={() => setRow(null)}>Cancel</Button>
      </div>
    </div>
  );
  return (
    <div className="mt-4">
      <datalist id="jc-units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
      <div className="flex items-center justify-between"><div className="text-xs text-ink-muted">Work items (estimated quantities)</div>
        {editor && !row && <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => open('add')}>Add item</Button>}</div>
      {items.length === 0 && !row && <div className="text-sm text-ink-muted">None yet</div>}
      <ol className="flex flex-col gap-1.5 mt-1">
        {items.map((it) => (
          <li key={it.id} className={'text-[13px] ' + (it.withdrawn_at ? 'text-ink-muted' : '')}>
            <div className="flex items-start gap-2">
              <span className="tnum w-6 shrink-0">{it.seq}.</span>
              <span className={'flex-1 ' + (it.withdrawn_at ? 'line-through' : '')}>{it.description}</span>
              <span className="tnum whitespace-nowrap">{qty(it.qty_estimated)} {it.unit}</span>
              {editor && !it.withdrawn_at && !row && (<>
                <button className="text-primary text-xs font-semibold" onClick={() => open('edit', it)}>Change</button>
                <button className="text-ink-muted text-xs font-semibold" onClick={() => open('withdraw', it)}><Undo2 size={13} className="inline" /> Withdraw</button>
              </>)}
            </div>
            {it.withdrawn_at && <div className="text-xs ml-8">Withdrawn by {it.withdrawn_by_name || '—'} {shortDate(it.withdrawn_at)}: {it.withdrawal_reason}</div>}
            {row?.id === it.id && form}
          </li>
        ))}
      </ol>
      {row?.mode === 'add' && form}
    </div>
  );
}

export function JobCardHistory({ ticketId }: { ticketId: string }) {
  const h = useLoad(() => api<any[]>(`/tickets/${ticketId}/job-card/history`), [ticketId]);
  if (h.error) return <ErrorState message={h.error} />;
  if (!h.data) return <Skeleton className="h-24 mt-3" />;
  return (
    <ol className="mt-3 flex flex-col gap-2">
      {h.data.map((l, i) => (
        <li key={i} className="border border-line rounded-input p-3 text-[13px] bg-surface">
          <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{EVENT[l.event_type] || l.event_type}</span>
            <span className="text-xs text-ink-muted">{l.actor_name || l.actor_role || 'System'} · {when(l.occurred_at)}</span></div>
          {l.event_type === 'JOB_CARD_CHANGED' && Object.keys(l.after_value || {}).map((k) => (
            <div key={k} className="text-xs mt-1"><span className="text-ink-muted">{LABEL[k] || k}:</span> {l.before_value?.[k] ? <><s className="text-ink-muted">{l.before_value[k]}</s> → </> : null}<b>{l.after_value[k] || '—'}</b></div>))}
          {l.event_type.startsWith('JOB_CARD_ITEM') && l.after_value && (
            <div className="text-xs mt-1">Item {l.after_value.item}: {l.before_value && l.event_type === 'JOB_CARD_ITEM_CHANGED'
              ? <><s className="text-ink-muted">{l.before_value.description}, {qty(l.before_value.qty_estimated)} {l.before_value.unit}</s> → </> : null}
              <b>{l.after_value.description}, {qty(l.after_value.qty_estimated)} {l.after_value.unit}</b></div>)}
          {l.reason && <div className="mt-1">“{l.reason}”</div>}
        </li>))}
    </ol>
  );
}

/* ------------------------------------------------------------ printable card */
export function JobCardPrint() {
  const { id = '' } = useParams();
  const card = useCard(id);
  // the job's photographs, which the card itself does not carry
  const ticket = useLoad(() => api<any>(`/tickets/${id}`).catch(() => null), [id]);
  if (card.error) return <ErrorState message={card.error} />;
  if (card.data === null) return <Card><EmptyState title="No job card" body="It is prepared when the complaint is assigned, and is read by the Overseer and those above." /></Card>;
  if (!card.data) return <Skeleton className="h-96" />;
  const c = card.data, t = c.ticket;
  const live = c.items.filter((i: any) => !i.withdrawn_at);
  const Row = ({ k, v }: { k: string; v: any }) => <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-2 py-1 border-b border-line"><span className="text-ink-muted">{k}</span><span className="tnum break-words min-w-0">{v || '—'}</span></div>;
  return (
    <div className="max-w-[820px] min-w-0">
      <div className="no-print flex justify-between items-center mb-4">
        <PageHeader title="Job card" sub="Prints on one A4 page. Changes are made from the complaint." />
        <Button icon={<Printer size={18} />} onClick={() => window.print()}>Print</Button>
      </div>
      <article className="print-sheet bg-surface border border-line rounded-card p-8 text-[13px] leading-relaxed">
        <div className="flex justify-between items-start border-b-2 border-ink pb-3">
          <div className="flex items-center gap-3"><BrandMark size={40} className="text-ink shrink-0" fresh="#9a9a9a" title="Civil Colony Maintenance Portal" />
            <div><div className="font-bold text-base">Northern Coalfields Limited</div><div>Civil Department — {t.area_code} Area, Colony Maintenance</div></div></div>
          <div className="text-right"><div className="font-bold text-lg tnum">{c.jc_no}</div><div>Prepared {shortDate(c.prepared_at)}</div></div>
        </div>
        <h2 className="text-center font-bold tracking-wide my-3">JOB CARD</h2>
        <section className="print-2col grid xl:grid-cols-2 gap-x-8">
          <div>
            <Row k="Complaint no." v={t.ticket_no} />
            <Row k="Premises" v={`${t.identifier}${t.quarter_type ? ` (Type ${t.quarter_type})` : ''}`} />
            <Row k="Fault" v={`${t.category} — ${t.sub_category}`} />
            <Row k="Emergency" v={t.is_emergency ? 'Yes' : 'No'} />
            <Row k="Raised" v={shortDate(t.raised_at)} />
            <Row k="Verified" v={`${shortDate(t.verified_at)}${t.verified_by_name ? ` by ${t.verified_by_name}` : ''}`} />
          </div>
          <div>
            <Row k="Contractor" v={t.contractor_name} />
            <Row k="Agreement no." v={t.agreement_no} />
            <Row k="Supervisor" v={t.supervisor_name} />
            <Row k="Assigned" v={shortDate(t.assigned_at)} />
            <Row k="Complete by" v={shortDate(t.completion_deadline_at)} />
            <Row k="Status" v={STATE[t.state]?.label || t.state} />
          </div>
        </section>
        <section className="mt-4"><div className="font-semibold">Complaint as raised</div><p className="whitespace-pre-wrap">{t.description || '—'}</p></section>
        <section className="mt-3"><div className="font-semibold">Scope of work</div><p className="whitespace-pre-wrap min-h-[3em]">{c.scope_of_work || ''}</p></section>
        <section className="mt-3"><div className="font-semibold">Site notes</div><p className="whitespace-pre-wrap min-h-[2em]">{c.site_notes || ''}</p></section>
        <table className="w-full mt-3 border-collapse">
          <thead><tr className="text-left border-y border-ink">{['#', 'Item of work', 'Unit', 'Est. qty', 'Qty done'].map((h) => <th key={h} className="py-1.5 pr-2">{h}</th>)}</tr></thead>
          <tbody>
            {live.map((i: any) => <tr key={i.id} className="border-b border-line"><td className="py-1.5 pr-2 tnum">{i.seq}</td><td className="pr-2">{i.description}</td><td>{i.unit}</td><td className="tnum">{qty(i.qty_estimated)}</td><td /></tr>)}
            {Array.from({ length: Math.max(0, 4 - live.length) }).map((_, k) => <tr key={`b${k}`} className="border-b border-line h-8"><td colSpan={5} /></tr>)}
          </tbody>
        </table>
        <p className="text-xs text-ink-muted mt-2">Quantities only; no rates or amounts are recorded on the portal. Workmen: {t.workmen_assigned || '________________'}</p>
        <Lifecycle life={c.lifecycle} print />
        <JobPhotos media={ticket.data?.media} />
        <footer className="grid grid-cols-3 gap-6 mt-12 text-center text-xs">
          {['Contractor’s supervisor', 'Civil Overseer', 'Civil Incharge'].map((r) => <div key={r} className="border-t border-ink pt-1">{r}<br />Signature and date</div>)}
        </footer>
      </article>
    </div>
  );
}

/* ------------------------------------------------------------ list */
export default function JobCards() {
  const [open, setOpen] = useState(true);
  const [q, setQ] = useState(''); const [query, setQuery] = useState('');
  const list = useLoad(() => api<{ items: any[] }>(`/job-cards?open=${open}${query ? `&q=${encodeURIComponent(query)}` : ''}`), [open, query]);
  return (
    <>
      <PageHeader title="Job cards" sub="Prepared when a complaint is assigned. The Overseer and Incharge fill them in; everyone above reads them." />
      <div className="flex flex-wrap gap-2 items-center mb-4">
        <form className="relative flex-1 min-w-[240px] max-w-md" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
          <SearchIcon size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input className={inputCls + ' pl-10'} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Complaint no., premises or firm" />
        </form>
        <Chip selected={open} onClick={() => setOpen(true)}>Open work</Chip>
        <Chip selected={!open} onClick={() => setOpen(false)}>All, closed included</Chip>
      </div>
      {list.error && <ErrorState message={list.error} retry={list.reload} />}
      <div className="bg-surface border border-line rounded-card overflow-auto">
        {!list.data ? <Skeleton className="h-40 m-4" /> : list.data.items.length === 0 ? <EmptyState title="No job cards" body="A card appears when a complaint is assigned to a contractor." /> : (
          <table className="w-full text-[13px] min-w-[860px]">
            <thead className="bg-bg"><tr className="text-left">{['Job card', 'Premises', 'Fault', 'Contractor', 'Status', 'Scope', 'Items', ''].map((h) => <th key={h} className="label px-4 py-3">{h}</th>)}</tr></thead>
            <tbody>{list.data.items.map((r) => (
              <tr key={r.ticket_id} className="border-t border-line h-[52px]">
                <td className="px-4 font-semibold tnum">{r.jc_no}{r.is_emergency && <span className="text-bad font-normal"> · emergency</span>}</td>
                <td className="px-4">{r.identifier}</td><td className="px-4">{r.sub_category}</td>
                <td className="px-4 text-ink-muted">{r.contractor_name || '—'}<div className="text-xs">{r.supervisor_name}</div></td>
                <td className="px-4"><StatusChip tone={STATE[r.state]?.tone || 'info'}>{STATE[r.state]?.label || r.state}</StatusChip></td>
                <td className="px-4">{r.has_scope ? 'Filled in' : <span className="text-risk">Not yet</span>}</td>
                <td className="px-4 tnum">{r.items}</td>
                <td className="px-4"><Link to={`/w/job-cards/${r.ticket_id}`} className="text-primary font-semibold inline-flex items-center gap-1"><ClipboardList size={15} />Open</Link></td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
