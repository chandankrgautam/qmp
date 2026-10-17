import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { ArrowRight, CornerDownLeft, Search } from 'lucide-react';
import { StatusChip } from '../ui';
import { api, session } from '../../lib/api';
import { STATE } from '../../lib/domain';
import { usePrefs } from '../../lib/prefs';
// loaded on first use, so the shell does not carry the panel for every role
const TicketPanel = lazy(() => import('../../pages/officer/TicketPanel'));

/* Ctrl+K / ⌘K from anywhere in the office portal: type a complaint number
   the way people say it ("JNT/2026/42"), a quarter ("B-234") or a word
   ("leak"), and go straight to it. Results come from the same search the
   Search page uses, under the caller's own row security — the palette
   filters nothing itself (control 3). */

type Item = { key: string; label: ReactNode; hint?: ReactNode; go: () => void };

/** "jnt/2026/42" → "JNT/2026/00042": the number as the system writes it. */
export function normaliseTicket(q: string) {
  const m = q.trim().match(/^([a-z]{2,4})\s*\/\s*(\d{4})\s*\/\s*(\d{1,5})$/i);
  return m ? `${m[1].toUpperCase()}/${m[2]}/${m[3].padStart(5, '0')}` : null;
}

const PANEL_ROLES = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL'];

export function CommandPalette({ pages }: { pages: { to: string; label: string; icon: ReactNode }[] }) {
  const nav = useNavigate();
  const { t } = usePrefs();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [i, setI] = useState(0);
  const [panel, setPanel] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const role = session.get()?.role || '';

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
    };
    const ask = () => setOpen(true);
    addEventListener('keydown', key); addEventListener('open-palette', ask);
    return () => { removeEventListener('keydown', key); removeEventListener('open-palette', ask); };
  }, []);
  useEffect(() => { if (open) { setQ(''); setHits([]); setI(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  // the search, a moment after typing stops; a stale answer never overwrites a newer one
  useEffect(() => {
    const term = q.trim();
    if (!open || term.length < 2) { setHits([]); return; }
    let live = true;
    const id = setTimeout(async () => {
      setBusy(true);
      const exact = normaliseTicket(term);
      try {
        const r = await api<{ items: any[] }>(`/search?page_size=8&q=${encodeURIComponent(exact || term)}`);
        if (live) { setHits(r.items); setI(0); }
      } catch { if (live) setHits([]); } finally { if (live) setBusy(false); }
    }, 180);
    return () => { live = false; clearTimeout(id); };
  }, [q, open]);

  const items: Item[] = useMemo(() => {
    const term = q.trim().toLowerCase();
    const openTicket = (h: any) => () => {
      setOpen(false);
      if (PANEL_ROLES.includes(role)) setPanel(h.id); else nav(`/w/search?q=${encodeURIComponent(h.ticket_no)}`);
    };
    const tickets: Item[] = hits.map((h) => ({
      key: h.id,
      label: <span className="flex items-center gap-2 min-w-0"><b className="tnum">{h.ticket_no}</b><span className="text-ink-muted shrink-0">·</span>
        <span className="font-medium">{h.identifier}</span><span className="truncate text-ink-muted">{h.sub_category}</span></span>,
      hint: <StatusChip tone={STATE[h.state]?.tone || 'info'}>{STATE[h.state]?.label || h.state}</StatusChip>,
      go: openTicket(h)
    }));
    const pg: Item[] = pages.filter((p) => !term || t(p.label).toLowerCase().includes(term) || p.label.toLowerCase().includes(term))
      .slice(0, term ? 4 : 8).map((p) => ({ key: p.to, label: <span className="flex items-center gap-2.5">{p.icon}{t(p.label)}</span>,
        hint: <ArrowRight size={15} className="text-ink-muted" />, go: () => { setOpen(false); nav(p.to); } }));
    const all: Item[] = term.length >= 2 ? [{ key: 'search', label: <span className="flex items-center gap-2.5"><Search size={18} />Search everything for “{q.trim()}”</span>,
      go: () => { setOpen(false); nav(`/w/search?q=${encodeURIComponent(normaliseTicket(q) || q.trim())}`); } }] : [];
    return [...tickets, ...pg, ...all];
  }, [hits, pages, q, role, nav, t]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(items.length - 1, x + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[i]?.go(); }
    else if (e.key === 'Escape') setOpen(false);
  };
  const nTickets = hits.length;
  const nPages = items.length - nTickets - (q.trim().length >= 2 ? 1 : 0);

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-[60] flex justify-center items-start pt-[12vh] px-4 backdrop-blur-[6px]" style={{ background: 'var(--scrim)' }} onClick={() => setOpen(false)}>
          <div role="dialog" aria-modal aria-label="Go to" onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[640px] glass-card rounded-[22px] overflow-hidden anim-fade-up">
            <div className="flex items-center gap-3 px-5 h-16 border-b border-line">
              <Search size={20} className="text-ink-muted shrink-0" />
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
                role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={items[i] ? `pal-${i}` : undefined}
                className="flex-1 bg-transparent outline-none focus-visible:outline-none text-[17px] placeholder:text-ink-muted"
                placeholder="Complaint number, quarter or a word — e.g. JNT/2026/42, B-234, leak" />
              {busy && <span className="w-4 h-4 rounded-full border-2 border-line-strong border-t-primary animate-spin" aria-hidden />}
              <kbd className="text-[11px] text-ink-muted border border-line rounded-md px-1.5 py-0.5">Esc</kbd>
            </div>
            <ul id="palette-list" role="listbox" className="max-h-[52vh] overflow-auto p-2">
              {nTickets > 0 && <li className="label px-3 pt-2 pb-1" role="presentation">Complaints</li>}
              {items.map((it, k) => (
                <li key={it.key} id={`pal-${k}`} role="option" aria-selected={k === i}>
                  {k === nTickets && nPages > 0 && <div className="label px-3 pt-3 pb-1">Pages</div>}
                  <button onMouseMove={() => setI(k)} onClick={it.go}
                    className={clsx('w-full min-h-11 flex items-center justify-between gap-3 px-3 py-2 rounded-xl text-left text-sm transition-colors',
                      k === i ? 'bg-tint text-ink' : 'hover:bg-row-hover')}>
                    <span className="min-w-0 flex-1">{it.label}</span>
                    <span className="shrink-0 flex items-center gap-2">{it.hint}{k === i && <CornerDownLeft size={14} className="text-ink-muted" />}</span>
                  </button>
                </li>
              ))}
              {q.trim().length >= 2 && !busy && nTickets === 0 && (
                <li className="px-3 py-2 text-[13px] text-ink-muted">No complaint in your scope matches “{q.trim()}”.</li>
              )}
            </ul>
            <div className="px-5 py-2.5 border-t border-line text-[11px] text-ink-muted flex gap-4">
              <span>↑ ↓ to move</span><span>Enter to open</span><span className="ml-auto">Ctrl K anywhere</span>
            </div>
          </div>
        </div>
      )}
      {panel && <Suspense fallback={null}><TicketPanel id={panel} onClose={() => setPanel(null)} onChanged={() => {}} /></Suspense>}
    </>
  );
}

/** The header button: the palette, for those who do not use the keyboard. */
export function PaletteButton() {
  return (
    <button onClick={() => dispatchEvent(new Event('open-palette'))}
      className="hidden md:flex items-center gap-2 h-10 pl-3 pr-2 rounded-full border border-line-strong bg-surface text-[13px] text-ink-muted hover:text-ink transition-colors">
      <Search size={16} />Go to complaint…<kbd className="ml-3 text-[11px] border border-line rounded-md px-1.5 py-0.5">Ctrl K</kbd>
    </button>
  );
}
