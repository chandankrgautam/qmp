import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Bookmark, Camera, Download, Megaphone, Plus, Route as RouteIcon, X } from 'lucide-react';
import { Button, Chip, Dialog, EmptyState, ErrorState, Field, Segmented, Skeleton, StatusChip, inputCls, useToast } from '../../components/ui';
import { categoryIcon } from '../../components/ui/icons';
import { PageHeader } from '../../components/shell/Shells';
import TicketPanel from './TicketPanel';
import { api, downloadCsv, idApi, session } from '../../lib/api';
import { STATE, areaFromScope, deadlineSla } from '../../lib/domain';
import { clockFor } from '../../lib/clock';
import { absTime, relTime } from '../../lib/format';
import { takePhoto } from '../../lib/photo';
import { useLoad } from '../../lib/useLoad';

/* The officer's inbox (V2, blueprint O1; ported 2026-10-15). Above it,
   main's five tiles, made smaller at the user's direction: Open, Due soon,
   Overdue, To assign / To inspect, and "SLA breached — needs decision", red
   whenever above nought; each filters the sections below. Three sections by who must act:
   what needs this officer now, what is with the contractor (watch only),
   and what waits on someone else. The inspection section keeps the
   department's own order (control 8) from /inspections/queue, untouched;
   every action still goes through the server's transition table
   (control 5). Rows are reached by keyboard: ↑ ↓ to move, Enter to open,
   X to select. Saved views are this viewer's, kept in this browser. */

const ACTS = ['verify', 'reject', 'assign', 'inspect', 'close'];
const WITH_CONTRACTOR = ['ASSIGNED', 'IN_PROGRESS', 'REWORK'];
const DONE = ['CLOSED', 'REJECTED'];
const NEXT: Record<string, string> = { RAISED: 'To verify', VERIFIED: 'To assign', REOPENED: 'Reopened — to assign again',
  WORK_COMPLETED: 'To inspect on site', INSPECTED_ACCEPTED: 'To close', REWORK: 'Sent back to the contractor',
  ASSIGNED: 'Work to start', IN_PROGRESS: 'Work under way' };
const NEED_ORDER: Record<string, number> = { RAISED: 0, REOPENED: 1, VERIFIED: 2, WORK_COMPLETED: 3, INSPECTED_ACCEPTED: 4 };

type Bucket = 'open' | 'soon' | 'overdue' | 'mine' | 'decide';
type View = { name: string; kind: 'q' | 'b'; cat: string | null; emergency: boolean };
const VIEWS_KEY = 'cp-inbox-views';
const readViews = (): View[] => { try { return JSON.parse(localStorage.getItem(VIEWS_KEY) || '[]'); } catch { return []; } };
const writeViews = (v: View[]) => { try { localStorage.setItem(VIEWS_KEY, JSON.stringify(v)); } catch { /* private window */ } };

export default function Queue() {
  const s = session.get()!;
  const toast = useToast();
  const incharge = s.role === 'MAINTENANCE_INCHARGE';
  const overseer = s.role === 'CIVIL_OVERSEER';
  const data = useLoad(async () => {
    const [list, insp, objections] = await Promise.all([
      api<{ items: any[] }>('/tickets'),
      api<{ items: any[] }>('/inspections/queue').catch(() => ({ items: [] })),
      api<{ items: any[] }>('/objections?open=true').catch(() => ({ items: [] }))
    ]);
    const order = new Map(insp.items.map((x, i) => [x.id, i]));
    const waiting = new Map(insp.items.map((x) => [x.id, Number(x.waiting_hours)]));
    const decorate = (t: any) => ({ ...t, inspectOrder: order.get(t.id) ?? 999, clock: clockFor(t, waiting.get(t.id) ?? null),
      sla: deadlineSla(t.completion_deadline_at, t.sla_completion_minutes, t.state) });
    const rows = list.items.filter((t) => !DONE.includes(t.state)).map(decorate);
    // an SLA breach waiting on a decision (user's request, 2026-10-12): whose
    // delay it was, or the Staff Officer's level-4 remark — closed ones included
    const decide = list.items.filter((t) => t.breach_unattributed || t.l4_remark_needed).map(decorate);
    // completed work (user's request, 2026-10-15): closed, newest first, until it
    // leaves the working screens 30 days after closure (decision 25)
    const done = list.items.filter((t) => t.state === 'CLOSED')
      .sort((a, b) => Date.parse(b.closed_at || b.raised_at) - Date.parse(a.closed_at || a.raised_at)).map(decorate);
    return { rows, decide, done, objections: objections.items };
  });

  const [bucket, setBucket] = useState<Bucket | null>(null);
  const [tab, setTab] = useState<'live' | 'done'>('live');
  const [kind, setKind] = useState<'q' | 'b'>('q');
  const [cat, setCat] = useState<string | null>(null);
  const [emergency, setEmergency] = useState(false);
  const [views, setViews] = useState<View[]>(readViews);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [assignFor, setAssignFor] = useState<string[] | null>(null);
  const [raise, setRaise] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [notice, setNotice] = useState(false);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const live = data.data?.rows || [];
  const decide = data.data?.decide || [];
  const mineStates = incharge ? ['VERIFIED', 'REOPENED'] : ['WORK_COMPLETED'];
  const active = live.filter((r) => !['INSPECTED_ACCEPTED', 'REFERRED_SPECIAL_REPAIR'].includes(r.state));
  const counts = {
    open: active.length,
    soon: active.filter((r) => r.sla?.tone === 'risk').length,
    overdue: active.filter((r) => r.sla?.tone === 'bad').length,
    mine: live.filter((r) => mineStates.includes(r.state)).length,
    decide: decide.length
  };
  const all = bucket === 'decide' ? decide : bucket === 'mine' ? live.filter((r) => mineStates.includes(r.state))
    : bucket === 'soon' ? active.filter((r) => r.sla?.tone === 'risk') : bucket === 'overdue' ? active.filter((r) => r.sla?.tone === 'bad')
    : bucket === 'open' ? active : live;
  const cats = useMemo(() => [...new Set(live.map((r) => r.category).filter(Boolean))].sort(), [live]);
  const filtered = all.filter((x) => (kind === 'q' ? x.premises_type === 'QUARTER' || !x.premises_type : x.premises_type && x.premises_type !== 'QUARTER'))
    .filter((x) => !cat || x.category === cat).filter((x) => !emergency || x.is_emergency);
  // work in the contractor's hands is theirs, even where an officer could reassign it
  const needsYou = filtered.filter((r) => !WITH_CONTRACTOR.includes(r.state) && (r.available_actions || []).some((a: string) => ACTS.includes(a)))
    .sort((a, b) => (NEED_ORDER[a.state] ?? 9) - (NEED_ORDER[b.state] ?? 9)
      || (a.state === 'WORK_COMPLETED' ? a.inspectOrder - b.inspectOrder : 0)
      || Number(b.is_emergency) - Number(a.is_emergency) || Date.parse(a.raised_at) - Date.parse(b.raised_at));
  const mine = new Set(needsYou.map((r) => r.id));
  const done = (data.data?.done || []).filter((x) => (kind === 'q' ? x.premises_type === 'QUARTER' || !x.premises_type : x.premises_type && x.premises_type !== 'QUARTER'))
    .filter((x) => !cat || x.category === cat).filter((x) => !emergency || x.is_emergency);
  const contractor = filtered.filter((r) => !mine.has(r.id) && WITH_CONTRACTOR.includes(r.state));
  const others = filtered.filter((r) => !mine.has(r.id) && !WITH_CONTRACTOR.includes(r.state));
  const flat = [...needsYou, ...contractor, ...others];

  const selectable = (r: any) => incharge ? ['VERIFIED', 'REOPENED'].includes(r.state) : overseer && r.state === 'WORK_COMPLETED';
  const toggle = (id: string) => setSel((x) => { const n = new Set(x); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // keyboard: ↑ ↓ move between rows, Enter opens, X selects
  const onRowKey = (e: React.KeyboardEvent, i: number, r: any) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      rowRefs.current[Math.min(flat.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === 'Enter') { e.preventDefault(); setOpen(r.id); }
    else if ((e.key === 'x' || e.key === 'X') && selectable(r)) { e.preventDefault(); toggle(r.id); }
  };

  const batchInspect = async () => {
    setBatchBusy(true);
    const ids = [...sel];
    try {
      for (const id of ids) await takePhoto(id, 'INSPECTION', 'Inspection (batch visit)');
      const r = await api('/tickets/inspect-batch', { body: { inspections: ids.map((id) => ({ ticket_id: id })) } });
      toast({ text: `${r.accepted} inspection${r.accepted === 1 ? '' : 's'} accepted${r.failed.length ? ` · ${r.failed.length} refused` : ''}`, tone: r.failed.length ? 'bad' : 'ok' });
      setSel(new Set()); data.reload();
    } catch (e: any) { toast({ text: e.message, tone: 'bad' }); } finally { setBatchBusy(false); }
  };

  const saveView = () => {
    const name = [kind === 'b' ? 'Buildings' : 'Quarters', cat?.split(' ')[0], emergency ? 'emergencies' : null].filter(Boolean).join(' · ');
    if (views.some((v) => v.name === name)) return;
    const next = [...views, { name, kind, cat, emergency }]; setViews(next); writeViews(next);
    toast({ text: `View saved: ${name}` });
  };
  const applyView = (v: View) => { setKind(v.kind); setCat(v.cat); setEmergency(v.emergency); };
  const dropView = (name: string) => { const next = views.filter((v) => v.name !== name); setViews(next); writeViews(next); };

  const area = areaFromScope(s.scope_path);
  const canPost = overseer || incharge;
  let idx = -1;
  const section = (title: string, hint: string, rows: any[], extra?: React.ReactNode, empty?: string) => (
    <section className="mt-5" aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <h2 className="text-[15px] font-semibold">{title} <span className="text-ink-muted font-normal tnum">· {rows.length}</span></h2>
        <span className="text-xs text-ink-muted flex items-center gap-3">{hint}{extra}</span>
      </div>
      <div className="bg-surface border border-line rounded-card overflow-auto">
        {rows.length === 0 ? <p className="text-[13px] text-ink-muted px-4 py-3">{empty}</p> : (
          <table className="w-full text-[13px] min-w-[760px]">
            <thead className="bg-bg sticky top-0 z-[1]">
              <tr className="text-left">
                {['', 'Complaint', kind === 'q' ? 'Qtr No.' : 'Building', 'Problem and next step', 'Clock', 'Status'].map((h, i) =>
                  <th key={i} scope="col" className="label px-4 py-2.5 font-semibold whitespace-nowrap">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const i = ++idx;
                const I = categoryIcon(r.category);
                const c = r.clock;
                return (
                  <tr key={r.id} ref={(el) => { rowRefs.current[i] = el; }} tabIndex={0} onClick={() => setOpen(r.id)} onKeyDown={(e) => onRowKey(e, i, r)}
                    aria-label={`${r.ticket_no}, ${r.identifier}, ${r.sub_category}, ${c.label}`}
                    className={clsx('border-t border-line cursor-pointer hover:bg-row-hover focus:bg-tint focus:outline-none transition-colors duration-150 h-[52px]',
                      sel.has(r.id) && '!bg-tint', c.tone === 'bad' && 'breach', c.tone !== 'bad' && r.is_emergency && 'shadow-[inset_3px_0_0_var(--status-at-risk)]')}>
                    <td className="pl-4 pr-1 w-8" onClick={(e) => e.stopPropagation()}>
                      {selectable(r) && <input type="checkbox" aria-label={`Select ${r.ticket_no}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} className="w-4 h-4" />}
                    </td>
                    <td className="px-4 whitespace-nowrap"><div className={clsx('font-semibold tnum font-mono text-[12.5px]', c.tone === 'bad' && 'text-bad')}>{r.ticket_no}</div>
                      <div className="text-xs text-ink-muted" title={absTime(r.raised_at)}>{relTime(r.raised_at)}</div></td>
                    <td className="px-4 font-medium whitespace-nowrap">{r.identifier}</td>
                    <td className="px-4 max-w-[340px]"><div className="flex items-center gap-2 min-w-0" title={r.sub_category}><I size={16} className="text-primary shrink-0" /><span className="truncate">{r.sub_category}</span></div>
                      <div className="text-xs text-ink-muted mt-0.5 truncate">{r.is_emergency && <b className="text-bad">Emergency · </b>}{NEXT[r.state] || STATE[r.state]?.label}
                        {r.state === 'WORK_COMPLETED' && overseer && r.inspectOrder < 999 && <> · stop {r.inspectOrder + 1} on today’s route</>}</div>
                      {r.assignee_role_ended && <div className="text-xs font-semibold text-bad mt-0.5">Supervisor's role has ended — reassign</div>}
                      {r.breach_unattributed && <div className="text-xs font-semibold text-bad mt-0.5">SLA breach — whose delay? Attribute it</div>}
                      {r.l4_remark_needed && <div className="text-xs font-semibold text-bad mt-0.5">Level 4 — Staff Officer's remark needed</div>}</td>
                    <td className="px-4 w-[210px]">
                      <div className={clsx('text-[12.5px] font-semibold tnum whitespace-nowrap', c.tone === 'bad' && 'text-bad', c.tone === 'risk' && 'text-risk', c.tone === 'muted' && 'text-ink-muted')}>{c.label}</div>
                      <div className="text-[11px] text-ink-muted truncate">{c.sub}</div>
                      <div className="h-1 rounded-full bg-line mt-1 overflow-hidden"><div className={clsx('h-full rounded-full',
                        { ok: 'bg-ok', risk: 'bg-risk', bad: 'bg-bad', muted: 'bg-ink-muted/50', info: 'bg-info' }[c.tone as 'ok'])} style={{ width: `${Math.max(4, c.fill * 100)}%` }} /></div>
                    </td>
                    <td className="px-4 whitespace-nowrap"><StatusChip tone={STATE[r.state]?.tone || 'info'}>{STATE[r.state]?.label || r.state}</StatusChip></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );

  return (
    <>
      <PageHeader title="Inbox" sub={`${area.name} · ${data.data ? `${needsYou.length} need${needsYou.length === 1 ? 's' : ''} you` : 'loading'}`}
        action={<div className="flex flex-wrap gap-2">
          {/* the complaints of this tab as CSV, row security deciding the rows (user's request, 2026-10-16) */}
          <Button variant="secondary" icon={<Download size={17} />} onClick={() => downloadCsv(
            `/maintenance/v1/tickets.csv?state=${tab === 'done' ? 'CLOSED' : 'RAISED,VERIFIED,ASSIGNED,IN_PROGRESS,REWORK,WORK_COMPLETED,INSPECTED_ACCEPTED,REOPENED,REFERRED_SPECIAL_REPAIR'}`,
            tab === 'done' ? 'completed-complaints.csv' : 'live-complaints.csv').catch((e) => toast({ text: e.message, tone: 'bad' }))}>Download CSV</Button>
          {canPost && <Button variant="secondary" icon={<Megaphone size={17} />} onClick={() => setNotice(true)}>Colony notices</Button>}
          {kind === 'b' && canPost && <Button icon={<Plus size={18} />} onClick={() => setRaise(true)}>Raise for a building</Button>}
        </div>} />
      {data.error && <ErrorState message={data.error} retry={data.reload} />}

      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2.5">
        {!data.data && !data.error ? [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[68px]" />) : (<>
          <Tile label="Open" value={counts.open} caption="Not yet fixed" on={bucket === 'open'} onClick={() => setBucket(bucket === 'open' ? null : 'open')} />
          <Tile label="Due soon" value={counts.soon} caption="Under 25% SLA left" tone="risk" on={bucket === 'soon'} onClick={() => setBucket(bucket === 'soon' ? null : 'soon')} />
          <Tile label="Overdue" value={counts.overdue} caption="SLA breached" tone="bad" on={bucket === 'overdue'} onClick={() => setBucket(bucket === 'overdue' ? null : 'overdue')} />
          <Tile label={incharge ? 'To assign' : overseer ? 'To inspect' : 'Awaiting inspection'} value={counts.mine}
            caption={incharge ? 'Verified by the Overseer' : 'Contractor claims done'} tone="await" on={bucket === 'mine'} onClick={() => setBucket(bucket === 'mine' ? null : 'mine')} />
          {/* red as soon as anything waits, so it cannot be missed */}
          <Tile label="SLA breached — needs decision" value={counts.decide} caption="Whose delay, or the level-4 remark" tone="bad"
            alarm={counts.decide > 0} on={bucket === 'decide'} onClick={() => setBucket(bucket === 'decide' ? null : 'decide')} />
        </>)}
      </div>
      {bucket && <div className="mt-2 text-[13px] text-ink-muted">Showing only <b className="text-ink">{
        { open: 'open', soon: 'due soon', overdue: 'overdue', mine: incharge ? 'to assign' : 'to inspect', decide: 'SLA breaches needing a decision' }[bucket]}</b> complaints ·{' '}
        <button className="underline text-primary" onClick={() => setBucket(null)}>show all</button></div>}

      {overseer && (data.data?.objections.length || 0) > 0 && (
        <div className="mt-4 rounded-card border border-risk bg-risk-bg text-risk p-3.5 text-[13px] flex flex-wrap gap-x-4 gap-y-1 items-center">
          <b>{data.data!.objections.length} objection{data.data!.objections.length > 1 ? 's' : ''} to answer within 24 hours:</b>
          {data.data!.objections.map((o) => (
            <button key={o.id} className="underline tnum" onClick={() => setOpen(o.ticket_id)}>{o.ticket_no}{o.overdue ? ' (overdue)' : ''}</button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <Segmented value={tab} onChange={(v) => { setTab(v); setSel(new Set()); }}
          options={[{ value: 'live', label: 'Live' }, { value: 'done', label: `Completed${data.data ? ` · ${data.data.done.length}` : ''}` }]} />
        <Segmented value={kind} onChange={(v) => { setKind(v); setSel(new Set()); }} options={[{ value: 'q', label: 'Quarters' }, { value: 'b', label: 'Other buildings' }]} />
        <Chip selected={!cat} onClick={() => setCat(null)}>All categories</Chip>
        {cats.map((c) => { const I = categoryIcon(c); return <Chip key={c} selected={cat === c} onClick={() => setCat(cat === c ? null : c)} icon={<I size={15} />}>{c.split(' ')[0].replace(/,$/, '')}</Chip>; })}
        <Chip selected={emergency} onClick={() => setEmergency(!emergency)}>Emergencies only</Chip>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={<Bookmark size={15} />} onClick={saveView}>Save this view</Button>
      </div>
      {views.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mt-2 text-[13px]">
          <span className="text-ink-muted">Saved views:</span>
          {views.map((v) => (
            <span key={v.name} className="inline-flex items-center rounded-full border border-line-strong bg-surface">
              <button className="pl-3 pr-1 h-8" onClick={() => applyView(v)}>{v.name}</button>
              <button className="w-7 h-8 grid place-items-center text-ink-muted hover:text-ink" aria-label={`Remove saved view ${v.name}`} onClick={() => dropView(v.name)}><X size={13} /></button>
            </span>
          ))}
        </div>
      )}

      {!data.data && !data.error && <div className="mt-5 grid gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>}
      {data.data && tab === 'done' && section('Completed', 'closed in the last 30 days, newest first · older ones are in Search', done, undefined,
        'Nothing closed in the last 30 days in this view.')}
      {data.data && tab === 'live' && (<>
        {section('Needs you', overseer ? 'inspections in the department’s order' : 'oldest first', needsYou,
          overseer ? <Link to="/w/today" className="inline-flex items-center gap-1 text-primary font-semibold"><RouteIcon size={13} />See as today’s route</Link> : undefined,
          'Nothing waits for you. New complaints, claims to inspect and work to assign appear here.')}
        {section('With the contractor', 'watch only · their own clock', contractor, undefined, 'No work is with the contractor right now.')}
        {section('Waiting on others', 'another officer or the resident', others, undefined, 'Nothing is waiting on anyone else.')}
        {flat.length === 0 && <EmptyState title="All clear" body="No live complaints in this view. Clear a filter to see more." />}
        <p className="text-[11.5px] text-ink-muted mt-4 flex flex-wrap gap-x-4 gap-y-1">
          <span><kbd className="font-mono border border-line rounded px-1">↑</kbd> <kbd className="font-mono border border-line rounded px-1">↓</kbd> move</span>
          <span><kbd className="font-mono border border-line rounded px-1">Enter</kbd> open</span>
          <span><kbd className="font-mono border border-line rounded px-1">X</kbd> select</span>
          <span><kbd className="font-mono border border-line rounded px-1">Ctrl K</kbd> go to any complaint</span>
          <span>Closed and rejected complaints are in Search.</span>
        </p>
      </>)}

      {sel.size > 0 && (
        <div className="sticky bottom-4 mt-4 mx-auto w-fit bg-surface border border-line rounded-full shadow-[0_-12px_32px_rgba(0,0,0,.15)] pl-5 pr-2 py-2 flex items-center gap-3">
          <span className="font-semibold text-sm tnum">{sel.size} selected</span>
          {incharge && <Button onClick={() => setAssignFor([...sel])}>Assign work</Button>}
          {overseer && <Button icon={<Camera size={18} />} loading={batchBusy} onClick={batchInspect}>Inspect and accept ({sel.size})</Button>}
          <Button variant="ghost" onClick={() => setSel(new Set())}>Clear</Button>
        </div>
      )}

      {open && <TicketPanel id={open} onClose={() => setOpen(null)} onChanged={data.reload} />}
      {assignFor && <BulkAssign ids={assignFor} onClose={() => setAssignFor(null)} onDone={() => { setAssignFor(null); setSel(new Set()); data.reload(); }} />}
      {raise && <RaiseForBuilding onClose={() => setRaise(false)} onDone={() => { setRaise(false); data.reload(); }} />}
      {notice && <NoticesDialog area={area.name} onClose={() => setNotice(false)} />}
    </>
  );
}

/* Colony notices (blueprint R4): post one for a colony in this Area, end
   it with a reason. The database decides the scope; nothing is filtered
   here except the list of colonies offered, by this Area's name. */
function NoticesDialog({ area, onClose }: { area: string; onClose: () => void }) {
  const toast = useToast();
  const list = useLoad(() => api<{ items: any[] }>('/notices?all=true'));
  const cols = useLoad(() => fetch('/identity/v1/masters/colonies').then((r) => r.json()));
  const mine = (cols.data || []).filter((c: any) => c.area === area);
  const [colony, setColony] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [hours, setHours] = useState('6');
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => { if (!colony && mine.length === 1) setColony(mine[0].id); }, [mine, colony]);
  const post = async () => {
    setBusy(true);
    try {
      await api('/notices', { body: { colony_id: colony, title, body, ends_at: hours ? new Date(Date.now() + Number(hours) * 3600e3).toISOString() : null } });
      toast({ text: 'Notice posted · residents of the colony see it before reporting' });
      setTitle(''); setBody(''); list.reload();
    } catch (e: any) { toast({ text: e.message, tone: 'bad' }); } finally { setBusy(false); }
  };
  const end = async (id: string) => {
    try { await api(`/notices/${id}/end`, { body: { reason } }); setEnding(null); setReason(''); list.reload(); toast({ text: 'Notice ended' }); }
    catch (e: any) { toast({ text: e.message, tone: 'bad' }); }
  };
  return (
    <Dialog open title="Colony notices" onClose={onClose} width={640}>
      <div className="grid gap-3">
        <p className="text-[13px] text-ink-muted">One notice for a colony-wide fault saves many identical complaints. Residents of the colony see it on their home and before they report. A notice is ended with a reason, never edited or deleted.</p>
        <div className="grid sm:grid-cols-[1fr_120px] gap-3">
          <Field label="Colony" required><select id="nt-colony" className={inputCls} value={colony} onChange={(e) => setColony(e.target.value)}>
            <option value="">Choose…</option>{mine.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Show for"><select id="nt-hours" className={inputCls} value={hours} onChange={(e) => setHours(e.target.value)}>
            {[['2', '2 hours'], ['6', '6 hours'], ['24', '1 day'], ['72', '3 days'], ['', 'Until ended']].map(([v, l]) => <option key={l} value={v}>{l}</option>)}</select></Field>
        </div>
        <Field label="Title" required help={`${title.length} / 120`}><input id="nt-title" className={inputCls} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Water supply to Block B off until 4 pm" /></Field>
        <Field label="Details" help={`${body.length} / 600`}><textarea id="nt-body" className={inputCls + ' h-auto min-h-[70px] py-2'} maxLength={600} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What is happening, and what residents need not report" /></Field>
        <div className="flex justify-end"><Button disabled={!colony || !title.trim()} loading={busy} onClick={post}>Post notice</Button></div>
        <div className="border-t border-line pt-3">
          <div className="label mb-2">Notices in this Area</div>
          {(list.data?.items || []).length === 0 && <p className="text-[13px] text-ink-muted">None yet.</p>}
          <ul className="grid gap-2">
            {(list.data?.items || []).map((n) => (
              <li key={n.id} className={clsx('rounded-xl border p-3 text-[13px]', n.ended_at ? 'border-line bg-muted' : 'border-risk/30 bg-risk-bg')}>
                <div className="flex justify-between gap-3"><b>{n.title}</b>
                  {!n.ended_at && ending !== n.id && <Button size="sm" variant="secondary" onClick={() => { setEnding(n.id); setReason(''); }}>End</Button>}</div>
                <div className="text-xs text-ink-muted mt-0.5">Posted {absTime(n.posted_at)}{n.ends_at ? ` · until ${absTime(n.ends_at)}` : ''}{n.ended_at ? ` · ended ${absTime(n.ended_at)} — “${n.end_reason}”` : ''}</div>
                {ending === n.id && (
                  <div className="flex gap-2 mt-2">
                    <input id={`nt-end-${n.id}`} className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it ends, e.g. valve repaired at 3:10 pm" />
                    <Button disabled={!reason.trim()} onClick={() => end(n.id)}>End notice</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Dialog>
  );
}

function BulkAssign({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const cs = useLoad(() => api<any[]>('/devices/assignable'));
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api('/tickets/assign-bulk', { body: { ticket_ids: ids, supervisor_id: pick } });
      const name = cs.data?.find((c) => c.actor_id === pick)?.person_name;
      toast({ text: `${r.assigned} complaint${r.assigned === 1 ? '' : 's'} assigned to ${name}${r.failed.length ? ` · ${r.failed.length} refused` : ''}`, tone: r.failed.length ? 'bad' : 'ok' });
      onDone();
    } catch (e: any) { toast({ text: e.message, tone: 'bad' }); } finally { setBusy(false); }
  };
  return (
    <Dialog open title={`Assign ${ids.length} complaint${ids.length > 1 ? 's' : ''}`} onClose={onClose}
      actions={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!pick} loading={busy} onClick={go}>Assign work</Button></>}>
      <p className="text-[13px] text-ink-muted mb-3">Only the contractor supervisors registered in this Area are listed, with their open jobs.</p>
      <div className="flex flex-col gap-2">
        {(cs.data || []).map((c) => (
          <label key={c.actor_id} className={'flex items-center gap-3 p-3 rounded-input border cursor-pointer ' + (pick === c.actor_id ? 'border-primary bg-tint' : 'border-line')}>
            <input type="radio" name="c" checked={pick === c.actor_id} onChange={() => setPick(c.actor_id)} />
            <span className="flex-1 min-w-0"><span className="font-medium">{c.person_name}</span>{c.contractor_name && <span className="block text-xs text-ink-muted truncate">{c.contractor_name}</span>}</span><span className="text-xs text-ink-muted tnum">{c.open_jobs} open jobs</span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}

/* Non-residential buildings have no resident: the Overseer or Incharge
   raises the complaint (decision 27). */
function RaiseForBuilding({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const prem = useLoad(() => idApi<{ items: any[] }>('/premises'));
  const cats = useLoad(() => api<any[]>('/masters/categories'));
  const [p, setP] = useState('');
  const [sub, setSub] = useState('');
  const [desc, setDesc] = useState('');
  // nothing is attached unless the officer adds it (user's finding, 2026-10-12:
  // a generated picture was attached to every building complaint unasked)
  const [photos, setPhotos] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const buildings = (prem.data?.items || []).filter((x) => x.premises_type !== 'QUARTER');
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const t = await api('/tickets', { body: { premises_id: p, sub_category_id: sub, description: desc || null } });
      for (let n = 1; n <= photos; n++) await takePhoto(t.id, 'COMPLAINT', `Reported by the civil office (${n} of ${photos})`).catch(() => {});
      toast({ text: `Complaint registered · ${t.ticket_no}` }); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Dialog open title="Raise a complaint for a building" onClose={onClose} width={560}
      actions={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!p || !sub} loading={busy} onClick={go}>Raise complaint</Button></>}>
      <div className="grid gap-4">
        <Field label="Building" required>
          <select className={inputCls} value={p} onChange={(e) => setP(e.target.value)}>
            <option value="">Choose…</option>
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.identifier} — {b.premises_type.replace('_', ' ').toLowerCase()}</option>)}
          </select>
        </Field>
        <Field label="Problem" required>
          <select className={inputCls} value={sub} onChange={(e) => setSub(e.target.value)}>
            <option value="">Choose…</option>
            {(cats.data || []).filter((c) => c.classification !== 'EM').map((c) => <option key={c.id} value={c.id}>{c.category} — {c.name_en}</option>)}
          </select>
        </Field>
        <Field label="Description"><textarea className={inputCls + ' h-auto min-h-[80px] py-2'} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        <Field label="Photographs" help="Optional, up to three. Web demo: an image is generated in place of a camera; the app takes real ones.">
          <Button variant="secondary" onClick={() => setPhotos((n) => (n + 1) % 4)}>
            {photos ? `${photos} of 3 will be attached — tap to change` : 'Add photographs (none attached)'}</Button>
        </Field>
        {err && <ErrorState message={err} />}
      </div>
    </Dialog>
  );
}

/* The work queue's tiles, smaller (user's direction, 2026-10-15): a count,
   a label and a caption; selected, it filters the sections. The decision tile
   is red on its own background whenever anything waits. */
function Tile({ label, value, caption, tone, on, alarm, onClick }:
  { label: string; value: number; caption: string; tone?: 'risk' | 'bad' | 'await'; on: boolean; alarm?: boolean; onClick: () => void }) {
  const fg = tone === 'bad' ? 'text-bad' : tone === 'risk' ? 'text-risk' : tone === 'await' ? 'text-await' : 'text-primary';
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={clsx('lift text-left rounded-card border px-3.5 py-2.5 flex items-center gap-3 min-h-[68px] transition-colors',
        alarm ? 'bg-bad-bg border-bad/40' : on ? 'bg-tint border-primary/40' : 'bg-surface border-line hover:bg-muted')}>
      <span className={clsx('text-[26px] font-semibold tnum leading-none tracking-[-0.02em]', value > 0 || !tone ? fg : 'text-ink-muted')}>{value}</span>
      <span className="min-w-0">
        <span className={clsx('block text-[13px] font-semibold leading-tight', alarm && 'text-bad')}>{label}</span>
        <span className="block text-[11.5px] text-ink-muted leading-tight truncate">{caption}</span>
      </span>
    </button>
  );
}
