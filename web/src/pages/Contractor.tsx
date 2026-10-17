import { useMemo, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { Camera, CheckCircle2, ChevronRight, Hammer, RotateCcw, Smartphone, Users } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState, Field, SectionLabel, Segmented, Skeleton, SlaRing, StatusChip, Timeline, inputCls, useToast } from '../components/ui';
import { categoryIcon } from '../components/ui/icons';
import { MobileShell } from '../components/shell/Shells';
import { ContractorMaterials } from './officer/Materials';
import { ContractorMeasurements } from './officer/Measurements';
import { Alerts, Profile } from './MobileCommon';
import { historyItems } from './Resident';
import { api, session } from '../lib/api';
import { STATE, contractorSla, slaText } from '../lib/domain';
import { hours, shortDate } from '../lib/format';
import { takePhoto } from '../lib/photo';
import { useLoad } from '../lib/useLoad';
import { Photographs } from '../components/Photographs';

/* Contractor field app (C1–C2). The ring is the contractor's own clock:
   time the job has been in their hands, summed across rounds, against the
   SLA (decision 2026-09-25). They see no resident phone numbers and no
   objections — both by design.

   Since 2026-10-16 a supervisor may also sign in here on the web, with the
   mobile and an OTP (amr 'otp'). Then the page reads the jobs and records
   materials only: starting work, photographs and the completion claim stay in
   the app (user's decisions) — the database refuses them anyway, and the page
   says so instead of offering them. */
const onWeb = () => session.get()?.amr === 'otp';

export default function Contractor() {
  return (
    <Routes>
      <Route path="jobs" element={<Jobs />} />
      <Route path="job/:id" element={<JobDetail />} />
      <Route path="alerts" element={<Alerts />} />
      <Route path="profile" element={<Profile />} />
      <Route path="*" element={<Navigate to="/m/jobs" replace />} />
    </Routes>
  );
}

const GROUPS: [string, string[]][] = [
  ['Sent back — rework', ['REWORK']],
  ['To start', ['ASSIGNED']],
  ['In progress', ['IN_PROGRESS']],
  ['Awaiting inspection', ['WORK_COMPLETED']]
];

function Jobs() {
  const nav = useNavigate();
  const [tab, setTab] = useState<'live' | 'done'>('live');
  const all = useLoad(() => api<{ items: any[] }>('/tickets'));
  const jobs = useLoad(async () => {
    const list = await api<{ items: any[] }>('/tickets');
    const live = list.items.filter((t) => ['ASSIGNED', 'IN_PROGRESS', 'REWORK', 'WORK_COMPLETED'].includes(t.state));
    return Promise.all(live.map((t) => api(`/tickets/${t.id}`)));
  });
  // work finished stays in view (user's request, 2026-10-15)
  const done = (all.data?.items || []).filter((t) => ['INSPECTED_ACCEPTED', 'CLOSED'].includes(t.state))
    .sort((a, b) => Date.parse(b.closed_at || b.inspected_at || 0) - Date.parse(a.closed_at || a.inspected_at || 0));
  // most urgent first: least contractor time left
  const sorted = useMemo(() => (jobs.data || []).slice().sort((a, b) =>
    (contractorSla(a)?.left ?? 1e9) - (contractorSla(b)?.left ?? 1e9)), [jobs.data]);
  const active = sorted.filter((t) => t.state !== 'WORK_COMPLETED').length;
  return (
    <MobileShell title={tab === 'done' ? `Completed · ${done.length}` : `Today’s jobs · ${active}`} sub={tab === 'done' ? 'Accepted or closed, newest first' : 'Sorted by SLA urgency'}>
      <Segmented className="w-full grid grid-cols-2 mb-4" value={tab} onChange={setTab}
        options={[{ value: 'live', label: `Jobs · ${active}` }, { value: 'done', label: `Completed · ${done.length}` }]} />
      {onWeb() && <p className="text-xs text-ink-muted -mt-2 mb-3 flex gap-1.5"><Smartphone size={14} className="shrink-0" />Signed in on the web: start work, take photographs and mark complete in the app.</p>}
      {tab === 'done' && (done.length === 0
        ? <EmptyState title="No completed jobs yet" body="Jobs accepted on inspection appear here, for 30 days after closure." />
        : <div className="flex flex-col gap-2.5">{done.map((t) => (
            <Card key={t.id} onClick={() => nav(`/m/job/${t.id}`)} className="p-3.5">
              <div className="flex justify-between gap-2"><div className="font-semibold">Qtr No. {t.identifier}</div><StatusChip tone={STATE[t.state]?.tone || 'ok'}>{STATE[t.state]?.label}</StatusChip></div>
              <div className="text-[13px] text-ink-muted truncate">{t.sub_category} · {t.ticket_no}</div>
              {t.completion_met != null && <div className={'text-[13px] font-semibold ' + (t.completion_met ? 'text-ok' : 'text-bad')}>{t.completion_met ? 'Within your time' : 'Over your time'}</div>}
              <div className="text-xs text-ink-muted">{t.closed_at ? `Closed ${shortDate(t.closed_at)}` : t.inspected_at ? `Accepted ${shortDate(t.inspected_at)}` : ''}</div>
            </Card>))}</div>)}
      {tab === 'live' && <>
      {jobs.error && <ErrorState message={jobs.error} retry={jobs.reload} />}
      {!jobs.data && !jobs.error && [0, 1, 2].map((i) => <Skeleton key={i} className="h-20 mb-2.5" />)}
      {jobs.data?.length === 0 && <EmptyState title="No jobs assigned" body="New work from the civil office will appear here." />}
      {GROUPS.map(([label, states]) => {
        const rows = sorted.filter((t) => states.includes(t.state));
        if (!rows.length) return null;
        return (
          <div key={label} className="mb-5">
            <SectionLabel className="mb-2.5">{label}</SectionLabel>
            <div className="flex flex-col gap-2.5">{rows.map((t) => <JobCard key={t.id} t={t} />)}</div>
          </div>
        );
      })}
      </>}
    </MobileShell>
  );
}

function JobCard({ t }: { t: any }) {
  const nav = useNavigate();
  const sla = contractorSla(t);
  const Icon = categoryIcon(t.category);
  return (
    <Card onClick={() => nav(`/m/job/${t.id}`)} className="p-3.5 flex items-center gap-3.5">
      {sla && t.state !== 'WORK_COMPLETED'
        ? <SlaRing fraction={sla.fraction} tone={sla.tone} label={slaText(sla.left)} />
        : <div className="w-14 h-14 rounded-full bg-await-bg text-await grid place-items-center"><CheckCircle2 /></div>}
      <div className="flex-1 min-w-0">
        <div className="font-semibold">Qtr No. {t.identifier}</div>
        <div className="text-[13px] text-ink-muted truncate">{t.sub_category}</div>
      </div>
      <Icon size={20} className="text-primary" />
      <ChevronRight size={18} className="text-ink-muted" />
    </Card>
  );
}

function JobDetail() {
  const { id } = useParams();
  const toast = useToast();
  const nav = useNavigate();
  const d = useLoad(() => api(`/tickets/${id}`), [id]);
  const [workmen, setWorkmen] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const t = d.data;
  const sla = t && contractorSla(t);
  const rework = t?.history?.filter((h: any) => h.to_state === 'REWORK').pop();

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key); setErr(null);
    try { await fn(); if (ok) toast({ text: ok }); d.reload(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  // photographs of this round only: a new round starts the count again (at most 3 of each)
  const roundStart = t?.contractor_window_started_at ? new Date(t.contractor_window_started_at).getTime() : 0;
  const count = (purpose: string) => (t?.media || []).filter((m: any) => m.purpose === purpose
    && (!roundStart || !m.captured_at || new Date(m.captured_at).getTime() >= roundStart)).length;
  const counts = { before: count('BEFORE'), after: count('COMPLETION') };
  // compulsory only once the HQ System Administrator requires them (2026-10-12)
  const needPhotos = t?.photo_rules?.completion_photos_required !== false;
  const photo = (which: 'before' | 'after') => run(which, async () => {
    await takePhoto(id!, which === 'before' ? 'BEFORE' : 'COMPLETION', `${which === 'before' ? 'Before' : 'After'} — Qtr ${t.identifier}`);
  });

  return (
    <MobileShell title={t?.ticket_no || 'Job'} sub={t?.sub_category} back="/m/jobs" tabs={false}>
      {d.error && <ErrorState message={d.error} retry={d.reload} />}
      {!t && !d.error && <Skeleton className="h-40" />}
      {t && (
        <>
          <Card className="p-4">
            <div className="flex justify-between items-start gap-3">
              <div>
                <div className="font-bold text-lg">Qtr No. {t.identifier}</div>
                <div className="text-[13px] text-ink-muted">{t.category}</div>
              </div>
              <StatusChip tone={STATE[t.state]?.tone || 'info'}>{STATE[t.state]?.label}</StatusChip>
            </div>
            {t.description && <p className="text-sm mt-3">{t.description}</p>}
            {t.is_emergency && <div className="mt-3"><StatusChip tone="bad">Emergency</StatusChip></div>}
          </Card>

          {sla && (
            <Card className="p-4 mt-3 flex items-center gap-4">
              <SlaRing size={88} fraction={sla.fraction} tone={sla.tone} label={slaText(sla.left)} sub={sla.left < 0 ? 'late' : 'left'} />
              <div className="text-[13px]">
                <div className="font-semibold text-sm">Your time on this job</div>
                <div className="text-ink-muted">{hours(sla.used)} used of {hours(sla.window)}{sla.running ? ' · clock running' : ' · clock stopped'}</div>
                <div className="text-xs text-ink-muted mt-1">Counts only while the job is with you. Inspection time is not yours.</div>
              </div>
            </Card>
          )}

          {rework && t.state === 'REWORK' && (
            <div className="mt-3 rounded-card bg-bad-bg text-bad p-3.5 text-[13px] flex gap-2.5">
              <RotateCcw size={18} className="shrink-0" /><div><b>Sent back by the Overseer.</b>{rework.reason && <> “{rework.reason}”</>}
                <div className="text-xs mt-0.5">New completion photographs are needed for this round.</div></div>
            </div>
          )}

          {onWeb() && ['ASSIGNED', 'REWORK', 'IN_PROGRESS'].includes(t.state) && (
            <div className="mt-3 rounded-card bg-tint p-3.5 text-[13px] flex gap-2.5">
              <Smartphone size={18} className="shrink-0 text-primary" />
              <div><b>{t.state === 'IN_PROGRESS' ? 'Photographs and marking complete are done in the app.' : 'Start the work in the app on your phone.'}</b>
                <div className="text-ink-muted mt-0.5">They are acts from the site. Here you can read the job and record the materials used.</div></div>
            </div>
          )}
          {!onWeb() && (t.state === 'ASSIGNED' || t.state === 'REWORK') && (
            <Card className="p-4 mt-3">
              <Field label="Workmen allotted" required help="Names of the workmen on this job">
                <input className={inputCls} value={workmen} onChange={(e) => setWorkmen(e.target.value)} placeholder="e.g. Ram Prasad, Sunil Kumar" />
              </Field>
              <Button className="w-full mt-4" icon={<Users size={18} />} disabled={!workmen.trim()} loading={busy === 'start'}
                onClick={() => run('start', () => api(`/tickets/${id}/start`, { body: { workmen_assigned: workmen } }), 'Work started')}>
                {t.state === 'REWORK' ? 'Resume work' : 'Start work'}</Button>
            </Card>
          )}

          {!onWeb() && t.state === 'IN_PROGRESS' && (
            <>
              <SectionLabel className="mt-5 mb-2.5">Update work</SectionLabel>
              <div className="grid grid-cols-2 gap-2.5">
                {(['before', 'after'] as const).map((w) => (
                  <button key={w} onClick={() => photo(w)} disabled={!!busy || counts[w] >= 3}
                    className={'aspect-square rounded-xl border-[1.5px] flex flex-col items-center justify-center gap-2 text-sm disabled:opacity-60 ' +
                      (counts[w] > 0 ? 'border-ok bg-ok-bg text-ok' : 'border-dashed border-line-strong text-ink-muted')}>
                    {counts[w] > 0 ? <CheckCircle2 size={26} /> : <Camera size={26} />}
                    <span className="font-semibold">{w === 'before' ? 'Before' : 'After'}</span>
                    <span className="text-xs tnum">{counts[w]} of 3</span>
                    <span className="text-xs">{busy === w ? 'Uploading…' : counts[w] >= 3 ? 'Limit reached' : 'Add photo'}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-ink-muted mt-2">{needPhotos
                ? 'At least one “before” and one “after” photograph are needed to mark the job complete; up to three of each.'
                : 'Photographs are optional for now; if you take them, up to three “before” and three “after”.'} Web demo: images are generated in place of the camera.</p>
              <Button size="lg" className="w-full mt-4" icon={<Hammer size={20} />} disabled={needPhotos && (counts.before < 1 || counts.after < 1)} loading={busy === 'done'}
                onClick={() => run('done', () => api(`/tickets/${id}/complete`, { method: 'POST' }), 'Marked complete — the Overseer will inspect it')}>
                Mark complete</Button>
              {needPhotos && (counts.before < 1 || counts.after < 1) && (
                <p className="text-xs text-risk mt-2">Add at least one before and one after photograph first.</p>
              )}
            </>
          )}
          {t.state === 'WORK_COMPLETED' && (
            <div className="mt-3 rounded-card bg-await-bg text-await p-3.5 text-[13px]">Claimed complete. Your clock has stopped; the Overseer inspects it next.</div>
          )}
          {err && <div className="mt-3"><ErrorState message={err} /></div>}

          {t.state !== 'ASSIGNED' && <ContractorMaterials key={t.state} ticketId={id!} />}
          {['INSPECTED_ACCEPTED', 'CLOSED'].includes(t.state) && <ContractorMeasurements ticketId={id!} />}

          {t.media?.length > 0 && (
            <>
              <SectionLabel className="mt-6 mb-3">Photographs</SectionLabel>
              <Photographs media={t.media} />
            </>
          )}
          <SectionLabel className="mt-6 mb-3">History</SectionLabel>
          <Card className="p-4"><Timeline items={historyItems(t)} /></Card>
          <Button variant="ghost" className="mt-4" onClick={() => nav('/m/jobs')}>Back to jobs</Button>
        </>
      )}
    </MobileShell>
  );
}
