import { useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { Camera, Home, Plus, ShieldAlert, Zap, CheckCircle2, RotateCcw, MessageSquareWarning, ChevronRight, Scale } from 'lucide-react';
import { Button, Card, Chip, EmptyState, ErrorState, Field, SectionLabel, Sheet, Skeleton, SlaRing, Stars, StatusChip,
  celebrate, inputCls, useToast } from '../components/ui';
import { InspectionReveal } from './LivingCard';
import { ColonyNotices, DetailsCard, EscalationCard, JourneyCard, StatusCard } from './Receipt';
import { doubleTick, tick } from '../lib/haptics';
import { vtName, vtNavigate } from '../lib/vt';
import { categoryIcon } from '../components/ui/icons';
import { MobileShell } from '../components/shell/Shells';
import { Alerts, Profile } from './MobileCommon';
import { api, idApi, session } from '../lib/api';
import { OPEN_STATES, STATE, deadlineSla, slaText } from '../lib/domain';
import { shortDate, when } from '../lib/format';
import { takePhoto } from '../lib/photo';
import { usePrefs } from '../lib/prefs';
import { useAutoRefresh, useLoad } from '../lib/useLoad';
import { Photographs } from '../components/Photographs';

/* Resident flow (v4 Mobile Apps, R1–R4). No KPIs on the resident home:
   one dominant action (design decision "boldness budget"). */

export default function Resident() {
  return (
    <Routes>
      <Route path="home" element={<ResidentHome />} />
      <Route path="complaints" element={<AllComplaints />} />
      <Route path="c/:id" element={<ComplaintDetail />} />
      <Route path="alerts" element={<Alerts />} />
      <Route path="profile" element={<Profile />} />
      <Route path="*" element={<Navigate to="/m/home" replace />} />
    </Routes>
  );
}

/* ---------------------------------------------------------------- home */
function useMine() {
  return useLoad(async () => {
    const list = await api<{ items: any[] }>('/tickets');
    // full rows: the SLA window lives on the ticket. A finished job stays
    // until the occupant has said whether it was fixed (user's finding,
    // 2026-10-10), unless the Staff Officer has decided or it is archived.
    const shown = list.items.filter((t) => OPEN_STATES.includes(t.state)
      || (['INSPECTED_ACCEPTED', 'CLOSED'].includes(t.state) && !t.archived_at));
    const full = (await Promise.all(shown.map(async (t) => {
      const d = await api(`/tickets/${t.id}`);
      if (OPEN_STATES.includes(d.state)) return d;
      if (d.final_decision) return null;
      const fb = await api(`/tickets/${t.id}/feedback`).catch(() => null);
      return fb ? null : { ...d, awaiting_you: true };
    }))).filter(Boolean);
    return { all: list.items, open: full };
  });
}

function ResidentHome() {
  const s = session.get()!;
  const { t } = usePrefs();
  const me = useLoad(() => idApi('/me'));
  const mine = useMine();
  const [report, setReport] = useState(false);
  useAutoRefresh(mine.reload, 30, report);
  const nav = useNavigate();
  const first = s.name.replace(/^(Mrs?\.?|Shri|Smt\.?)\s+/i, '');
  return (
    <MobileShell title={`Namaste, ${first}`} sub={s.role === 'CUSTODIAN' ? 'Custodian' : 'Resident'}
      overlay={<ReportSheet open={report} onClose={() => setReport(false)} onDone={(id) => { setReport(false); mine.reload(); nav(`/m/c/${id}`); }} />}>
      <Card className="p-4 flex items-center gap-3.5">
        <div className="w-12 h-12 rounded-card bg-tint text-primary grid place-items-center shrink-0"><Home size={22} /></div>
        {me.loading ? <Skeleton className="h-10 flex-1" /> : (
          <div className="min-w-0">
            <div className="text-[13px] text-ink-muted">{t('My quarter')}</div>
            <div className="font-bold text-[17px] truncate">Qtr No. {me.data?.identifier}, {me.data?.area}</div>
            <div className="text-[13px] text-ink-muted">{me.data?.quarter_type ? `Type ${me.data.quarter_type}` : me.data?.premises_type} · {me.data?.colony}</div>
          </div>
        )}
      </Card>

      <div className="mt-3"><ColonyNotices compact /></div>
      <button onClick={() => setReport(true)}
        className="mt-3 w-full rounded-card-lg p-5 flex items-center gap-4 text-left text-white shadow-[0_8px_20px_rgba(15,76,76,.28)] active:scale-[.99] transition-transform"
        style={{ background: 'linear-gradient(150deg,var(--primary-button),var(--primary-dark))' }}>
        <span className="w-14 h-14 rounded-full bg-gold text-primary-dark grid place-items-center shrink-0"><Plus size={28} /></span>
        <span><span className="block text-xl font-bold">{t('Report a problem')}</span>
          <span className="block text-[13px] text-white/78">{t('Takes under a minute')}</span></span>
      </button>

      <SectionLabel className="mt-6 mb-2.5">{t('My open complaints')}</SectionLabel>
      {mine.error && <ErrorState message={mine.error} retry={mine.reload} />}
      {mine.loading && !mine.data && [0, 1].map((i) => <Skeleton key={i} className="h-20 mb-2.5" />)}
      {mine.data && mine.data.open.length === 0 && (
        <EmptyState title="No open complaints" body="Report a problem when something in your quarter needs fixing." />
      )}
      <div className="flex flex-col gap-2.5">
        {mine.data?.open.map((c) => <ComplaintCard key={c.id} c={c} />)}
      </div>
    </MobileShell>
  );
}

function ComplaintCard({ c }: { c: any }) {
  const nav = useNavigate();
  const sla = deadlineSla(c.completion_deadline_at, c.sla_completion_minutes, c.state);
  const st = STATE[c.state];
  return (
    <div style={vtName('card', c.id)}><Card onClick={() => vtNavigate(nav, `/m/c/${c.id}`)} className="p-3.5 flex items-center gap-3.5">
      <span style={vtName('ring', c.id)}>{sla ? <SlaRing fraction={sla.fraction} tone={sla.tone} label={slaText(sla.left)} />
        : c.state === 'RAISED' ? <SlaRing fraction={0} tone="neutral" label="New" />
        : <div className="w-14 h-14 rounded-full bg-tint grid place-items-center text-primary"><CheckCircle2 /></div>}</span>
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate">{c.sub_category}</div>
        <div className="text-xs text-ink-muted tnum">{c.ticket_no} · {shortDate(c.raised_at)}</div>
        <div className="mt-1.5"><StatusChip tone={st?.tone || 'info'}>{st?.resident || c.state}</StatusChip></div>
        {c.awaiting_you && <div className="text-[13px] font-semibold text-await mt-1.5">Was it fixed? Tap to answer</div>}
      </div>
      <ChevronRight size={18} className="text-ink-muted" />
    </Card></div>
  );
}

function AllComplaints() {
  const list = useLoad(() => api<{ items: any[] }>('/tickets'));
  const nav = useNavigate();
  return (
    <MobileShell title="My complaints" sub="Open and recent">
      {list.error && <ErrorState message={list.error} retry={list.reload} />}
      {list.data?.items.length === 0 && <EmptyState title="Nothing reported yet" body="Your complaints will appear here." />}
      <div className="flex flex-col gap-2.5">
        {list.data?.items.map((c) => (
          <Card key={c.id} onClick={() => nav(`/m/c/${c.id}`)} className="p-3.5">
            <div className="flex justify-between gap-2">
              <div className="font-semibold truncate">{c.sub_category}</div>
              <StatusChip tone={STATE[c.state]?.tone || 'info'}>{STATE[c.state]?.resident || c.state}</StatusChip>
            </div>
            <div className="text-xs text-ink-muted tnum mt-1">{c.ticket_no} · {when(c.raised_at)}</div>
          </Card>
        ))}
      </div>
    </MobileShell>
  );
}

/* ---------------------------------------------------------------- report sheet */
function ReportSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  /* What needs fixing first (the user kept this order on 2026-10-15 over the
     design experiment's camera-first), then the description and up to three
     photographs, then GOV.UK's "Check your answers" with Change on each row.
     The camera only, never the gallery (control 2); every photograph located. */
  const toast = useToast();
  const { t: tr, lang } = usePrefs();
  const hi = lang === 'hi';
  const cats = useLoad(() => api<any[]>('/masters/categories'), []);
  const [step, setStep] = useState(1);
  const [cat, setCat] = useState<string | null>(null);
  const [sub, setSub] = useState<any>(null);
  const [desc, setDesc] = useState('');
  const [emergency, setEmergency] = useState(false);
  const [photos, setPhotos] = useState(0);   // up to three, as the contractor's (user's finding, 2026-10-10)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setStep(1); setCat(null); setSub(null); setDesc(''); setEmergency(false); setPhotos(0); setErr(null); } }, [open]);

  const groups = useMemo(() => {
    const g: Record<string, any[]> = {};
    for (const s of cats.data || []) (g[s.category] ||= []).push(s);
    return g;
  }, [cats.data]);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const t = await api('/tickets', { body: { sub_category_id: sub.id, description: desc || null, is_emergency: emergency } });
      for (let n = 1; n <= photos; n++) await takePhoto(t.id, 'COMPLAINT', `${sub.name_en} — as reported (${n} of ${photos})`).catch(() => {});
      tick();
      toast({ text: `${hi ? 'शिकायत दर्ज' : 'Complaint registered'} · ${t.ticket_no}` });
      onDone(t.id);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const em = sub?.classification === 'EM';
  const titles = [hi ? 'क्या ठीक करना है?' : 'What needs fixing?', hi ? 'विवरण और फ़ोटो' : 'Describe and photograph', hi ? 'जाँचें और भेजें' : 'Check and send'];

  return (
    <Sheet open={open} onClose={onClose} title={tr('Report a problem')} sub={`${hi ? 'चरण' : 'Step'} ${step} ${hi ? 'में से' : 'of'} 3 · ${titles[step - 1]}`} progress={[step, 3]}>
      {step === 1 && (
        <>
          <div className="mb-3"><ColonyNotices /></div>
          <div className="grid grid-cols-3 gap-2.5">
            {Object.keys(groups).map((c) => {
              const Icon = categoryIcon(c);
              return (
                <button key={c} onClick={() => { setCat(c); setSub(null); }} aria-pressed={cat === c}
                  className={clsx('min-h-20 rounded-card border p-2 flex flex-col items-center justify-center gap-1.5 text-xs font-medium text-center',
                    cat === c ? 'border-primary bg-tint text-primary' : 'border-line bg-surface')}>
                  <Icon size={22} />{c.split(' ')[0].replace(/,$/, '')}
                </button>
              );
            })}
          </div>
          {cat && (
            <div className="mt-4">
              <div className="label mb-2">{cat}</div>
              <div className="flex flex-col gap-2">
                {groups[cat].map((s) => (
                  <button key={s.id} onClick={() => setSub(s)} aria-pressed={sub?.id === s.id}
                    className={clsx('min-h-11 text-left px-3.5 py-2.5 rounded-input border text-sm', sub?.id === s.id ? 'border-primary bg-tint font-semibold' : 'border-line bg-surface')}>
                    {hi && s.name_hi ? <span lang="hi">{s.name_hi}</span> : s.name_en}{s.emergency_eligible && <span className="ml-2 text-[11px] text-bad font-semibold">{hi ? 'आपात हो सकती है' : 'can be emergency'}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
          {em && (
            <div className="mt-4 rounded-card bg-risk-bg text-risk p-3.5 text-[13px] flex gap-2.5">
              <Zap size={18} className="shrink-0" />Electrical work is handled by the E&amp;M Department, not this portal. Please contact your Area E&amp;M office.
            </div>
          )}
          <Button className="w-full mt-5" disabled={!sub || em} onClick={() => setStep(2)}>{hi ? 'आगे बढ़ें' : 'Continue'}</Button>
        </>
      )}
      {step === 2 && (
        <>
          <Field label={hi ? 'समस्या बताएं' : 'Describe the problem'} help={hi ? 'वैकल्पिक — इससे ओवरसियर और ठेकेदार को मदद मिलती है' : 'Optional — it helps the Overseer and contractor'}>
            <textarea className={inputCls + ' h-auto min-h-[110px] py-2.5'} maxLength={500} value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder={hi ? 'जैसे: सुबह से रसोई का नल टपक रहा है' : 'e.g. Kitchen tap leaking since morning; water collecting under the sink'} />
          </Field>
          <div className={clsx('text-xs text-right -mt-1 tnum', desc.length >= 500 ? 'text-bad' : desc.length >= 450 ? 'text-risk' : 'text-ink-muted')}>{desc.length} / 500</div>
          <button onClick={() => setPhotos((n) => (n + 1) % 4)}
            className={clsx('mt-3 w-full rounded-card border-[1.5px] border-dashed p-4 flex items-center gap-3 text-left', photos ? 'border-primary bg-tint' : 'border-line-strong')}>
            <Camera size={22} className="text-primary" />
            <span><span className="block font-semibold text-sm">{photos ? (hi ? `3 में से ${photos} फ़ोटो जुड़ेंगी` : `${photos} of 3 photographs will be attached`) : (hi ? 'फ़ोटो जोड़ें (तीन तक)' : 'Add photographs (up to three)')}</span>
              <span className="block text-xs text-ink-muted">{hi ? 'केवल कैमरा, गैलरी नहीं। एक और के लिए फिर दबाएँ; चौथी बार दबाने पर सब हट जाती हैं। वेब डेमो में चित्र बनाया जाता है।' : 'Camera only, never the gallery. Tap again for another; a fourth tap clears them. Web demo: images are generated in place of the camera'}</span></span>
          </button>
          {sub?.emergency_eligible && (
            <label className="mt-3 flex items-start gap-3 rounded-card border border-line bg-surface p-3.5 text-sm">
              <input type="checkbox" className="mt-1" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} />
              <span><b className="text-bad">{hi ? 'यह आपात स्थिति है' : 'This is an emergency'}</b>
                <span className="block text-xs text-ink-muted">{hi ? 'जल्दी कार्रवाई। गलत उपयोग दर्ज होता है; ओवरसियर इसे बदल सकते हैं।' : 'Faster response. Misuse is recorded, and the Overseer may downgrade it.'}</span></span>
            </label>
          )}
          <div className="flex gap-2 mt-5"><Button variant="secondary" onClick={() => setStep(1)}>{hi ? 'पीछे' : 'Back'}</Button>
            <Button className="flex-1" onClick={() => setStep(3)}>{hi ? 'आगे बढ़ें' : 'Continue'}</Button></div>
        </>
      )}
      {step === 3 && (
        <>
          <dl className="bg-surface border border-line rounded-card divide-y divide-line text-[13.5px]">
            {([
              [hi ? 'समस्या' : 'Problem', hi && sub?.name_hi ? sub.name_hi : sub?.name_en, 1],
              [hi ? 'विवरण' : 'Description', desc || (hi ? 'कोई नहीं' : 'None'), 2],
              [hi ? 'फ़ोटो' : 'Photographs', photos ? (hi ? `${photos} जुड़ेंगी` : `${photos} attached`) : (hi ? 'कोई नहीं' : 'None'), 2],
              [hi ? 'आपात' : 'Emergency', emergency ? (hi ? 'हाँ' : 'Yes') : (hi ? 'नहीं' : 'No'), 2]
            ] as [string, string, number][]).map(([k, v, st]) => (
              <div key={k} className="grid grid-cols-[96px_1fr_auto] gap-3 px-3.5 py-3 items-start">
                <dt className="text-ink-muted">{k}</dt><dd className="m-0 font-medium break-words">{v}</dd>
                <button type="button" className="text-primary text-[13px] font-semibold underline underline-offset-2" onClick={() => setStep(st)}>
                  {hi ? 'बदलें' : 'Change'}<span className="sr-only"> {k}</span></button>
              </div>
            ))}
          </dl>
          <p className="text-xs text-ink-muted mt-3">{hi ? 'पहले सिविल कॉलोनी ओवरसियर जाँच करेंगे; तभी समय सीमा तय होगी। आपको हर कदम दिखेगा।' : 'The Civil Colony Overseer checks it first; the deadline is fixed then. You will see every step.'}</p>
          {err && <div className="mt-3"><ErrorState message={err} /></div>}
          <div className="flex gap-2 mt-5"><Button variant="secondary" onClick={() => setStep(2)}>{hi ? 'पीछे' : 'Back'}</Button>
            <Button className="flex-1" loading={busy} onClick={submit}>{hi ? 'शिकायत भेजें' : 'Send complaint'}</Button></div>
        </>
      )}
    </Sheet>
  );
}

/* ---------------------------------------------------------------- detail, verify & rate */
const EVENT_TITLE: Record<string, string> = {
  RAISED: 'Complaint registered', VERIFIED: 'Checked by the Overseer', REJECTED: 'Not accepted', ASSIGNED: 'Given to the contractor',
  STARTED: 'Work started', COMPLETION_CLAIMED: 'Contractor says the work is done', INSPECTED: 'Inspected by the Overseer',
  CLOSED: 'Closed', REOPENED: 'Reopened', REFERRED_SPECIAL_REPAIR: 'Referred for special repair',
  REJECTION_CONTESTED: 'You contested the decision', CONTEST_REINSTATED: 'Complaint reinstated after review',
  CONTEST_UPHELD: 'Rejection upheld, sent to the Staff Officer', REFERRED_TO_STAFF_OFFICER: 'Referred to the Area Civil Staff Officer',
  STAFF_OFFICER_DECIDED: 'Decided by the Area Civil Staff Officer', OCCUPANT_CONFIRMED: 'Occupant confirmed the work',
  OCCUPANT_DISPUTED: 'Occupant says it is not fixed'
};
const ROLE_SHORT: Record<string, string> = { RESIDENT: 'You / your household', CUSTODIAN: 'Custodian', CIVIL_OVERSEER: 'Civil Overseer',
  MAINTENANCE_INCHARGE: 'Civil Colony Incharge', CONTRACTOR_SUPERVISOR: 'Contractor', STAFF_OFFICER_CIVIL: 'Staff Officer (Civil)', SYSTEM: 'System' };

// officers see when an act was done from the web rather than the phone (user's decision, 2026-10-16)
const WEB = ['password', 'passkey', 'otp'];
export function historyItems(t: any) {
  const officer = !['RESIDENT', 'CUSTODIAN', 'CONTRACTOR', 'CONTRACTOR_SUPERVISOR'].includes(session.get()?.role || '');
  return (t.history || []).map((h: any, i: number, all: any[]) => ({
    title: h.event_type === 'INSPECTED' ? (h.to_state === 'REWORK' ? 'Sent back for rework' : 'Inspected and accepted')
      : h.event_type.startsWith('CLOCK_PAUSED') ? 'Clock paused' : h.event_type.startsWith('CLOCK_RESUMED') ? 'Clock resumed'
      : EVENT_TITLE[h.event_type] || h.event_type,
    who: `${h.actor_role === 'RESIDENT' && !['RESIDENT', 'CUSTODIAN'].includes(session.get()?.role || '') ? 'Resident'
      : ROLE_SHORT[h.actor_role] || h.actor_role}${officer && WEB.includes(h.via) ? ' · from the web' : ''}${h.reason ? ` — “${h.reason}”` : ''}`,
    at: when(h.occurred_at), current: i === all.length - 1
  }));
}

function ComplaintDetail() {
  const { id } = useParams();
  const toast = useToast();
  const d = useLoad(() => api(`/tickets/${id}`), [id]);
  const fb = useLoad(() => api(`/tickets/${id}/feedback`), [id]);
  const [mode, setMode] = useState<null | 'object' | 'reopen' | 'contest'>(null);
  const [rating, setRating] = useState(0);
  const [reasons, setReasons] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = d.data;
  useAutoRefresh(() => { d.reload(); fb.reload(); }, 30, mode !== null || busy);
  const canRate = t && ['INSPECTED_ACCEPTED', 'CLOSED'].includes(t.state) && !fb.data;
  const final = !!t?.final_decision;
  // before closure the complaint can be reopened at once; after closure, within 24 hours
  const canReopen = !final && (t?.state === 'INSPECTED_ACCEPTED'
    || (t?.state === 'CLOSED' && t.closed_at && Date.now() - new Date(t.closed_at).getTime() < 24 * 3600e3));
  // a double tick the first time a complaint is seen closed (V1)
  useEffect(() => {
    if (t?.state !== 'CLOSED') return;
    try { const seen = JSON.parse(localStorage.getItem('cp-seen-closed') || '[]');
      if (!seen.includes(t.id)) { doubleTick(); localStorage.setItem('cp-seen-closed', JSON.stringify([...seen, t.id].slice(-200))); } } catch { /* private window */ }
  }, [t?.state, t?.id]);
  const REASONS = ['Neat work', 'On time', 'Polite workmen', 'Cleaned up after', 'Took too long', 'Left a mess'];

  const act = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true); setErr(null);
    try { await fn(); if (ok) toast({ text: ok }); setMode(null); setNote(''); setPhoto(false); d.reload(); fb.reload(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const confirmFixed = () => act(async () => {
    await api(`/tickets/${id}/feedback`, { body: { confirmed: true, rating: rating || null, comment: reasons.join(', ') || null } });
    doubleTick();
    celebrate('Thank you — confirmed', rating ? `You rated it ${rating} of 5` : 'Your answer is recorded');
  }, '');
  const contest = () => act(async () => {
    await api(`/tickets/${id}/contest`, { body: { reason: note } });
  }, 'Your contest has gone to the Overseer and Incharge');
  // a photo is compulsory on reopen (design rule), enforced here before the call
  const reopen = () => act(async () => {
    await takePhoto(id!, 'COMPLAINT', 'Still not fixed');
    await api(`/tickets/${id}/reopen`, { body: { reason: note } });
  }, 'Complaint reopened');
  const object = () => act(async () => {
    if (photo) await takePhoto(id!, 'OBJECTION', 'Objection during work');
    await api(`/tickets/${id}/objections`, { body: { note } });
  }, 'Objection sent to the Overseer and Incharge');

  return (
    <MobileShell title={t?.sub_category || 'Complaint'} sub={t?.ticket_no} back="/m/home" tabs={false}>
      {d.error && <ErrorState message={d.error} retry={d.reload} />}
      {!t && !d.error && <Skeleton className="h-40" />}
      {t && (
        <>
          {/* the receipt (V2, R1): status first, then what the resident can do, then the record */}
          <StatusCard t={t} />

          {/* actions */}
          {t.state === 'IN_PROGRESS' && !mode && (
            <Button variant="secondary" className="w-full mt-3" icon={<MessageSquareWarning size={18} />} onClick={() => setMode('object')}>Object to the work</Button>
          )}
          {canRate && !final && !mode && (
            <Card className="p-4 mt-3">
              <div className="font-semibold">Was it fixed properly?</div>
              <div className="text-xs text-ink-muted">Your answer goes to the civil office. It never replaces the Overseer’s inspection.</div>
              <div className="mt-3"><Stars value={rating} onChange={setRating} /></div>
              <div className="flex flex-wrap gap-2 mt-3">
                {REASONS.map((r) => <Chip key={r} selected={reasons.includes(r)} onClick={() => setReasons((x) => x.includes(r) ? x.filter((y) => y !== r) : [...x, r])}>{r}</Chip>)}
              </div>
              <Button variant="success" size="lg" className="w-full mt-4" loading={busy} icon={<CheckCircle2 size={20} />} onClick={confirmFixed}>Yes, it’s fixed</Button>
              {canReopen && <Button variant="secondary" size="lg" className="w-full mt-2 !text-bad !border-bad/40" icon={<RotateCcw size={18} />}
                onClick={() => setMode('reopen')}>Not fixed, reopen</Button>}
            </Card>
          )}
          {fb.data && (
            <Card className="p-4 mt-3 text-sm flex items-center gap-2">
              <CheckCircle2 size={18} className="text-ok" />You {fb.data.confirmed ? 'confirmed the fix' : 'disputed the work'}{fb.data.rating ? ` and rated it ${fb.data.rating}/5` : ''}.
            </Card>
          )}
          {fb.data && canReopen && !canRate && !mode && (
            <Button variant="secondary" className="w-full mt-2 !text-bad" icon={<RotateCcw size={18} />} onClick={() => setMode('reopen')}>Not fixed, reopen</Button>
          )}
          {final && (
            <div className="mt-3 rounded-card bg-await-bg text-await p-3.5 text-[13px]">
              This complaint has been decided by the Area Civil Staff Officer. Further disputes are not taken in the portal; you may write to the Area Civil Office.
            </div>
          )}
          {t.can_contest && !final && !mode && (
            <Card className="p-4 mt-3">
              <div className="font-semibold">Not accepted</div>
              <div className="text-xs text-ink-muted">If you disagree, you may contest this decision once. The Overseer or Incharge reviews it; if they uphold it, the Area Civil Staff Officer decides in writing.</div>
              <Button variant="secondary" className="w-full mt-3" icon={<Scale size={18} />} onClick={() => setMode('contest')}>Contest this decision</Button>
            </Card>
          )}
          {mode && (
            <Card className="p-4 mt-3">
              <div className="font-semibold">{mode === 'object' ? 'Object while work is under way' : mode === 'reopen' ? 'Reopen this complaint' : 'Contest this decision'}</div>
              <div className="text-xs text-ink-muted mb-3">{mode === 'object' ? 'Goes to the Overseer and Incharge, not the contractor. The Overseer answers within 24 hours.'
                : mode === 'reopen' ? 'A photo of the problem is required. The same complaint reopens; nothing new is created.'
                : 'You can contest once. Say why the complaint should be taken up. A further dispute after the Staff Officer decides is not taken in the portal.'}</div>
              <textarea className={inputCls + ' h-auto min-h-[90px] py-2.5'} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder={mode === 'contest' ? 'Why should this complaint be taken up?' : 'Say what is still wrong'} />
              {mode === 'object' && (
                <label className="flex items-center gap-2 text-sm mt-2"><input type="checkbox" checked={photo} onChange={(e) => setPhoto(e.target.checked)} />Attach a photo</label>
              )}
              {mode === 'reopen' && <div className="text-xs text-ink-muted mt-2 flex items-center gap-1.5"><Camera size={14} />A photo will be taken and attached.</div>}
              {err && <div className="mt-3"><ErrorState message={err} /></div>}
              <div className="flex gap-2 mt-4">
                <Button variant="secondary" onClick={() => { setMode(null); setErr(null); }}>Cancel</Button>
                <Button className="flex-1" variant={mode === 'object' ? 'primary' : 'destructive'} loading={busy} disabled={!note.trim()}
                  onClick={mode === 'object' ? object : mode === 'reopen' ? reopen : contest}>
                  {mode === 'object' ? 'Send objection' : mode === 'reopen' ? 'Reopen complaint' : 'Contest decision'}
                </Button>
              </div>
            </Card>
          )}
          {err && !mode && <div className="mt-3"><ErrorState message={err} /></div>}

          <InspectionReveal t={t} />
          <div className="grid gap-3 mt-3">
            <DetailsCard t={t} />
            {t.media?.length > 0 && (
              <Card className="p-4">
                <div className="font-semibold mb-3">Photographs</div>
                <Photographs media={t.media} />
              </Card>
            )}
            <EscalationCard t={t} />
            <JourneyCard t={t} items={historyItems(t)} />
          </div>

          {t.reviews?.length > 0 && (
            <>
              <SectionLabel className="mt-6 mb-3">Review of your complaint</SectionLabel>
              {t.reviews.map((r: any) => (
                <Card key={r.id} className="p-4 mb-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold">{r.kind === 'REJECTION_CONTEST' ? 'You contested the rejection' : 'Repeated reopening'}</div>
                    <StatusChip tone={r.stage === 'DECIDED' ? 'ok' : 'await'}>
                      {r.stage === 'WITH_OFFICERS' ? 'With the Overseer / Incharge' : r.stage === 'WITH_STAFF_OFFICER' ? 'With the Staff Officer' : 'Decided'}</StatusChip>
                  </div>
                  <div className="text-xs text-ink-muted mt-1">{when(r.raised_at)}</div>
                  {r.raised_reason && <div className="mt-2">“{r.raised_reason}”</div>}
                  {r.officer_outcome && (
                    <div className="mt-2 rounded-input bg-tint p-2.5 text-[13px]">
                      <b>{r.officer_outcome === 'REINSTATE' ? 'Reinstated' : 'Rejection upheld'}</b>
                      {r.officer_note && <> — “{r.officer_note}”</>}
                      <div className="text-xs text-ink-muted">{when(r.officer_at)}</div>
                    </div>
                  )}
                  {r.so_outcome && (
                    <div className="mt-2 rounded-input bg-tint p-2.5 text-[13px]">
                      <b>Decision of the Area Civil Staff Officer:</b> {({ REINSTATE: 'complaint reinstated', UPHOLD: 'rejection upheld', REWORK: 'work to be redone',
                        CLOSE: 'complaint closed', SPECIAL_REPAIR: 'referred for special repair' } as Record<string, string>)[r.so_outcome] || r.so_outcome}
                      {r.so_decision && <div className="whitespace-pre-wrap mt-0.5">“{r.so_decision}”</div>}
                      <div className="text-xs text-ink-muted">{when(r.so_at)}</div>
                    </div>
                  )}
                </Card>
              ))}
            </>
          )}

          {t.objections?.length > 0 && (
            <>
              <SectionLabel className="mt-6 mb-3">Objections</SectionLabel>
              {t.objections.map((o: any) => (
                <Card key={o.id} className="p-4 mb-2 text-sm">
                  <div className="flex gap-2"><ShieldAlert size={16} className="text-risk shrink-0 mt-0.5" /><div>{o.note}</div></div>
                  <div className="text-xs text-ink-muted mt-1">{when(o.raised_at)}</div>
                  {o.responded_at ? <div className="mt-2 rounded-input bg-tint p-2.5 text-[13px]"><b>Overseer:</b> {o.response_note}</div>
                    : <div className="text-xs text-risk mt-2">Awaiting the Overseer’s answer</div>}
                </Card>
              ))}
            </>
          )}
        </>
      )}
    </MobileShell>
  );
}
