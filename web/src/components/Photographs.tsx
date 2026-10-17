import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Card, IconButton } from './ui';
import { session } from '../lib/api';
import { when } from '../lib/format';

/* The complaint's photographs (user's finding, 2026-10-10: they were kept
   but shown nowhere). Fetched with the session's token — an <img> cannot
   send one — and held as object URLs for the life of the page. The server
   decides who sees which: an objection's photograph never reaches the
   contractor. */

type Media = { id: string; purpose: string; captured_at?: string; latitude?: number | null; longitude?: number | null; gps_accuracy_m?: number | null };

/* Where it was taken, on every photograph (user's request, 2026-10-12). */
const placeOf = (m: Media) => m.latitude == null || m.longitude == null ? null
  : `${Number(m.latitude).toFixed(5)}, ${Number(m.longitude).toFixed(5)}${m.gps_accuracy_m != null ? ` (±${Math.round(Number(m.gps_accuracy_m))} m)` : ''}`;

const KINDS: [string, string][] = [
  // whoever raised it — the occupant, or an officer for a building
  ['COMPLAINT', 'Photographs of the problem'], ['OBJECTION', 'With the objection'],
  ['BEFORE', 'Before the work'], ['COMPLETION', 'After the work'], ['INSPECTION', "The Overseer's inspection"]
];

const cache = new Map<string, Promise<string | null>>();
function blobUrl(id: string): Promise<string | null> {
  if (!cache.has(id)) {
    cache.set(id, fetch(`/maintenance/v1/media/${id}/image`, { headers: { authorization: `Bearer ${session.get()?.token}` } })
      .then((r) => (r.ok ? r.blob().then((b) => URL.createObjectURL(b)) : null))
      .catch(() => null));
  }
  return cache.get(id)!;
}

function Thumb({ m, onOpen }: { m: Media; onOpen: (src: string) => void }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => { let live = true; blobUrl(m.id).then((u) => live && setSrc(u)); return () => { live = false; }; }, [m.id]);
  return (
    <div className="w-28 shrink-0">
      <button type="button" onClick={() => src && onOpen(src)} title={when(m.captured_at)}
        className="w-24 h-24 rounded-input overflow-hidden bg-muted grid place-items-center text-[11px] text-ink-muted">
        {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : src === null ? 'Not available' : '…'}
      </button>
      <div className="text-[10px] leading-tight text-ink-muted mt-1 tnum">{placeOf(m) || 'No location recorded'}</div>
    </div>
  );
}

export function Photographs({ media }: { media?: Media[] }) {
  const [open, setOpen] = useState<{ src: string; m: Media } | null>(null);
  if (!media?.length) return null;
  return (
    <Card className="p-4 grid gap-3">
      {KINDS.map(([purpose, label]) => {
        const set = media.filter((m) => m.purpose === purpose);
        if (!set.length) return null;
        return (
          <div key={purpose}>
            <div className="text-[13px] font-semibold mb-1.5">{label} · {set.length}</div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {set.map((m) => <Thumb key={m.id} m={m} onOpen={(src) => setOpen({ src, m })} />)}
            </div>
          </div>
        );
      })}
      {open && (
        <div className="fixed inset-0 z-50 bg-black/85 grid place-items-center p-6" onClick={() => setOpen(null)} role="dialog" aria-label="Photograph">
          <div className="absolute top-4 right-4"><IconButton label="Close" onClick={() => setOpen(null)}><X size={22} className="text-white" /></IconButton></div>
          <img src={open.src} alt="" className="max-w-full max-h-[80vh] rounded-card" />
          <div className="text-white/80 text-sm mt-3">{KINDS.find(([p]) => p === open.m.purpose)?.[1]} · {when(open.m.captured_at)}</div>
          <div className="text-white/70 text-sm tnum">{placeOf(open.m) ? `Taken at ${placeOf(open.m)}` : 'No location recorded with this photograph'}</div>
        </div>
      )}
    </Card>
  );
}

/* Every photograph of the job on the job card, the printed sheet included
   (user's request, 2026-10-16: the card showed only how many). In the order
   the work went — the problem, before, after, the inspection — each with what
   it is, when and where it was taken; sized to print several to a row. */
function Plate({ m }: { m: Media }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => { let live = true; blobUrl(m.id).then((u) => live && setSrc(u)); return () => { live = false; }; }, [m.id]);
  return (
    <figure className="break-inside-avoid m-0">
      <div className="aspect-[4/3] rounded-input overflow-hidden bg-muted grid place-items-center text-[11px] text-ink-muted border border-line">
        {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : src === null ? 'Not available' : '…'}
      </div>
      <figcaption className="text-[10.5px] leading-tight mt-1">
        <b>{KINDS.find(([p]) => p === m.purpose)?.[1] || m.purpose}</b> · {when(m.captured_at)}
        <div className="text-ink-muted tnum">{placeOf(m) || 'No location recorded'}</div>
      </figcaption>
    </figure>
  );
}
export function JobPhotos({ media, title = 'Photographs of the job' }: { media?: Media[]; title?: string }) {
  const order = KINDS.map(([p]) => p);
  const list = (media || []).slice().sort((a, b) => order.indexOf(a.purpose) - order.indexOf(b.purpose)
    || Date.parse(a.captured_at || '') - Date.parse(b.captured_at || ''));
  return (
    <section className="mt-4 break-inside-avoid">
      <div className="font-semibold">{title} · {list.length}</div>
      {list.length === 0
        ? <p className="text-xs text-ink-muted">None taken. Photographs are optional until the HQ System Administrator requires them; any taken are located and taken in the app.</p>
        : <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 mt-2">{list.map((m) => <Plate key={m.id} m={m} />)}</div>}
    </section>
  );
}
