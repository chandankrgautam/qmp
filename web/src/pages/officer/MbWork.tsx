import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { AlertTriangle, RefreshCw, Search as SearchIcon } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState, Field, KpiTile, SectionLabel, Segmented, Skeleton, StatusChip, inputCls } from '../../components/ui';
import { api, session } from '../../lib/api';
import { shortDate, when } from '../../lib/format';
import { useAutoRefresh, useLoad } from '../../lib/useLoad';
import { JobCardSection } from './JobCard';
import { MaterialsSection } from './Materials';
import { MbExtract, MeasurementsSection, type Tab as ExtractTab } from './Measurements';
import { PageHeader } from '../../components/shell/Shells';

/* Working through a month's MB, and finding it later (user's decisions,
   2026-10-16). Each officer of the chain works from one list — what waits at
   their own step — and reviews each job beside it, one at a time: there is no
   approving several together. The server decides every number and every
   button; the database refuses anything else. */

const STAGE: Record<string, string> = {
  SUPERVISOR: 'Supervisor', OVERSEER: 'Civil Overseer', INCHARGE: 'Civil Incharge', STAFF_OFFICER: 'Staff Officer', APPROVED: 'Approved'
};
const thisMonth = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7);
type Filter = 'all' | 'mine' | 'below' | 'sent_back' | 'approved' | 'waiting_long';
const MATCH: Record<Filter, (r: any) => boolean> = {
  all: () => true, mine: (r) => r.mine, below: (r) => r.below, sent_back: (r) => r.sent_back,
  approved: (r) => r.stage === 'APPROVED', waiting_long: (r) => r.waiting_long
};

function StageChip({ stage }: { stage: string }) {
  return stage === 'APPROVED' ? <StatusChip tone="ok">Approved</StatusChip> : <StatusChip tone="info">{STAGE[stage] || stage}</StatusChip>;
}

function ContractPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const cs = useLoad(() => api<any[]>('/contracts'));
  return (
    <Field label="Contract">
      <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All contracts</option>
        {(cs.data || []).map((c) => <option key={c.id} value={c.id}>{c.contractor_name}{c.agreement_no ? ` · ${c.agreement_no}` : ''}</option>)}
      </select>
    </Field>
  );
}

/* ------------------------------------------------------------ the worklist */
export function Worklist() {
  const role = session.get()?.role || '';
  const atStep = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL'].includes(role);
  const [contract, setContract] = useState('');
  const [month, setMonth] = useState(thisMonth());
  const [kind, setKind] = useState<'measurements' | 'materials'>('measurements');
  const [filter, setFilter] = useState<Filter>(atStep ? 'mine' : 'all');
  const [sel, setSel] = useState<string | null>(null);
  const w = useLoad(() => api<any>(`/mb/worklist?month=${month || thisMonth()}&kind=${kind}${contract ? `&contract_id=${contract}` : ''}`), [month, kind, contract]);
  useAutoRefresh(w.reload, 30);
  const rows: any[] = (w.data?.rows || []).filter(MATCH[filter]);

  // ↓ / ↑ move through the list, one job at a time
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = rows.findIndex((r) => r.ticket_id === sel);
      const next = rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? -1 : i) + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) setSel(next.ticket_id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, sel]);

  const t = w.data?.tiles;
  const tile = (f: Filter, label: string, value: number | undefined, caption: string, tone: any = 'neutral') => (
    <KpiTile key={f} label={label} value={value ?? 0} caption={caption} tone={filter === f ? 'info' : tone}
      valueTone={f === 'waiting_long' && value ? 'bad' : undefined} onClick={() => setFilter(filter === f ? 'all' : f)} />
  );
  return (
    <>
      <div className="flex flex-wrap gap-3 items-end mb-4">
        <div className="min-w-[240px]"><ContractPicker value={contract} onChange={setContract} /></div>
        <Field label="Month the work was accepted"><input type="month" className={inputCls} value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <Segmented value={kind} onChange={(k) => setKind(k as any)} options={[{ value: 'measurements', label: 'Measurements' }, { value: 'materials', label: 'Materials' }]} />
        <Button size="sm" variant="ghost" icon={<RefreshCw size={16} />} onClick={w.reload}>Refresh</Button>
      </div>
      {w.error && <ErrorState message={w.error} retry={w.reload} />}
      {!w.data && !w.error && <Skeleton className="h-40" />}
      {w.data && (<>
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
          {atStep && tile('mine', 'Waiting for me', t.mine, 'At my step')}
          {atStep && tile('below', 'Below me', t.below, 'Still at an earlier step')}
          {tile('sent_back', 'Sent back', t.sent_back, 'Returned one step')}
          {tile('approved', 'Approved', t.approved, kind === 'measurements' ? 'MB approved' : 'Materials approved')}
          {tile('waiting_long', `Over ${w.data.wait_days} days`, t.waiting_long, 'At one step', t.waiting_long ? 'bad' : 'neutral')}
          {tile('all', 'All jobs', t.total, 'Accepted this month')}
        </div>
        {kind === 'measurements' && w.data.sample.length > 0 && (
          <Card className="p-3 mb-4 text-[13px] flex flex-wrap gap-x-6 gap-y-1">
            <b>Sample check</b>
            {w.data.sample.map((s: any) => (
              <span key={s.contract_id} className={s.shortfall ? 'text-bad font-semibold' : ''}>
                {s.contractor_name}: {s.checked} of {s.required} needed checked ({s.target_percent}% of {s.jobs} jobs){s.shortfall ? ` — ${s.shortfall} short` : ' ✓'}
              </span>))}
          </Card>
        )}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,520px)] items-start">
          <Card className="p-0 overflow-x-auto">
            {rows.length === 0 ? <div className="p-6"><EmptyState title="Nothing here" body={filter === 'mine' ? 'Nothing waits at your step for this month and contract.' : 'No jobs match.'} /></div> : (
              <table className="w-full text-[13px]">
                <thead><tr className="text-left text-xs text-ink-muted border-b border-line">
                  <th className="p-2.5 font-medium">Complaint</th><th className="p-2.5 font-medium">Quarter · fault</th>
                  <th className="p-2.5 font-medium">{kind === 'measurements' ? 'Measurements' : 'Materials'}</th>
                  <th className="p-2.5 font-medium">At step</th><th className="p-2.5 font-medium">Changes</th>
                </tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.ticket_id} onClick={() => setSel(r.ticket_id)} aria-selected={sel === r.ticket_id}
                    className={clsx('border-b border-line cursor-pointer align-top', sel === r.ticket_id ? 'bg-tint' : 'hover:bg-bg')}>
                    <td className="p-2.5 tnum whitespace-nowrap font-medium">{r.ticket_no}{r.checked && <div className="text-xs text-ok font-normal">check-measured</div>}</td>
                    <td className="p-2.5">{r.identifier}<div className="text-xs text-ink-muted">{r.sub_category}</div></td>
                    <td className="p-2.5"><StageChip stage={r.stage} />{r.sent_back && <div className="text-xs text-reopen mt-0.5">sent back</div>}</td>
                    <td className={clsx('p-2.5 tnum whitespace-nowrap', r.waiting_long && 'text-bad font-semibold')}>
                      {r.stage === 'APPROVED' ? shortDate(r.approved_at) : <>{r.waiting_long && <AlertTriangle size={13} className="inline mr-1" />}{r.days_at_step} d</>}</td>
                    <td className="p-2.5 tnum">{r.changes ? <StatusChip tone="risk">{r.changes} changed</StatusChip> : <span className="text-ink-muted">—</span>}</td>
                  </tr>))}</tbody>
              </table>
            )}
            <div className="text-xs text-ink-muted p-2.5">↓ ↑ move through the list. Each job is approved on its own. Quantities only; no rates are recorded.</div>
          </Card>
          <div className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            {sel ? <ReviewPane key={sel} ticketId={sel} /> : <Card className="p-6 text-sm text-ink-muted">Choose a job to review it here: the job card, the materials and the measurements with their MB lines, and the actions of your step.</Card>}
          </div>
        </div>
      </>)}
    </>
  );
}

/* one job's evidence, with the actions of the caller's step */
function ReviewPane({ ticketId }: { ticketId: string }) {
  const t = useLoad(() => api<any>(`/tickets/${ticketId}`), [ticketId]);
  if (t.error) return <ErrorState message={t.error} retry={t.reload} />;
  if (!t.data) return <Skeleton className="h-64" />;
  const d = t.data;
  return (
    <Card className="p-4">
      <div className="flex justify-between gap-2">
        <div><div className="font-semibold tnum">{d.ticket_no}</div><div className="text-[13px] text-ink-muted">Qtr {d.identifier} · {d.sub_category}</div></div>
        <Link to={`/w/queue?t=${ticketId}`} className="text-primary text-xs font-semibold">Open the complaint</Link>
      </div>
      {d.workmen_assigned && <div className="text-xs text-ink-muted mt-1">Workmen: {d.workmen_assigned} · accepted {when(d.inspected_at)}</div>}
      <JobCardSection ticketId={ticketId} state={d.state} media={d.media} />
      <MaterialsSection ticketId={ticketId} />
      <MeasurementsSection ticketId={ticketId} />
    </Card>
  );
}

/* ------------------------------------------------------------ finding it later */
export function MbFind() {
  const [f, setF] = useState({ q: '', contract: '', stage: '', from: '', to: '', page: '' });
  const [asked, setAsked] = useState<typeof f | null>(null);
  const r = useLoad(() => (asked ? api<any>(`/mb/search?${new URLSearchParams(Object.entries({
    q: asked.q, contract_id: asked.contract, stage: asked.stage, approved_from: asked.from, approved_to: asked.to, page_no: asked.page, page_size: '100'
  }).filter(([, v]) => v)).toString()}`) : Promise.resolve(null)), [asked]);
  const go = (e?: React.FormEvent) => { e?.preventDefault(); setAsked({ ...f }); };
  return (
    <>
      <form onSubmit={go} className="flex flex-wrap gap-3 items-end mb-4">
        <div className="min-w-[260px] flex-1"><Field label="Words of an item, complaint number, quarter or fault">
          <input className={inputCls} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="e.g. plaster, JNT/2026/00042, D-12" /></Field></div>
        <div className="min-w-[220px]"><ContractPicker value={f.contract} onChange={(contract) => setF({ ...f, contract })} /></div>
        <Field label="Measurements"><select className={inputCls} value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })}>
          <option value="">Any step</option>{Object.entries(STAGE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Approved from"><input type="date" className={inputCls} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="to"><input type="date" className={inputCls} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label="MB page"><input className={inputCls + ' tnum w-24'} inputMode="numeric" value={f.page} onChange={(e) => setF({ ...f, page: e.target.value.replace(/\D/g, '') })} /></Field>
        <Button type="submit" icon={<SearchIcon size={16} />}>Find</Button>
      </form>
      {!asked && <Card className="p-6 text-sm text-ink-muted">Every job ever measured stays in its contract's MB. Search by any of the above, or open a contract's MB month by month from a result.</Card>}
      {r.error && <ErrorState message={r.error} retry={r.reload} />}
      {asked && !r.data && !r.error && <Skeleton className="h-32" />}
      {r.data && (
        <Card className="p-0 overflow-x-auto">
          <div className="p-2.5 text-xs text-ink-muted">{r.data.total} {r.data.total === 1 ? 'job' : 'jobs'} found{r.data.total > r.data.items.length ? ` — the first ${r.data.items.length} shown; narrow the search` : ''}</div>
          {r.data.items.length === 0 ? <div className="p-6"><EmptyState title="Nothing found" body="Try fewer words, or another contract or date." /></div> : (
            <table className="w-full text-[13px]">
              <thead><tr className="text-left text-xs text-ink-muted border-y border-line">
                <th className="p-2.5 font-medium">Complaint</th><th className="p-2.5 font-medium">Quarter · fault</th><th className="p-2.5 font-medium">MB · page · lines</th>
                <th className="p-2.5 font-medium">Measurements</th></tr></thead>
              <tbody>{r.data.items.map((x: any) => (
                <tr key={x.ticket_id} className="border-b border-line align-top">
                  <td className="p-2.5 tnum whitespace-nowrap font-medium"><Link className="text-primary" to={`/w/queue?t=${x.ticket_id}`}>{x.ticket_no}</Link></td>
                  <td className="p-2.5">{x.identifier}<div className="text-xs text-ink-muted">{x.sub_category}</div></td>
                  <td className="p-2.5 tnum"><Link className="text-primary" to={`/w/mb/book/${x.contract_id}?page=${x.pages[0]}&job=${x.ticket_id}`}>{x.mb_no}</Link>
                    <div className="text-xs text-ink-muted">page {x.pages.join(', ')} · lines {x.first_line}–{x.last_line}</div></td>
                  <td className="p-2.5"><StageChip stage={x.stage} />{x.approved_at && <div className="text-xs text-ink-muted mt-0.5">{shortDate(x.approved_at)}</div>}</td>
                </tr>))}</tbody>
            </table>
          )}
        </Card>
      )}
      <SectionLabel className="mt-6 mb-2">Quantities only; no rates are recorded.</SectionLabel>
    </>
  );
}

/* ------------------------------------------------------------ the Measurement book page */
type Tab = 'work' | 'find' | ExtractTab;
export default function MeasurementBook() {
  const [tab, setTab] = useState<Tab>('work');
  return (
    <>
      <div className="print:hidden">
        <PageHeader title="Measurement book" sub="Each job's measurements and materials through the approval chain, the MB reference record, and the extract. Quantities only; no rates are recorded." />
        <Segmented<Tab> className="mb-4" value={tab} onChange={setTab}
          options={[{ value: 'work', label: 'Worklist' }, { value: 'find', label: 'Find in the MB' }, { value: 'extract', label: 'MB extract' }, { value: 'check', label: 'Check-measurement' }]} />
      </div>
      {tab === 'work' && <Worklist />}
      {tab === 'find' && <MbFind />}
      {(tab === 'extract' || tab === 'check') && <MbExtract tab={tab} />}
    </>
  );
}
