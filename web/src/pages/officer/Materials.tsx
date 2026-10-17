import { useState } from 'react';
import { Download, History as HistoryIcon, Pencil, Plus, Undo2 } from 'lucide-react';
import { Button, Card, Dialog, EmptyState, ErrorState, Field, SectionLabel, Segmented, Skeleton, StatusChip, inputCls, useToast } from '../../components/ui';
import { PageHeader } from '../../components/shell/Shells';
import { ApiError, api, session } from '../../lib/api';
import { shortDate, when } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import TicketPanel from './TicketPanel';
import { SheetChain } from '../../components/SheetChain';

/* Materials (decision 9, 2026-09-30): record only. The contractor says what
   was used, Civil verifies it at inspection, the reports compare the two.
   The master is kept by the HQ System Administrator alone. No rates or
   amounts exist anywhere (control 9). The database enforces every rule
   here; the screens only follow. */

const qty = (v: any) => (v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 }));
const numOnly = (v: string) => v.replace(/[^0-9.]/g, '');
const EVENT: Record<string, string> = {
  MATERIAL_CLAIMED: 'Material recorded', MATERIAL_CLAIM_WITHDRAWN: 'Line withdrawn',
  MATERIAL_VERIFIED: 'Verified', MATERIAL_REVERIFIED: 'Verified again'
};
const FLAGS: Record<string, { label: string; why: string }> = {
  OVER_CLAIM: { label: 'Claimed more than verified', why: 'Verified less than claimed' },
  ABOVE_NORM: { label: 'Above the usual quantity', why: 'More than one job normally needs' },
  REPEAT_AT_PREMISES: { label: 'Repeat at the same premises', why: 'Same material at the same premises within 90 days' },
  UNVERIFIED: { label: 'Not verified', why: 'Passed inspection without the materials being verified' }
};

const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404;

/* ------------------------------------------------------------ officer: in the complaint panel */
export function MaterialsSection({ ticketId }: { ticketId: string }) {
  const m = useLoad(() => api<any>(`/tickets/${ticketId}/materials`).catch((e) => {
    if (isNotFound(e)) return null;
    throw e;
  }), [ticketId]);
  // the approval chain after the work (2026-10-16)
  const sh = useLoad(() => api<any>(`/tickets/${ticketId}/sheets`).catch(() => null), [ticketId]);
  const [hist, setHist] = useState(false);
  if (m.error) return <><SectionLabel className="mt-6 mb-3">Materials</SectionLabel><ErrorState message={m.error} retry={m.reload} /></>;
  if (m.data === null && !m.loading) return null;
  if (!m.data) return <Skeleton className="h-24 mt-6" />;
  const { items, can_verify, can_claim, reason_needed, stage } = m.data as { items: any[]; can_verify: boolean; can_claim: boolean; reason_needed: boolean; stage: string };
  const reload = () => { m.reload(); sh.reload(); };
  return (
    <>
      <div className="flex items-center justify-between mt-6 mb-3">
        <SectionLabel>Materials</SectionLabel>
        <Button size="sm" variant="ghost" icon={<HistoryIcon size={16} />} onClick={() => setHist(!hist)}>{hist ? 'Hide changes' : 'Changes'}</Button>
      </div>
      <Card className="p-4">
        <SheetChain sheet={sh.data?.materials} ticketId={ticketId} kind="materials" onMoved={reload} />
        {items.length === 0 && <div className="text-sm text-ink-muted">No materials recorded by the contractor yet.</div>}
        <ol className="flex flex-col gap-3">
          {items.map((l) => <Line key={l.id} ticketId={ticketId} line={l} canVerify={can_verify} reasonNeeded={reason_needed} onDone={reload} />)}
        </ol>
        {can_claim && <AddMissed ticketId={ticketId} afterApproval={stage === 'APPROVED'} onDone={reload} />}
        <div className="text-xs text-ink-muted mt-3">Quantities only. The contractor supplies the material; no rates are recorded.</div>
      </Card>
      {hist && <MaterialsHistory ticketId={ticketId} />}
    </>
  );
}

function Line({ ticketId, line: l, canVerify, reasonNeeded, onDone }: { ticketId: string; line: any; canVerify: boolean; reasonNeeded?: boolean; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(String(l.qty_claimed ?? ''));
  const [remark, setRemark] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const withdrawn = !!l.withdrawn_at;
  const verified = l.qty_verified != null;
  // in the approval chain a change needs a reason; as before, so does verifying again
  const needReason = verified || (!!reasonNeeded && Number(v) !== Number(l.qty_verified ?? l.qty_claimed));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api(`/tickets/${ticketId}/materials/${l.id}/verify`, { body: {
        qty_verified: Number(v), remark: remark.trim() || undefined, reason: reason.trim() || undefined } });
      toast({ text: verified ? 'Verified again' : 'Verified' }); setOpen(false); setReason(''); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <li className={'text-[13px] ' + (withdrawn ? 'text-ink-muted' : '')}>
      <div className="flex items-start gap-2">
        <span className="tnum w-6 shrink-0">{l.seq}.</span>
        <div className="flex-1 min-w-0">
          <div className={withdrawn ? 'line-through' : 'font-medium'}>{l.name_en} <span className="text-ink-muted font-normal tnum">({l.code})</span></div>
          <div className="text-xs text-ink-muted tnum">Claimed {qty(l.qty_claimed)} {l.unit} · {l.claimed_by_name || '—'} · {when(l.claimed_at)}{l.claimed_via === 'otp' && ' · from the web'}</div>
          {!withdrawn && (verified
            ? <div className="text-xs tnum mt-0.5">Verified <b>{qty(l.qty_verified)} {l.unit}</b> · {l.verified_by_name || '—'} · {when(l.verified_at)}
              {l.verification_remark && <> · “{l.verification_remark}”</>}</div>
            : <div className="text-xs text-ink-muted mt-0.5">Not verified</div>)}
          {withdrawn && <div className="text-xs mt-0.5">Withdrawn {shortDate(l.withdrawn_at)}: {l.withdrawal_reason}</div>}
        </div>
        {canVerify && !withdrawn && !open && (
          <button className="text-primary text-xs font-semibold min-h-11 px-1" onClick={() => { setErr(null); setOpen(true); }}>{verified ? 'Verify again' : 'Verify'}</button>
        )}
      </div>
      {open && (
        <div className="grid gap-2 border border-line rounded-input p-3 mt-2">
          <Field label={`Verified quantity (${l.unit})`}>
            <input className={inputCls + ' tnum'} inputMode="decimal" value={v} onChange={(e) => setV(numOnly(e.target.value))} />
          </Field>
          <Field label="Remark (optional)">
            <input className={inputCls} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="e.g. Counted on site" />
          </Field>
          {needReason && (
            <Field label={reasonNeeded ? 'Reason for the change' : 'Reason for verifying again'} required>
              <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Kept in the record" />
            </Field>
          )}
          {err && <ErrorState message={err} />}
          <div className="flex gap-2">
            <Button size="sm" loading={busy} disabled={v === '' || isNaN(Number(v)) || (needReason && !reason.trim())} onClick={save}>{verified ? 'Save verification' : 'Verify'}</Button>
            <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </li>
  );
}

/* An officer adds a line the supervisor missed, at their own step of the chain;
   after approval only the Staff Officer, with a reason (2026-10-16). */
function AddMissed({ ticketId, afterApproval, onDone }: { ticketId: string; afterApproval: boolean; onDone: () => void }) {
  const toast = useToast();
  const master = useLoad(() => api<any[]>('/materials'), []);
  const [open, setOpen] = useState(false);
  const [mid, setMid] = useState(''); const [q, setQ] = useState(''); const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const active = (master.data || []).filter((x) => x.active);
  const chosen = active.find((x) => x.id === mid);
  if (!open) return <Button size="sm" variant="ghost" className="mt-2" icon={<Plus size={16} />} onClick={() => setOpen(true)}>Add a missed line</Button>;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api(`/tickets/${ticketId}/materials`, { body: { material_id: mid, qty_claimed: Number(q), reason: reason.trim() || undefined } });
      toast({ text: 'Line added' }); setOpen(false); setMid(''); setQ(''); setReason(''); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-2 border border-line rounded-input p-3 mt-3">
      <Field label="Material">
        <select className={inputCls} value={mid} onChange={(e) => setMid(e.target.value)}>
          <option value="">Choose a material</option>
          {active.map((x) => <option key={x.id} value={x.id}>{x.name_en} ({x.unit})</option>)}
        </select>
      </Field>
      <Field label={chosen ? `Quantity (${chosen.unit})` : 'Quantity'}><input className={inputCls + ' tnum'} inputMode="decimal" value={q} onChange={(e) => setQ(numOnly(e.target.value))} /></Field>
      {afterApproval && <Field label="Reason for adding after approval" required><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      <p className="text-xs text-ink-muted">Recorded as added by you; the next step verifies it.</p>
      {err && <ErrorState message={err} />}
      <div className="flex gap-2">
        <Button size="sm" loading={busy} disabled={!mid || !(Number(q) > 0) || (afterApproval && !reason.trim())} onClick={save}>Add line</Button>
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}

function MaterialsHistory({ ticketId }: { ticketId: string }) {
  const h = useLoad(() => api<any[]>(`/tickets/${ticketId}/materials/history`), [ticketId]);
  if (h.error) return <ErrorState message={h.error} />;
  if (!h.data) return <Skeleton className="h-24 mt-3" />;
  if (h.data.length === 0) return <div className="text-sm text-ink-muted mt-3">No changes yet.</div>;
  return (
    <ol className="mt-3 flex flex-col gap-2">
      {h.data.map((l, i) => {
        const a = l.after_value || {}, b = l.before_value || {};
        return (
          <li key={i} className="border border-line rounded-input p-3 text-[13px] bg-surface">
            <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{EVENT[l.event_type] || l.event_type}</span>
              <span className="text-xs text-ink-muted">{l.actor_name || l.actor_role || 'System'} · {when(l.occurred_at)}</span></div>
            {l.event_type === 'MATERIAL_CLAIMED' && (a.name_en || a.qty_claimed != null) && (
              <div className="text-xs mt-1">{a.name_en || a.code}: <b className="tnum">{qty(a.qty_claimed)} {a.unit || ''}</b></div>)}
            {(l.event_type === 'MATERIAL_VERIFIED' || l.event_type === 'MATERIAL_REVERIFIED') && a.qty_verified != null && (
              <div className="text-xs mt-1 tnum">{b.qty_verified != null && <><s className="text-ink-muted">{qty(b.qty_verified)}</s> → </>}<b>{qty(a.qty_verified)}</b>{a.verification_remark && <> · “{a.verification_remark}”</>}</div>)}
            {l.reason && <div className="mt-1">“{l.reason}”</div>}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------ contractor: on the phone job page */
export function ContractorMaterials({ ticketId }: { ticketId: string }) {
  const toast = useToast();
  const m = useLoad(() => api<any>(`/tickets/${ticketId}/materials`).catch((e) => {
    if (isNotFound(e)) return null;
    throw e;
  }), [ticketId]);
  const master = useLoad(() => api<any[]>('/materials'), []);
  const sh = useLoad(() => api<any>(`/tickets/${ticketId}/sheets`).catch(() => null), [ticketId]);
  const [adding, setAdding] = useState(false);
  const [mid, setMid] = useState('');
  const [q, setQ] = useState('');
  const [wid, setWid] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (m.error) return <ErrorState message={m.error} retry={m.reload} />;
  if (!m.data) return m.loading ? <Skeleton className="h-24 mt-5" /> : null;
  const { items, can_claim } = m.data as { items: any[]; can_claim: boolean };
  if (items.length === 0 && !can_claim && !sh.data?.materials) return null;
  const active = (master.data || []).filter((x) => x.active);
  const chosen = active.find((x) => x.id === mid);
  const run = async (fn: () => Promise<unknown>, ok: string, done: () => void) => {
    setBusy(true); setErr(null);
    try { await fn(); toast({ text: ok }); done(); m.reload(); sh.reload(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="flex items-center justify-between mt-6 mb-3">
        <SectionLabel>Materials used</SectionLabel>
        {can_claim && !adding && <Button size="sm" variant="ghost" icon={<Plus size={16} />} onClick={() => { setErr(null); setAdding(true); }}>Add material</Button>}
      </div>
      <Card className="p-4">
        <SheetChain sheet={sh.data?.materials} ticketId={ticketId} kind="materials" onMoved={() => { m.reload(); sh.reload(); }} />
        <p className="text-xs text-ink-muted">Record what you used: during the work and after it, until you send it for review. Civil checks it step by step. No rates are recorded.</p>
        {items.length === 0 && !adding && <div className="text-sm text-ink-muted mt-3">Nothing recorded yet.</div>}
        <ol className="flex flex-col gap-3 mt-3">
          {items.map((l) => {
            const withdrawn = !!l.withdrawn_at;
            const mine = can_claim && !withdrawn && l.qty_verified == null;
            return (
              <li key={l.id} className={'text-[13px] ' + (withdrawn ? 'text-ink-muted' : '')}>
                <div className="flex items-start gap-2">
                  <span className="tnum w-6 shrink-0">{l.seq}.</span>
                  <div className="flex-1 min-w-0">
                    <div className={withdrawn ? 'line-through' : 'font-medium'}>{l.name_en}</div>
                    <div className="text-xs tnum">{qty(l.qty_claimed)} {l.unit} used</div>
                    {!withdrawn && (l.qty_verified != null
                      ? <div className="mt-0.5"><StatusChip tone="ok">Verified {qty(l.qty_verified)} {l.unit}</StatusChip></div>
                      : <div className="text-xs text-ink-muted mt-0.5">Civil verifies at inspection</div>)}
                    {withdrawn && <div className="text-xs mt-0.5">Withdrawn: {l.withdrawal_reason}</div>}
                  </div>
                  {mine && wid !== l.id && (
                    <button className="text-ink-muted text-xs font-semibold min-h-11 px-1" onClick={() => { setErr(null); setReason(''); setWid(l.id); }}>
                      <Undo2 size={13} className="inline" /> Withdraw</button>
                  )}
                </div>
                {wid === l.id && (
                  <div className="grid gap-2 border border-line rounded-input p-3 mt-2">
                    <input className={inputCls} aria-label="Reason for withdrawing" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is it withdrawn? Kept in the record" />
                    {err && <ErrorState message={err} />}
                    <div className="flex gap-2">
                      <Button size="sm" variant="destructive" loading={busy} disabled={!reason.trim()}
                        onClick={() => run(() => api(`/tickets/${ticketId}/materials/${l.id}/withdraw`, { body: { reason: reason.trim() } }), 'Line withdrawn', () => setWid(null))}>Withdraw line</Button>
                      <Button size="sm" variant="secondary" onClick={() => setWid(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {adding && (
          <div className="grid gap-2 border border-line rounded-input p-3 mt-3">
            <Field label="Material">
              <select className={inputCls} value={mid} onChange={(e) => setMid(e.target.value)}>
                <option value="">Choose a material</option>
                {active.map((x) => <option key={x.id} value={x.id}>{x.name_en} ({x.unit})</option>)}
              </select>
            </Field>
            <Field label={chosen ? `Quantity used (${chosen.unit})` : 'Quantity used'}>
              <input className={inputCls + ' tnum'} inputMode="decimal" value={q} onChange={(e) => setQ(numOnly(e.target.value))} placeholder="e.g. 2" />
            </Field>
            {master.error && <ErrorState message={master.error} retry={master.reload} />}
            {err && <ErrorState message={err} />}
            <div className="flex gap-2">
              <Button size="sm" loading={busy} disabled={!mid || !(Number(q) > 0)}
                onClick={() => run(() => api(`/tickets/${ticketId}/materials`, { body: { material_id: mid, qty_claimed: Number(q) } }), 'Material recorded', () => { setAdding(false); setMid(''); setQ(''); })}>Add material</Button>
              <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

/* ------------------------------------------------------------ the page */
type Tab = 'consumption' | 'anomalies' | 'master';

export default function Materials() {
  const [tab, setTab] = useState<Tab>('consumption');
  return (
    <>
      <PageHeader title="Materials" sub="What contractors say they used, and what Civil verified. Quantities only; no rates are recorded." />
      <Segmented<Tab> className="mb-4" value={tab} onChange={setTab}
        options={[{ value: 'consumption', label: 'Consumption' }, { value: 'anomalies', label: 'Anomalies' }, { value: 'master', label: 'Master' }]} />
      {tab === 'consumption' && <Consumption />}
      {tab === 'anomalies' && <Anomalies />}
      {tab === 'master' && <Master />}
    </>
  );
}

function Filters({ f, set }: { f: { contract: string; from: string; to: string }; set: (f: { contract: string; from: string; to: string }) => void }) {
  const cs = useLoad(() => api<any[]>('/contracts'));
  return (
    <div className="flex flex-wrap gap-3 items-end mb-4">
      <div className="min-w-[240px]">
        <Field label="Contract">
          <select className={inputCls} value={f.contract} onChange={(e) => set({ ...f, contract: e.target.value })}>
            <option value="">All contracts</option>
            {(cs.data || []).map((c) => <option key={c.id} value={c.id}>{c.contractor_name}{c.agreement_no ? ` · ${c.agreement_no}` : ''}</option>)}
          </select>
        </Field>
      </div>
      <Field label="From"><input type="date" className={inputCls} value={f.from} onChange={(e) => set({ ...f, from: e.target.value })} /></Field>
      <Field label="To"><input type="date" className={inputCls} value={f.to} onChange={(e) => set({ ...f, to: e.target.value })} /></Field>
      {cs.error && <div className="w-full"><ErrorState message={cs.error} retry={cs.reload} /></div>}
    </div>
  );
}
const qs = (f: { contract: string; from: string; to: string }) => {
  const p = new URLSearchParams();
  if (f.contract) p.set('contract_id', f.contract);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  const s = p.toString();
  return s ? `?${s}` : '';
};

function Consumption() {
  const toast = useToast();
  const [f, setF] = useState({ contract: '', from: '', to: '' });
  const [busy, setBusy] = useState(false);
  const r = useLoad(() => api<{ rows: any[] }>(`/materials/consumption${qs(f)}`), [f.contract, f.from, f.to]);
  const download = async () => {
    setBusy(true);
    try {
      const s = session.get();
      const res = await fetch(`/maintenance/v1/materials/consumption.csv${qs(f)}`, { headers: { authorization: `Bearer ${s?.token}` } });
      if (!res.ok) { toast({ text: 'Export failed. Try again.', tone: 'bad' }); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = `materials-consumption${f.from ? '-' + f.from : ''}${f.to ? '-to-' + f.to : ''}.csv`;
      a.click();
      toast({ text: 'Consumption report downloaded' });
    } catch { toast({ text: 'Export failed. Try again.', tone: 'bad' }); } finally { setBusy(false); }
  };
  return (
    <>
      <Filters f={f} set={setF} />
      <div className="flex justify-end mb-2"><Button size="sm" variant="secondary" icon={<Download size={16} />} loading={busy} onClick={download}>Download CSV</Button></div>
      {r.error && <ErrorState message={r.error} retry={r.reload} />}
      <div className="bg-surface border border-line rounded-card overflow-auto">
        {!r.data ? <Skeleton className="h-40 m-4" /> : r.data.rows.length === 0
          ? <EmptyState title="No materials recorded" body="Nothing was claimed in this period for this contract." /> : (
          <table className="w-full text-[13px] min-w-[820px]">
            <thead className="bg-bg"><tr className="text-left">
              {['Material', 'Unit', 'Jobs', 'Claimed', 'Verified', 'Not yet verified', 'Variance'].map((h, i) => <th key={h} className={'label px-4 py-3 ' + (i > 1 ? 'text-right' : '')}>{h}</th>)}
            </tr></thead>
            <tbody>{r.data.rows.map((x) => (
              <tr key={x.material_id} className="border-t border-line h-[52px]">
                <td className="px-4"><span className="font-medium">{x.name_en}</span> <span className="text-xs text-ink-muted tnum">{x.code}</span></td>
                <td className="px-4">{x.unit}</td>
                <td className="px-4 tnum text-right">{qty(x.jobs)}</td>
                <td className="px-4 tnum text-right">{qty(x.qty_claimed)}</td>
                <td className="px-4 tnum text-right">{qty(x.qty_verified)}</td>
                <td className="px-4 tnum text-right">{qty(x.qty_unverified)}</td>
                <td className={'px-4 tnum text-right ' + (Number(x.variance) > 0 ? 'text-bad font-semibold' : '')}>{qty(x.variance)}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-ink-muted mt-2">Withdrawn lines are left out. Variance is claimed less verified, over verified lines only.</p>
    </>
  );
}

function Anomalies() {
  const [f, setF] = useState({ contract: '', from: '', to: '' });
  const [open, setOpen] = useState<string | null>(null);
  const r = useLoad(() => api<{ items: any[] }>(`/materials/anomalies${qs(f)}`), [f.contract, f.from, f.to]);
  return (
    <>
      <Filters f={f} set={setF} />
      {r.error && <ErrorState message={r.error} retry={r.reload} />}
      {!r.data ? <Skeleton className="h-40" /> : r.data.items.length === 0
        ? <Card><EmptyState title="No anomalies" body="Nothing to look at for this contract and period." /></Card>
        : Object.keys(FLAGS).map((flag) => {
          const rows = r.data!.items.filter((x) => x.flag === flag);
          if (!rows.length) return null;
          return (
            <section key={flag} className="mb-6">
              <div className="flex items-baseline gap-2 mb-1"><SectionLabel>{FLAGS[flag].label}</SectionLabel><span className="text-xs text-ink-muted tnum">{rows.length}</span></div>
              <p className="text-[13px] text-ink-muted mb-2">{FLAGS[flag].why}.</p>
              <div className="bg-surface border border-line rounded-card overflow-auto">
                <table className="w-full text-[13px] min-w-[760px]">
                  <thead className="bg-bg"><tr className="text-left">
                    {['Complaint', 'Premises', 'Material', 'Claimed', 'Verified', 'Detail'].map((h) => <th key={h} className="label px-4 py-3">{h}</th>)}
                  </tr></thead>
                  <tbody>{rows.map((x, i) => (
                    <tr key={x.line_id + flag + i} className="border-t border-line h-[52px] hover:bg-row-hover cursor-pointer" onClick={() => setOpen(x.ticket_id)}>
                      <td className="px-4 font-semibold tnum text-primary">{x.ticket_no}</td>
                      <td className="px-4">{x.identifier}</td>
                      <td className="px-4">{x.name_en}</td>
                      <td className="px-4 tnum">{qty(x.qty_claimed)} {x.unit}</td>
                      <td className="px-4 tnum">{x.qty_verified == null ? 'Not verified' : `${qty(x.qty_verified)} ${x.unit}`}</td>
                      <td className="px-4 text-ink-muted">{x.detail}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            </section>
          );
        })}
      {open && <TicketPanel id={open} onClose={() => setOpen(null)} onChanged={r.reload} />}
    </>
  );
}

/* ------------------------------------------------------------ master */
type Draft = { code: string; name_en: string; name_hi: string; unit: string; category: string; norm: string; reason: string };
const CATEGORIES = ['Civil', 'Plumbing', 'Carpentry', 'Painting', 'Glazing', 'Flooring', 'Hardware'];
const UNITS = ['Bag', 'Cum', 'No.', 'Rm', 'Sqm', 'Kg', 'Litre', 'Set'];

function Master() {
  const admin = session.get()?.role === 'ADMINISTRATOR';
  const toast = useToast();
  const [all, setAll] = useState(false);
  const list = useLoad(() => api<any[]>(`/materials${all ? '?all=true' : ''}`), [all]);
  const [dlg, setDlg] = useState<null | { mode: 'add' | 'edit' | 'toggle'; m?: any }>(null);
  const [d, setD] = useState<Draft>({ code: '', name_en: '', name_hi: '', unit: '', category: '', norm: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = (mode: 'add' | 'edit' | 'toggle', m?: any) => {
    setErr(null); setDlg({ mode, m });
    setD({ code: m?.code || '', name_en: m?.name_en || '', name_hi: m?.name_hi || '', unit: m?.unit || '', category: m?.category || '',
      norm: m?.norm_max_per_job ?? '', reason: '' });
  };
  const save = async () => {
    if (!dlg) return;
    setBusy(true); setErr(null);
    const norm = d.norm === '' ? null : Number(d.norm);
    try {
      if (dlg.mode === 'add') {
        await api('/materials', { body: { code: d.code.trim(), name_en: d.name_en.trim(), name_hi: d.name_hi.trim(), unit: d.unit.trim(),
          category: d.category.trim() || undefined, norm_max_per_job: norm ?? undefined } });
        toast({ text: 'Material added' });
      } else if (dlg.mode === 'edit') {
        await api(`/materials/${dlg.m.id}`, { method: 'PUT', body: { name_en: d.name_en.trim(), name_hi: d.name_hi.trim(), unit: d.unit.trim(),
          category: d.category.trim() || null, norm_max_per_job: norm, reason: d.reason.trim() } });
        toast({ text: 'Material changed' });
      } else {
        await api(`/materials/${dlg.m.id}`, { method: 'PUT', body: { active: !dlg.m.active, reason: d.reason.trim() } });
        toast({ text: dlg.m.active ? 'Material deactivated' : 'Material reactivated' });
      }
      setDlg(null); list.reload();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const valid = dlg?.mode === 'toggle' ? !!d.reason.trim()
    : !!d.name_en.trim() && !!d.name_hi.trim() && !!d.unit.trim() && (d.norm === '' || Number(d.norm) > 0)
      && (dlg?.mode === 'add' ? !!d.code.trim() : !!d.reason.trim());
  const title = dlg?.mode === 'add' ? 'Add material' : dlg?.mode === 'edit' ? `Edit ${dlg.m.code}` : dlg?.m?.active ? `Deactivate ${dlg.m.code}` : `Reactivate ${dlg?.m?.code}`;
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: e.target.value });
  return (
    <>
      <datalist id="mat-units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
      <datalist id="mat-cats">{CATEGORIES.map((u) => <option key={u} value={u} />)}</datalist>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <label className="inline-flex items-center gap-2 text-[13px] min-h-11">
          <input type="checkbox" className="w-4 h-4" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show inactive
        </label>
        <div className="flex-1" />
        {admin && <Button icon={<Plus size={18} />} onClick={() => open('add')}>Add material</Button>}
      </div>
      {list.error && <ErrorState message={list.error} retry={list.reload} />}
      <div className="bg-surface border border-line rounded-card overflow-auto">
        {!list.data ? <Skeleton className="h-40 m-4" /> : list.data.length === 0 ? <EmptyState title="No materials" body="The master list is empty." /> : (
          <table className="w-full text-[13px] min-w-[860px]">
            <thead className="bg-bg"><tr className="text-left">
              {['Code', 'Name', 'Hindi name', 'Unit', 'Category', 'Usual most per job', 'Status', ...(admin ? [''] : [])].map((h, i) => <th key={h + i} className="label px-4 py-3">{h}</th>)}
            </tr></thead>
            <tbody>{list.data.map((m) => (
              <tr key={m.id} className={'border-t border-line h-[52px] ' + (m.active ? '' : 'text-ink-muted')}>
                <td className="px-4 font-semibold tnum">{m.code}</td>
                <td className="px-4">{m.name_en}</td>
                <td className="px-4">{m.name_hi}</td>
                <td className="px-4">{m.unit}</td>
                <td className="px-4">{m.category || '—'}</td>
                <td className="px-4 tnum">{qty(m.norm_max_per_job)}</td>
                <td className="px-4"><StatusChip tone={m.active ? 'ok' : 'neutral'}>{m.active ? 'Active' : 'Inactive'}</StatusChip></td>
                {admin && <td className="px-4 whitespace-nowrap">
                  <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => open('edit', m)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => open('toggle', m)}>{m.active ? 'Deactivate' : 'Reactivate'}</Button>
                </td>}
              </tr>))}</tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-ink-muted mt-2">A material is never deleted; an inactive one cannot be claimed. Only the HQ System Administrator changes this list, and every change is logged with its reason.</p>
      <Dialog open={!!dlg} title={title} onClose={() => setDlg(null)} actions={<>
        <Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button>
        <Button loading={busy} disabled={!valid} onClick={save}>{dlg?.mode === 'add' ? 'Add material' : dlg?.mode === 'edit' ? 'Save change' : dlg?.m?.active ? 'Deactivate' : 'Reactivate'}</Button>
      </>}>
        <div className="grid gap-3">
          {dlg?.mode !== 'toggle' && (<>
            <Field label="Code" required={dlg?.mode === 'add'} help={dlg?.mode === 'edit' ? 'The code cannot be changed' : 'e.g. CEM-OPC43'}>
              <input className={inputCls} value={d.code} onChange={set('code')} disabled={dlg?.mode === 'edit'} />
            </Field>
            <Field label="Name" required><input className={inputCls} value={d.name_en} onChange={set('name_en')} /></Field>
            <Field label="Hindi name" required><input className={inputCls} lang="hi" value={d.name_hi} onChange={set('name_hi')} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Unit" required><input className={inputCls} list="mat-units" value={d.unit} onChange={set('unit')} /></Field>
              <Field label="Category"><input className={inputCls} list="mat-cats" value={d.category} onChange={set('category')} /></Field>
            </div>
            <Field label="Usual most per job" help="Above this on one job, the report flags it. Leave blank for none.">
              <input className={inputCls + ' tnum'} inputMode="decimal" value={d.norm} onChange={(e) => setD({ ...d, norm: numOnly(e.target.value) })} />
            </Field>
          </>)}
          {dlg?.mode !== 'add' && (
            <Field label="Reason" required help="Kept in the record">
              <input className={inputCls} value={d.reason} onChange={set('reason')} />
            </Field>
          )}
          {err && <ErrorState message={err} />}
        </div>
      </Dialog>
    </>
  );
}
