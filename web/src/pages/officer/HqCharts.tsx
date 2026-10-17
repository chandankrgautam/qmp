import { useEffect, useRef } from 'react';
import { Bar, BarChart, CartesianGrid, ComposedChart, LabelList, Legend, Line, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { EmptyState } from '../../components/ui';
import { num, pct } from '../../lib/format';

/* Charts of the executive dashboard. Every figure is computed by the server;
   nothing here is a rate, a penalty or an amount of money (control 9). */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10' -> 'Oct 2026' (by hand: en-GB writes "Sept"). */
export const monthLabel = (m: string) => { const [y, mm] = m.split('-'); return `${MON[Number(mm) - 1] || mm} ${y}`; };
const shortMonth = (m: string) => `${MON[Number(m.split('-')[1]) - 1] || ''} ${m.slice(2, 4)}`;

export const slaColor = (v: number | null, target: number) =>
  v === null ? 'var(--border-strong)' : v >= target ? 'var(--status-resolved)' : v >= target - 15 ? 'var(--status-at-risk)' : 'var(--status-breached)';

const tip = { borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' };
const tick = { fontSize: 12, fill: 'var(--text-muted)' };
const clamp = (v: number) => Math.max(0, Math.min(100, v));
const NOTHING = <EmptyState title="Nothing recorded yet" body="This chart fills in once complaints have been raised and judged in the period." />;

export function TrendChart({ trend, target }: { trend: any[]; target: number }) {
  if (!trend.some((t) => t.complaints > 0 || t.sla_pct !== null)) return NOTHING;
  const data = trend.map((t) => ({ ...t, label: shortMonth(t.month), sla: t.sla_pct === null ? null : clamp(Number(t.sla_pct)) }));
  return (
    <ResponsiveContainer width="100%" height="100%"><ComposedChart data={data} margin={{ left: -12, right: -8, top: 8 }}>
      <CartesianGrid stroke="var(--border)" vertical={false} />
      <XAxis dataKey="label" tick={tick} axisLine={false} tickLine={false} interval="preserveStartEnd" />
      <YAxis yAxisId="l" domain={[0, 100]} unit="%" tick={tick} axisLine={false} tickLine={false} />
      <YAxis yAxisId="r" orientation="right" allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
      <Tooltip contentStyle={tip} formatter={(v: any, n: any) => [n === 'SLA compliance' ? pct(v) : num(v), n]} />
      <Legend wrapperStyle={{ fontSize: 12 }} />
      <Bar yAxisId="r" dataKey="complaints" name="Complaints" fill="var(--status-info-bg)" stroke="var(--status-info)" radius={[4, 4, 0, 0]} />
      <ReferenceLine yAxisId="l" y={target} stroke="var(--status-at-risk)" strokeDasharray="6 4" label={{ value: `Target ${target}%`, fontSize: 11, fill: 'var(--status-at-risk)', position: 'insideTopRight' }} />
      <Line yAxisId="l" type="monotone" dataKey="sla" name="SLA compliance" stroke="var(--primary)" strokeWidth={2.5} dot={{ r: 3 }} connectNulls />
    </ComposedChart></ResponsiveContainer>
  );
}

export function Heatmap({ heatmap, target }: { heatmap: any[]; target: number }) {
  const months: string[] = heatmap[0]?.months.map((m: any) => m.month) || [];
  if (!heatmap.some((a) => a.months.some((m: any) => m.judged > 0))) return NOTHING;
  const bg = (v: number | null) => v === null ? 'var(--border)'
    : v >= target ? 'color-mix(in srgb, var(--status-resolved) 28%, var(--surface))'
    : `color-mix(in srgb, var(--status-breached) ${Math.round(25 + Math.min(1, (target - v) / 60) * 65)}%, var(--surface))`;
  return (
    // opens scrolled to the latest month, the one that matters most, when
    // the months do not all fit
    <ScrollEnd>
      <table className="text-[12px] tnum border-separate border-spacing-[3px]">
        <thead><tr><th className="sticky left-0 z-10 bg-surface" />{months.map((m) => <th key={m} className="label !text-[10px] px-1 font-medium whitespace-nowrap">{shortMonth(m)}</th>)}</tr></thead>
        <tbody>{heatmap.map((a) => (
          <tr key={a.code}>
            <th scope="row" className="sticky left-0 z-10 bg-surface text-left pr-2 font-semibold whitespace-nowrap" title={a.name}>{a.code}</th>
            {a.months.map((m: any) => (
              <td key={m.month} className="min-w-[38px] h-8 text-center rounded-md text-ink" style={{ background: bg(m.sla_pct === null ? null : Number(m.sla_pct)) }}
                title={`${a.name}, ${monthLabel(m.month)}: ${m.judged ? pct(m.sla_pct) + ' of ' + m.judged + ' judged' : 'nothing judged'}`}>
                {m.sla_pct === null ? '' : Math.round(Number(m.sla_pct))}
              </td>))}
          </tr>))}</tbody>
      </table>
      <p className="text-[11px] text-ink-muted mt-2">Darker red is worse; green is at or above target; grey means nothing was judged. Hover a cell for the number judged.</p>
    </ScrollEnd>
  );
}

/** SLA by Area and month as a tracker (V2, blueprint H1, after Tremor's
    Tracker): one row per Area, one block per month — met, close, missed,
    nothing judged — with the latest figure at the end. Colour is never the
    only signal: each block's title carries the month, the figure and how
    many complaints were judged, and the last column states the number. */
export function SlaTracker({ heatmap, target }: { heatmap: any[]; target: number }) {
  if (!heatmap.some((a) => a.months.some((m: any) => m.judged > 0))) return NOTHING;
  const months: string[] = heatmap[0]?.months.map((m: any) => m.month) || [];
  return (
    <div className="grid gap-1.5">
      <div className="grid grid-cols-[52px_1fr_56px] gap-3 text-[11px] text-ink-muted">
        <span />
        <span className="flex justify-between"><span>{monthLabel(months[0])}</span><span>{monthLabel(months[months.length - 1])}</span></span>
        <span className="text-right">latest</span>
      </div>
      {heatmap.map((a) => {
        const last = [...a.months].reverse().find((m: any) => m.sla_pct !== null);
        return (
          <div key={a.code} className="grid grid-cols-[52px_1fr_56px] gap-3 items-center">
            <span className="text-[12px] font-semibold" title={a.name}>{a.code}</span>
            <span className="flex gap-[3px]" role="img" aria-label={`${a.name}: ${a.months.filter((m: any) => m.judged).map((m: any) => `${monthLabel(m.month)} ${pct(m.sla_pct)}`).join(', ') || 'nothing judged'}`}>
              {a.months.map((m: any) => (
                <span key={m.month} className="flex-1 h-6 rounded-[3px] min-w-[6px]"
                  style={{ background: m.sla_pct === null ? 'var(--muted)' : slaColor(Number(m.sla_pct), target), opacity: m.sla_pct === null ? 1 : 0.85 }}
                  title={`${a.name}, ${monthLabel(m.month)}: ${m.judged ? `${pct(m.sla_pct)} of ${m.judged} judged` : 'nothing judged'}`} />
              ))}
            </span>
            <span className="text-right text-[12.5px] font-semibold tnum" style={{ color: last ? slaColor(Number(last.sla_pct), target) : 'var(--text-muted)' }}>{last ? pct(last.sla_pct) : '—'}</span>
          </div>
        );
      })}
      <p className="text-[11px] text-ink-muted mt-1 flex flex-wrap gap-x-4 gap-y-1">
        <span><i className="inline-block w-2.5 h-2.5 rounded-sm align-middle mr-1" style={{ background: 'var(--status-resolved)' }} />at or above {target}%</span>
        <span><i className="inline-block w-2.5 h-2.5 rounded-sm align-middle mr-1" style={{ background: 'var(--status-at-risk)' }} />within 15 points</span>
        <span><i className="inline-block w-2.5 h-2.5 rounded-sm align-middle mr-1" style={{ background: 'var(--status-breached)' }} />below</span>
        <span><i className="inline-block w-2.5 h-2.5 rounded-sm align-middle mr-1" style={{ background: 'var(--muted)' }} />nothing judged</span>
      </p>
    </div>
  );
}

export function LagChart({ lag }: { lag: any[] }) {
  // the server already gives average hours per closed complaint
  const data = lag.filter((l) => l.closed > 0).map((l) => (
    { code: l.code, Contractor: l.contractor_hours, Department: l.department_hours, Paused: l.paused_hours }));
  if (!data.length) return NOTHING;
  // as tall as the Areas it shows, not a fixed box with one bar at the foot
  return (
    <div style={{ height: Math.max(170, 80 + data.length * 34) }}>
    <ResponsiveContainer width="100%" height="100%"><BarChart data={data} layout="vertical" margin={{ left: 4, right: 12 }}>
      <CartesianGrid stroke="var(--border)" horizontal={false} />
      <XAxis type="number" tick={tick} axisLine={false} tickLine={false} unit="h" />
      <YAxis type="category" dataKey="code" tick={tick} axisLine={false} tickLine={false} width={44} interval={0} />
      <Tooltip cursor={{ fill: 'var(--tint)' }} contentStyle={tip} formatter={(v: any, n: any) => [`${num(v, 1)} h`, n]} />
      <Legend wrapperStyle={{ fontSize: 12 }} />
      <Bar dataKey="Contractor" stackId="t" fill="var(--primary)" />
      <Bar dataKey="Department" stackId="t" fill="var(--status-awaiting)" />
      <Bar dataKey="Paused" stackId="t" fill="var(--border-strong)" />
    </BarChart></ResponsiveContainer>
    </div>
  );
}

const STAGE: Record<string, string> = { RAISED: 'Raised', VERIFIED: 'Verified', ASSIGNED: 'Assigned', CLAIMED: 'Completion claimed',
  ACCEPTED: 'Inspected and accepted', CLOSED: 'Closed', CONFIRMED: 'Resident confirmed' };
export function Funnel({ funnel, exits }: { funnel: any[]; exits: { rejected: number; special_repair: number } }) {
  const top = funnel[0]?.count || 0;
  if (!top) return NOTHING;
  return (
    <div className="space-y-2">
      {funnel.map((s, i) => {
        const prev = i ? funnel[i - 1].count : 0;
        const drop = i && prev ? Math.round(((prev - s.count) / prev) * 100) : null;
        return (
          <div key={s.stage} className="flex items-center gap-3 text-[13px]">
            <div className="w-40 shrink-0">{STAGE[s.stage] || s.stage}</div>
            <div className="flex-1 h-7 bg-tint rounded-md overflow-hidden">
              <div className="h-full bg-primary rounded-md" style={{ width: `${Math.max(2, (s.count / top) * 100)}%` }} />
            </div>
            <div className="w-14 text-right tnum font-semibold">{num(s.count)}</div>
            <div className="w-20 text-right tnum text-ink-muted text-xs">{drop === null ? '' : drop > 0 ? `-${drop}% drop` : 'no drop'}</div>
          </div>);
      })}
      <div className="flex flex-wrap gap-x-6 gap-y-1 pt-2 text-[13px] text-ink-muted border-t border-line">
        <span>Exits: <b className="text-bad tnum">{num(exits.rejected)}</b> rejected</span>
        <span><b className="text-ink tnum">{num(exits.special_repair)}</b> referred for special repair</span>
      </div>
    </div>
  );
}

export function LoadScatter({ areas, target }: { areas: any[]; target: number }) {
  const pts = areas.filter((a) => a.per100 !== null && a.sla_pct !== null).map((a) => ({ x: Number(a.per100), y: clamp(Number(a.sla_pct)), z: a.complaints, code: a.code }));
  if (!pts.length) return NOTHING;
  return (
    <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ left: -10, right: 20, top: 12, bottom: 4 }}>
      <CartesianGrid stroke="var(--border)" />
      <XAxis type="number" dataKey="x" name="Per 100 quarters per month" tick={tick} domain={[0, 'auto']} />
      <YAxis type="number" dataKey="y" name="SLA compliance" unit="%" domain={[0, 100]} tick={tick} />
      <ZAxis dataKey="z" name="Complaints" range={[80, 600]} />
      <Tooltip contentStyle={tip} cursor={{ strokeDasharray: '3 3' }} />
      <ReferenceLine y={target} stroke="var(--status-at-risk)" strokeDasharray="6 4" />
      <Scatter data={pts} fill="var(--primary)" fillOpacity={0.55}>
        <LabelList dataKey="code" position="top" style={{ fontSize: 11, fill: 'var(--text)' }} />
      </Scatter>
    </ScatterChart></ResponsiveContainer>
  );
}

export function RankSlope({ areas }: { areas: any[] }) {
  if (!areas.some((a) => a.sla_now !== null || a.sla_prev !== null)) return NOTHING;
  const W = 420, H = 410, top = 22, step = (H - top - 8) / 12, xl = 90, xr = W - 90;
  const y = (r: number) => top + (r - 1) * step;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-h-full" role="img" aria-label="Rank movement from the previous month to this month">
      <text x={xl} y={12} textAnchor="middle" fontSize="11" fill="var(--text-muted)">Previous month</text>
      <text x={xr} y={12} textAnchor="middle" fontSize="11" fill="var(--text-muted)">This month</text>
      {areas.map((a) => {
        // a place only means something when the Area has a figure in both months
        const both = a.sla_now !== null && a.sla_prev !== null;
        const c = !both ? 'var(--border)' : a.rank_now < a.rank_prev ? 'var(--status-resolved)' : a.rank_now > a.rank_prev ? 'var(--status-breached)' : 'var(--border-strong)';
        return (
          <g key={a.code}>
            <line x1={xl} y1={y(a.rank_prev)} x2={xr} y2={y(a.rank_now)} stroke={c} strokeWidth={a.rank_now === a.rank_prev ? 1.5 : 2.5} />
            <circle cx={xl} cy={y(a.rank_prev)} r={3.5} fill={c} /><circle cx={xr} cy={y(a.rank_now)} r={3.5} fill={c} />
            <text x={xl - 10} y={y(a.rank_prev) + 4} textAnchor="end" fontSize="11" fill="var(--text)">{a.rank_prev} {a.code}</text>
            <text x={xr + 10} y={y(a.rank_now) + 4} fontSize="11" fill="var(--text)">{a.rank_now} {a.code}</text>
          </g>);
      })}
    </svg>
  );
}

export function CategoryMatrix({ categories }: { categories: { columns: any[]; rows: any[] } }) {
  const { columns, rows } = categories;
  if (!rows.some((r) => r.total > 0)) return NOTHING;
  return (
    <div className="overflow-auto">
      <table className="text-[12px] tnum">
        <thead><tr><th />{columns.map((c) => <th key={c.code} className="label !text-[10px] px-1.5 pb-2 font-medium align-bottom" title={c.name_en}><div className="truncate w-[64px]">{c.name_en}</div></th>)}</tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.code}>
            <th scope="row" className="text-left pr-3 font-semibold whitespace-nowrap" title={r.name}>{r.code}</th>
            {columns.map((c) => {
              const n = r.counts?.[c.code] || 0, share = r.total ? n / r.total : 0, d = n ? 6 + Math.sqrt(share) * 24 : 0;
              return (
                <td key={c.code} className="h-9 text-center" title={`${r.name}, ${c.name_en}: ${n} of ${r.total} (${Math.round(share * 100)}%)`}>
                  {n > 0 && <span className="inline-block rounded-full bg-primary opacity-70" style={{ width: d, height: d }} />}
                </td>);
            })}
          </tr>))}</tbody>
      </table>
    </div>
  );
}

function ScrollEnd({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth; }, []);
  return <div ref={ref} className="overflow-auto">{children}</div>;
}
