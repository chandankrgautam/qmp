/* The component set. Each follows DESIGN_SYSTEM.md §8: pill buttons with
   verb-and-object labels, hairline cards, status always as icon + text. */
import { createContext, useCallback, useContext, useEffect, useRef, useState,
  type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { AlertOctagon, BadgeCheck, CheckCircle2, ClockAlert, Info, Loader2, RotateCcw, X, Star } from 'lucide-react';
import type { Tone } from '../../lib/domain';
import { BrandMark, BrandTile } from './brand';
export { BrandMark, BrandTile, BrandLoader } from './brand';
export { celebrate } from './flourish';

/* ------------------------------------------------------------ Button */
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'gold' | 'success';
type BtnSize = 'md' | 'sm' | 'lg';
export function Button({ variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize; loading?: boolean; icon?: ReactNode }) {
  return (
    <button {...rest} disabled={disabled || loading} aria-busy={loading || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap select-none',
        'transition-[background-color,border-color,color,transform] duration-200 ease-[var(--ease)] disabled:opacity-45 disabled:cursor-not-allowed active:scale-[.97] active:translate-y-px',
        size === 'md' && 'h-11 px-5 text-sm', size === 'sm' && 'h-9 px-4 text-[13px]', size === 'lg' && 'h-14 px-6 text-base',
        variant === 'primary' && 'sheen bg-primary-btn text-on-primary hover:bg-primary-hover',
        variant === 'secondary' && 'bg-surface text-primary border-[1.5px] border-line-strong hover:bg-muted',
        variant === 'ghost' && 'text-primary hover:bg-muted',
        variant === 'destructive' && 'bg-bad text-white hover:opacity-90',
        variant === 'gold' && 'sheen bg-gold text-primary-dark hover:bg-[var(--gold-hover)]',
        variant === 'success' && 'bg-secondary text-white hover:opacity-90',
        className)}>
      {loading ? <Loader2 size={16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
export function IconButton({ label, children, className, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button aria-label={label} title={label} {...rest}
      className={clsx('inline-grid place-items-center w-11 h-11 rounded-full text-ink hover:bg-muted transition-colors', className)}>
      {children}
    </button>
  );
}

/* ------------------------------------------------------------ Card */
export function Card({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) {
  return (
    <div onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
      className={clsx('bg-surface border border-line rounded-card', onClick && 'cursor-pointer lift', className)}>
      {children}
    </div>
  );
}
export const SectionLabel = ({ children, className }: { children: ReactNode; className?: string }) =>
  <div className={clsx('label', className)}>{children}</div>;

/* ------------------------------------------------------------ Status */
const TONE: Record<Tone, { cls: string; Icon: typeof Info }> = {
  ok: { cls: 'text-ok bg-ok-bg', Icon: CheckCircle2 },
  risk: { cls: 'text-risk bg-risk-bg', Icon: ClockAlert },
  bad: { cls: 'text-bad bg-bad-bg', Icon: AlertOctagon },
  info: { cls: 'text-info bg-info-bg', Icon: Info },
  reopen: { cls: 'text-reopen bg-reopen-bg', Icon: RotateCcw },
  await: { cls: 'text-await bg-await-bg', Icon: BadgeCheck },
  neutral: { cls: 'text-ink-muted bg-muted', Icon: Info }
};
export const toneText: Record<Tone, string> = { ok: 'text-ok', risk: 'text-risk', bad: 'text-bad', info: 'text-info',
  reopen: 'text-reopen', await: 'text-await', neutral: 'text-ink-muted' };
export function StatusChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  const { cls, Icon } = TONE[tone];
  return (
    <span className={clsx('inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-xs font-semibold whitespace-nowrap', cls)}>
      <Icon size={14} aria-hidden />{children}
    </span>
  );
}

/* ------------------------------------------------------------ SLA ring */
const RING: Record<Tone, string> = { ok: 'var(--status-resolved)', risk: 'var(--status-at-risk)', bad: 'var(--status-breached)',
  info: 'var(--status-info)', reopen: 'var(--status-reopened)', await: 'var(--status-awaiting)', neutral: 'var(--text-muted)' };
export function SlaRing({ fraction, tone, label, size = 56, stroke, sub, color, track }:
  { fraction: number; tone: Tone; label: string; size?: number; stroke?: number; sub?: string; color?: string; track?: string }) {
  const sw = stroke ?? (size >= 150 ? 12 : size >= 88 ? 8 : 6);
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const f = tone === 'bad' ? 1 : Math.max(0, Math.min(1, fraction));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${label}${sub ? ' ' + sub : ''}`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track ?? 'var(--border)'} strokeWidth={sw} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color ?? RING[tone]} strokeWidth={sw}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - f)}
          style={{ transition: 'stroke-dashoffset 900ms var(--ease)' }} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center leading-none">
        <div>
          <div className={clsx('tnum font-bold', size >= 150 ? (label.length > 5 ? 'text-[30px]' : 'text-4xl') : size >= 88 ? 'text-xl' : 'text-[13px]')}
            style={{ color: color ? undefined : RING[tone] }}>{label}</div>
          {sub && <div className="text-[11px] mt-1 opacity-80">{sub}</div>}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ KPI tile */
const TILE: Record<string, string> = { ok: 'bg-ok-bg', risk: 'bg-risk-bg', bad: 'bg-bad-bg', info: 'bg-tint',
  reopen: 'bg-reopen-bg', await: 'bg-await-bg', neutral: 'bg-surface' };
export function KpiTile({ label, value, caption, tone = 'neutral', valueTone, spark, onClick }:
  { label: string; value: ReactNode; caption?: ReactNode; tone?: Tone | 'neutral'; valueTone?: Tone; spark?: number[]; onClick?: () => void }) {
  return (
    <div onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      className={clsx('kpi-tile rounded-card border border-line p-5 flex justify-between gap-3 min-w-0', TILE[tone],
        onClick && 'cursor-pointer lift')}>
      <div className="min-w-0">
        <div className="label">{label}</div>
        <div className={clsx('tnum text-[32px] leading-[1.05] font-semibold tracking-[-0.03em] mt-2', valueTone ? toneText[valueTone] : 'text-primary')}>{typeof value === 'number' ? <CountUp to={value} /> : value}</div>
        {caption && <div className="text-[13px] text-ink-muted mt-1">{caption}</div>}
      </div>
      {spark && spark.length > 1 && <Spark values={spark} tone={valueTone ?? 'info'} />}
    </div>
  );
}
/** A figure that counts up to its value when it first appears. */
function CountUp({ to }: { to: number }) {
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [v, setV] = useState(() => (still() ? to : 0));
  useEffect(() => {
    if (still() || !Number.isFinite(to)) { setV(to); return; }
    let raf = 0; const t0 = performance.now();
    const tick = (t: number) => { const p = Math.min(1, (t - t0) / 900); setV(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <>{v.toLocaleString('en-IN')}</>;
}
function Spark({ values, tone }: { values: number[]; tone: Tone }) {
  const max = Math.max(...values, 1);
  return (
    <div className="flex items-end gap-[3px] h-7 self-center" aria-hidden>
      {values.slice(-8).map((v, i) => (
        <div key={i} className="w-[5px] rounded-sm opacity-60" style={{ height: `${Math.max(12, (v / max) * 100)}%`, background: RING[tone] }} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ Chips and segmented */
export function Chip({ selected, children, onClick, icon }: { selected?: boolean; children: ReactNode; onClick?: () => void; icon?: ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={selected}
      className={clsx('inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full text-[13px] font-medium border-[1.5px] transition-colors whitespace-nowrap',
        selected ? 'bg-primary-btn text-on-primary border-transparent' : 'bg-surface text-ink border-line-strong hover:bg-muted')}>
      {icon}{children}
    </button>
  );
}
export function Segmented<T extends string>({ options, value, onChange, className }:
  { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={clsx('inline-flex flex-wrap bg-muted rounded-2xl p-1 gap-1', className)} role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} onClick={() => onChange(o.value)}
          className={clsx('min-h-9 px-3.5 rounded-xl text-[13px] font-medium transition-colors text-center',
            o.value === value ? 'bg-surface text-primary shadow-sm font-semibold' : 'text-ink-muted hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ Form fields */
export function Field({ label, required, help, error, children }:
  { label: string; required?: boolean; help?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[13px] font-medium text-ink mb-1.5">{label}{required && ' *'}</span>
      {children}
      {error ? <span className="flex items-center gap-1 text-xs text-bad mt-1.5"><AlertOctagon size={13} />{error}</span>
        : help && <span className="block text-xs text-ink-muted mt-1.5">{help}</span>}
    </label>
  );
}
export const inputCls = 'w-full h-11 px-3.5 rounded-input border-[1.5px] border-line-strong bg-surface text-ink text-sm placeholder:text-ink-muted hover:border-ink-muted/50 transition-colors duration-200 focus:border-primary focus:outline-none disabled:bg-muted disabled:text-ink-muted';

/* ------------------------------------------------------------ Dialog and sheet */
export function Dialog({ open, title, onClose, children, actions, width = 480 }:
  { open: boolean; title: string; onClose: () => void; children: ReactNode; actions?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass a fresh onClose on every render; depending on it re-ran the
  // focus below after each keystroke and threw the cursor onto the close
  // button (user's finding, 2026-10-13). Focus once, when the dialog opens,
  // in its first field; the close button only if there is nothing else.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const box = ref.current;
    (box?.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea')
      ?? box?.querySelector<HTMLElement>('[data-dialog-body] button, [data-dialog-actions] button')
      ?? box?.querySelector<HTMLElement>('button'))?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    addEventListener('keydown', esc);
    return () => { removeEventListener('keydown', esc); prev?.focus(); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 backdrop-blur-[6px]" style={{ background: 'var(--scrim)' }} onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal aria-label={title} onClick={(e) => e.stopPropagation()}
        className="bg-surface rounded-dialog p-6 w-full max-h-[90vh] overflow-auto anim-fade-up shadow-[0_24px_64px_rgba(10,51,51,.28)]"
        style={{ maxWidth: width }}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <h3 className="text-lg font-semibold">{title}</h3>
          <IconButton label="Close" onClick={onClose} className="-mt-2 -mr-2"><X size={20} /></IconButton>
        </div>
        <div data-dialog-body>{children}</div>
        {actions && <div data-dialog-actions className="flex justify-end flex-wrap gap-2 mt-6">{actions}</div>}
      </div>
    </div>
  );
}
export function Sheet({ open, title, sub, onClose, children, progress }:
  { open: boolean; title: string; sub?: string; onClose: () => void; children: ReactNode; progress?: [number, number] }) {
  if (!open) return null;
  return (
    <div className="absolute inset-0 z-40 flex items-end" style={{ background: 'var(--scrim)' }} onClick={onClose}>
      <div role="dialog" aria-modal aria-label={title} onClick={(e) => e.stopPropagation()}
        className="w-full max-h-[88%] overflow-auto bg-bg rounded-t-sheet anim-sheet shadow-[0_-12px_32px_rgba(0,0,0,.25)]">
        <div className="w-10 h-1 rounded-full bg-line-strong mx-auto mt-3" />
        <div className="px-4 pt-3 pb-2 flex items-start justify-between">
          <div><h3 className="text-lg font-semibold">{title}</h3>{sub && <div className="text-[13px] text-ink-muted">{sub}</div>}</div>
          <IconButton label="Close" onClick={onClose}><X size={20} /></IconButton>
        </div>
        {progress && (
          <div className="flex gap-1.5 px-4 mb-3">
            {Array.from({ length: progress[1] }).map((_, i) => (
              <div key={i} className={clsx('h-1 flex-1 rounded-full', i < progress[0] ? 'bg-primary-btn' : 'bg-line')} />
            ))}
          </div>
        )}
        <div className="px-4 pb-6">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Feedback states */
export const Skeleton = ({ className }: { className?: string }) => <div className={clsx('skeleton', className)} />;
export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="text-center py-10 px-4">
      <div className="w-14 h-14 rounded-2xl bg-tint text-primary/70 grid place-items-center mx-auto"><BrandMark size={34} /></div>
      <div className="font-semibold mt-3">{title}</div>
      {body && <p className="text-[13px] text-ink-muted mt-1 max-w-sm mx-auto">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="flex items-start gap-3 p-4 rounded-card border border-bad bg-bad-bg text-bad text-[13px]" role="alert">
      <AlertOctagon size={18} className="shrink-0 mt-0.5" />
      <div className="flex-1">{message}</div>
      {retry && <Button size="sm" variant="secondary" onClick={retry}>Try again</Button>}
    </div>
  );
}

/* ------------------------------------------------------------ Timeline */
export function Timeline({ items }: { items: { title: string; who?: string; at?: string; current?: boolean; done?: boolean }[] }) {
  return (
    <ol className="relative border-l-2 border-line ml-1.5">
      {items.map((it, i) => (
        <li key={i} className="pl-5 pb-5 last:pb-0 relative">
          <span className={clsx('absolute -left-[7px] top-1 w-3 h-3 rounded-full',
            it.current ? 'bg-surface ring-2 ring-primary' : it.done === false ? 'bg-surface border-2 border-line-strong' : 'bg-primary-btn')} />
          <div className="font-semibold text-[15px]">{it.title}</div>
          {it.who && <div className="text-[13px] text-ink-muted">{it.who}</div>}
          {it.at && <div className="text-xs text-ink-muted">{it.at}</div>}
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------ Rating */
export function Stars({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} role="radio" aria-checked={value === n} aria-label={`${n} of 5`} onClick={() => onChange(n)}
          className="w-11 h-11 grid place-items-center">
          <Star size={30} fill={n <= value ? 'var(--gold)' : 'none'} stroke={n <= value ? 'var(--gold)' : 'var(--border-strong)'} />
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ Avatar and brand */
export const Avatar = ({ text, className }: { text: string; className?: string }) =>
  <div className={clsx('w-9 h-9 rounded-full bg-primary-btn text-on-primary grid place-items-center text-[13px] font-semibold shrink-0', className)}>{text}</div>;

export function Logo({ onDark = true, compact }: { onDark?: boolean; compact?: boolean }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <BrandTile size={44} className="shrink-0 rounded-[11px] ring-1 ring-white/20" />
      {!compact && (
        <div className="leading-tight min-w-0">
          <div className={clsx('font-bold text-[15px] tracking-wide', onDark ? 'text-white' : 'text-primary')}>CIVIL COLONY</div>
          <div className="text-[10.5px] font-semibold tracking-[.14em] text-gold">MAINTENANCE PORTAL</div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ Toast */
type ToastT = { id: number; text: string; undo?: () => void; tone?: 'ok' | 'bad' };
const ToastCtx = createContext<(t: Omit<ToastT, 'id'>) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastT[]>([]);
  const push = useCallback((t: Omit<ToastT, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x, { ...t, id }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-6 left-1/2 z-[60] flex flex-col gap-2 items-center" style={{ transform: 'translateX(-50%)' }} role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={clsx('flex items-center gap-3 rounded-full pl-5 pr-3 py-3 text-sm font-medium text-white shadow-[0_12px_32px_rgba(10,51,51,.3)]',
            t.tone === 'bad' ? 'bg-bad' : 'bg-primary-dark')} style={{ animation: 'fade-up 240ms var(--ease) both' }}>
            {t.text}
            {t.undo && <button className="text-gold font-semibold px-2" onClick={t.undo}>Undo</button>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
