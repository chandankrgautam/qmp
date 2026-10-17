import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, Download, Minus, MonitorPlay, Presentation, X } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState, KpiTile, SectionLabel, Segmented, Skeleton, useToast } from '../../components/ui';
import { PageHeader } from '../../components/shell/Shells';
import { api, session } from '../../lib/api';
import { num, pct } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import type { Tone } from '../../lib/domain';
import { CategoryMatrix, Funnel, Heatmap, LagChart, LoadScatter, RankSlope, SlaTracker, TrendChart, monthLabel } from './HqCharts';

/* Executive dashboard for the GM Civil, Directors and CMD (read-only, all
   Areas). Every figure is computed by the server from the record; this page
   only presents it. Evidence only: no deductions or money (control 9). */

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const slaTone = (v: number | null, target: number): Tone => v === null ? 'neutral' : v >= target ? 'ok' : v >= target - 15 ? 'risk' : 'bad';
const CHIP: Record<Tone, string> = { ok: 'bg-ok-bg text-ok', risk: 'bg-risk-bg text-risk', bad: 'bg-bad-bg text-bad', info: 'bg-info-bg text-info',
  reopen: 'bg-reopen-bg text-reopen', await: 'bg-await-bg text-await', neutral: 'bg-muted text-ink-muted' };
const n1 = (v: any) => (v === null || v === undefined ? null : Number(v));
const toArea = (code: string) => `/w/search?ticket_no=${encodeURIComponent(code + '/')}`;

type Pair = { now: number | null; prev: number | null };

/** Change against the previous month. For reopen and hours, up is bad. */
function Delta({ p, upBad, unit = '', digits = 1 }: { p: Pair; upBad?: boolean; unit?: string; digits?: number }) {
  const a = n1(p.now), b = n1(p.prev);
  if (a === null || b === null) return <span>no previous month to compare</span>;
  const d = a - b;
  if (Math.abs(d) < 0.05) return <span className="inline-flex items-center gap-1"><Minus size={14} />unchanged</span>;
  const bad = upBad ? d > 0 : d < 0;
  const Icon = d > 0 ? ArrowUp : ArrowDown;
  return <span className={'inline-flex items-center gap-1 font-medium ' + (bad ? 'text-bad' : 'text-ok')}>
    <Icon size={14} />{num(Math.abs(d), digits)}{unit} vs last month</span>;
}

export default function Hq() {
  const nav = useNavigate();
  const [months, setMonths] = useState('12');
  const [meeting, setMeeting] = useState(false);
  const r = useLoad(() => api<any>(`/hq/executive?months=${months}`), [months]);
  const d = r.data;

  const slides: { title: string; sub?: string; el: ReactNode }[] = d ? [
    { title: 'Areas compared', el: <RankTable d={d} big /> },
    { title: 'SLA compliance trend', el: <Fill><TrendChart trend={d.trend} target={d.target_percent} /></Fill> },
    { title: 'SLA by Area and month', el: <Heatmap heatmap={d.heatmap} target={d.target_percent} /> },
    { title: 'Where the time goes', el: <Fill><LagChart lag={d.lag} /></Fill> },
    { title: 'Complaint funnel', el: <Funnel funnel={d.funnel} exits={d.funnel_exits} /> },
    { title: 'Load against performance', el: <Fill><LoadScatter areas={d.areas} target={d.target_percent} /></Fill> },
    { title: 'Rank movement', el: <Fill><RankSlope areas={d.areas} /></Fill> },
    { title: 'Category concentration by Area', el: <CategoryMatrix categories={d.categories} /> }
  ] : [];

  return (
    <>
      <PageHeader title="All-Areas overview" sub={d ? `${monthLabel(d.period.labels[0])} to ${monthLabel(d.period.labels[d.period.labels.length - 1])} · SLA target ${d.target_percent}%` : 'All Areas, read-only'}
        action={<div className="flex flex-wrap items-center gap-2">
          <Segmented value={months} onChange={setMonths} options={[3, 6, 12, 24].map((m) => ({ value: String(m), label: `${m} months` }))} />
          <Button variant="secondary" icon={<Presentation size={18} />} disabled={!d} onClick={() => setMeeting(true)}>Meeting mode</Button>
          <Button variant="secondary" icon={<MonitorPlay size={18} />} onClick={() => nav('/w/hq/wall')}>Wall display</Button>
          <Download_ months={months} />
        </div>} />
      {r.error && <ErrorState message={r.error} retry={r.reload} />}
      {!d && !r.error && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Skeleton key={i} className="h-[104px]" />)}</div>}
      {d && (
        <div className="space-y-4">
          <Kpis d={d} />
          <Watch watch={d.watch} />
          <Card className="overflow-hidden">
            <div className="p-5 pb-3"><SectionLabel>{d.areas.length} Areas compared</SectionLabel>
              <p className="text-[13px] text-ink-muted mt-1">Ranked by SLA compliance, then complaints. Select an Area to see its complaints.</p></div>
            <RankTable d={d} />
            <p className="text-xs text-ink-muted px-5 py-3 border-t border-line leading-relaxed">
              <b>SLA compliance</b>: completion claims judged on the contractor&apos;s own clock, less recorded pauses, within the SLA fixed at verification.
              {' '}<b>First-time fix</b>: closed with no rework and no reopening. <b>Reopen</b>: closed complaints that were reopened.
              {' '}<b>Median hours</b>: raised to closed. <b>Confirmation</b>: closed complaints the resident confirmed, where there is a resident.
              {' '}<b>Per 100</b>: complaints per 100 quarters per month. A complaint counts in the month it was raised; rejected ones included.
            </p>
          </Card>
          <div className="grid xl:grid-cols-2 gap-4">
            <Panel title="SLA compliance trend" sub="Monthly, against the target; bars show complaints raised"><div className="h-72"><TrendChart trend={d.trend} target={d.target_percent} /></div></Panel>
            <Panel title="SLA by Area and month" sub="One block per month; hover a block for the figure"><SlaTracker heatmap={d.heatmap} target={d.target_percent} /></Panel>
            <Panel title="Where the time goes" sub="Average hours per closed complaint, split by who holds it"><LagChart lag={d.lag} /></Panel>
            <Panel title="Complaint funnel" sub="Where complaints stop moving, for those raised in the period"><Funnel funnel={d.funnel} exits={d.funnel_exits} /></Panel>
            <Panel title="Load against performance" sub="Each dot is an Area · x = complaints per 100 quarters per month · y = SLA compliance"><div className="h-80"><LoadScatter areas={d.areas} target={d.target_percent} /></div></Panel>
            <Panel title="Rank movement" sub="Position by SLA compliance, last month to this month"><div className="h-[420px] flex justify-center"><RankSlope areas={d.areas} /></div></Panel>
            <Panel title="Category concentration by Area" sub="Bubble size is the share of that Area's complaints" className="xl:col-span-2"><CategoryMatrix categories={d.categories} /></Panel>
          </div>
          <Contractors rows={d.contractors} target={d.target_percent} />
          <p className="text-xs text-ink-muted">Evidence only — no deductions or amounts are calculated (control 9).</p>
        </div>
      )}
      {meeting && d && <MeetingMode slides={slides} onClose={() => setMeeting(false)} />}
    </>
  );
}

const Fill = ({ children }: { children: ReactNode }) => <div className="h-full min-h-[320px]">{children}</div>;

function Panel({ title, sub, children, className }: { title: string; sub?: string; children: ReactNode; className?: string }) {
  return <Card className={'p-5 min-w-0 ' + (className || '')}><SectionLabel>{title}</SectionLabel>{sub && <p className="text-[13px] text-ink-muted mt-1">{sub}</p>}<div className="mt-4">{children}</div></Card>;
}

function Download_({ months }: { months: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/maintenance/v1/hq/executive.csv?months=${months}`, { headers: { authorization: `Bearer ${session.get()?.token}` } });
      if (!res.ok) { toast({ text: 'Export failed. Try again.', tone: 'bad' }); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = `hq-executive-${months}-months.csv`;
      a.click();
      toast({ text: 'Overview downloaded' });
    } catch { toast({ text: 'Export failed. Try again.', tone: 'bad' }); } finally { setBusy(false); }
  };
  return <Button variant="secondary" icon={<Download size={18} />} loading={busy} onClick={go}>Download CSV</Button>;
}

function Kpis({ d }: { d: any }) {
  const k = d.kpis, t = d.target_percent;
  const live = (v: number, bad = true): { valueTone?: Tone; tone: Tone | 'neutral' } => (bad && v > 0 ? { valueTone: 'bad', tone: 'bad' } : { tone: 'neutral' });
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile label="Complaints this month" value={num(k.complaints.now)} caption={<Delta p={k.complaints} digits={0} upBad />} />
        <KpiTile label="SLA compliance" value={pct(k.sla_pct.now)} valueTone={slaTone(n1(k.sla_pct.now), t) === 'neutral' ? undefined : slaTone(n1(k.sla_pct.now), t)}
          caption={<><div>Target {t}%</div><Delta p={k.sla_pct} unit=" pts" /></>} />
        <KpiTile label="First-time fix" value={pct(k.first_time_fix_pct.now)} caption={<Delta p={k.first_time_fix_pct} unit=" pts" />} />
        <KpiTile label="Median hours to close" value={k.median_close_hours.now === null ? '—' : num(k.median_close_hours.now, 1)} caption={<Delta p={k.median_close_hours} unit=" h" upBad />} />
        <KpiTile label="Reopen rate" value={pct(k.reopen_pct.now)} caption={<Delta p={k.reopen_pct} unit=" pts" upBad />} />
        <KpiTile label="Resident confirmation" value={pct(k.confirmation_pct.now)} caption={<Delta p={k.confirmation_pct} unit=" pts" />} />
        <KpiTile label="Average rating" value={k.avg_rating.now === null ? '—' : num(k.avg_rating.now, 2)} caption={<Delta p={k.avg_rating} digits={2} />} />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile label="Open now" value={num(k.open_now)} />
        <KpiTile label="Overdue now" value={num(k.overdue_now)} {...live(k.overdue_now)} />
        <KpiTile label="Inspection waiting > 48 h" value={num(k.inspection_waiting)} {...live(k.inspection_waiting)} />
        <KpiTile label="Open at level 4" value={num(k.open_level4)} caption="Reached the GM" {...live(k.open_level4)} />
      </div>
    </>
  );
}

function Watch({ watch }: { watch: any[] }) {
  const nav = useNavigate();
  return (
    <Card className="p-5">
      <SectionLabel>Needs HQ attention</SectionLabel>
      {watch.length === 0 ? <p className="text-[13px] text-ink-muted mt-2">Nothing needs HQ attention. No Area is below target, waiting on an inspection or at escalation level 4.</p> : (
        <ul className="mt-3 divide-y divide-line">
          {watch.map((w, i) => (
            <li key={i}><button onClick={() => nav(toArea(w.code))}
              className="w-full text-left flex items-start gap-3 py-2.5 hover:bg-row-hover rounded-lg px-2 -mx-2">
              <span className={'shrink-0 mt-0.5 inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold ' + (w.severity === 'critical' ? CHIP.bad : CHIP.risk)}>{w.severity === 'critical' ? 'Critical' : 'Warning'}</span>
              <span className="min-w-0"><span className="font-semibold">{w.code}</span> <span className="text-ink">{w.title}</span>
                <span className="block text-[13px] text-ink-muted">{w.detail}</span></span>
            </button></li>))}
        </ul>)}
    </Card>
  );
}

function Move({ now, prev }: { now: number; prev: number }) {
  if (now === prev) return <Minus size={14} className="text-ink-muted" aria-label="no change" />;
  return now < prev
    ? <span className="inline-flex items-center text-ok" aria-label={`up ${prev - now}`}><ArrowUp size={14} />{prev - now}</span>
    : <span className="inline-flex items-center text-bad" aria-label={`down ${now - prev}`}><ArrowDown size={14} />{now - prev}</span>;
}

function RankTable({ d, big }: { d: any; big?: boolean }) {
  const nav = useNavigate();
  const t = d.target_percent;
  const heads = ['#', '', 'Area', 'Quarters', 'Contractor', 'Complaints', 'Per 100', 'SLA', 'First-time fix', 'Reopen', 'Median h', 'Confirmed', 'Rating', 'Open / overdue'];
  if (!d.areas.some((a: any) => a.complaints > 0 || a.open_now > 0)) return <EmptyState title="Nothing recorded yet" body="Areas appear here with figures once complaints are raised." />;
  return (
    <div className="overflow-auto">
      <table className={'w-full tnum ' + (big ? 'text-xl min-w-[1000px]' : 'text-[13px] min-w-[1100px]')}>
        <thead className="bg-bg"><tr className="text-left">{heads.map((h, i) => <th key={i} className="label px-3 py-3 whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>
          {d.areas.map((a: any) => (
            <tr key={a.code} className={'border-t border-line hover:bg-row-hover cursor-pointer ' + (big ? 'h-14' : 'h-[52px]')} onClick={() => nav(toArea(a.code))}>
              <td className="px-3 font-semibold">{a.rank}</td>
              <td className="px-1">{a.sla_now !== null && a.sla_prev !== null ? <Move now={a.rank_now} prev={a.rank_prev} /> : <span className="text-ink-muted">—</span>}</td>
              <td className="px-3 whitespace-nowrap"><span className="inline-block px-2 py-0.5 rounded-md bg-tint text-[11px] font-semibold mr-2">{a.code}</span><b>{a.name}</b></td>
              <td className="px-3">{num(a.quarters)}</td>
              <td className="px-3 text-ink-muted max-w-[220px] truncate" title={(a.contractors || []).join('; ')}>{(a.contractors || []).join('; ') || '—'}</td>
              <td className="px-3">{num(a.complaints)}</td>
              <td className="px-3">{a.per100 === null ? '—' : num(a.per100, 2)}</td>
              <td className="px-3"><span className={'inline-block px-3 py-1 rounded-lg font-semibold ' + CHIP[slaTone(n1(a.sla_pct), t)]}>{a.sla_pct === null ? '—' : pct(a.sla_pct)}</span></td>
              <td className="px-3">{pct(a.first_time_fix_pct)}</td>
              <td className="px-3">{pct(a.reopen_pct)}</td>
              <td className="px-3">{a.median_close_hours === null ? '—' : num(a.median_close_hours, 1)}</td>
              <td className="px-3">{pct(a.confirmation_pct)}</td>
              <td className="px-3">{a.avg_rating === null ? '—' : num(a.avg_rating, 2)}</td>
              <td className="px-3 whitespace-nowrap">{num(a.open_now)} / <span className={a.overdue_now > 0 ? 'text-bad font-semibold' : ''}>{num(a.overdue_now)}</span></td>
            </tr>))}
        </tbody>
      </table>
    </div>
  );
}

function Contractors({ rows, target }: { rows: any[]; target: number }) {
  return (
    <Card className="overflow-hidden">
      <div className="p-5 pb-3"><SectionLabel>Contractors across Areas</SectionLabel>
        <p className="text-[13px] text-ink-muted mt-1">Flagged where one contractor is below target in more than one Area</p></div>
      {rows.length === 0 ? <EmptyState title="Nothing recorded yet" body="Contractors appear once complaints are assigned to them." /> : (
        <div className="overflow-auto">
          <table className="w-full text-[13px] min-w-[720px] tnum">
            <thead className="bg-bg"><tr className="text-left">{['Contractor', 'Areas', 'Complaints', 'SLA', 'Breaches', 'Below target in'].map((h) => <th key={h} className="label px-4 py-3 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.contractor_name} className={'border-t border-line h-12 ' + (c.flagged ? 'bg-bad-bg' : '')}>
                <td className="px-4 font-semibold">{c.contractor_name}{c.flagged && <span className="ml-2 text-[11px] font-semibold text-bad">Flagged</span>}</td>
                <td className="px-4">{(c.areas || []).join(', ')}</td>
                <td className="px-4">{num(c.complaints)}</td>
                <td className="px-4"><span className={'inline-block px-3 py-1 rounded-lg font-semibold ' + CHIP[slaTone(n1(c.sla_pct), target)]}>{c.sla_pct === null ? '—' : pct(c.sla_pct)}</span></td>
                <td className="px-4">{num(c.breaches)}</td>
                <td className="px-4">{(c.below_target_areas || []).join(', ') || '—'}</td>
              </tr>))}</tbody>
          </table>
        </div>)}
    </Card>
  );
}

/* Large type, high contrast. Charts rotate every 12 s and pause while the
   pointer or focus is on them; nothing rotates under reduced motion. */
function MeetingMode({ slides, onClose }: { slides: { title: string; el: ReactNode }[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const still = reduced();
  useEffect(() => {
    if (paused || still) return;
    const id = setInterval(() => setI((x) => (x + 1) % slides.length), 12000);
    return () => clearInterval(id);
  }, [paused, still, slides.length]);
  useEffect(() => { const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', esc); return () => removeEventListener('keydown', esc); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-primary-dark text-white p-6 sm:p-10 flex flex-col" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div className="text-3xl font-bold">{slides[i].title}</div>
        <div className="flex gap-2 items-center">
          <span className="text-white/60 text-sm">{still ? 'Rotation off' : paused ? 'Paused' : 'Next in 12 s'}</span>
          <Button variant="ghost" className="!text-white" onClick={() => setI((i + 1) % slides.length)}>Next</Button>
          <Button variant="ghost" className="!text-white" icon={<X />} onClick={onClose}>Close</Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 mt-6 bg-surface text-ink rounded-dialog p-6 sm:p-8 overflow-auto">{slides[i].el}</div>
    </div>
  );
}
