import { useState } from 'react';
import clsx from 'clsx';
import { Check } from 'lucide-react';
import { Button, ErrorState, Field, inputCls, useToast } from './ui';
import { api, session } from '../lib/api';
import { when } from '../lib/format';

/* The approval chain after the work (user's decisions, 2026-10-16): a job's
   materials (and, later, its measurements) go up contractor supervisor →
   Civil Overseer → Civil Colony Incharge → Area Civil Staff Officer. The
   server says which moves the caller may make (`can`); the database refuses
   anything else. Officers see who made each move; the contractor sees the
   role and the remark, never the name. */

const STEPS: [string, string][] = [
  ['SUPERVISOR', 'Supervisor'], ['OVERSEER', 'Civil Overseer'], ['INCHARGE', 'Civil Incharge'],
  ['STAFF_OFFICER', 'Staff Officer'], ['APPROVED', 'Approved']
];
const ROLE: Record<string, string> = {
  CONTRACTOR_SUPERVISOR: 'Supervisor', CIVIL_OVERSEER: 'Civil Overseer', MAINTENANCE_INCHARGE: 'Civil Colony Incharge',
  STAFF_OFFICER_CIVIL: 'Area Civil Staff Officer'
};
const DID: Record<string, string> = {
  SUBMIT: 'sent it for review', PASS: 'reviewed it and passed it up', PASS_NO_CHANGE: 'reviewed it — no change — and passed it up',
  RETURN: 'sent it back', APPROVE: 'approved it', REOPEN: 'sent the approved sheet back down'
};
const LABEL: Record<string, string> = {
  submit: 'Send for review', pass: 'Pass up after review', 'pass-no-change': 'Reviewed — no change',
  return: 'Send back', approve: 'Approve', reopen: 'Send back down'
};
const NEEDS_REMARK = ['return', 'reopen'];
const WAIT_DAYS = 7;   // the setting's default; the flag on Today comes in a later phase

export function SheetChain({ sheet, ticketId, kind, onMoved }: { sheet: any; ticketId: string; kind: 'materials' | 'measurements'; onMoved: () => void }) {
  const toast = useToast();
  const [asking, setAsking] = useState<string | null>(null);
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!sheet) return null;
  const at = STEPS.findIndex(([s]) => s === sheet.stage);
  const waited = (Date.now() - Date.parse(sheet.stage_since)) / 86_400_000;
  const contractor = ['CONTRACTOR', 'CONTRACTOR_SUPERVISOR'].includes(session.get()?.role || '');
  const move = async (action: string) => {
    setBusy(action); setErr(null);
    try {
      await api(`/tickets/${ticketId}/sheets/${kind}/${action}`, { body: { remark: remark.trim() || undefined } });
      toast({ text: action === 'approve' ? 'Approved' : action === 'submit' ? 'Sent for review' : NEEDS_REMARK.includes(action) ? 'Sent back' : 'Passed up' });
      setAsking(null); setRemark(''); onMoved();
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  return (
    <div className="border border-line rounded-input p-3 mb-3 bg-bg">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-[12px]" aria-label="Steps of approval">
        {STEPS.map(([s, label], i) => (
          <li key={s} className="flex items-center gap-1">
            <span className={clsx('inline-flex items-center gap-1 h-7 px-2.5 rounded-full border',
              i < at ? 'bg-ok-bg text-ok border-transparent' : i === at ? (s === 'APPROVED' ? 'bg-ok text-white border-transparent font-semibold' : 'bg-primary-btn text-on-primary border-transparent font-semibold') : 'border-line-strong text-ink-muted')}
              aria-current={i === at ? 'step' : undefined}>
              {(i < at || (i === at && s === 'APPROVED')) && <Check size={13} />}{label}
            </span>
            {i < STEPS.length - 1 && <span className="text-ink-muted">›</span>}
          </li>
        ))}
      </ol>
      <div className={clsx('text-xs mt-2', sheet.stage !== 'APPROVED' && waited > WAIT_DAYS ? 'text-bad font-semibold' : 'text-ink-muted')}>
        {sheet.stage === 'APPROVED' ? `Approved ${when(sheet.approved_at)}` : `At this step since ${when(sheet.stage_since)}`}
        {sheet.stage !== 'APPROVED' && waited > WAIT_DAYS && ` — waiting over ${WAIT_DAYS} days`}
      </div>
      {sheet.can?.length > 0 && !asking && (
        <div className="flex flex-wrap gap-2 mt-3">
          {sheet.can.map((a: string) => (
            <Button key={a} size="sm" variant={NEEDS_REMARK.includes(a) ? 'secondary' : 'primary'} loading={busy === a}
              onClick={() => (NEEDS_REMARK.includes(a) ? (setAsking(a), setErr(null)) : move(a))}>{LABEL[a] || a}</Button>
          ))}
        </div>
      )}
      {sheet.can?.includes('submit') && !asking && <p className="text-xs text-ink-muted mt-1.5">After sending, you can change nothing unless it is sent back to you.</p>}
      {asking && (
        <div className="grid gap-2 mt-3">
          <Field label={asking === 'reopen' ? 'Why are the approved materials sent back?' : 'Why is it sent back? The step below sees this.'} required>
            <input className={inputCls} value={remark} onChange={(e) => setRemark(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={!remark.trim()} loading={busy === asking} onClick={() => move(asking)}>{LABEL[asking]}</Button>
            <Button size="sm" variant="secondary" onClick={() => { setAsking(null); setRemark(''); }}>Cancel</Button>
          </div>
        </div>
      )}
      {err && <div className="mt-2"><ErrorState message={err} /></div>}
      {sheet.events?.length > 0 && (
        <ol className="mt-3 grid gap-1.5 text-[12.5px]">
          {sheet.events.map((e: any, i: number) => (
            <li key={i} className={e.action === 'RETURN' || e.action === 'REOPEN' ? 'text-reopen' : ''}>
              <b>{ROLE[e.actor_role] || e.actor_role}</b>{!contractor && e.actor_name ? ` (${e.actor_name})` : ''} {DID[e.action] || e.action}
              {e.remark && <> — “{e.remark}”</>}
              <span className="text-ink-muted"> · {when(e.at)}{!contractor && ['password', 'passkey', 'otp'].includes(e.via) ? ' · from the web' : ''}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
