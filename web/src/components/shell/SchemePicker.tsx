import clsx from 'clsx';
import { Check } from 'lucide-react';
import { usePrefs } from '../../lib/prefs';
import schemes from '../../lib/schemes.json';

/* Colour scheme, chosen by the person and kept in this browser
   (2026-10-15). The schemes come from tokens/tokens.json through the
   token build, never from this file. Status colours (on time, at risk,
   breached …) are the same in every scheme. */

type Info = { name: string; note: string; swatch: string[] };
const LIST = Object.entries(schemes as Record<string, Info>);

export function SchemePicker({ compact }: { compact?: boolean }) {
  const { scheme, setScheme } = usePrefs();
  return (
    <div role="radiogroup" aria-label="Colour scheme" className={clsx('grid gap-1.5', !compact && 'sm:grid-cols-2')}>
      {LIST.map(([id, s]) => {
        const on = scheme === id;
        return (
          <button key={id} type="button" role="radio" aria-checked={on} onClick={() => setScheme(id)}
            className={clsx('flex items-center gap-3 text-left rounded-xl border px-2.5 py-2 transition-colors',
              on ? 'border-primary bg-tint' : 'border-line hover:bg-row-hover')}>
            <span className="flex shrink-0 rounded-md overflow-hidden ring-1 ring-black/10" aria-hidden>
              {s.swatch.map((c, i) => <span key={i} className="w-3.5 h-7" style={{ background: c }} />)}
            </span>
            <span className="min-w-0 flex-1">
              <span className={clsx('block text-[13px]', on && 'font-semibold')}>{s.name}</span>
              {!compact && <span className="block text-[11.5px] text-ink-muted leading-snug">{s.note}</span>}
            </span>
            {on && <Check size={16} className="text-primary shrink-0" />}
          </button>
        );
      })}
    </div>
  );
}
