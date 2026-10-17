import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { ArrowUpRight, BadgeCheck, Camera, ClipboardList, Hammer, HardHat, MapPin, Phone, ShieldCheck, Star, UserCheck } from 'lucide-react';
import { Logo, SlaRing, StatusChip } from '../components/ui';
import { GovStrip } from '../components/shell/GovFrame';
import { AREAS, STATE, type Tone } from '../lib/domain';

/* Landing page — experiment: "Singrauli, right now".
   A drawn colony whose sky follows the real hour in Singrauli, in layers
   that move at different depths; a complaint that walks itself through the
   project's real lifecycle; the seven steps told as you scroll; the
   inspection photograph's stamp; the thirteen Areas. Every claim is one the
   system keeps (README §3–4): the Overseer closes after inspection, the
   resident may reopen within 24 hours, there is no visit booking. */

const still = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------ time of day */
type Phase = 'dawn' | 'day' | 'dusk' | 'night';
const istNow = () => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const h = Number(p.find((x) => x.type === 'hour')?.value), m = Number(p.find((x) => x.type === 'minute')?.value);
  return { h, m, label: new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date()) };
};
const phaseAt = (h: number, m: number): Phase => {
  const t = h + m / 60;
  return t >= 5 && t < 7 ? 'dawn' : t >= 7 && t < 17 ? 'day' : t >= 17 && t < 19.5 ? 'dusk' : 'night';
};
const SKY: Record<Phase, { sky: [string, string, string]; far: string; mine: string; mid: string; near: string; ground: string; orb: string; glow: string; lit: number }> = {
  dawn:  { sky: ['#24324d', '#b7776a', '#f1c28e'], far: '#6d6a7d', mine: '#57536a', mid: '#3a3f52', near: '#1f2a33', ground: '#152026', orb: '#ffd9a0', glow: 'rgba(255,190,130,.55)', lit: 0.35 },
  day:   { sky: ['#6fa9bf', '#bcd9d6', '#f2ead2'], far: '#8fa8a0', mine: '#7d8f86', mid: '#4f6b63', near: '#2c4a44', ground: '#1d3532', orb: '#fff6dc', glow: 'rgba(255,246,220,.6)', lit: 0 },
  dusk:  { sky: ['#1a2840', '#7b4a5c', '#e4955a'], far: '#5a4c5f', mine: '#47394c', mid: '#2e2c3d', near: '#19222b', ground: '#10181e', orb: '#ffb46a', glow: 'rgba(255,150,90,.55)', lit: 0.7 },
  night: { sky: ['#03090f', '#0a1c25', '#123139'], far: '#14272d', mine: '#102228', mid: '#0c1b20', near: '#081317', ground: '#050d10', orb: '#e9efe6', glow: 'rgba(200,225,215,.28)', lit: 1 }
};

/* small deterministic random, so the colony is the same on every visit */
const rng = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

/* ------------------------------------------------------------ the colony */
function Colony({ phase }: { phase: Phase }) {
  const c = SKY[phase];
  const { blocks, trees, stars, lit } = useMemo(() => {
    const r = rng(42);
    const blocks: { x: number; y: number; w: number; h: number; floors: number; cols: number; tank: boolean; row: number }[] = [];
    ([[0, 610, 0.82], [1, 690, 1]] as const).forEach(([row, base, scale]) => {
      let x = -40 + r() * 60;
      while (x < 1640) {
        const floors = row === 0 ? 1 + Math.round(r()) : 2;
        const w = (150 + r() * 70) * scale, h = floors * (row === 0 ? 46 : 58) + 24 + r() * 14;
        blocks.push({ x, y: base - h, w, h, floors, cols: Math.max(3, Math.round(w / 34)), tank: r() > 0.45, row });
        x += w + 22 + r() * 46;
      }
    });
    const trees = Array.from({ length: 26 }, () => ({ x: r() * 1640 - 20, s: 26 + r() * 30, y: 700 + r() * 40 }));
    const stars = Array.from({ length: 90 }, () => ({ x: r() * 1600, y: r() * 380, s: r() * 1.3 + 0.3, d: r() * 4 }));
    const w = rng(7);
    const lit = blocks.map((b) => Array.from({ length: b.floors * b.cols }, () => w()));
    return { blocks, trees, stars, lit };
  }, []);
  const layer = (depth: number): CSSProperties => ({
    transform: `translate3d(calc(var(--px, 0) * ${depth * 18}px), calc(var(--sy, 0) * ${depth * 120}px + var(--py, 0) * ${depth * 6}px), 0)`,
    willChange: 'transform'
  });
  const orbX = phase === 'dawn' ? 1180 : phase === 'dusk' ? 1260 : 1150, orbY = phase === 'day' ? 170 : phase === 'night' ? 150 : 400;

  return (
    <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice" className="absolute inset-0 w-full h-full sky-svg" aria-hidden>
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={c.sky[0]} /><stop offset=".55" stopColor={c.sky[1]} /><stop offset="1" stopColor={c.sky[2]} />
        </linearGradient>
        <radialGradient id="orb-glow"><stop offset="0" stopColor={c.glow} /><stop offset="1" stopColor="rgba(0,0,0,0)" /></radialGradient>
        <linearGradient id="haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={c.sky[2]} stopOpacity="0" /><stop offset="1" stopColor={c.sky[2]} stopOpacity=".55" /></linearGradient>
      </defs>
      <rect width="1600" height="900" fill="url(#sky)" />

      {phase === 'night' && <g>{stars.map((s, i) => <circle key={i} cx={s.x} cy={s.y} r={s.s} fill="#fff" className="twinkle" style={{ animationDelay: `${s.d}s` }} />)}</g>}

      <g style={layer(0.15)}>
        <circle cx={orbX} cy={orbY} r="210" fill="url(#orb-glow)" />
        <circle cx={orbX} cy={orbY} r={phase === 'night' ? 34 : 48} fill={c.orb} />
        {phase === 'night' && <circle cx={orbX + 14} cy={orbY - 10} r="30" fill={c.sky[1]} />}
      </g>

      {/* the coalfield on the horizon: overburden benches and a dragline */}
      <g style={layer(0.25)}>
        <path d="M0 520 L180 470 L300 480 L420 430 L560 450 L700 400 L860 420 L1010 380 L1200 410 L1380 370 L1600 400 L1600 900 L0 900Z" fill={c.far} />
        <path d="M640 470 h380 v-22 h-40 v-22 h-60 v-20 h-160 v20 h-60 v22 h-60z" fill={c.mine} />
        <path d="M1090 452 l70 -120 l8 6 l-62 116z M1160 332 l180 92" stroke={c.mine} strokeWidth="5" fill="none" />
        <rect x="1080" y="440" width="44" height="22" fill={c.mine} />
      </g>
      <rect width="1600" height="900" fill="url(#haze)" />

      {/* quarters: flat-roofed blocks, water tanks on top, windows that light up after dark */}
      {[0, 1].map((row) => (
        <g key={row} style={layer(row === 0 ? 0.45 : 0.7)}>
          {blocks.map((b, i) => {
            if (b.row !== row) return null;
            const fill = row === 0 ? c.mid : c.near, fh = (b.h - 18) / b.floors, ww = (b.w - 20) / b.cols;
            return (
              <g key={i}>
                <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={fill} />
                <rect x={b.x - 4} y={b.y - 6} width={b.w + 8} height="7" fill={fill} />
                {b.tank && <g fill={fill}><rect x={b.x + b.w * 0.62} y={b.y - 30} width="30" height="20" rx="3" /><rect x={b.x + b.w * 0.62 + 6} y={b.y - 12} width="3" height="8" /><rect x={b.x + b.w * 0.62 + 21} y={b.y - 12} width="3" height="8" /></g>}
                {Array.from({ length: b.floors }).map((_, f) => Array.from({ length: b.cols }).map((__, k) => {
                  const on = lit[i][f * b.cols + k] < c.lit * 0.62;
                  return <rect key={`${f}-${k}`} x={b.x + 10 + k * ww + ww * 0.22} y={b.y + 12 + f * fh + fh * 0.22} width={ww * 0.56} height={fh * 0.42} rx="1.5"
                    fill={on ? '#ffd58a' : (phase === 'day' ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.05)')}
                    className={on ? 'window-on' : undefined} style={on ? { animationDelay: `${(i * 7 + k) % 9}s` } : undefined} />;
                }))}
              </g>
            );
          })}
        </g>
      ))}

      {/* trees, street lamps and the road */}
      <g style={layer(1)}>
        <rect x="-40" y="726" width="1680" height="200" fill={c.ground} />
        <rect x="-40" y="760" width="1680" height="3" fill="rgba(255,255,255,.08)" />
        {trees.map((t, i) => (
          <g key={i} fill={c.near}>
            <rect x={t.x - 2} y={t.y - 4} width="4" height="26" />
            <circle cx={t.x} cy={t.y - t.s * 0.5} r={t.s * 0.55} /><circle cx={t.x - t.s * 0.35} cy={t.y - t.s * 0.25} r={t.s * 0.4} /><circle cx={t.x + t.s * 0.35} cy={t.y - t.s * 0.3} r={t.s * 0.42} />
          </g>
        ))}
        {[180, 620, 1060, 1500].map((x) => (
          <g key={x}><rect x={x} y="660" width="3" height="100" fill={c.near} />
            <rect x={x - 14} y="658" width="18" height="4" fill={c.near} />
            {c.lit > 0.3 && <circle cx={x - 12} cy="666" r="34" fill="url(#orb-glow)" opacity=".6" />}</g>
        ))}
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------ the live complaint card */
const WALK: { s: keyof typeof STATE; f: number; who: string; icon: ReactNode }[] = [
  { s: 'RAISED', f: 0.02, who: 'You reported it · with a photograph', icon: <ClipboardList size={16} /> },
  { s: 'VERIFIED', f: 0.04, who: 'Overseer checked it · deadline fixed', icon: <UserCheck size={16} /> },
  { s: 'ASSIGNED', f: 0.08, who: 'Given to M/s Jayant Constructions', icon: <HardHat size={16} /> },
  { s: 'IN_PROGRESS', f: 0.4, who: 'Workmen: Ram Prasad, Sunil Kumar', icon: <Hammer size={16} /> },
  { s: 'WORK_COMPLETED', f: 0.66, who: 'Contractor says done · before & after', icon: <Camera size={16} /> },
  { s: 'INSPECTED_ACCEPTED', f: 0.66, who: 'Overseer inspected on site · geo-tagged', icon: <ShieldCheck size={16} /> },
  { s: 'CLOSED', f: 0.66, who: 'You confirmed · rated it 5 of 5', icon: <Star size={16} /> }
];
const toneOf = (s: string): Tone => (s === 'CLOSED' || s === 'INSPECTED_ACCEPTED' ? 'ok' : STATE[s].tone);
function LiveCard({ compact }: { compact?: boolean }) {
  const [i, setI] = useState(still() ? 3 : 0);
  useEffect(() => { if (still()) return; const id = setInterval(() => setI((x) => (x + 1) % WALK.length), 2600); return () => clearInterval(id); }, []);
  const w = WALK[i];
  return (
    <div className={clsx('glass-card rounded-[28px] p-5 text-ink', compact ? 'w-full' : 'w-[360px]')}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold tnum text-ink-muted">JNT/2026/00042 · example</span>
        <span key={w.s} className="anim-chip"><StatusChip tone={toneOf(w.s)}>{STATE[w.s].resident}</StatusChip></span>
      </div>
      <div className="flex items-center gap-4 mt-4">
        <SlaRing size={76} fraction={w.f} tone="ok" label={w.s === 'CLOSED' ? '✓' : `${Math.round((1 - w.f) * 48)}h`} sub={w.s === 'CLOSED' ? 'met' : 'left'} />
        <div className="min-w-0">
          <div className="font-semibold text-[16px] tracking-[-0.01em]">Kitchen tap leaking</div>
          <div className="text-[13px] text-ink-muted">Qtr No. B-234 · Jayant</div>
        </div>
      </div>
      <div key={i} className="anim-chip mt-4 rounded-2xl bg-tint/80 p-3 flex items-center gap-3 text-[13px]">
        <span className="w-8 h-8 rounded-xl bg-primary-btn text-on-primary grid place-items-center shrink-0">{w.icon}</span>
        <span className="font-medium">{w.who}</span>
      </div>
      <div className="flex gap-1 mt-4" aria-hidden>
        {WALK.map((_, k) => <span key={k} className={clsx('h-1 flex-1 rounded-full transition-colors duration-700', k <= i ? 'bg-primary' : 'bg-line')} />)}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ pieces */
function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>('.reveal');
    if (still() || !('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('is-in')); return; }
    const io = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } }),
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
}
function CountUp({ to, ms = 1600 }: { to: number; ms?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [v, setV] = useState(still() ? to : 0);
  useEffect(() => {
    if (still() || !ref.current) return;
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return; io.disconnect();
      const t0 = performance.now();
      const tick = (t: number) => { const p = Math.min(1, (t - t0) / ms); setV(Math.round(to * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
    });
    io.observe(ref.current);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [to, ms]);
  return <span ref={ref} className="tnum">{v.toLocaleString('en-IN')}</span>;
}
function IslandButton({ children, onClick, tone = 'gold', icon }: { children: ReactNode; onClick: () => void; tone?: 'gold' | 'glass' | 'ink'; icon?: ReactNode }) {
  return (
    <button onClick={onClick}
      className={clsx('sheen group inline-flex items-center gap-3 h-14 pl-6 pr-2 rounded-full font-semibold text-[15px] whitespace-nowrap',
        'transition-[transform,background-color,box-shadow] duration-500 ease-fluid hover:-translate-y-0.5 active:scale-[.98] active:translate-y-0',
        tone === 'gold' && 'bg-gold text-primary-dark hover:bg-[var(--gold-hover)] shadow-[0_14px_34px_-12px_rgba(201,169,106,.8)]',
        tone === 'glass' && 'bg-white/[.08] text-white ring-1 ring-white/25 backdrop-blur-md hover:bg-white/[.14]',
        tone === 'ink' && 'bg-primary-btn text-on-primary hover:bg-primary-hover shadow-[0_14px_34px_-14px_rgba(15,76,76,.7)]')}>
      {icon}{children}
      <span className={clsx('w-10 h-10 rounded-full grid place-items-center transition-transform duration-500 ease-fluid group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-105 group-hover:rotate-45',
        tone === 'gold' ? 'bg-primary-dark/10' : 'bg-white/12')}><ArrowUpRight size={18} strokeWidth={1.75} /></span>
    </button>
  );
}
const Eyebrow = ({ children, dark }: { children: ReactNode; dark?: boolean }) => (
  <span className={clsx('inline-flex items-center gap-2 rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.12em] sm:tracking-[0.22em] font-medium ring-1',
    dark ? 'text-gold ring-gold/35 bg-gold/[.07]' : 'text-gold-text ring-gold/40 bg-gold/[.05]')}>
    <span className="w-1.5 h-1.5 rounded-full bg-current" />{children}</span>
);

/* the seven steps of the story, each the project's own state */
const STORY: { s: keyof typeof STATE; who: string; title: string; body: string; icon: ReactNode }[] = [
  { s: 'RAISED', who: 'You', title: 'You tell us, in under a minute', body: 'Pick the fault from pictures, add a photograph, send. Your complaint gets its number at once.', icon: <ClipboardList size={16} /> },
  { s: 'VERIFIED', who: 'Civil Overseer', title: 'The Overseer checks it', body: 'The deadline is fixed here, by the system, from the department’s table. Nobody can stretch it afterwards.', icon: <UserCheck size={16} /> },
  { s: 'ASSIGNED', who: 'Civil Incharge', title: 'It goes to your Area’s contractor', body: 'A job card is prepared for it. From this moment the contractor’s own clock is running.', icon: <HardHat size={16} /> },
  { s: 'IN_PROGRESS', who: 'Contractor', title: 'Work starts, with names', body: 'The workmen sent to your quarter are named. If something is wrong while they work, you can object.', icon: <Hammer size={16} /> },
  { s: 'WORK_COMPLETED', who: 'Contractor', title: 'The contractor says it is done', body: 'Only says. A claim needs a photograph before the work and one after — and it closes nothing.', icon: <Camera size={16} /> },
  { s: 'INSPECTED_ACCEPTED', who: 'Civil Overseer', title: 'An Overseer inspects it on site', body: 'With a photograph taken in the app, carrying the place and the time — and never by the person the work was given to.', icon: <ShieldCheck size={16} /> },
  { s: 'CLOSED', who: 'You', title: 'You have the final say', body: 'Confirm and rate it — or reopen it within 24 hours. It comes back as the same complaint, never a new one.', icon: <BadgeCheck size={16} /> }
];

/* ------------------------------------------------------------ page */
export default function Hero() {
  const nav = useNavigate();
  const hero = useRef<HTMLElement>(null);
  const [now, setNow] = useState(istNow);
  const [override, setOverride] = useState<Phase | null>(null);
  const phase = override ?? phaseAt(now.h, now.m);
  const [menu, setMenu] = useState(false);
  const [step, setStep] = useState(0);
  const menuBtn = useRef<HTMLButtonElement>(null);
  useReveal();

  useEffect(() => { const id = setInterval(() => setNow(istNow()), 30000); return () => clearInterval(id); }, []);
  // depth: the pointer tilts the scene, scrolling sinks it — transforms only, one frame at a time
  useEffect(() => {
    const el = hero.current; if (!el || still()) return;
    let raf = 0, px = 0, py = 0;
    const paint = () => { raf = 0; const r = el.getBoundingClientRect();
      el.style.setProperty('--px', px.toFixed(3)); el.style.setProperty('--py', py.toFixed(3));
      el.style.setProperty('--sy', Math.max(0, Math.min(1, -r.top / r.height)).toFixed(3)); };
    const ask = () => { if (!raf) raf = requestAnimationFrame(paint); };
    const move = (e: PointerEvent) => { px = e.clientX / innerWidth - 0.5; py = e.clientY / innerHeight - 0.5; ask(); };
    addEventListener('pointermove', move, { passive: true }); addEventListener('scroll', ask, { passive: true });
    return () => { removeEventListener('pointermove', move); removeEventListener('scroll', ask); cancelAnimationFrame(raf); };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(false); menuBtn.current?.focus(); } };
    addEventListener('keydown', esc); document.body.style.overflow = 'hidden';
    return () => { removeEventListener('keydown', esc); document.body.style.overflow = ''; };
  }, [menu]);
  // which story step is in the middle of the screen
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>('[data-step]');
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) setStep(Number((e.target as HTMLElement).dataset.step)); }),
      { rootMargin: '-45% 0px -45% 0px' });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  const NAV = [['#story', 'How it works'], ['#proof', 'Inspection'], ['#areas', 'Areas'], ['#help', 'Help']];
  const stagger = (i: number) => ({ animationDelay: `${150 + i * 110}ms` });
  const cur = STORY[step];

  return (
    <div className="bg-bg overflow-x-clip">
      <GovStrip className="relative z-50" />
      {/* ------------------------------------------------ floating island nav */}
      <header className="fixed top-12 inset-x-0 z-40 px-4 flex justify-center pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-2 md:gap-5 w-full md:w-max max-w-[1100px] p-2 rounded-full
          bg-primary-dark/[.72] backdrop-blur-2xl backdrop-saturate-150 ring-1 ring-white/12 shadow-[0_18px_44px_-20px_rgba(0,0,0,.7)]">
          <div className="pl-1"><Logo /></div>
          <nav className="hidden lg:flex items-center gap-1 text-[14px] font-medium text-white/75" aria-label="Page">
            {NAV.map(([h, l]) => <a key={h} href={h} className="px-3.5 py-2 rounded-full hover:text-white hover:bg-white/10 transition-colors duration-300 ease-fluid">{l}</a>)}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/signin" className="sheen hidden sm:inline-flex h-11 items-center px-5 rounded-full bg-white text-primary-dark text-sm font-semibold transition-transform duration-500 ease-fluid hover:scale-[1.03] active:scale-[.98]">Sign in</Link>
            <button ref={menuBtn} className="lg:hidden relative w-11 h-11 rounded-full bg-white/10 ring-1 ring-white/15"
              aria-label={menu ? 'Close menu' : 'Open menu'} aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <span className={clsx('absolute left-1/2 top-1/2 h-[1.5px] w-5 -ml-2.5 bg-white rounded-full transition-transform duration-500 ease-fluid', menu ? 'rotate-45' : '-translate-y-[4px]')} />
              <span className={clsx('absolute left-1/2 top-1/2 h-[1.5px] w-5 -ml-2.5 bg-white rounded-full transition-transform duration-500 ease-fluid', menu ? '-rotate-45' : 'translate-y-[4px]')} />
            </button>
          </div>
        </div>
      </header>
      <div className={clsx('fixed inset-0 z-30 lg:hidden bg-primary-dark/85 backdrop-blur-3xl transition-opacity duration-500 ease-fluid', menu ? 'opacity-100' : 'opacity-0 pointer-events-none')} aria-hidden={!menu}>
        <nav className="h-full flex flex-col justify-center px-8 gap-1" aria-label="Menu">
          {[...NAV, ['/signin', 'Sign in']].map(([h, l], i) => (
            <div key={h} className="overflow-hidden">
              <a href={h} tabIndex={menu ? 0 : -1} onClick={(e) => { setMenu(false); if (h === '/signin') { e.preventDefault(); nav('/signin'); } }}
                className={clsx('block py-2 text-white text-[42px] font-semibold tracking-[-0.04em] transition-[transform,opacity] duration-700 ease-fluid', menu ? 'translate-y-0 opacity-100' : 'translate-y-14 opacity-0')}
                style={{ transitionDelay: menu ? `${100 + i * 60}ms` : '0ms' }}>{l}</a>
            </div>
          ))}
        </nav>
      </div>

      {/* ------------------------------------------------ 1. the colony, right now */}
      <section ref={hero} className="relative min-h-[100dvh] overflow-hidden text-white flex flex-col">
        <Colony phase={phase} />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(5,20,22,.82) 0%, rgba(5,20,22,.55) 38%, rgba(5,20,22,0) 70%), linear-gradient(0deg, rgba(5,20,22,.75) 0%, rgba(5,20,22,0) 35%)' }} />

        <div className="relative z-10 flex-1 max-w-[1280px] w-full mx-auto px-4 md:px-8 pt-32 md:pt-40 pb-10 grid lg:grid-cols-[1.25fr_.75fr] gap-10 items-center">
          <div>
            <div className="anim-fade-up flex flex-wrap items-center gap-3" style={stagger(0)}>
              <Eyebrow dark>Northern Coalfields Limited · Singrauli</Eyebrow>
            </div>
            {/* Bilingual by default, as the colony's own signboards are: English and Hindi set
                together as one headline, not a language switch. Devanagari has no italic, so its
                accent is the serif (Noto Serif Devanagari) in gold. Hindi to be checked by the
                department's Rajbhasha cell. */}
            <h1 className="mt-7 anim-fade-up" style={stagger(1)}>
              <span className="block text-[46px] sm:text-[64px] lg:text-[84px] leading-[.94] font-semibold tracking-[-0.05em]">
                A home that’s<br />cared for, <em className="font-quote font-semibold italic text-gold tracking-[-0.02em] whitespace-nowrap">every day.</em>
              </span>
              <span lang="hi" className="mt-5 flex items-stretch gap-4">
                <span className="w-[3px] rounded-full bg-gold/70 shrink-0" aria-hidden />
                <span className="block text-[28px] sm:text-[38px] lg:text-[46px] leading-[1.35] font-semibold text-white/92">
                  एक घर, जिसकी देखभाल होती है —{' '}
                  <span className="text-gold whitespace-nowrap" style={{ fontFamily: 'var(--font-quote-hi)' }}>हर दिन।</span>
                </span>
              </span>
            </h1>
            <p className="mt-7 text-[17px] md:text-[20px] leading-[1.55] text-white/80 max-w-[34rem] anim-fade-up" style={stagger(2)}>
              Report a problem in your quarter in under a minute. You’ll see every step until it is fixed,
              and nothing is closed until an Overseer has inspected the work.
            </p>
            <div className="mt-10 flex flex-wrap gap-3 anim-fade-up" style={stagger(3)}>
              <IslandButton icon={<ClipboardList size={19} strokeWidth={1.75} />} onClick={() => nav('/signin?tab=Resident')}>Report a problem</IslandButton>
              <IslandButton tone="glass" onClick={() => nav('/signin?tab=Civil Colony Incharge')}>Officer sign in</IslandButton>
            </div>
          </div>
          <div className="hidden lg:flex justify-end anim-fade-up" style={stagger(4)}><div className="float-slow"><LiveCard /></div></div>
        </div>

        {/* the hour in Singrauli, and a way to see the colony at any hour */}
        <div className="relative z-10 max-w-[1280px] w-full mx-auto px-4 md:px-8 pb-8 flex flex-wrap items-end justify-between gap-4">
          <div className="text-[13px] text-white/75 flex flex-wrap items-center gap-x-2 gap-y-1" id="help">
            <span><span className="tnum font-semibold text-white">{now.label}</span> in Singrauli</span>
            <span className="text-white/30">·</span> 24-hour helpline
            <a href="tel:07805224000" className="font-semibold text-white tnum inline-flex items-center gap-1.5 hover:text-gold transition-colors duration-300"><Phone size={14} strokeWidth={1.75} />07805-224000</a>
          </div>
          <div className="flex gap-1 p-1 rounded-full bg-black/25 backdrop-blur-md ring-1 ring-white/10" role="group" aria-label="See the colony at another hour">
            {(['dawn', 'day', 'dusk', 'night'] as Phase[]).map((p) => (
              <button key={p} onClick={() => setOverride(override === p ? null : p)} aria-pressed={phase === p}
                className={clsx('h-8 px-3.5 rounded-full text-[12px] font-medium capitalize transition-colors duration-300', phase === p ? 'bg-white text-primary-dark' : 'text-white/70 hover:text-white')}>{p}</button>
            ))}
          </div>
        </div>
        <div className="lg:hidden relative z-10 px-4 pb-8"><LiveCard compact /></div>
      </section>

      {/* ------------------------------------------------ 2. the story, as you scroll */}
      <section id="story" className="relative scroll-mt-24">
        <div className="max-w-[1280px] mx-auto px-4 md:px-8 pt-28 md:pt-40">
          <div className="reveal max-w-3xl">
            <Eyebrow>How it works</Eyebrow>
            <h2 className="mt-5 text-[40px] md:text-[64px] leading-[1] font-semibold tracking-[-0.045em] text-primary">
              One complaint. <em className="font-quote italic text-gold-text tracking-[-0.02em]">Seven honest steps.</em>
            </h2>
            <p className="mt-5 text-[17px] text-ink-muted max-w-2xl">Each step is taken by a named person in a named role, and the record of it can never be edited afterwards.</p>
          </div>
        </div>
        <div className="max-w-[1280px] mx-auto px-4 md:px-8 grid lg:grid-cols-2 gap-10 lg:gap-20 pb-28 md:pb-40">
          {/* sticky phone */}
          <div className="hidden lg:block">
            <div className="sticky top-[calc(50vh-300px)] h-[600px] grid place-items-center">
              <div className="relative w-[300px] h-[600px] rounded-[48px] bg-primary-dark p-3 shadow-[0_50px_100px_-40px_rgba(10,51,51,.7)] ring-1 ring-black/10">
                <div className="absolute top-5 left-1/2 -translate-x-1/2 w-20 h-5 rounded-full bg-black/60" />
                <div className="h-full rounded-[38px] bg-bg overflow-hidden flex flex-col">
                  <div className="bg-sidebar text-white px-5 pt-12 pb-5">
                    <div className="text-[11px] text-white/60">My quarter — B-234</div>
                    <div className="font-semibold text-[17px] mt-0.5">Kitchen tap leaking</div>
                  </div>
                  <div className="p-4 flex-1">
                    <div key={step} className="anim-chip"><StatusChip tone={toneOf(cur.s)}>{STATE[cur.s].resident}</StatusChip></div>
                    <ol className="mt-5 space-y-3">
                      {STORY.map((st, k) => (
                        <li key={st.s} className={clsx('flex items-center gap-3 transition-opacity duration-700 ease-fluid', k > step && 'opacity-30')}>
                          <span className={clsx('w-7 h-7 rounded-full grid place-items-center shrink-0 transition-colors duration-700',
                            k < step ? 'bg-primary-btn text-on-primary' : k === step ? 'bg-gold text-primary-dark ring-4 ring-gold/25' : 'bg-muted text-ink-muted')}>
                            {k < step ? <BadgeCheck size={14} /> : <span className="text-[11px] font-semibold">{k + 1}</span>}</span>
                          <span className="text-[13px] leading-tight"><span className="font-semibold block">{STATE[st.s].resident}</span>
                            <span className="text-ink-muted text-[11px]">{st.who}</span></span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
              </div>
            </div>
          </div>
          {/* the steps */}
          <div>
            {STORY.map((st, k) => (
              <div key={st.s} data-step={k} className="py-10 lg:py-0 lg:min-h-[62vh] flex items-center">
                <div className={clsx('transition-[opacity,filter] duration-700 ease-fluid', step === k ? 'opacity-100' : 'lg:opacity-35 lg:blur-[1px]')}>
                  <div className="flex items-center gap-3">
                    <span className="font-quote italic text-[64px] leading-none text-gold-text">{String(k + 1).padStart(2, '0')}</span>
                    <span className="inline-flex items-center gap-2 h-8 px-3 rounded-full bg-tint text-primary text-[12px] font-semibold">{st.icon}{st.who}</span>
                  </div>
                  <h3 className="mt-5 text-[30px] md:text-[40px] leading-[1.05] font-semibold tracking-[-0.035em] text-primary">{st.title}</h3>
                  <p className="mt-4 text-[17px] leading-[1.6] text-ink-muted max-w-md">{st.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ 3. proof, not promises */}
      <section id="proof" className="relative bg-primary-dark text-white overflow-hidden scroll-mt-24">
        <div className="absolute inset-0 opacity-60" style={{ background: 'radial-gradient(60% 50% at 80% 30%, rgba(143,211,203,.18), transparent 70%), radial-gradient(50% 50% at 10% 90%, rgba(201,169,106,.16), transparent 70%)' }} />
        <div className="relative max-w-[1280px] mx-auto px-4 md:px-8 py-28 md:py-40 grid lg:grid-cols-2 gap-14 items-center">
          <div className="reveal">
            <Eyebrow dark>The inspection</Eyebrow>
            <h2 className="mt-5 text-[40px] md:text-[64px] leading-[1] font-semibold tracking-[-0.045em]">
              Proof, <em className="font-quote italic text-gold tracking-[-0.02em]">not promises.</em>
            </h2>
            <p className="mt-6 text-[17px] text-white/70 max-w-lg">A repair is closed only on an Overseer’s own photograph, taken on site after the contractor says the work is done.</p>
            <div className="mt-10 grid sm:grid-cols-3 gap-3">
              {[['Taken in the app', 'Never picked from a gallery.'], ['Place and time', 'Fixed at the moment of the shutter.'], ['Kept as evidence', 'Its record outlives the picture itself.']].map(([t, b]) => (
                <div key={t} className="rounded-2xl p-4 bg-white/[.05] ring-1 ring-white/10 backdrop-blur-sm">
                  <div className="font-semibold text-[15px]">{t}</div><div className="text-[13px] text-white/60 mt-1">{b}</div>
                </div>
              ))}
            </div>
          </div>
          {/* viewfinder */}
          <div className="reveal">
            <div className="relative aspect-[4/3] rounded-[2rem] overflow-hidden ring-1 ring-white/15 shadow-[0_50px_100px_-40px_rgba(0,0,0,.8)]"
              style={{ background: 'linear-gradient(160deg,#3d5a52,#1d3532 60%,#13262a)' }}>
              <svg viewBox="0 0 400 300" className="absolute inset-0 w-full h-full" aria-hidden>
                <rect x="70" y="60" width="260" height="190" fill="#2a463f" /><rect x="70" y="60" width="260" height="14" fill="#4d6b62" />
                <rect x="170" y="130" width="60" height="120" fill="#16302c" /><circle cx="218" cy="190" r="3" fill="#c9a96a" />
                <rect x="95" y="100" width="50" height="40" fill="#3f5f57" /><rect x="255" y="100" width="50" height="40" fill="#3f5f57" />
                <rect x="0" y="250" width="400" height="50" fill="#0f2220" />
              </svg>
              <div className="absolute inset-6 pointer-events-none">
                {['top-0 left-0 border-t-2 border-l-2', 'top-0 right-0 border-t-2 border-r-2', 'bottom-0 left-0 border-b-2 border-l-2', 'bottom-0 right-0 border-b-2 border-r-2'].map((c) => (
                  <span key={c} className={clsx('absolute w-8 h-8 border-white/80 rounded-[4px]', c)} />))}
                <span className="absolute left-1/2 top-1/2 w-10 h-10 -ml-5 -mt-5 rounded-full ring-1 ring-white/70 focus-pulse" />
              </div>
              <div className="absolute top-5 left-1/2 -translate-x-1/2 flex items-center gap-2 h-7 px-3 rounded-full bg-black/40 backdrop-blur-md text-[11px] font-semibold whitespace-nowrap">
                <span className="w-2 h-2 rounded-full bg-[#F0877E] rec-blink" />INSPECTION · JNT/2026/00042
              </div>
              <div className="absolute left-0 right-0 bottom-0 p-5 bg-gradient-to-t from-black/70 to-transparent font-mono text-[12px] leading-relaxed tnum">
                <div className="flex items-center gap-1.5"><MapPin size={13} />24.1966° N, 82.6643° E · ±6 m</div>
                <div>{now.label} IST · Civil Colony Overseer · Jayant</div>
                <div className="text-white/55">SHA-256 recorded on upload</div>
              </div>
            </div>
            <div className="text-[12px] text-white/45 mt-3">Illustration of how an inspection photograph is stamped.</div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ 4. thirteen Areas */}
      <section id="areas" className="relative py-28 md:py-36 overflow-hidden scroll-mt-24">
        <div className="max-w-[1280px] mx-auto px-4 md:px-8 reveal">
          <Eyebrow>Across the coalfield</Eyebrow>
          <h2 className="mt-5 text-[40px] md:text-[64px] leading-[1] font-semibold tracking-[-0.045em] text-primary">
            Thirteen colonies. <em className="font-quote italic text-gold-text tracking-[-0.02em]">One standard.</em>
          </h2>
        </div>
        <div className="mt-14 marquee-mask" aria-hidden>
          <div className="marquee">
            {[0, 1].map((dup) => (
              <div key={dup} className="flex shrink-0 gap-10 pr-10">
                {Object.keys(AREAS).map((code) => (
                  <span key={code} className="text-[96px] md:text-[150px] font-semibold tracking-[-0.06em] leading-none outline-text">{code}</span>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="max-w-[1280px] mx-auto px-4 md:px-8 mt-14 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-6 gap-y-1 reveal">
          {Object.entries(AREAS).map(([code, name]) => (
            <div key={code} className="group flex items-baseline gap-3 py-3 border-b border-line">
              <span className="w-12 shrink-0 text-[11px] font-semibold text-gold-text tnum tracking-[0.06em]">{code}</span>
              <span className="text-[15px] transition-transform duration-500 ease-fluid group-hover:translate-x-1">{name}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------ 5. numbers */}
      <section className="border-y border-line bg-surface/60">
        <div className="max-w-[1280px] mx-auto px-4 md:px-8 py-16 grid grid-cols-2 lg:grid-cols-4 gap-y-10">
          {([[<CountUp key="q" to={15000} />, 'company quarters'], [<span key="b">~<CountUp to={130} /></span>, 'other buildings — schools, dispensaries, offices'],
            [<CountUp key="a" to={13} ms={900} />, 'Areas, one portal'], [<span key="h"><CountUp to={24} ms={900} /> h</span>, 'to reopen if it is not fixed']] as [ReactNode, string][]).map(([v, l], i) => (
            <div key={i} className="reveal px-2 lg:border-l lg:first:border-l-0 border-line lg:pl-8">
              <div className="text-[52px] md:text-[64px] font-semibold tracking-[-0.05em] text-primary leading-none">{v}</div>
              <div className="text-[14px] text-ink-muted mt-3 max-w-[14rem]">{l}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------ 6. the last word */}
      <section className="max-w-[1280px] mx-auto px-4 md:px-8 py-28 md:py-40">
        <div className="reveal relative rounded-[2.5rem] overflow-hidden bg-primary-dark text-white p-8 md:p-16">
          <div className="absolute -right-24 -top-24 w-[420px] h-[420px] rounded-full opacity-50 float-slow" style={{ background: 'radial-gradient(circle, rgba(201,169,106,.45), transparent 65%)' }} />
          <div className="relative grid lg:grid-cols-[1.3fr_.7fr] gap-10 items-end">
            <div>
              <blockquote className="font-quote italic text-[36px] md:text-[60px] leading-[1.02] tracking-[-0.01em]">“Well maintained colonies, stronger communities.”</blockquote>
              <p className="mt-6 text-white/70 text-[17px] max-w-lg">Something not right at home? It takes under a minute to tell us.</p>
            </div>
            <div className="flex flex-col items-start lg:items-end gap-3">
              <IslandButton onClick={() => nav('/signin?tab=Resident')}>Report a problem</IslandButton>
              <a href="tel:07805224000" className="text-white/75 hover:text-white text-sm inline-flex items-center gap-2"><Phone size={14} />07805-224000 · 24 hours</a>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="max-w-[1280px] mx-auto px-4 md:px-8 py-10 flex flex-wrap items-center justify-between gap-6">
          <div className="flex flex-wrap items-center gap-4"><Logo onDark={false} />
            {['NCL', 'CIL'].map((l) => <div key={l} className="w-[96px] h-10 rounded-xl ring-1 ring-line grid place-items-center text-[11px] font-semibold text-ink-muted" title={`${l} logo — from NCL Corporate Communications`}>{l} logo</div>)}
          </div>
          <div className="text-[13px] text-ink-muted">Northern Coalfields Limited · A subsidiary of Coal India Limited · Singrauli, Madhya Pradesh</div>
        </div>
      </footer>
    </div>
  );
}
