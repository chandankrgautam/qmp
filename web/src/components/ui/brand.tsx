import clsx from 'clsx';

/* The portal's mark: the fresh brick (chosen 2026-10-15). A wall under a
   roof, three courses laid in stretcher bond, one brick new and in gold —
   maintenance is replacing what is broken, one piece at a time, and the
   rest of the wall stands. The same geometry is drawn in public/favicon.svg
   and the Android launcher icon (48-unit grid). Colours follow the chosen
   scheme: the bricks take the text or sidebar colour, the fresh brick the
   scheme's accent (--gold). */

export const ROOF = 'M7 19 24 8 41 19';
/** [x, y, width] for every brick; course height 5.4, joints about 1.4. */
export const BRICKS: [number, number, number][] = [
  [10, 22, 8.4], [19.8, 22, 8.4], [29.6, 22, 8.4],
  [10, 28.6, 3.7], [15.1, 28.6, 8.4], [34.7, 28.6, 3.3],
  [10, 35.2, 8.4], [19.8, 35.2, 8.4], [29.6, 35.2, 8.4]
];
export const FRESH: [number, number, number] = [24.9, 28.6, 8.4];

/** The mark alone, in the current text colour, the fresh brick in the accent. */
export function BrandMark({ size = 32, className, title, fresh = 'var(--gold, #C9A96A)' }:
  { size?: number; className?: string; title?: string; fresh?: string }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className={className} role={title ? 'img' : undefined}
      aria-label={title} aria-hidden={title ? undefined : true}>
      <path d={ROOF} fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      {BRICKS.map(([x, y, w]) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height="5.4" rx=".9" fill="currentColor" />)}
      <rect x={FRESH[0]} y={FRESH[1]} width={FRESH[2]} height="5.4" rx=".9" fill={fresh} />
    </svg>
  );
}

/** The app-icon tile: cream ground, the wall in the scheme's sidebar colour. */
export function BrandTile({ size = 44, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className={className} aria-hidden>
      <rect width="48" height="48" rx="11" fill="#F8F6EF" />
      <g style={{ color: 'var(--sidebar)' }}>
        <path d={ROOF} fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
        {BRICKS.map(([x, y, w]) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height="5.4" rx=".9" fill="currentColor" />)}
      </g>
      <rect x={FRESH[0]} y={FRESH[1]} width={FRESH[2]} height="5.4" rx=".9" fill="var(--gold)" stroke="var(--gold-text)" strokeWidth=".6" />
    </svg>
  );
}

/** The loading screen: the courses are laid one by one, then the fresh brick slides home. */
export function BrandLoader({ label = 'Loading…', className }: { label?: string; className?: string }) {
  const course = (y: number) => BRICKS.filter((b) => b[1] === y);
  return (
    <div className={clsx('min-h-[60vh] grid place-items-center', className)} role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-4 text-primary">
        <svg viewBox="0 0 48 48" width="76" height="76" aria-hidden className="brick-loader">
          <path d={ROOF} fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
          {[35.2, 28.6, 22].map((y, i) => (
            <g key={y} className="course" style={{ animationDelay: `${i * 160}ms` }}>
              {course(y).map(([x, yy, w]) => <rect key={x} x={x} y={yy} width={w} height="5.4" rx=".9" fill="currentColor" />)}
            </g>
          ))}
          <rect x={FRESH[0]} y={FRESH[1]} width={FRESH[2]} height="5.4" rx=".9" fill="var(--gold)" className="fresh" />
        </svg>
        <span className="text-[13px] text-ink-muted">{label}</span>
      </div>
    </div>
  );
}

