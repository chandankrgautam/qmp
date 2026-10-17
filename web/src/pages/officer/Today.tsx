import { useState } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { Clock, Flag, Footprints, MessageSquareWarning, Ruler, Zap } from 'lucide-react';
import { Card, EmptyState, ErrorState, Skeleton, SlaRing, StatusChip } from '../../components/ui';
import { categoryIcon } from '../../components/ui/icons';
import { PageHeader } from '../../components/shell/Shells';
import TicketPanel from './TicketPanel';
import { api } from '../../lib/api';
import { deadlineSla, slaText } from '../../lib/domain';
import { relTime, shortDate } from '../../lib/format';
import { useAutoRefresh, useLoad } from '../../lib/useLoad';

/* Today: only what waits for this officer now (user's decision, 2026-10-15,
   on porting the design experiment). Each task opens the complaint panel,
   where the action is taken exactly as on the work queue; the list reloads
   the moment an action is taken, and every half minute.

   Inspections keep the departmental queue's order exactly as the server
   gives it (control 8): emergencies, then the priority the Overseer or
   Incharge set, then premises type, then the date the complaint was
   verified — never the contractor's completion claim. Accepting an
   inspection is the app's alone (control 1); the panel says so. */

const MIN_PER_STOP = 12; // the planning figure of the load simulation (README §6)

export default function Today() {
  const [open, setOpen] = useState<string | null>(null);
  const d = useLoad(async () => {
    const [list, q, objections, wm, wt] = await Promise.all([
      api<{ items: any[] }>('/tickets'),
      api<{ items: any[]; oldest_pending_hours: number }>('/inspections/queue').catch(() => ({ items: [] as any[], oldest_pending_hours: 0 })),
      api<{ items: any[] }>('/objections?open=true').catch(() => ({ items: [] as any[] })),
      // each job's measurements and materials waiting at this officer's step (2026-10-16)
      api<any>('/mb/worklist?month=open&kind=measurements').catch(() => ({ rows: [] })),
      api<any>('/mb/worklist?month=open&kind=materials').catch(() => ({ rows: [] }))
    ]);
    const can = (t: any, a: string) => (t.available_actions || []).includes(a);
    const byId = new Map(list.items.map((t) => [t.id, t]));
    return {
      oldest: q.oldest_pending_hours,
      decide: list.items.filter((t) => t.breach_unattributed || t.l4_remark_needed),
      // the queue's own order, untouched; only the ones this officer may inspect
      inspect: q.items.map((s) => ({ ...byId.get(s.id), ...s })).filter((t) => can(t, 'inspect')),
      verify: list.items.filter((t) => t.state === 'RAISED' && can(t, 'verify')),
      assign: list.items.filter((t) => ['VERIFIED', 'REOPENED'].includes(t.state) && can(t, 'assign') && !t.assignee_role_ended),
      reassign: list.items.filter((t) => t.assignee_role_ended && can(t, 'assign')),
      close: list.items.filter((t) => t.state === 'INSPECTED_ACCEPTED' && can(t, 'close') && !t.l4_remark_needed),
      objections: objections.items,
      sheets: [...wm.rows.filter((r: any) => r.mine).map((r: any) => ({ ...r, kind: 'Measurements' })),
               ...wt.rows.filter((r: any) => r.mine).map((r: any) => ({ ...r, kind: 'Materials' }))]
        .sort((a: any, b: any) => b.days_at_step - a.days_at_step),
      waitDays: wm.wait_days ?? 7
    };
  });
  useAutoRefresh(d.reload, 30, open !== null);
  const x = d.data;
  const total = x ? x.decide.length + x.inspect.length + x.verify.length + x.assign.length + x.reassign.length + x.close.length + x.objections.length + x.sheets.length : 0;
  const mins = (x?.inspect.length || 0) * MIN_PER_STOP;

  return (
    <>
      <PageHeader title="Today" sub={`${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}${x ? ` · ${total} task${total === 1 ? '' : 's'} waiting for you` : ''}`} />
      {d.error && <ErrorState message={d.error} retry={d.reload} />}
      {!x && !d.error && <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>}
      {x && (
        <div className="grid xl:grid-cols-[1fr_320px] gap-6 items-start">
          <div className="grid gap-6">
            {x.inspect.length > 0 && (
              <div className="flex flex-wrap gap-3">
                <Summary icon={<Footprints size={18} />} value={String(x.inspect.length)} label={x.inspect.length === 1 ? 'inspection to do' : 'inspections to do'} />
                <Summary icon={<Clock size={18} />} value={mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60 ? `${mins % 60} min` : ''}` : `${mins} min`} label={`on site, at ${MIN_PER_STOP} min each`} />
                <Summary icon={<Flag size={18} />} value={`${x.oldest} h`} label="oldest claim waiting" tone={x.oldest >= 48 ? 'bad' : undefined} />
              </div>
            )}
            {total === 0 && <Card><EmptyState title="Nothing waiting for you" body="New complaints to verify, work to assign, claims to inspect and complaints to close appear here as they arrive." /></Card>}
            <Section title="Needs a decision" hint="an SLA breach to attribute, or the level-4 remark" rows={x.decide} alarm onOpen={setOpen}
              line={(t) => t.l4_remark_needed ? 'Level 4 — the Staff Officer’s remark is needed before closing' : 'SLA breach — whose delay? Attribute it on the Area dashboard'} />
            {x.objections.length > 0 && (
              <section aria-label="Objections to answer">
                <h2 className="text-[15px] font-semibold mb-2">Objections to answer <span className="text-ink-muted font-normal tnum">· {x.objections.length}</span>
                  <span className="text-xs text-ink-muted font-normal ml-2">within 24 hours</span></h2>
                <div className="grid gap-2">
                  {x.objections.map((o: any) => (
                    <Card key={o.id} onClick={() => setOpen(o.ticket_id)} className="p-3.5 flex items-center gap-3">
                      <MessageSquareWarning size={18} className="text-risk shrink-0" />
                      <div className="min-w-0 flex-1"><div className="font-semibold tnum text-[13.5px]">{o.ticket_no}{o.overdue && <span className="text-bad"> · overdue</span>}</div>
                        <div className="text-[13px] text-ink-muted truncate">“{o.note}”</div></div>
                    </Card>
                  ))}
                </div>
              </section>
            )}
            <Section title="To inspect" hint="in the department’s order" rows={x.inspect} numbered onOpen={setOpen}
              line={(t) => `Claimed ${t.waiting_hours ?? '—'} h ago${t.inspection_priority_note ? ` · “${t.inspection_priority_note}”` : ''}${t.workmen_assigned ? ` · workmen ${t.workmen_assigned}` : ''}`} />
            <Section title="To verify" hint="oldest first" rows={[...x.verify].reverse()} onOpen={setOpen} line={(t) => `Raised ${relTime(t.raised_at)}`} />
            <Section title="To assign" hint="verified, for a contractor supervisor" rows={x.assign} onOpen={setOpen}
              line={(t) => t.state === 'REOPENED' ? 'Reopened — to be given back' : `Verified · due ${shortDate(t.completion_deadline_at)}`} />
            <Section title="To reassign" hint="the supervisor’s role has ended" rows={x.reassign} alarm onOpen={setOpen} line={() => 'Supervisor’s role has ended — reassign'} />
            <Section title="To close" hint="inspected and accepted" rows={x.close} onOpen={setOpen} line={() => 'Inspected and accepted — to close'} />
            {x.sheets.length > 0 && (
              <section aria-label="Measurements and materials to review">
                <h2 className="text-[15px] font-semibold mb-2">Measurements and materials to review <span className="text-ink-muted font-normal tnum">· {x.sheets.length}</span>
                  <span className="text-xs text-ink-muted font-normal ml-2">at your step of the approval chain · <Link to="/w/mb" className="text-primary">the worklist</Link></span></h2>
                <div className="grid gap-2">
                  {x.sheets.map((r: any) => (
                    <Card key={`${r.kind}${r.ticket_id}`} onClick={() => setOpen(r.ticket_id)} className={clsx('p-3.5 flex items-center gap-3', r.waiting_long && 'border-bad/40 bg-bad-bg')}>
                      <Ruler size={18} className={clsx('shrink-0', r.waiting_long ? 'text-bad' : 'text-primary')} />
                      <div className="min-w-0 flex-1"><div className="font-semibold text-[13.5px]">Qtr {r.identifier} <span className="text-xs text-ink-muted tnum font-normal">{r.ticket_no}</span></div>
                        <div className={clsx('text-xs', r.waiting_long ? 'text-bad font-semibold' : 'text-ink-muted')}>{r.kind} · {r.sent_back ? 'sent back to you · ' : ''}{r.days_at_step} days at your step{r.waiting_long ? ` — over ${x.waitDays} days` : ''}{r.changes ? ` · ${r.changes} changed` : ''}</div></div>
                    </Card>
                  ))}
                </div>
              </section>
            )}
          </div>
          <Card className="p-5 text-[13px] leading-relaxed xl:sticky xl:top-24">
            <div className="font-semibold text-[15px] mb-2">How this page works</div>
            <p className="text-ink-muted">Only what waits for you. Open a task to act on it in the complaint panel, as on the work queue; it leaves this page as soon as it is done.</p>
            <p className="text-ink-muted mt-2">Inspections follow the department’s order: <b className="text-ink">emergencies</b>, then any <b className="text-ink">priority</b> set, then the <b className="text-ink">type of premises</b>, then the <b className="text-ink">date verified</b> — never when the contractor claimed the work.</p>
            <p className="text-ink-muted mt-2">Accepting an inspection is done in the app on your registered phone; everything else can be done here.</p>
          </Card>
        </div>
      )}
      {open && <TicketPanel id={open} onClose={() => setOpen(null)} onChanged={d.reload} />}
    </>
  );
}

function Section({ title, hint, rows, line, onOpen, numbered, alarm }:
  { title: string; hint: string; rows: any[]; line: (t: any) => string; onOpen: (id: string) => void; numbered?: boolean; alarm?: boolean }) {
  if (!rows.length) return null;
  return (
    <section aria-label={title}>
      <h2 className={clsx('text-[15px] font-semibold mb-2', alarm && 'text-bad')}>{title} <span className="text-ink-muted font-normal tnum">· {rows.length}</span>
        <span className="text-xs text-ink-muted font-normal ml-2">{hint}</span></h2>
      <ol className="grid gap-2">
        {rows.map((t, k) => {
          const I = categoryIcon(t.category);
          const sla = deadlineSla(t.completion_deadline_at, t.sla_completion_minutes, t.state);
          return (
            <li key={t.id}>
              <Card onClick={() => onOpen(t.id)} className={clsx('p-3.5 flex items-center gap-3.5', alarm && 'border-bad/40 bg-bad-bg', sla?.tone === 'bad' && !alarm && 'breach')}>
                {numbered && <span className={clsx('w-9 h-9 rounded-xl grid place-items-center font-semibold tnum shrink-0',
                  k === 0 ? 'bg-primary-btn text-on-primary' : 'bg-surface border border-line-strong text-primary')}>{k + 1}</span>}
                {sla ? <SlaRing size={52} fraction={sla.fraction} tone={sla.tone} label={slaText(sla.left)} />
                  : <SlaRing size={52} fraction={0} tone="neutral" label="—" />}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{t.premises_type === 'QUARTER' || !t.premises_type ? 'Qtr No. ' : ''}{t.identifier}</span>
                    <span className="text-xs text-ink-muted tnum">{t.ticket_no}</span>
                    {t.is_emergency && <StatusChip tone="bad">Emergency</StatusChip>}
                    {t.inspection_priority != null && <span className="inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-xs font-semibold bg-await-bg text-await"><Zap size={13} />Priority {t.inspection_priority}</span>}
                  </div>
                  <div className="flex items-center gap-2 text-[13px] text-ink-muted mt-0.5 min-w-0">
                    <I size={15} className="text-primary shrink-0" /><span className="truncate">{t.sub_category}</span>
                  </div>
                  <div className={clsx('text-xs mt-0.5 truncate', alarm ? 'text-bad font-semibold' : 'text-ink-muted')}>{line(t)}</div>
                </div>
              </Card>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Summary({ icon, value, label, tone }: { icon: React.ReactNode; value: string; label: string; tone?: 'bad' }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-surface border border-line px-4 py-3 min-w-[190px]">
      <span className={clsx('w-9 h-9 rounded-xl grid place-items-center', tone === 'bad' ? 'bg-bad-bg text-bad' : 'bg-tint text-primary')}>{icon}</span>
      <span><span className={clsx('block text-xl font-semibold tnum tracking-[-0.02em]', tone === 'bad' && 'text-bad')}>{value}</span>
        <span className="block text-xs text-ink-muted">{label}</span></span>
    </div>
  );
}
