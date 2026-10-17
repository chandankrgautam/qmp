import { useState } from 'react';
import { Scale } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState, Field, SectionLabel, Skeleton, StatusChip, inputCls, useToast } from '../../components/ui';
import { PageHeader } from '../../components/shell/Shells';
import TicketPanel from './TicketPanel';
import { ApiError, api, session } from '../../lib/api';
import { shortDate, when } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

/* Disputes: a rejection contested by the occupant, or a complaint reopened
   three times. The steps and who may take them are enforced by the
   database; this screen only presents them (control 5). */

export const KIND: Record<string, string> = {
  REJECTION_CONTEST: 'Rejection contested', REPEAT_DISPUTE: 'Reopened repeatedly'
};
export const STAGE: Record<string, string> = {
  WITH_OFFICERS: 'With the Overseer / Incharge', WITH_STAFF_OFFICER: 'With the Staff Officer', DECIDED: 'Decided'
};
const OUTCOME: Record<string, string> = {
  REINSTATE: 'Reinstated', UPHOLD: 'Rejection upheld', REWORK: 'Work to be redone', CLOSE: 'Closed', SPECIAL_REPAIR: 'Referred for special repair'
};
const SO_CHOICES: Record<string, [string, string][]> = {
  REJECTION_CONTEST: [['REINSTATE', 'Reinstate the complaint'], ['UPHOLD', 'Uphold the rejection']],
  REPEAT_DISPUTE: [['REWORK', 'Redo the work'], ['CLOSE', 'Close the complaint'], ['SPECIAL_REPAIR', 'Refer for special repair']]
};

export function DisputesSection({ ticketId, state, refresh = 0, onChanged }: { ticketId: string; state: string; refresh?: number; onChanged: () => void }) {
  const s = session.get()!;
  const toast = useToast();
  const list = useLoad(() => api<any[]>(`/tickets/${ticketId}/reviews`), [ticketId, state, refresh]);
  const [note, setNote] = useState('');
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // not visible to this caller: show nothing
  if (list.error && (/not found/i.test(list.error) || /404/.test(list.error))) return null;
  if (!list.data && !list.error) return <Skeleton className="h-16 mt-6" />;
  if (list.error) return <div className="mt-6"><ErrorState message={list.error} retry={list.reload} /></div>;
  const reviews = list.data || [];
  if (reviews.length === 0) return null;

  const act = async (key: string, path: string, body: unknown, ok: string) => {
    setBusy(key); setErr(null);
    try { await api(path, { body }); toast({ text: ok }); setNote(''); setChoice(''); list.reload(); onChanged(); }
    catch (e: any) { setErr(e instanceof ApiError ? e.message : String(e.message || e)); } finally { setBusy(null); }
  };
  const officerRole = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE'].includes(s.role);
  const waiting = reviews.find((r) => r.kind === 'REPEAT_DISPUTE' && r.stage === 'WITH_STAFF_OFFICER');

  return (
    <>
      <SectionLabel className="mt-6 mb-3">Disputes</SectionLabel>
      {waiting && (
        <div className="mb-3 rounded-card bg-await-bg text-await p-3.5 text-[13px]">
          Waiting for the Area Civil Staff Officer’s decision — cannot be reassigned until then.
        </div>
      )}
      {reviews.map((r) => (
        <Card key={r.id} className="p-4 mb-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold flex items-center gap-2"><Scale size={16} className="text-primary" />{KIND[r.kind] || r.kind}</div>
            <StatusChip tone={r.stage === 'DECIDED' ? 'ok' : 'await'}>{STAGE[r.stage] || r.stage}</StatusChip>
          </div>
          <div className="text-xs text-ink-muted mt-1">Raised {when(r.raised_at)}</div>
          {r.raised_reason && <div className="mt-2">“{r.raised_reason}”</div>}
          {r.officer_outcome && (
            <div className="mt-2 rounded-input bg-tint p-2.5 text-[13px]">
              <b>{r.officer_by_name || 'Overseer / Incharge'}:</b> {OUTCOME[r.officer_outcome] || r.officer_outcome}{r.officer_note && <> — “{r.officer_note}”</>}
              <div className="text-xs text-ink-muted">{when(r.officer_at)}</div>
            </div>
          )}
          {r.so_outcome && (
            <div className="mt-2 rounded-input bg-tint p-2.5 text-[13px]">
              <b>Staff Officer{r.so_by_name ? ` — ${r.so_by_name}` : ''}:</b> {OUTCOME[r.so_outcome] || r.so_outcome}
              {r.so_decision && <div className="whitespace-pre-wrap mt-0.5">“{r.so_decision}”</div>}
              <div className="text-xs text-ink-muted">{when(r.so_at)}</div>
            </div>
          )}

          {r.stage === 'WITH_OFFICERS' && officerRole && (
            <div className="mt-3">
              <Field label="Your note — the occupant sees it" required>
                <textarea className={inputCls + ' h-auto min-h-[70px] py-2'} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <div className="text-xs text-ink-muted mt-1.5">Uphold sends it to the Area Civil Staff Officer for a written decision.</div>
              <div className="flex gap-2 mt-3">
                <Button size="sm" disabled={!note.trim()} loading={busy === 'REINSTATE'}
                  onClick={() => act('REINSTATE', `/reviews/${r.id}/officer`, { outcome: 'REINSTATE', note }, 'Complaint reinstated')}>Reinstate</Button>
                <Button size="sm" variant="secondary" disabled={!note.trim()} loading={busy === 'UPHOLD'}
                  onClick={() => act('UPHOLD', `/reviews/${r.id}/officer`, { outcome: 'UPHOLD', note }, 'Sent to the Staff Officer')}>Uphold</Button>
              </div>
            </div>
          )}

          {r.stage === 'WITH_STAFF_OFFICER' && s.role === 'STAFF_OFFICER_CIVIL' && (
            <div className="mt-3">
              <div className="text-[13px] font-medium mb-1.5">Your decision</div>
              <div className="flex flex-wrap gap-2 mb-3">
                {(SO_CHOICES[r.kind] || []).map(([v, l]) => (
                  <button key={v} onClick={() => setChoice(v)} aria-pressed={choice === v}
                    className={'h-9 px-3.5 rounded-full text-[13px] border-[1.5px] ' + (choice === v ? 'bg-primary-btn text-on-primary border-transparent' : 'border-line-strong')}>{l}</button>
                ))}
              </div>
              <Field label="Written decision — kept in the record, and the occupant sees it" required>
                <textarea className={inputCls + ' h-auto min-h-[90px] py-2'} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <div className="text-xs text-ink-muted mt-1.5">After this, the occupant cannot dispute or reopen this complaint again in the portal.</div>
              <Button className="mt-3" size="sm" disabled={!choice || !note.trim()} loading={busy === 'decide'}
                onClick={() => act('decide', `/reviews/${r.id}/decide`, { outcome: choice, decision: note }, 'Decision recorded')}>Record decision</Button>
            </div>
          )}
        </Card>
      ))}
      {err && <div className="mt-2"><ErrorState message={err} /></div>}
    </>
  );
}

/* The page: reviews waiting for this role. */
export default function Disputes() {
  const s = session.get()!;
  const res = useLoad(() => api<any[]>('/reviews?pending=true'));
  const [open, setOpen] = useState<string | null>(null);
  const sub = s.role === 'STAFF_OFFICER_CIVIL' ? 'Waiting for your written decision'
    : ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE'].includes(s.role) ? 'Contested rejections waiting for your review'
    : 'Disputes waiting for an officer';
  return (
    <>
      <PageHeader title="Disputes" sub={sub} />
      {res.error && <ErrorState message={res.error} retry={res.reload} />}
      <div className="bg-surface border border-line rounded-card overflow-auto">
        {!res.data ? <Skeleton className="h-40 m-4" /> : res.data.length === 0
          ? <EmptyState title="Nothing waiting" body="Contested rejections and repeated disputes appear here when they need you." />
          : (
            <table className="w-full text-[13px] min-w-[860px]">
              <thead className="bg-bg"><tr className="text-left">{['Complaint', 'Qtr / building', 'Fault', 'Dispute', 'Stage', 'Raised', 'Reason'].map((h) => <th key={h} className="label px-4 py-3">{h}</th>)}</tr></thead>
              <tbody>{res.data.map((r) => (
                <tr key={r.id} className="border-t border-line h-[52px] hover:bg-row-hover cursor-pointer" onClick={() => setOpen(r.ticket_id)}>
                  <td className="px-4 font-semibold tnum">{r.ticket_no}</td>
                  <td className="px-4">{r.identifier}</td>
                  <td className="px-4">{r.sub_category}</td>
                  <td className="px-4">{KIND[r.kind] || r.kind}</td>
                  <td className="px-4"><StatusChip tone="await">{STAGE[r.stage] || r.stage}</StatusChip></td>
                  <td className="px-4 tnum text-ink-muted">{shortDate(r.raised_at)}</td>
                  <td className="px-4 text-ink-muted max-w-[260px] truncate">{r.raised_reason || '—'}</td>
                </tr>))}</tbody>
            </table>
          )}
      </div>
      {open && <TicketPanel id={open} onClose={() => setOpen(null)} onChanged={res.reload} />}
    </>
  );
}
