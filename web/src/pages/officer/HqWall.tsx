import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { AlertTriangle, ArrowDown, ArrowUp, Maximize2, Minimize2, X } from 'lucide-react';
import { BrandMark } from '../../components/ui';
import { api } from '../../lib/api';
import { num, pct } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

/* The wall display for the GM (Civil)'s office: the executive dashboard's
   live figures as a dark board meant to be read from across a room. It
   refreshes itself every minute and walks the thirteen Areas one at a time.
   Read-only, the same figures as the dashboard (GET /hq/executive), under
   the viewer's own row security; evidence only (control 9). */

const REFRESH_MS = 60_000;
const SPOT_MS = 7_000;
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const tone = (v: number | null, target: number) => v === null ? 'none' : v >= target ? 'ok' : v >= target - 15 ? 'risk' : 'bad';
const TILE: Record<string, string> = {
  ok: 'bg-[#163b2e] text-[#9fe0bd] ring-[#2f7a57]/50', risk: 'bg-[#3d3011] text-[#f0c372] ring-[#a37a24]/50',
  bad: 'bg-[#45201d] text-[#f5a199] ring-[#b4473e]/60', none: 'bg-white/[.04] text-white/45 ring-white/10'
};
const istClock = () => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date());
const istDate = () => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());

/* What changed since this display was first opened today (V2, blueprint
   H2), so a glance tells the GM something new. The baseline is kept in this
   browser, one per day; nothing is written anywhere else. */
type Base = { at: string; day: string; open: number; overdue: number; insp: number; l4: number; below: string[] };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
function useBaseline(d: any, target: number) {
  const [base, setBase] = useState<Base | null>(null);
  useEffect(() => {
    if (!d) return;
    const now: Base = { at: istClock(), day: today(), open: d.kpis.open_now, overdue: d.kpis.overdue_now, insp: d.kpis.inspection_waiting,
      l4: d.kpis.open_level4, below: d.areas.filter((a: any) => a.sla_now !== null && Number(a.sla_now) < target).map((a: any) => a.code) };
    let b: Base | null = null;
    try { b = JSON.parse(localStorage.getItem('cp-wall-base') || 'null'); } catch { b = null; }
    if (!b || b.day !== now.day) { b = now; try { localStorage.setItem('cp-wall-base', JSON.stringify(b)); } catch { /* private window */ } }
    setBase(b);
  }, [d, target]);
  if (!d || !base) return null;
  const parts: string[] = [];
  const diff = (n: number, was: number, what: string, up: string, down: string) => {
    if (n > was) parts.push(`${what} ${up} by ${n - was} (${was} → ${n})`);
    else if (n < was) parts.push(`${what} ${down} by ${was - n} (${was} → ${n})`);
  };
  diff(d.kpis.open_now, base.open, 'open', 'up', 'down');
  diff(d.kpis.overdue_now, base.overdue, 'overdue', 'up', 'down');
  diff(d.kpis.inspection_waiting, base.insp, 'inspections over 48 h', 'up', 'down');
  diff(d.kpis.open_level4, base.l4, 'at level 4', 'up', 'down');
  const below = d.areas.filter((a: any) => a.sla_now !== null && Number(a.sla_now) < target).map((a: any) => a.code);
  const fell = below.filter((c: string) => !base.below.includes(c)), rose = base.below.filter((c: string) => !below.includes(c));
  if (fell.length) parts.push(`${fell.join(', ')} fell below target`);
  if (rose.length) parts.push(`${rose.join(', ')} back at target`);
  return { since: base.at, text: parts.length ? parts.join(' · ') : 'no change' };
}

export default function HqWall() {
  const nav = useNavigate();
  const r = useLoad(() => api<any>('/hq/executive?months=3'));
  const [clock, setClock] = useState(istClock);
  const [at, setAt] = useState(istClock);
  const [spot, setSpot] = useState(0);
  const [full, setFull] = useState(!!document.fullscreenElement);
  const d = r.data;

  useEffect(() => { const id = setInterval(() => { r.reload(); setAt(istClock()); }, REFRESH_MS); return () => clearInterval(id); }, [r.reload]);
  useEffect(() => { const id = setInterval(() => setClock(istClock()), 15_000); return () => clearInterval(id); }, []);
  useEffect(() => {
    if (!d || still()) return;
    const id = setInterval(() => setSpot((s) => (s + 1) % d.areas.length), SPOT_MS);
    return () => clearInterval(id);
  }, [d]);
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.fullscreenElement) nav('/w/hq'); };
    addEventListener('fullscreenchange', f); addEventListener('keydown', esc);
    return () => { removeEventListener('fullscreenchange', f); removeEventListener('keydown', esc); };
  }, [nav]);
  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});

  const k = d?.kpis, target = d?.target_percent ?? 90;
  const changed = useBaseline(d, target);
  const areas: any[] = d ? [...d.areas].sort((a: any, b: any) => a.code.localeCompare(b.code)) : [];
  const a = areas[spot];

  return (
    <div className="wall fixed inset-0 z-50 overflow-auto text-white flex flex-col" style={{ background: 'radial-gradient(120% 80% at 10% 0%, color-mix(in srgb, var(--primary-dark) 85%, #fff) 0%, var(--primary-dark) 55%, color-mix(in srgb, var(--primary-dark) 60%, #000) 100%)' }}>
      {/* header */}
      <header className="flex items-center gap-4 px-8 pt-6">
        <BrandMark size={40} className="text-[#e8efe9]" />
        <div className="min-w-0">
          <div className="text-[13px] uppercase tracking-[0.2em] text-white/50">NCL Civil · Colony maintenance</div>
          <div className="text-2xl font-semibold tracking-[-0.02em]">All thirteen Areas, live</div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-4xl font-semibold tnum tracking-[-0.03em]">{clock}</div>
          <div className="text-[13px] text-white/50">{istDate()}</div>
        </div>
        <div className="flex items-center gap-2 ml-4">
          <button onClick={toggleFull} className="w-11 h-11 rounded-full grid place-items-center bg-white/[.06] ring-1 ring-white/10 hover:bg-white/10" aria-label={full ? 'Leave full screen' : 'Full screen'}>
            {full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
          <button onClick={() => nav('/w/hq')} className="w-11 h-11 rounded-full grid place-items-center bg-white/[.06] ring-1 ring-white/10 hover:bg-white/10" aria-label="Close the wall display"><X size={18} /></button>
        </div>
      </header>

      {r.error && <div className="m-8 rounded-2xl bg-[#45201d] p-5">{r.error}</div>}
      {!d && !r.error && <div className="flex-1 grid place-items-center text-white/50">Loading the figures…</div>}

      {d && (
        <div className="flex-1 flex flex-col gap-6 px-8 py-6 min-h-0">
          {changed && (
            <div className="rounded-2xl bg-white/[.05] ring-1 ring-white/10 px-5 py-3 text-[16px]">
              <span className="text-white/50">Since {changed.since} today: </span>
              <span className={changed.text === 'no change' ? 'text-white/70' : 'text-white font-semibold'}>{changed.text}</span>
            </div>
          )}
          {/* live counts */}
          <section className="grid grid-cols-2 xl:grid-cols-5 gap-4">
            <Big label="SLA compliance this month" value={pct(k.sla_pct.now)} sub={`Target ${target}%`} tone={tone(k.sla_pct.now === null ? null : Number(k.sla_pct.now), target)} />
            <Big label="Open now" value={num(k.open_now)} />
            <Big label="Overdue now" value={num(k.overdue_now)} tone={k.overdue_now > 0 ? 'bad' : 'ok'} />
            <Big label="Inspection waiting > 48 h" value={num(k.inspection_waiting)} tone={k.inspection_waiting > 0 ? 'risk' : 'ok'} />
            <Big label="Open at level 4 (GM)" value={num(k.open_level4)} tone={k.open_level4 > 0 ? 'bad' : 'ok'} />
          </section>

          {/* the thirteen Areas, one lit at a time */}
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <div className="text-[13px] uppercase tracking-[0.2em] text-white/50">SLA compliance by Area · this month</div>
              <div className="text-[13px] text-white/40">green at or above {target}% · amber within 15 points · red below</div>
            </div>
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${areas.length}, minmax(0, 1fr))` }}>
              {areas.map((x, i) => {
                const tn = tone(x.sla_now === null ? null : Number(x.sla_now), target);
                return (
                  <button key={x.code} onClick={() => setSpot(i)} aria-pressed={i === spot}
                    className={clsx('rounded-2xl ring-1 px-2 py-4 text-center transition-[transform,box-shadow,opacity] duration-700 ease-fluid', TILE[tn],
                      i === spot ? 'scale-[1.06] shadow-[0_20px_50px_-20px_rgba(0,0,0,.8)] ring-2 opacity-100' : 'opacity-80 hover:opacity-100')}>
                    <div className="text-[13px] font-semibold tracking-[0.06em]">{x.code}</div>
                    <div className="text-[26px] font-semibold tnum leading-tight mt-1">{x.sla_now === null ? '—' : `${Math.round(Number(x.sla_now))}`}<span className="text-sm opacity-70">{x.sla_now === null ? '' : '%'}</span></div>
                    <div className="text-[11px] opacity-70 mt-1 tnum">{x.open_now} open{x.overdue_now ? ` · ${x.overdue_now} late` : ''}</div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* the Area in the spotlight */}
          {a && (
            <section key={a.code} className="wall-spot grid xl:grid-cols-[1.1fr_.9fr] gap-6 rounded-[28px] bg-white/[.04] ring-1 ring-white/10 p-7">
              <div>
                <div className="text-[13px] uppercase tracking-[0.2em] text-white/50">{a.code} · in focus</div>
                <div className="text-[44px] font-semibold tracking-[-0.03em] leading-tight">{a.name}</div>
                <div className="text-white/55 mt-1">{a.contractors.length ? a.contractors.join(' · ') : 'No live contract recorded'}</div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <Mini label="SLA this month" value={a.sla_now === null ? '—' : pct(a.sla_now)}
                  delta={a.sla_now !== null && a.sla_prev !== null ? Number(a.sla_now) - Number(a.sla_prev) : null} />
                <Mini label="Open / overdue" value={`${a.open_now} / ${a.overdue_now}`} />
                <Mini label="Inspection > 48 h" value={String(a.inspection_waiting)} />
                <Mini label="Per 100 quarters" value={a.per100 === null ? '—' : num(a.per100, 1)} />
                <Mini label="First-time fix" value={pct(a.first_time_fix_pct)} />
                <Mini label="Reopen rate" value={pct(a.reopen_pct)} />
              </div>
            </section>
          )}

          {/* what needs HQ attention, moving slowly along the foot */}
          <section className="mt-auto rounded-2xl bg-white/[.03] ring-1 ring-white/10 overflow-hidden">
            {d.watch.length === 0 ? <div className="px-6 py-4 text-white/60">Nothing needs HQ attention.</div> : (
              <div className="marquee-mask py-4"><div className="marquee" style={{ animationDuration: `${Math.max(40, d.watch.length * 12)}s` }}>
                {[0, 1].map((dup) => (
                  <div key={dup} className="flex shrink-0 gap-10 pr-10" aria-hidden={dup === 1}>
                    {d.watch.map((w: any, i: number) => (
                      <span key={i} className="inline-flex items-center gap-2.5 whitespace-nowrap text-[17px]">
                        <AlertTriangle size={18} className={w.severity === 'critical' ? 'text-[#f5a199]' : 'text-[#f0c372]'} />{w.title}
                      </span>
                    ))}
                  </div>
                ))}
              </div></div>
            )}
          </section>
          <div className="flex justify-between text-[12px] text-white/35">
            <span>Refreshed {at} · every minute · Evidence only — no amounts are calculated.</span>
            <span>Esc to leave</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Big({ label, value, sub, tone: t = 'none' }: { label: string; value: string; sub?: string; tone?: string }) {
  const col = t === 'bad' ? 'text-[#f5a199]' : t === 'risk' ? 'text-[#f0c372]' : t === 'ok' ? 'text-[#9fe0bd]' : 'text-white';
  return (
    <div className="rounded-[24px] bg-white/[.04] ring-1 ring-white/10 p-6">
      <div className="text-[13px] text-white/55">{label}</div>
      <div className={clsx('text-[64px] font-semibold tnum leading-none mt-3 tracking-[-0.04em]', col)}>{value}</div>
      {sub && <div className="text-[13px] text-white/45 mt-2">{sub}</div>}
    </div>
  );
}
function Mini({ label, value, delta }: { label: string; value: string; delta?: number | null }) {
  return (
    <div>
      <div className="text-[12px] text-white/50">{label}</div>
      <div className="text-[28px] font-semibold tnum tracking-[-0.02em] flex items-center gap-2">{value}
        {delta !== undefined && delta !== null && Math.abs(delta) >= 0.5 && (
          <span className={clsx('text-sm inline-flex items-center', delta > 0 ? 'text-[#9fe0bd]' : 'text-[#f5a199]')}>
            {delta > 0 ? <ArrowUp size={14} /> : <ArrowDown size={14} />}{Math.abs(Math.round(delta))}</span>)}
      </div>
    </div>
  );
}
