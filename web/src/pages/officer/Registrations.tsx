import { useState } from 'react';
import { AlertTriangle, MapPin } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState, Field, Skeleton, StatusChip, inputCls, useToast } from '../../components/ui';
import { PageHeader } from '../../components/shell/Shells';
import { idApi, session } from '../../lib/api';
import { ROLE_LABEL } from '../../lib/domain';
import { when } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

/* The approval queue. The server returns only the registrations the
   caller may approve: residents and custodians to the Incharge; phones of
   officials and contractors, which ask for no role, to the Area
   administrators — roles are assigned separately, on People and roles
   (decision 2026-09-30). */

export default function Registrations() {
  const s = session.get()!;
  const q = useLoad(() => idApi<{ items: any[] }>('/registrations'));
  // homes asked for by people already registered (2026-10-13): the role only
  const h = useLoad(() => idApi<{ items: any[] }>('/home-requests'));
  const homes = (h.data?.items || []).map((x) => ({ ...x, submitted_identifier: x.identifier, submitted_sector: x.sector,
    waiting_hours: Math.round((Date.now() - new Date(x.created_at).getTime()) / 3600000), home: true }));
  return (
    <>
      <PageHeader title="Registrations" sub={s.role !== 'MAINTENANCE_INCHARGE'
        ? 'Phones waiting for approval. A phone carries no role of its own: approving it lets its owner sign in to the roles already assigned to them.'
        : 'Phones of residents, custodians and the contractor supervisors you appointed, waiting for your check. Correcting the quarter number here builds the premises register.'} />
      {q.error && <ErrorState message={q.error} retry={q.reload} />}
      {!q.data && !q.error && <Skeleton className="h-40" />}
      {q.data?.items.length === 0 && homes.length === 0 && <Card><EmptyState title="Nothing waiting" body="New registrations will appear here. The Incharge has three days to act on each." /></Card>}
      <div className="grid xl:grid-cols-2 gap-3">
        {q.data?.items.map((r) => <Item key={r.id} r={r} onDone={q.reload} />)}
      </div>
      {homes.length > 0 && (<>
        <h2 className="font-semibold text-base mt-6 mb-1">Homes asked for by people already registered</h2>
        <p className="text-[13px] text-ink-muted mb-3">Their phone is approved already; approving gives them this quarter or building as one more role.</p>
        <div className="grid xl:grid-cols-2 gap-3">
          {homes.map((r) => <Item key={r.id} r={r} onDone={h.reload} />)}
        </div>
      </>)}
    </>
  );
}

function Item({ r, onDone }: { r: any; onDone: () => void }) {
  const toast = useToast();
  const occupant = r.role === 'RESIDENT' || r.role === 'CUSTODIAN';
  const [f, setF] = useState({ corrected_identifier: r.submitted_identifier || '', corrected_sector: r.submitted_sector || '',
    quarter_type: 'B' });
  const [reject, setReject] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (k: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(k); setErr(null);
    try { await fn(); toast({ text: ok }); onDone(); } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  // a resident is bound to a quarter; a custodian to an existing building (decision 2026-09-30)
  const quarter = r.role === 'RESIDENT';
  const base = r.home ? `/home-requests/${r.id}` : `/registrations/${r.id}`;
  const approve = () => act('ok', () => idApi(`${base}/approve`, { body: occupant
    ? { corrected_identifier: f.corrected_identifier, ...(quarter ? { corrected_sector: f.corrected_sector || null, quarter_type: f.quarter_type } : {}) }
    : {} }), r.home ? `${r.submitted_identifier} approved for ${r.name}` : `Registration of ${r.name} approved`);

  return (
    <Card className={'p-5 ' + (r.already_claimed ? 'shadow-[inset_3px_0_0_var(--status-at-risk)]' : '')}>
      <div className="flex justify-between gap-3 items-start">
        <div>
          <div className="font-semibold text-base">{r.name}</div>
          <div className="text-xs text-ink-muted tnum">{r.home ? 'Already registered — phone approved' : r.personnel_no || 'No Employee ID'} · {r.mobile}{!r.home && ' (verified by OTP)'}
            {r.resident_category === 'NON_NCL' && ' · Non-NCL — verify identity in person'}</div>
        </div>
        <StatusChip tone={occupant ? 'info' : 'await'}>{r.role ? ROLE_LABEL[r.role] : 'Phone only'}</StatusChip>
      </div>
      {occupant ? (
        <div className="text-[13px] mt-3 flex items-center gap-1.5"><MapPin size={14} className="text-ink-muted" />
          Submitted as: <b>{r.colony}</b> · {quarter ? `${r.submitted_sector || 'no sector'} · ` : 'building '}“{r.submitted_identifier}”</div>
      ) : (
        <div className="text-[13px] mt-3">Roles already assigned: <b>{r.existing_roles ? r.existing_roles.split(', ').map((x: string) => ROLE_LABEL[x] || x).join(', ') : 'none yet'}</b></div>
      )}
      {r.home && <div className="text-[13px] mt-1">Roles in your Area: <b>{r.existing_roles ? r.existing_roles.split(', ').map((x: string) => ROLE_LABEL[x] || x).join(', ') : 'none'}</b></div>}
      <div className="text-xs text-ink-muted mt-1">Waiting {r.waiting_hours} h · {when(r.created_at)}</div>
      {r.already_claimed && <div className="mt-2 text-[13px] text-risk flex gap-1.5"><AlertTriangle size={15} />This quarter is already held by an active device — check before approving.</div>}

      {occupant ? (
        <div className="grid grid-cols-2 gap-3 mt-4">
          <Field label={quarter ? 'Correct the quarter number' : 'Building'}><input className={inputCls} value={f.corrected_identifier} onChange={(e) => setF({ ...f, corrected_identifier: e.target.value })} /></Field>
          {quarter && <Field label="Sector"><input className={inputCls} value={f.corrected_sector} onChange={(e) => setF({ ...f, corrected_sector: e.target.value })} /></Field>}
          {quarter && (
            <Field label="Quarter type" required>
              <select className={inputCls} value={f.quarter_type} onChange={(e) => setF({ ...f, quarter_type: e.target.value })}>
                {['A', 'B', 'C', 'D', 'MQ'].map((t) => <option key={t}>{t}</option>)}
              </select>
            </Field>
          )}
        </div>
      ) : (
        <div className="mt-4 rounded-card bg-await-bg text-await p-3 text-[13px]">Approving lets this phone sign in as <b>{r.name}</b>, in every role assigned to them. Check it is their phone first.</div>
      )}

      {reject && (
        <Field label="Reason — the applicant sees it" required>
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. No such quarter in this colony" />
        </Field>
      )}
      {err && <div className="mt-3"><ErrorState message={err} /></div>}
      <div className="flex flex-wrap gap-2 mt-4">
        {!reject ? (<>
          <Button loading={busy === 'ok'} onClick={approve}>{r.home ? 'Approve home' : 'Approve registration'}</Button>
          <Button variant="secondary" onClick={() => setReject(true)}>Reject</Button>
          {occupant && !r.home && <Button variant="ghost" loading={busy === 'site'} onClick={() => act('site', () => idApi(`/registrations/${r.id}/refer-site-check`, { method: 'POST' }), 'Sent to the Overseer for a site check')}>Ask Overseer to check the site</Button>}
        </>) : (<>
          <Button variant="destructive" disabled={!reason.trim()} loading={busy === 'no'} onClick={() => act('no', () => idApi(`${base}/reject`, { body: { reason } }), r.home ? 'Home refused' : 'Registration rejected')}>{r.home ? 'Refuse home' : 'Reject registration'}</Button>
          <Button variant="secondary" onClick={() => setReject(false)}>Cancel</Button>
        </>)}
      </div>
    </Card>
  );
}
