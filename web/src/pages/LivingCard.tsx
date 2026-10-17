import { useEffect, useState } from 'react';
import { Camera, MapPin } from 'lucide-react';
import { Card } from '../components/ui';
import { session } from '../lib/api';
import { when } from '../lib/format';

/* The Overseer's inspection photograph on the resident's complaint page:
   revealed, with its place and time, once the work is accepted — the
   proof the resident is owed. (V1's ring hero and swipe panes gave way to
   the V2 receipt, pages/Receipt.tsx.) */

/** The Overseer's inspection photograph, revealed once the work is accepted. */
export function InspectionReveal({ t }: { t: any }) {
  const m = (t.media || []).filter((x: any) => x.purpose === 'INSPECTION').slice(-1)[0];
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!m) return;
    let u: string | null = null;
    fetch(`/maintenance/v1/media/${m.id}/image`, { headers: { authorization: `Bearer ${session.get()?.token}` } })
      .then(async (r) => { if (!r.ok) { setGone(true); return; } u = URL.createObjectURL(await r.blob()); setUrl(u); })
      .catch(() => setGone(true));
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [m?.id]);
  if (!m || !['INSPECTED_ACCEPTED', 'CLOSED'].includes(t.state)) return null;
  return (
    <Card className="mt-3 overflow-hidden">
      <div className="px-4 pt-3.5 pb-2 flex items-center gap-2 text-sm font-semibold"><Camera size={16} className="text-primary" />Inspected on site by the Overseer</div>
      <div className="relative aspect-[4/3] bg-muted">
        {url && <img src={url} alt="The Overseer's inspection photograph of the work" className="absolute inset-0 w-full h-full object-cover reveal-photo" />}
        {!url && !gone && <div className="absolute inset-0 skeleton !rounded-none" />}
        {gone && <div className="absolute inset-0 grid place-items-center text-[13px] text-ink-muted px-6 text-center">The photograph is no longer kept; its place and time are.</div>}
        <div className="absolute left-0 right-0 bottom-0 p-3 bg-gradient-to-t from-black/70 to-transparent text-white text-[12px] font-mono tnum">
          {m.latitude != null && <div className="flex items-center gap-1.5"><MapPin size={12} />{Number(m.latitude).toFixed(4)}° N, {Number(m.longitude).toFixed(4)}° E</div>}
          <div>{when(m.captured_at)}</div>
        </div>
      </div>
    </Card>
  );
}
