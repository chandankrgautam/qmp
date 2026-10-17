import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera, PauseCircle, PlayCircle, ShieldAlert, X } from 'lucide-react';
import { Button, Card, ErrorState, celebrate, Field, IconButton, SectionLabel, Skeleton, SlaRing, StatusChip, Timeline, inputCls, useToast } from '../../components/ui';
import { historyItems } from '../Resident';
import { api, session } from '../../lib/api';
import { STATE, contractorSla, deadlineSla, slaText } from '../../lib/domain';
import { hours, when } from '../../lib/format';
import { takePhoto } from '../../lib/photo';
import { useAutoRefresh, useLoad } from '../../lib/useLoad';
import { Photographs } from '../../components/Photographs';
import { DisputesSection } from './Disputes';
import { JobCardSection } from './JobCard';
import { MaterialsSection } from './Materials';
import { MeasurementsSection } from './Measurements';

/* The side panel an officer works a complaint from. Buttons come from
   available_actions, which the server reads from the same transition
   table the database enforces — the screen can never offer a move the
   database would refuse (control 5). */

// the Overseer and every role above read the job card (decision 2026-09-30)
const JOB_CARD_READERS = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL', 'GM_CIVIL', 'HQ_EXECUTIVE', 'ADMINISTRATOR'];

type Mode = null | 'reject' | 'refer' | 'sendback' | 'assign' | 'pause' | 'priority' | { answer: string };

export default function TicketPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const s = session.get()!;
  const toast = useToast();
  const d = useLoad(() => api(`/tickets/${id}`), [id]);
  const pauses = useLoad(() => api<any[]>(`/tickets/${id}/pauses`), [id]);
  const contractors = useLoad(() => api<any[]>('/devices/assignable').catch(() => []), []);
  const [mode, setMode] = useState<Mode>(null);
  const [text, setText] = useState('');
  const [pick, setPick] = useState('');
  const [attr, setAttr] = useState('OCCUPANT');
  const [prio, setPrio] = useState('');
  const [l4, setL4] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const t = d.data;
  // what others do (the occupant's answer, the contractor's claim) shows
  // without reopening the panel; never while an action form is open
  const [tick, setTick] = useState(0);
  useAutoRefresh(() => { d.reload(); pauses.reload(); setTick((n) => n + 1); }, 30, mode !== null || busy !== null);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key); setErr(null);
    try { await fn(); if (key === 'close') celebrate('Complaint closed', t?.ticket_no); else toast({ text: ok }); setMode(null); setText(''); d.reload(); pauses.reload(); onChanged(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  const post = (p: string, body?: unknown) => api(`/tickets/${id}/${p}`, { method: 'POST', body });
  // the inspection photograph is taken first: in-app, geo-tagged, this
  // Overseer's own and after the claim — the database checks all four
  // the photograph is optional until the HQ System Administrator requires it (2026-10-12)
  const needInspectionPhoto = t?.photo_rules?.inspection_photo_required !== false;
  const inspect = (accepted: boolean, withPhoto = true) => run(accepted ? 'accept' : 'sendback', async () => {
    if (withPhoto) await takePhoto(id, 'INSPECTION', `Inspection — Qtr ${t.identifier}`);
    await post('inspect', { accepted, remark: accepted ? undefined : text });
  }, accepted ? 'Inspection accepted' : 'Sent back for rework');

  const acts: string[] = t?.available_actions || [];
  const sla = t && deadlineSla(t.completion_deadline_at, t.sla_completion_minutes, t.state);
  const csla = t && contractorSla(t);
  const openPause = (pauses.data || []).find((p) => !p.resumed_at);
  const officer = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL'].includes(s.role);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" style={{ background: 'var(--scrim)' }} onClick={onClose}>
      <aside role="dialog" aria-label="Complaint" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] h-full bg-bg overflow-auto shadow-[0_24px_64px_rgba(10,51,51,.28)]" style={{ animation: 'fade-up 240ms var(--ease) both' }}>
        <div className="sticky top-0 z-10 bg-surface border-b border-line px-5 h-16 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="font-semibold tnum">{t?.ticket_no || '…'}</div>
            <div className="text-xs text-ink-muted truncate">{t?.sub_category}</div>
          </div>
          {t && <StatusChip tone={STATE[t.state]?.tone || 'info'}>{STATE[t.state]?.label}</StatusChip>}
          <IconButton label="Close" onClick={onClose}><X size={20} /></IconButton>
        </div>
        <div className="p-5">
          {d.error && <ErrorState message={d.error} retry={d.reload} />}
          {!t && !d.error && <Skeleton className="h-48" />}
          {t && (
            <>
              <Card className="p-4 flex gap-4 items-center">
                {sla ? <SlaRing size={88} fraction={sla.fraction} tone={sla.tone} label={slaText(sla.left)} sub={sla.left < 0 ? 'overdue' : 'left'} />
                  : <SlaRing size={88} fraction={t.state === 'RAISED' ? 0 : 1} tone={t.completion_met === false ? 'bad' : t.state === 'RAISED' ? 'neutral' : 'ok'}
                      label={t.state === 'RAISED' ? 'New' : t.completion_met === false ? 'Missed' : t.completion_met ? 'Met' : '—'} />}
                <div className="min-w-0 text-[13px]">
                  <div className="font-semibold text-base">{t.quarter_type ? `Qtr No. ${t.identifier}` : t.identifier}</div>
                  <div className="text-ink-muted">{t.category}{t.is_emergency && <span className="text-bad font-semibold"> · Emergency</span>}</div>
                  {csla && <div className="mt-1.5">Contractor time: <b className="tnum">{hours(csla.used)}</b> of {hours(csla.window)}
                    {t.completion_met !== null && <> · SLA <b className={t.completion_met ? 'text-ok' : 'text-bad'}>{t.completion_met ? 'met' : 'missed'}</b></>}</div>}
                  {t.workmen_assigned && <div className="text-ink-muted">Workmen: {t.workmen_assigned}</div>}
                  {openPause && <div className="text-risk mt-1">Clock paused — {openPause.attribution.toLowerCase().replace('_', ' ')}: {openPause.reason}</div>}
                </div>
              </Card>
              {t.description && <Card className="p-4 mt-3 text-sm">{t.description}</Card>}

              {t.breach_unattributed && (
                <div className="mt-3 rounded-input bg-bad-bg text-bad p-3 text-[13px]">
                  <b>An SLA breach on this complaint waits for a decision:</b> whose delay was it — the contractor's, the department's, the occupant's or force majeure?
                  {' '}<Link to="/w/area" className="underline font-semibold">Attribute it on the Area dashboard</Link>.
                </div>
              )}
              {t.l4_remark_needed && (
                <div className="mt-3 rounded-input bg-risk-bg text-risk p-3 text-[13px]">
                  <b>This complaint reached the GM (level 4).</b> It can be closed only after the Area Civil Staff Officer records a remark.
                  {s.role === 'STAFF_OFFICER_CIVIL' && (
                    <div className="mt-2 grid gap-2">
                      <textarea className={inputCls + ' h-auto min-h-[70px] py-2'} value={l4} onChange={(e) => setL4(e.target.value)}
                        placeholder="e.g. Delay was the department's; contractor not at fault. May be closed." />
                      <div><Button size="sm" disabled={!l4.trim()} loading={busy === 'l4'}
                        onClick={() => run('l4', () => post('escalation-remark', { remark: l4 }), 'Remark recorded — the complaint can now be closed').then(() => setL4(''))}>Record the remark</Button>
                        <span className="text-xs ml-2">Recorded once; it cannot be changed afterwards.</span></div>
                    </div>
                  )}
                </div>
              )}
              {t.assignee_role_ended && (
                <div className="mt-3 rounded-input bg-bad-bg text-bad p-3 text-[13px]">
                  <b>The supervisor's role has ended.</b> Nobody can start or finish this job until it is reassigned — use Assign work to give it to a current supervisor.
                </div>
              )}
              {/* ------------- actions */}
              <div className="flex flex-wrap gap-2 mt-4">
                {acts.includes('verify') && <Button loading={busy === 'verify'} onClick={() => run('verify', () => post('verify'), 'Complaint verified — SLA fixed')}>Verify complaint</Button>}
                {acts.includes('reject') && <Button variant="secondary" onClick={() => setMode('reject')}>Reject</Button>}
                {acts.includes('assign') && <Button onClick={() => { contractors.reload(); setMode('assign'); }}>Assign work</Button>}
                {acts.includes('inspect') && (s.amr === 'device'
                  ? <>
                      <Button icon={<Camera size={18} />} loading={busy === 'accept'} onClick={() => inspect(true)}>Inspect and accept</Button>
                      {!needInspectionPhoto && <Button variant="secondary" loading={busy === 'accept'} onClick={() => inspect(true, false)}>Accept without a photograph</Button>}
                    </>
                  : <div className="text-[13px] rounded-input bg-risk-bg text-risk px-3 py-2 w-full">Inspection is accepted only from the app on your registered phone — signed in on the web here. You can still return it for rework here.</div>)}
                {acts.includes('send-back') && <Button variant="secondary" onClick={() => setMode('sendback')}>Return for rework</Button>}
                {acts.includes('close') && !t.l4_remark_needed && <Button variant="success" loading={busy === 'close'} onClick={() => run('close', () => post('close'), 'Complaint closed')}>Close complaint</Button>}
                {acts.includes('refer-special-repair') && <Button variant="ghost" onClick={() => setMode('refer')}>Refer for special repair</Button>}
                {officer && ['VERIFIED', 'ASSIGNED', 'IN_PROGRESS', 'REWORK'].includes(t.state) && (openPause
                  ? <Button variant="ghost" icon={<PlayCircle size={18} />} loading={busy === 'resume'} onClick={() => run('resume', () => post('resume', { clock: 'COMPLETION' }), 'Clock resumed')}>Resume clock</Button>
                  : <Button variant="ghost" icon={<PauseCircle size={18} />} onClick={() => setMode('pause')}>Pause clock</Button>)}
                {['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE'].includes(s.role) && t.state === 'WORK_COMPLETED' &&
                  <Button variant="ghost" onClick={() => { setPrio(t.inspection_priority ?? ''); setText(t.inspection_priority_note ?? ''); setMode('priority'); }}>Set inspection priority</Button>}
                {acts.length === 0 && <div className="text-[13px] text-ink-muted">No action is yours at this stage.</div>}
              </div>

              {mode && (
                <Card className="p-4 mt-3">
                  {mode === 'assign' && (
                    <>
                      <div className="font-semibold mb-1">Assign to contractor</div>
                      <div className="text-xs text-ink-muted mb-3">Only contractor supervisors of this Area are listed.</div>
                      <div className="flex flex-col gap-2">
                        {(contractors.data || []).map((c) => (
                          <label key={c.actor_id} className={'flex items-center gap-3 p-3 rounded-input border cursor-pointer ' + (pick === c.actor_id ? 'border-primary bg-tint' : 'border-line')}>
                            <input type="radio" name="c" checked={pick === c.actor_id} onChange={() => setPick(c.actor_id)} />
                            <span className="flex-1 min-w-0"><span className="font-medium">{c.person_name}</span>{c.contractor_name && <span className="block text-xs text-ink-muted truncate">{c.contractor_name}</span>}</span><span className="text-xs text-ink-muted tnum">{c.open_jobs} open jobs</span>
                          </label>
                        ))}
                        {contractors.data?.length === 0 && <div className="text-[13px] text-ink-muted">No active contractor supervisor in this Area.</div>}
                      </div>
                    </>
                  )}
                  {(mode === 'reject' || mode === 'refer' || mode === 'sendback') && (
                    <Field label={mode === 'reject' ? 'Reason — the resident sees it' : mode === 'refer' ? 'Why is this beyond the maintenance contract?' : 'What must be redone?'} required>
                      <textarea className={inputCls + ' h-auto min-h-[80px] py-2'} value={text} onChange={(e) => setText(e.target.value)} />
                    </Field>
                  )}
                  {mode === 'sendback' && <div className="text-xs text-ink-muted mt-2 flex gap-1.5"><Camera size={14} />Your inspection photograph is taken and attached first.</div>}
                  {mode === 'pause' && (
                    <>
                      <div className="font-semibold mb-1">Pause the SLA clock</div>
                      <div className="text-xs text-ink-muted mb-3">Only a locked quarter / refused access, or force majeure, stops the clock. Want of material or labour is the contractor’s obligation.</div>
                      <div className="flex gap-2 mb-3">
                        {[['OCCUPANT', 'Occupant — no access'], ['FORCE_MAJEURE', 'Force majeure']].map(([v, l]) => (
                          <button key={v} onClick={() => setAttr(v)} className={'h-9 px-3.5 rounded-full text-[13px] border-[1.5px] ' + (attr === v ? 'bg-primary-btn text-on-primary border-transparent' : 'border-line-strong')}>{l}</button>
                        ))}
                      </div>
                      <Field label="Reason" required><input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Quarter locked on two visits" /></Field>
                    </>
                  )}
                  {mode === 'priority' && (
                    <div className="grid grid-cols-[120px_1fr] gap-3">
                      <Field label="Priority 1–9"><input className={inputCls} type="number" min={1} max={9} value={prio} onChange={(e) => setPrio(e.target.value)} /></Field>
                      <Field label="Note"><input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} placeholder="Why this goes first" /></Field>
                    </div>
                  )}
                  {typeof mode === 'object' && mode && (
                    <Field label="Your answer — the resident sees it" required>
                      <textarea className={inputCls + ' h-auto min-h-[80px] py-2'} value={text} onChange={(e) => setText(e.target.value)} />
                    </Field>
                  )}
                  <div className="flex justify-end gap-2 mt-4">
                    <Button variant="secondary" onClick={() => { setMode(null); setErr(null); }}>Cancel</Button>
                    {mode === 'assign' && <Button disabled={!pick} loading={busy === 'assign'} onClick={() => run('assign', () => post('assign', { supervisor_id: pick }), `Work assigned to ${contractors.data?.find((c) => c.actor_id === pick)?.person_name}`)}>Assign work</Button>}
                    {mode === 'reject' && <Button variant="destructive" disabled={!text.trim()} loading={busy === 'reject'} onClick={() => run('reject', () => post('reject', { reason: text }), 'Complaint rejected')}>Reject complaint</Button>}
                    {mode === 'refer' && <Button disabled={!text.trim()} loading={busy === 'refer'} onClick={() => run('refer', () => post('refer-special-repair', { reason: text }), 'Referred for special repair')}>Refer complaint</Button>}
                    {mode === 'sendback' && <Button variant="destructive" disabled={!text.trim()} loading={busy === 'sendback'} onClick={() => inspect(false)}>Return for rework</Button>}
                    {mode === 'sendback' && !needInspectionPhoto && <Button variant="secondary" disabled={!text.trim()} loading={busy === 'sendback'} onClick={() => inspect(false, false)}>Return without a photograph</Button>}
                    {mode === 'pause' && <Button disabled={!text.trim()} loading={busy === 'pause'} onClick={() => run('pause', () => post('pause', { clock: 'COMPLETION', attribution: attr, reason: text }), 'Clock paused')}>Pause clock</Button>}
                    {mode === 'priority' && <Button loading={busy === 'priority'} onClick={() => run('priority', () => api(`/tickets/${id}/inspection-priority`, { method: 'PUT', body: { priority: prio ? Number(prio) : null, note: text || null } }), 'Inspection priority set')}>Set priority</Button>}
                    {typeof mode === 'object' && mode && <Button disabled={!text.trim()} loading={busy === 'answer'} onClick={() => run('answer', () => api(`/objections/${(mode as any).answer}/respond`, { body: { response_note: text } }), 'Objection answered')}>Send answer</Button>}
                  </div>
                </Card>
              )}
              {err && <div className="mt-3"><ErrorState message={err} /></div>}

              {t.objections?.length > 0 && (
                <>
                  <SectionLabel className="mt-6 mb-3">Objections from the occupant</SectionLabel>
                  {t.objections.map((o: any) => (
                    <Card key={o.id} className="p-4 mb-2 text-sm">
                      <div className="flex gap-2"><ShieldAlert size={16} className="text-risk shrink-0 mt-0.5" />{o.note}</div>
                      <div className="text-xs text-ink-muted mt-1">{when(o.raised_at)}</div>
                      {o.responded_at ? <div className="mt-2 rounded-input bg-tint p-2.5 text-[13px]"><b>Answered:</b> {o.response_note}</div>
                        : officer && <Button size="sm" variant="secondary" className="mt-2" onClick={() => { setText(''); setMode({ answer: o.id }); }}>Answer objection</Button>}
                    </Card>
                  ))}
                </>
              )}
              {t.media?.length > 0 && (
                <>
                  <SectionLabel className="mt-6 mb-3">Photographs</SectionLabel>
                  <Photographs media={t.media} />
                </>
              )}
              {JOB_CARD_READERS.includes(s.role) && <JobCardSection ticketId={id} state={t.state} refresh={tick} media={t.media} />}
              {JOB_CARD_READERS.includes(s.role) && <DisputesSection ticketId={id} state={t.state} refresh={tick} onChanged={() => { d.reload(); onChanged(); }} />}
              {JOB_CARD_READERS.includes(s.role) && <MaterialsSection ticketId={id} />}
              {JOB_CARD_READERS.includes(s.role) && <MeasurementsSection ticketId={id} />}
              <SectionLabel className="mt-6 mb-3">History</SectionLabel>
              <Card className="p-4"><Timeline items={historyItems(t)} /></Card>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
