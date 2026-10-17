import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Download, RotateCcw, Smartphone, X } from 'lucide-react';
import { Button, Card, Chip, EmptyState, ErrorState, IconButton, SectionLabel, Segmented, Skeleton, SlaRing, StatusChip, Timeline, useToast } from '../../components/ui';
import { categoryIcon } from '../../components/ui/icons';
import { PageHeader } from '../../components/shell/Shells';
import { ContractorMaterials } from './Materials';
import { ContractorMeasurements, MeasurementsSection } from './Measurements';
import { JobCardSection } from './JobCard';
import { historyItems } from '../Resident';
import { Photographs } from '../../components/Photographs';
import { api, downloadCsv, session } from '../../lib/api';
import { STATE, contractorSla, slaText } from '../../lib/domain';
import { hours, relTime, shortDate } from '../../lib/format';
import { useAutoRefresh, useLoad } from '../../lib/useLoad';

/* The contractor's jobs on the web, laid out as the Overseer's Inbox (user's
   decisions, 2026-10-16): tiles, Live / Completed, one table, the complaint
   panel at the side — with only what each contractor role may do.

   The firm (CONTRACTOR) reads every job of the work order this role is held
   on, who holds each, and downloads a CSV; it changes nothing. A firm with
   several work orders holds a role for each and switches (control 3 kept).

   The supervisor (CONTRACTOR_SUPERVISOR) signed in on the web sees only the
   jobs assigned to him, and records or withdraws materials; starting work,
   photographs and the completion claim stay in the app — the database refuses
   them from a web session, and the panel says so instead of offering them.

   Neither sees the occupant's objections, answers or disputes, nor the job
   card: the server leaves them out. */

const LIVE = ['ASSIGNED', 'IN_PROGRESS', 'REWORK', 'WORK_COMPLETED'];
const DONE = ['INSPECTED_ACCEPTED', 'CLOSED'];
type Bucket = 'start' | 'progress' | 'rework' | 'await' | 'late';
const BUCKET_STATES: Record<Exclude<Bucket, 'late'>, string[]> = {
  start: ['ASSIGNED'], progress: ['IN_PROGRESS'], rework: ['REWORK'], await: ['WORK_COMPLETED']
};

export default function FirmJobs() {
  const toast = useToast();
  const firm = session.get()?.role === 'CONTRACTOR';
  const [tab, setTab] = useState<'live' | 'done'>('live');
  const [bucket, setBucket] = useState<Bucket | null>(null);
  const [who, setWho] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const d = useLoad(async () => {
    const [list, sups] = await Promise.all([
      api<{ items: any[] }>('/tickets'),
      firm ? api<any[]>('/devices/assignable').catch(() => [] as any[]) : Promise.resolve([] as any[])
    ]);
    return { rows: list.items, names: new Map<string, string>(sups.map((s) => [s.actor_id, s.person_name || 'Supervisor'])) };
  });
  useAutoRefresh(d.reload, 30, open !== null);
  const all = d.data?.rows || [];
  const late = (t: any) => { const s = contractorSla(t); return !!s && s.left < 0; };
  const live = all.filter((t) => LIVE.includes(t.state));
  const done = all.filter((t) => DONE.includes(t.state))
    .sort((a, b) => Date.parse(b.closed_at || b.inspected_at || 0) - Date.parse(a.closed_at || a.inspected_at || 0));
  const supervisors = useMemo(() => [...new Set(all.map((t) => t.assigned_to).filter(Boolean))] as string[], [all]);
  const count = (b: Bucket) => b === 'late' ? live.filter(late).length : live.filter((t) => BUCKET_STATES[b].includes(t.state)).length;
  const rows = (tab === 'live' ? live : done)
    .filter((t) => !who || t.assigned_to === who)
    .filter((t) => tab !== 'live' || !bucket || (bucket === 'late' ? late(t) : BUCKET_STATES[bucket].includes(t.state)))
    // most urgent first: least of the contractor's own time left (README §3)
    .sort((a, b) => tab === 'live' ? (contractorSla(a)?.left ?? 1e9) - (contractorSla(b)?.left ?? 1e9) : 0);
  const name = (id?: string) => (id && d.data?.names.get(id)) || '—';
  const csv = async () => {
    const q = new URLSearchParams({ state: (tab === 'live' ? LIVE : DONE).join(',') });
    if (who) q.set('supervisor_id', who);
    try { await downloadCsv(`/maintenance/v1/tickets.csv?${q}`, tab === 'live' ? 'our-jobs.csv' : 'our-completed-jobs.csv'); }
    catch (e: any) { toast({ text: e.message, tone: 'bad' }); }
  };
  const tiles: [Bucket, string, string, 'info' | 'bad' | 'await' | 'risk'][] = [
    ['start', 'To start', 'Assigned, not begun', 'info'], ['progress', 'In progress', 'Work under way', 'info'],
    ['rework', 'Sent back', 'To be redone', 'bad'], ['await', 'Awaiting inspection', 'Claimed done', 'await'],
    ['late', firm ? 'Over the time' : 'Over my time', "The contractor's clock", 'bad']];

  return (
    <>
      <PageHeader title={firm ? 'Our jobs' : 'My jobs'}
        sub={firm ? 'Every job of this work order · read only' : 'Jobs assigned to you · materials can be recorded here'}
        action={firm ? <Button variant="secondary" icon={<Download size={17} />} onClick={csv}>Download CSV</Button> : undefined} />
      {d.error && <ErrorState message={d.error} retry={d.reload} />}
      {!firm && (
        <div className="mb-4 rounded-card bg-tint p-3.5 text-[13px] flex gap-2.5">
          <Smartphone size={18} className="shrink-0 text-primary" />
          <div><b>Starting work, photographs and marking complete are done in the app on your phone.</b>
            <span className="text-ink-muted"> They are acts from the site. Here you can follow your jobs and record the materials used.</span></div>
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2.5">
        {!d.data && !d.error ? [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[68px]" />)
          : tiles.map(([b, label, caption, tone]) => (
            <Tile key={b} label={label} caption={caption} value={count(b)} tone={tone} alarm={b === 'late' && count(b) > 0}
              on={tab === 'live' && bucket === b} onClick={() => { setTab('live'); setBucket(bucket === b ? null : b); }} />))}
      </div>
      {bucket && tab === 'live' && <div className="mt-2 text-[13px] text-ink-muted">Showing only <b className="text-ink">{tiles.find(([b]) => b === bucket)?.[1].toLowerCase()}</b> ·{' '}
        <button className="underline text-primary" onClick={() => setBucket(null)}>show all</button></div>}

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <Segmented value={tab} onChange={(v) => { setTab(v); setBucket(null); }}
          options={[{ value: 'live', label: `Live${d.data ? ` · ${live.length}` : ''}` }, { value: 'done', label: `Completed${d.data ? ` · ${done.length}` : ''}` }]} />
        {firm && supervisors.length > 0 && <Chip selected={!who} onClick={() => setWho(null)}>All supervisors</Chip>}
        {firm && supervisors.map((id) => <Chip key={id} selected={who === id} onClick={() => setWho(who === id ? null : id)}>{name(id)}</Chip>)}
      </div>
      {!d.data && !d.error && <div className="mt-5 grid gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>}
      {d.data && rows.length === 0 && (
        <div className="mt-5"><EmptyState title={tab === 'live' ? (bucket ? 'Nothing here' : 'No live jobs') : 'Nothing completed yet'}
          body={tab === 'live' ? (firm ? 'Jobs given to your supervisors appear here.' : 'New work from the civil office appears here.')
            : 'Jobs accepted on inspection appear here, for 30 days after closure.'} /></div>
      )}
      {rows.length > 0 && (
        <div className="mt-5 bg-surface border border-line rounded-card overflow-auto">
          <table className="w-full text-[13px] min-w-[760px]">
            <thead className="bg-bg"><tr className="text-left">
              {['Complaint', 'Qtr No.', 'Fault', ...(firm ? ['Supervisor'] : []), tab === 'live' ? (firm ? "Contractor's time" : 'My time') : 'Result', 'Status'].map((h) =>
                <th key={h} scope="col" className="label px-4 py-2.5 font-semibold whitespace-nowrap">{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((t) => {
                const I = categoryIcon(t.category);
                const s = contractorSla(t);
                return (
                  <tr key={t.id} tabIndex={0} onClick={() => setOpen(t.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(t.id)}
                    className={clsx('border-t border-line cursor-pointer hover:bg-row-hover focus:bg-tint focus:outline-none h-[52px]', tab === 'live' && late(t) && 'breach')}>
                    <td className="px-4 whitespace-nowrap"><div className="font-semibold tnum font-mono text-[12.5px]">{t.ticket_no}</div>
                      <div className="text-xs text-ink-muted">{relTime(t.raised_at)}</div></td>
                    <td className="px-4 font-medium whitespace-nowrap">{t.identifier}</td>
                    <td className="px-4 max-w-[300px]"><div className="flex items-center gap-2 min-w-0"><I size={16} className="text-primary shrink-0" /><span className="truncate">{t.sub_category}</span></div>
                      {t.is_emergency && <div className="text-xs font-semibold text-bad">Emergency</div>}
                      {t.state === 'REWORK' && <div className="text-xs font-semibold text-bad">Sent back — to be redone</div>}</td>
                    {firm && <td className="px-4 whitespace-nowrap">{name(t.assigned_to)}</td>}
                    <td className="px-4 whitespace-nowrap">
                      {tab === 'live'
                        ? (s ? <span className={s.tone === 'bad' ? 'text-bad font-semibold' : s.tone === 'risk' ? 'text-risk font-semibold' : ''}>{hours(s.used)} of {hours(s.window)}{t.state === 'WORK_COMPLETED' ? ' · stopped' : ''}</span> : '—')
                        : <span className={t.completion_met === false ? 'text-bad font-semibold' : 'text-ok'}>{t.completion_met === false ? 'Over the time' : t.completion_met ? 'Within the time' : '—'}
                            <span className="block text-xs text-ink-muted">{t.closed_at ? `Closed ${shortDate(t.closed_at)}` : t.inspected_at ? `Accepted ${shortDate(t.inspected_at)}` : ''}</span></span>}
                    </td>
                    <td className="px-4 whitespace-nowrap"><StatusChip tone={STATE[t.state]?.tone || 'info'}>{STATE[t.state]?.label || t.state}</StatusChip></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {firm && <p className="text-[11.5px] text-ink-muted mt-4">Read only. Holding several work orders? Switch to the other one from your name at the top. Starting work, photographs and marking complete are done by your supervisors in the app.</p>}
      {open && <JobPanel id={open} firm={firm} supervisor={name(all.find((t) => t.id === open)?.assigned_to)} onClose={() => { setOpen(null); d.reload(); }} />}
    </>
  );
}

/* The officer's tile, as on the Inbox: a count, a label, a caption. */
function Tile({ label, value, caption, tone, on, alarm, onClick }:
  { label: string; value: number; caption: string; tone: 'info' | 'bad' | 'await' | 'risk'; on: boolean; alarm?: boolean; onClick: () => void }) {
  const fg = tone === 'bad' ? 'text-bad' : tone === 'risk' ? 'text-risk' : tone === 'await' ? 'text-await' : 'text-primary';
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={clsx('lift text-left rounded-card border px-3.5 py-2.5 flex items-center gap-3 min-h-[68px] transition-colors',
        alarm ? 'bg-bad-bg border-bad/40' : on ? 'bg-tint border-primary/40' : 'bg-surface border-line hover:bg-muted')}>
      <span className={clsx('text-[26px] font-semibold tnum leading-none tracking-[-0.02em]', value > 0 ? fg : 'text-ink-muted')}>{value}</span>
      <span className="min-w-0">
        <span className={clsx('block text-[13px] font-semibold leading-tight', alarm && 'text-bad')}>{label}</span>
        <span className="block text-[11.5px] text-ink-muted leading-tight truncate">{caption}</span>
      </span>
    </button>
  );
}

/* One job at the side, as the officer's complaint panel — with only what this
   role may do: materials for the supervisor it is assigned to, nothing for the firm. */
function JobPanel({ id, firm, supervisor, onClose }: { id: string; firm: boolean; supervisor: string; onClose: () => void }) {
  const d = useLoad(() => api(`/tickets/${id}`), [id]);
  const t = d.data;
  const s = t && contractorSla(t);
  const sentBack = t?.history?.filter((h: any) => h.to_state === 'REWORK').pop();
  return (
    <div className="fixed inset-0 z-40 flex justify-end" style={{ background: 'var(--scrim)' }} onClick={onClose}>
      <aside role="dialog" aria-label="Job" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] h-full bg-bg overflow-auto shadow-[0_24px_64px_rgba(10,51,51,.28)]" style={{ animation: 'fade-up 240ms var(--ease) both' }}>
        <div className="sticky top-0 z-10 bg-surface border-b border-line px-5 h-16 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="font-semibold tnum">{t?.ticket_no || '…'}</div>
            <div className="text-xs text-ink-muted truncate">{t?.sub_category}</div>
          </div>
          {t && <StatusChip tone={STATE[t.state]?.tone || 'info'}>{STATE[t.state]?.label}</StatusChip>}
          <IconButton label="Close" onClick={onClose}><X size={20} /></IconButton>
        </div>
        <div className="p-5">
          {d.error && <ErrorState message={d.error} retry={d.reload} />}
          {!t && !d.error && <Skeleton className="h-48" />}
          {t && (
            <>
              <Card className="p-4 flex gap-4 items-center">
                {/* finished work shows its result, not time left on a clock that has stopped */}
                {s && !DONE.includes(t.state) ? <SlaRing size={88} fraction={s.fraction} tone={s.tone} label={slaText(s.left)} sub={s.left < 0 ? 'late' : 'left'} />
                  : <SlaRing size={88} fraction={1} tone={t.completion_met === false ? 'bad' : 'ok'} label={t.completion_met === false ? 'Late' : '✓'}
                      sub={t.completion_met === false ? 'over time' : 'in time'} />}
                <div className="min-w-0 text-[13px]">
                  <div className="font-semibold text-base">Qtr No. {t.identifier}</div>
                  <div className="text-ink-muted">{t.category}{t.is_emergency && <span className="text-bad font-semibold"> · Emergency</span>}</div>
                  {firm && <div className="mt-1">Supervisor: <b>{supervisor}</b></div>}
                  {t.workmen_assigned && <div className="text-ink-muted">Workmen: {t.workmen_assigned}</div>}
                  {s && <div className="text-ink-muted mt-1">{firm ? "The contractor's time" : 'Your time on this job'}: {hours(s.used)} of {hours(s.window)}{s.running ? ' · clock running' : ' · clock stopped'}</div>}
                  <div className="text-xs text-ink-muted mt-0.5">Counts only while the job is with the contractor. Inspection time is not the contractor's.</div>
                </div>
              </Card>
              {t.description && <Card className="p-4 mt-3 text-sm">{t.description}</Card>}
              {t.state === 'REWORK' && (
                <div className="mt-3 rounded-card bg-bad-bg text-bad p-3.5 text-[13px] flex gap-2.5">
                  <RotateCcw size={18} className="shrink-0" /><div><b>Sent back by the Overseer.</b>{sentBack?.reason && <> “{sentBack.reason}”</>}</div>
                </div>
              )}
              {!firm && ['ASSIGNED', 'REWORK', 'IN_PROGRESS'].includes(t.state) && (
                <div className="mt-3 rounded-card bg-tint p-3.5 text-[13px] flex gap-2.5">
                  <Smartphone size={18} className="shrink-0 text-primary" />
                  <div><b>{t.state === 'IN_PROGRESS' ? 'Take the photographs and mark it complete in the app.' : 'Start the work in the app on your phone.'}</b>
                    <div className="text-ink-muted mt-0.5">Materials used can be recorded here, below.</div></div>
                </div>
              )}
              {t.state === 'WORK_COMPLETED' && (
                <div className="mt-3 rounded-card bg-await-bg text-await p-3.5 text-[13px]">Claimed complete. The contractor's clock has stopped; the Overseer inspects it next.</div>
              )}
              {t.state !== 'ASSIGNED' && <ContractorMaterials key={t.state} ticketId={id} />}
              {/* the supervisor reads and changes his job's card and keeps his own measurement sheet (2026-10-16); the firm reads what Civil measured */}
              {!firm && <JobCardSection ticketId={id} state={t.state} media={t.media} />}
              {!firm && DONE.includes(t.state) && <MeasurementsSection ticketId={id} />}
              {firm && DONE.includes(t.state) && <ContractorMeasurements ticketId={id} />}
              {t.media?.length > 0 && (<><SectionLabel className="mt-6 mb-3">Photographs</SectionLabel><Photographs media={t.media} /></>)}
              <SectionLabel className="mt-6 mb-3">History</SectionLabel>
              <Card className="p-4"><Timeline items={historyItems(t)} /></Card>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
