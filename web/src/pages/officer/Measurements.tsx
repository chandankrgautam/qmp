import { Fragment, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, BookOpen, Download, History as HistoryIcon, Printer, Ruler } from 'lucide-react';
import { Button, Card, Dialog, EmptyState, ErrorState, Field, KpiTile, SectionLabel, Segmented, Skeleton, StatusChip, inputCls, useToast } from '../../components/ui';
import { PageHeader } from '../../components/shell/Shells';
import { ApiError, api, session } from '../../lib/api';
import { shortDate, when } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import TicketPanel from './TicketPanel';
import { SheetChain } from '../../components/SheetChain';

/* Measurement book (phase 5): after the work is accepted Civil measures each
   job-card item, the entries are written into the department's paper MB, and
   the Area Civil Staff Officer check-measures a share of them. Quantities
   only; no rate, price or amount exists anywhere (control 9). The database
   enforces every rule here; the screens only follow. */

const qty = (v: any) => (v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 }));
const numOnly = (v: string) => v.replace(/[^0-9.]/g, '');
// Assumption: the panel is not told the tolerance, so it uses the default 5%
// (maint_config check_measure_tolerance_percent). The MB page uses the server's
// own `flagged`, which follows whatever the setting is.
const PANEL_TOLERANCE = 5;
const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404;
const EVENT: Record<string, string> = {
  MEASURED: 'Measured', REMEASURED: 'Measured again', MB_RECORDED: 'Written in the MB',
  CHECK_MEASURED: 'Check-measured', CHECK_REVISED: 'Check revised'
};

// "Nos × L × B × D = Qty unit", only the dimensions that were given
function formula(m: any, unit: string) {
  const parts = [m.nos, m.length, m.breadth, m.depth].filter((x) => x != null).map(qty);
  return parts.length > 1 || (parts.length === 1 && m.nos == null)
    ? `${parts.join(' × ')} = ${qty(m.qty)} ${unit}` : `${qty(m.qty)} ${unit}`;
}
const mbRef = (m: { mb_no?: string | null; mb_page?: string | null }) => `MB ${m.mb_no} · p. ${m.mb_page}`;
const varianceText = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`);

/* ------------------------------------------------------------ one dialog for measure, re-measure and check */
type Mode = { kind: 'measure' | 'remeasure' | 'check'; ticketId?: string; itemId?: string; m?: any; unit: string; title: string; always?: boolean };

function MeasureDialog({ mode, onClose, onDone }: { mode: Mode | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const m = mode?.m;
  const [d, setD] = useState({ nos: '', length: '', breadth: '', depth: '', qty: '', remark: '', reason: '', check: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // the dialog is mounted once per page; reset its fields each time it opens
  const [seen, setSeen] = useState<Mode | null>(null);
  if (mode !== seen) {
    setSeen(mode); setErr(null);
    setD({ nos: m?.nos != null && mode?.kind !== 'check' ? String(m.nos) : '', length: m?.length != null && mode?.kind !== 'check' ? String(m.length) : '',
      breadth: m?.breadth != null && mode?.kind !== 'check' ? String(m.breadth) : '', depth: m?.depth != null && mode?.kind !== 'check' ? String(m.depth) : '',
      qty: m?.qty != null && mode?.kind !== 'check' ? String(m.qty) : '', remark: mode?.kind === 'check' ? '' : (m?.remark || ''), reason: '',
      check: mode?.kind === 'check' && m?.check_qty != null ? String(m.check_qty) : '' });
  }
  if (!mode) return <Dialog open={false} title="" onClose={onClose}>{null}</Dialog>;
  const set = (k: keyof typeof d) => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: numOnly(e.target.value) });
  const dims = [d.length, d.breadth, d.depth].some((x) => x !== '');
  const product = Math.round((Number(d.nos || 1) * Number(d.length || 1) * Number(d.breadth || 1) * Number(d.depth || 1)) * 1000) / 1000;
  const positive = (v: string) => v === '' || Number(v) > 0;
  const rechecking = mode.kind === 'check' && m?.check_qty != null;
  // after the MB approval the Staff Officer gives a reason for every correction
  const needReason = mode.kind === 'remeasure' || rechecking || !!mode.always;
  const valid = mode.kind === 'check'
    ? d.check !== '' && !isNaN(Number(d.check)) && (!rechecking || !!d.reason.trim())
    : positive(d.nos) && positive(d.length) && positive(d.breadth) && positive(d.depth)
      && (dims || d.qty !== '' || d.nos !== '') && (!needReason || !!d.reason.trim());
  const num = (v: string) => (v === '' ? undefined : Number(v));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (mode.kind === 'check') {
        await api(`/measurements/${m.id}/check`, { body: { check_qty: Number(d.check), remark: d.remark.trim() || undefined, reason: d.reason.trim() || undefined } });
        toast({ text: rechecking ? 'Check revised' : 'Check recorded' });
      } else {
        const body = { nos: num(d.nos), length: num(d.length), breadth: num(d.breadth), depth: num(d.depth),
          qty: dims ? undefined : num(d.qty), remark: d.remark.trim() || undefined };
        if (mode.kind === 'measure') { await api(`/tickets/${mode.ticketId}/measurements`, { body: { item_id: mode.itemId, ...body, reason: d.reason.trim() || undefined } }); toast({ text: 'Measurement recorded' }); }
        else { await api(`/measurements/${m.id}`, { method: 'PUT', body: { ...body, reason: d.reason.trim() } }); toast({ text: 'Measurement changed' }); }
      }
      onClose(); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Dialog open title={mode.title} onClose={onClose} actions={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button loading={busy} disabled={!valid} onClick={save}>{mode.kind === 'measure' ? 'Record measurement' : mode.kind === 'remeasure' ? 'Save measurement' : rechecking ? 'Save revised check' : 'Record check'}</Button>
    </>}>
    <div className="grid gap-3">
      {mode.kind === 'check' ? (<>
        <div className="text-[13px] text-ink-muted">Measured <b className="tnum text-ink">{qty(m.qty)} {mode.unit}</b>{mode.unit.endsWith('.') ? '' : '.'} Your check cannot be on your own measurement.</div>
        <Field label={`Check quantity (${mode.unit})`} required><input className={inputCls + ' tnum'} inputMode="decimal" value={d.check} onChange={set('check')} /></Field>
        <Field label="Remark (optional)"><input className={inputCls} value={d.remark} onChange={(e) => setD({ ...d, remark: e.target.value })} /></Field>
      </>) : (<>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nos"><input className={inputCls + ' tnum'} inputMode="decimal" value={d.nos} onChange={set('nos')} /></Field>
          <Field label="Length"><input className={inputCls + ' tnum'} inputMode="decimal" value={d.length} onChange={set('length')} /></Field>
          <Field label="Breadth"><input className={inputCls + ' tnum'} inputMode="decimal" value={d.breadth} onChange={set('breadth')} /></Field>
          <Field label="Depth / height"><input className={inputCls + ' tnum'} inputMode="decimal" value={d.depth} onChange={set('depth')} /></Field>
        </div>
        <Field label={`Quantity (${mode.unit})`} help={dims ? 'Worked out from the dimensions, as the database will record it' : 'Give the dimensions, or the quantity directly'}>
          <input className={inputCls + ' tnum'} inputMode="decimal" disabled={dims} value={dims ? String(product) : d.qty} onChange={set('qty')} />
        </Field>
        <Field label="Remark (optional)"><input className={inputCls} value={d.remark} onChange={(e) => setD({ ...d, remark: e.target.value })} /></Field>
      </>)}
      {needReason && (
        <Field label={mode.kind === 'check' ? 'Reason for revising the check' : mode.kind === 'measure' ? 'Reason for the correction' : 'Reason for measuring again'} required help="Kept in the record">
          <input className={inputCls} value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} />
        </Field>
      )}
      {err && <ErrorState message={err} />}
    </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------ the complaint panel: officers and the supervisor */
/* Since 2026-10-16 the measurements are the supervisor's own sheet first, then
   go up the chain (Overseer, Incharge, Staff Officer); each measures again at
   their own step, with a reason. The server says who may measure now. */
export function MeasurementsSection({ ticketId }: { ticketId: string }) {
  const r = useLoad(() => api<any>(`/tickets/${ticketId}/measurements`).catch((e) => {
    if (isNotFound(e)) return null;
    throw e;
  }), [ticketId]);
  const sh = useLoad(() => api<any>(`/tickets/${ticketId}/sheets`).catch(() => null), [ticketId]);
  const [hist, setHist] = useState(false);
  const [book, setBook] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const supervisor = session.get()?.role === 'CONTRACTOR_SUPERVISOR';
  const reload = () => { r.reload(); sh.reload(); };
  if (r.error) return <><SectionLabel className="mt-6 mb-3">Measurements</SectionLabel><ErrorState message={r.error} retry={r.reload} /></>;
  if (r.data === null && !r.loading) return null;
  if (!r.data) return <Skeleton className="h-24 mt-6" />;
  const { items, can_measure, can_check, stage, reason_needed } = r.data as { items: any[]; can_measure: boolean; can_check: boolean; stage: string; reason_needed: boolean };
  const always = stage === 'APPROVED';
  return (
    <>
      <div className="flex items-center justify-between mt-6 mb-3">
        <SectionLabel>{supervisor ? 'My measurement sheet' : 'Measurements'}</SectionLabel>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" icon={<BookOpen size={16} />} onClick={() => setBook(!book)}>{book ? 'Hide MB record' : 'MB record'}</Button>
          {!supervisor && <Button size="sm" variant="ghost" icon={<HistoryIcon size={16} />} onClick={() => setHist(!hist)}>{hist ? 'Hide changes' : 'Changes'}</Button>}
        </div>
      </div>
      <Card className="p-4">
        <SheetChain sheet={sh.data?.measurements} ticketId={ticketId} kind="measurements" onMoved={reload} />
        {items.length === 0 && <div className="text-sm text-ink-muted">The job card has no work items to measure.</div>}
        <ol className="flex flex-col gap-3">
          {items.map((i) => {
            const m = i.measurement;
            const checked = m && m.check_qty != null;
            const flagged = checked && m.variance_percent != null && Math.abs(m.variance_percent) > PANEL_TOLERANCE;
            return (
              <li key={i.item_id} className="text-[13px]">
                <div className="flex items-start gap-2">
                  <span className="tnum w-6 shrink-0">{i.seq}.</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{i.description}</div>
                    <div className="text-xs text-ink-muted tnum">Estimated {qty(i.qty_estimated)} {i.unit}</div>
                    {m ? (
                      <div className="mt-0.5">
                        <div className="tnum"><b>{formula(m, i.unit)}</b>{m.remark && <span className="text-ink-muted"> · “{m.remark}”</span>}</div>
                        <div className="text-xs text-ink-muted tnum">{m.last_by_role && m.last_at && m.last_at !== m.measured_at
                          ? <>Last measured by {ROLE_NAME[m.last_by_role] || m.last_by_role}{m.last_by_name ? ` (${m.last_by_name})` : ''} · {when(m.last_at)}</>
                          : <>{m.measured_by_name || '—'} · {when(m.measured_at)}</>}</div>
                        {m.mb_no && <div className="mt-1"><StatusChip tone="ok">{mbRef(m)}</StatusChip></div>}
                        {checked && (
                          <div className={'text-xs tnum mt-1 flex items-center gap-1 ' + (flagged ? 'text-bad font-semibold' : '')}>
                            {flagged && <AlertTriangle size={13} />}
                            Check {qty(m.check_qty)} {i.unit} · {m.checked_by_name || '—'} · variance {varianceText(m.variance_percent)}
                            {flagged && <> — more than {PANEL_TOLERANCE}% apart</>}
                          </div>
                        )}
                      </div>
                    ) : <div className="text-xs text-ink-muted mt-0.5">Not measured</div>}
                  </div>
                  <div className="flex flex-col items-end">
                    {can_measure && !m && (
                      <button className="text-primary text-xs font-semibold min-h-11 px-1"
                        onClick={() => setMode({ kind: 'measure', ticketId, itemId: i.item_id, unit: i.unit, title: `Measure item ${i.seq}`, always })}>Measure</button>)}
                    {can_measure && m && (
                      <button className="text-primary text-xs font-semibold min-h-11 px-1"
                        onClick={() => setMode({ kind: 'remeasure', m, unit: i.unit, title: reason_needed ? `Change the measurement of item ${i.seq}` : `Measure item ${i.seq} again` })}>{reason_needed ? 'Change' : 'Re-measure'}</button>)}
                    {can_check && m && (
                      <button className="text-primary text-xs font-semibold min-h-11 px-1"
                        onClick={() => setMode({ kind: 'check', m, unit: i.unit, title: `Check-measure item ${i.seq}` })}>{checked ? 'Revise check' : 'Check'}</button>)}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        {!can_measure && stage === 'SUPERVISOR' && items.some((i) => !i.measurement) && (
          <div className="text-xs text-ink-muted mt-3">{supervisor ? 'You measure against the job card once the Overseer has accepted the work.' : 'The supervisor measures first, once the work is accepted, and sends the sheet for review.'}</div>)}
        <div className="text-xs text-ink-muted mt-3">Quantities only; no rates are recorded. Every measurement and every change takes its own line of the MB record; nothing is rewritten.</div>
      </Card>
      {book && <MbLines ticketId={ticketId} />}
      {hist && <MeasurementsHistory ticketId={ticketId} />}
      <MeasureDialog mode={mode} onClose={() => setMode(null)} onDone={reload} />
    </>
  );
}

function MeasurementsHistory({ ticketId }: { ticketId: string }) {
  const h = useLoad(() => api<any[]>(`/tickets/${ticketId}/measurements/history`), [ticketId]);
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
            {(l.event_type === 'MEASURED' || l.event_type === 'REMEASURED') && a.qty != null && (
              <div className="text-xs mt-1 tnum">{b.qty != null && <><s className="text-ink-muted">{qty(b.qty)}</s> → </>}<b>{qty(a.qty)}</b></div>)}
            {l.event_type === 'MB_RECORDED' && a.mb_no && <div className="text-xs mt-1 tnum">{mbRef(a)}</div>}
            {(l.event_type === 'CHECK_MEASURED' || l.event_type === 'CHECK_REVISED') && a.check_qty != null && (
              <div className="text-xs mt-1 tnum">{b.check_qty != null && <><s className="text-ink-muted">{qty(b.check_qty)}</s> → </>}<b>{qty(a.check_qty)}</b></div>)}
            {l.reason && <div className="mt-1">“{l.reason}”</div>}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------ contractor: read-only, on the phone job page */
export function ContractorMeasurements({ ticketId }: { ticketId: string }) {
  const r = useLoad(() => api<any>(`/tickets/${ticketId}/measurements`).catch((e) => {
    // the contractor simply sees nothing where there is nothing to show
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }), [ticketId]);
  if (r.error || !r.data) return null;
  const done = (r.data.items as any[]).filter((i) => i.measurement);
  if (done.length === 0) return null;
  return (
    <>
      <SectionLabel className="mt-6 mb-3">Measured by Civil</SectionLabel>
      <Card className="p-4">
        <ol className="flex flex-col gap-3">
          {done.map((i) => (
            <li key={i.item_id} className="text-[13px] flex items-start gap-2">
              <span className="tnum w-6 shrink-0">{i.seq}.</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium">{i.description}</div>
                <div className="tnum">{qty(i.measurement.qty)} {i.unit}</div>
                {i.measurement.mb_no && <div className="mt-0.5"><StatusChip tone="ok">{mbRef(i.measurement)}</StatusChip></div>}
              </div>
            </li>
          ))}
        </ol>
        <div className="text-xs text-ink-muted mt-3">Quantities only; no rates are recorded.</div>
      </Card>
    </>
  );
}

/* ------------------------------------------------------------ the MB reference record (2026-10-16) */
/* The paper Measurement Book stays official; the portal keeps the record it
   is copied from: one MB number per contract, every version of a measurement
   on its own line, 25 lines to a page, a revision appended and the old line
   kept, struck through. Officers see who; the contractor the role. */
const ROLE_NAME: Record<string, string> = {
  CONTRACTOR_SUPERVISOR: 'Supervisor', CIVIL_OVERSEER: 'Civil Overseer', MAINTENANCE_INCHARGE: 'Civil Colony Incharge',
  STAFF_OFFICER_CIVIL: 'Area Civil Staff Officer', SYSTEM: 'System'
};
const STAGE_NAME: Record<string, string> = {
  SUPERVISOR: 'With the supervisor', OVERSEER: 'With the Overseer', INCHARGE: 'With the Incharge', STAFF_OFFICER: 'With the Staff Officer'
};
const lineDims = (l: any) => {
  const parts = [l.nos, l.length, l.breadth, l.depth].filter((x) => x != null).map(qty);
  return parts.length > 1 ? `${parts.join(' × ')} = ` : '';
};

function MbLineRow({ l, job, mark }: { l: any; job?: boolean; mark?: boolean }) {
  const item = <>{l.item_seq}. {l.description}</>;
  const amount = <>{lineDims(l)}{qty(l.qty)}</>;
  return (
    <tr className={'border-t border-line align-top ' + (l.superseded ? 'text-ink-muted' : '') + (mark ? ' bg-tint' : '')}>
      <td className="py-1.5 pr-2 tnum">{l.page}</td>
      <td className="py-1.5 pr-2 tnum">{l.line_no}</td>
      {!job && <td className="py-1.5 pr-2 tnum whitespace-nowrap">{l.ticket_no}</td>}
      <td className="py-1.5 pr-2">{l.superseded ? <s>{item}</s> : item}
        {l.correction && <span className="ml-1 text-bad font-semibold">· correction after approval</span>}
        {l.reason && <div className="text-xs">“{l.reason}”</div>}</td>
      <td className="py-1.5 pr-2 tnum whitespace-nowrap">{l.superseded ? <s>{amount}</s> : <b>{amount}</b>} {l.unit}</td>
      <td className="py-1.5 text-xs">{ROLE_NAME[l.by_role] || l.by_role}{l.by_name ? ` (${l.by_name})` : ''}<div className="text-ink-muted">{when(l.at)}</div></td>
    </tr>
  );
}

const HEAD = (job?: boolean) => (
  <thead><tr className="text-left text-xs text-ink-muted">
    <th className="pr-2 font-medium">Page</th><th className="pr-2 font-medium">Line</th>{!job && <th className="pr-2 font-medium">Complaint</th>}
    <th className="pr-2 font-medium">Item</th><th className="pr-2 font-medium">Quantity</th><th className="font-medium">By</th>
  </tr></thead>
);

/* one job's lines, in the complaint panel */
export function MbLines({ ticketId }: { ticketId: string }) {
  const r = useLoad(() => api<any>(`/tickets/${ticketId}/mb`), [ticketId]);
  const officer = !['CONTRACTOR', 'CONTRACTOR_SUPERVISOR'].includes(session.get()?.role || '');
  if (r.error) return <ErrorState message={r.error} />;
  if (!r.data) return <Skeleton className="h-20 mt-3" />;
  const d = r.data;
  const pages = [...new Set(d.lines.map((l: any) => l.page))].join(', ');
  return (
    <Card className="p-4 mt-3">
      <div className="flex flex-wrap justify-between gap-2 text-[13px]">
        <span className="font-semibold">{d.mb_no || 'No MB yet'}{d.lines.length > 0 && ` · page ${pages}`}</span>
        {officer && d.contract_id && d.mb_no && <Link className="text-primary text-xs font-semibold" to={`/w/mb/book/${d.contract_id}`}>The contract's whole MB</Link>}
      </div>
      {d.lines.length === 0 ? <div className="text-sm text-ink-muted mt-2">Nothing measured yet. The first measurement opens the contract's MB.</div> : (
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-[13px]">{HEAD(true)}<tbody>{d.lines.map((l: any) => <MbLineRow key={l.line_no} l={l} job />)}</tbody></table>
        </div>
      )}
      <div className="text-xs text-ink-muted mt-2">The reference record for the paper MB. A struck line was measured again; the later line stands.</div>
    </Card>
  );
}

/* the contract's whole MB: the index of jobs, then the pages of 25 lines, as printed */
export function MbBook() {
  const { contractId } = useParams();
  const [qp, setQp] = useSearchParams();
  const page = Number(qp.get('page')) || 0;
  const month = qp.get('month') || '';
  const job = qp.get('job') || '';
  const r = useLoad(() => api<any>(`/contracts/${contractId}/mb${page ? `?page_from=${page}&page_to=${page}` : month ? `?month=${month}` : ''}`), [contractId, page, month]);
  if (r.error) return <ErrorState message={r.error} retry={r.reload} />;
  if (!r.data) return <Skeleton className="h-64" />;
  const d = r.data;
  const go = (p: Record<string, string>) => setQp(p);
  const shown = d.lines.length ? `${d.lines[0].page === d.lines.at(-1).page ? `page ${d.lines[0].page}` : `pages ${d.lines[0].page}–${d.lines.at(-1).page}`}` : 'no lines';
  const pages: Record<number, any[]> = {};
  for (const l of d.lines) (pages[l.page] ||= []).push(l);
  return (
    <div>
      <div className="print:hidden">
        <PageHeader title={`MB record ${d.mb_no}`}
          sub={`Opened ${shortDate(d.opened_at)} · ${d.pages} page${d.pages === 1 ? '' : 's'} of ${d.lines_per_page} lines · the reference for the paper Measurement Book`}
          action={<Button variant="secondary" icon={<Printer size={18} />} onClick={() => window.print()}>Print</Button>} />
      </div>
      <Card className="p-3 mb-4 print:hidden flex flex-wrap gap-3 items-end">
        <Field label="Month">
          <select className={inputCls} value={page ? '' : (month || d.months.at(-1)?.month || '')} onChange={(e) => go(e.target.value ? { month: e.target.value } : {})}>
            {page ? <option value="">—</option> : null}
            {[...d.months].reverse().map((m: any) => <option key={m.month} value={m.month}>{m.month} · {m.first_page === m.last_page ? `page ${m.first_page}` : `pages ${m.first_page}–${m.last_page}`} · {m.jobs} {m.jobs === 1 ? 'job' : 'jobs'}</option>)}
          </select>
        </Field>
        <Field label={`Go to page (of ${d.pages})`}>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const v = Number((e.currentTarget.elements.namedItem('p') as HTMLInputElement).value); if (v > 0) go({ page: String(Math.min(v, d.pages)) }); }}>
            <input name="p" className={inputCls + ' tnum w-24'} inputMode="numeric" defaultValue={page || ''} key={page} />
            <Button type="submit" size="sm" variant="secondary">Open</Button>
          </form>
        </Field>
        {page > 0 && <div className="flex gap-2">
          {page > 1 && <Button size="sm" variant="ghost" onClick={() => go({ page: String(page - 1) })}>‹ Page {page - 1}</Button>}
          {page < d.pages && <Button size="sm" variant="ghost" onClick={() => go({ page: String(page + 1) })}>Page {page + 1} ›</Button>}
        </div>}
        <div className="text-xs text-ink-muted ml-auto">Showing {shown}</div>
      </Card>
      <Card className="p-4 mb-4">
        <SectionLabel className="mb-2">Index of jobs — {shown}</SectionLabel>
        {d.jobs.length === 0 ? <div className="text-sm text-ink-muted">No entries yet.</div> : (
          <table className="w-full text-[13px]">
            <thead><tr className="text-left text-xs text-ink-muted"><th className="font-medium pr-2">Complaint</th><th className="font-medium pr-2">Pages</th><th className="font-medium">Measurements</th></tr></thead>
            <tbody>{d.jobs.map((j: any) => (
              <tr key={j.ticket_id} className="border-t border-line">
                <td className={'py-1.5 pr-2 tnum ' + (j.ticket_id === job ? 'font-bold text-primary' : '')}>{j.ticket_no}</td>
                <td className="py-1.5 pr-2 tnum">{j.pages.map((p: number, i: number) => <Fragment key={p}>{i > 0 && ', '}<a className="text-primary" href={`#mb-page-${p}`}>{p}</a></Fragment>)}</td>
                <td className="py-1.5">{j.stage === 'APPROVED' ? <StatusChip tone="ok">Approved {shortDate(j.approved_at)}</StatusChip> : <StatusChip tone="info">{STAGE_NAME[j.stage] || j.stage}</StatusChip>}</td>
              </tr>))}</tbody>
          </table>
        )}
      </Card>
      {Object.keys(pages).map(Number).sort((a, b) => a - b).map((p) => (
        <Card key={p} className="p-4 mb-4 break-after-page">
          <div id={`mb-page-${p}`} className="flex justify-between text-[13px] mb-2"><b>{d.mb_no}</b><span className="tnum">Page {p}</span></div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">{HEAD()}<tbody>{pages[p].map((l) => <MbLineRow key={l.line_no} l={l} mark={l.ticket_id === job} />)}</tbody></table>
          </div>
        </Card>
      ))}
      <div className="text-xs text-ink-muted">Quantities only; no rates are recorded. A struck line was measured again; the later line stands.</div>
    </div>
  );
}

/* ------------------------------------------------------------ the page */
export type Tab = 'extract' | 'check';
type Status = 'all' | 'unrecorded' | 'recorded';
type F = { contract: string; from: string; to: string; status: Status };

const qs = (f: F) => {
  const p = new URLSearchParams();
  if (f.contract) p.set('contract_id', f.contract);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  p.set('status', f.status);
  return `?${p.toString()}`;
};

/* the extract and check-measurement tabs of the Measurement book page */
export function MbExtract({ tab }: { tab: Tab }) {
  const role = session.get()?.role;
  const canRecord = role === 'CIVIL_OVERSEER' || role === 'MAINTENANCE_INCHARGE';
  const canCheck = role === 'STAFF_OFFICER_CIVIL';
  const toast = useToast();
  const [f, setF] = useState<F>({ contract: '', from: '', to: '', status: 'all' });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [rec, setRec] = useState(false);
  const [mbNo, setMbNo] = useState(''); const [mbPage, setMbPage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const cs = useLoad(() => api<any[]>('/contracts'));
  const r = useLoad(() => api<any>(`/mb/extract${qs(f)}`), [f.contract, f.from, f.to, f.status]);
  const d = r.data;
  const entries: any[] = d ? d.jobs.flatMap((j: any) => j.entries.map((e: any) => ({ ...e, job: j }))) : [];
  const unrecorded = entries.filter((e) => !e.mb_no);
  const toggle = (id: string) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n); };

  const download = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/maintenance/v1/mb/extract.csv${qs(f)}`, { headers: { authorization: `Bearer ${session.get()?.token}` } });
      if (!res.ok) { toast({ text: 'Export failed. Try again.', tone: 'bad' }); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = `mb-extract${f.from ? '-' + f.from : ''}${f.to ? '-to-' + f.to : ''}.csv`;
      a.click();
      toast({ text: 'MB extract downloaded' });
    } catch { toast({ text: 'Export failed. Try again.', tone: 'bad' }); } finally { setBusy(false); }
  };
  const record = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await api<{ recorded: number }>('/mb/record', { body: { measurement_ids: [...sel], mb_no: mbNo.trim(), mb_page: mbPage.trim() } });
      toast({ text: `${res.recorded} ${res.recorded === 1 ? 'entry' : 'entries'} written in the MB` });
      setRec(false); setSel(new Set()); setMbNo(''); setMbPage(''); r.reload();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const checkOf = (e: any) => setMode({ kind: 'check', m: { id: e.id, qty: e.qty, check_qty: e.check_qty }, unit: e.unit, title: `Check-measure ${e.job.ticket_no} · item ${e.seq}` });

  return (
    <>
      <div className="print:hidden">
        <div className="flex flex-wrap gap-3 items-end mb-4">
          <div className="min-w-[240px]">
            <Field label="Contract">
              <select className={inputCls} value={f.contract} onChange={(e) => setF({ ...f, contract: e.target.value })}>
                <option value="">All contracts</option>
                {(cs.data || []).map((c) => <option key={c.id} value={c.id}>{c.contractor_name}{c.agreement_no ? ` · ${c.agreement_no}` : ''}</option>)}
              </select>
            </Field>
          </div>
          <Field label="From"><input type="date" className={inputCls} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="To"><input type="date" className={inputCls} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Segmented<Status> value={f.status} onChange={(status) => setF({ ...f, status })}
            options={[{ value: 'all', label: 'All' }, { value: 'unrecorded', label: 'Not in MB' }, { value: 'recorded', label: 'In MB' }]} />
        </div>
        {cs.error && <div className="mb-3"><ErrorState message={cs.error} retry={cs.reload} /></div>}
        {r.error && <ErrorState message={r.error} retry={r.reload} />}
        {!d && !r.error && <Skeleton className="h-40" />}
        {d && (
          <>
            <div className="grid grid-cols-2 xl:grid-cols-5 gap-3 mb-4">
              <KpiTile label="Entries" value={d.summary.entries} />
              <KpiTile label="Written in MB" value={d.summary.recorded} tone="ok" />
              <KpiTile label="Not yet in MB" value={d.summary.unrecorded} tone={d.summary.unrecorded ? 'risk' : 'neutral'} />
              <KpiTile label="Checked" value={d.summary.checked}
                caption={<Meter value={d.summary.check_percent} target={d.summary.target_percent} />} />
              <KpiTile label="Flagged" value={d.summary.flagged} tone={d.summary.flagged ? 'bad' : 'neutral'} valueTone={d.summary.flagged ? 'bad' : undefined}
                caption={`Check differs by more than ${d.summary.tolerance_percent}%`} />
            </div>

            {tab === 'extract' && (
              <>
                <div className="flex flex-wrap gap-2 items-center justify-end mb-3">
                  {canRecord && unrecorded.length > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setSel(sel.size === unrecorded.length ? new Set() : new Set(unrecorded.map((e) => e.id)))}>
                      {sel.size === unrecorded.length ? 'Clear selection' : 'Select all not in MB'}</Button>)}
                  {canRecord && <Button size="sm" icon={<BookOpen size={16} />} disabled={sel.size === 0} onClick={() => { setErr(null); setRec(true); }}>Record in MB{sel.size ? ` (${sel.size})` : ''}</Button>}
                  <Button size="sm" variant="secondary" icon={<Download size={16} />} loading={busy} onClick={download}>Download CSV</Button>
                  <Button size="sm" variant="secondary" icon={<Printer size={16} />} onClick={() => window.print()}>Print</Button>
                </div>
                {d.jobs.length === 0
                  ? <Card><EmptyState title="No measurements" body="Nothing was measured in this period for this contract." /></Card>
                  : d.jobs.map((j: any) => (
                    <section key={j.ticket_id} className="mb-5">
                      <button className="text-left mb-1.5 w-full" onClick={() => setOpen(j.ticket_id)}>
                        <span className="font-semibold tnum text-primary">{j.ticket_no}</span>
                        <span className="text-[13px] text-ink-muted"> · {j.jc_no} · {j.identifier} · {j.sub_category}{j.closed_at ? ` · closed ${shortDate(j.closed_at)}` : ''}</span>
                      </button>
                      <div className="bg-surface border border-line rounded-card overflow-auto">
                        <table className="w-full text-[13px] min-w-[860px]">
                          <thead className="bg-bg"><tr className="text-left">
                            {canRecord && <th className="px-3 py-3 w-10" />}
                            {['Item', 'Description', 'Nos', 'L', 'B', 'D/H', 'Qty', 'Unit', 'MB ref', 'Check'].map((h, i) => <th key={h} className={'label px-3 py-3 ' + (i >= 2 && i <= 6 ? 'text-right' : '')}>{h}</th>)}
                          </tr></thead>
                          <tbody>{j.entries.map((e: any) => (
                            <tr key={e.id} className="border-t border-line min-h-[44px]">
                              {canRecord && <td className="px-3">{!e.mb_no && <input type="checkbox" className="w-4 h-4" aria-label={`Select item ${e.seq}`} checked={sel.has(e.id)} onChange={() => toggle(e.id)} />}</td>}
                              <td className="px-3 tnum">{e.seq}</td>
                              <td className="px-3 py-2">{e.description}</td>
                              {[e.nos, e.length, e.breadth, e.depth].map((v, k) => <td key={k} className="px-3 tnum text-right">{qty(v)}</td>)}
                              <td className="px-3 tnum text-right font-semibold">{qty(e.qty)}</td>
                              <td className="px-3">{e.unit}</td>
                              <td className="px-3 tnum whitespace-nowrap">{e.mb_no ? mbRef(e) : <span className="text-ink-muted">Not in MB</span>}</td>
                              <td className="px-3 tnum whitespace-nowrap"><CheckCell e={e} /></td>
                            </tr>))}</tbody>
                        </table>
                      </div>
                    </section>))}
              </>
            )}

            {tab === 'check' && (
              <>
                <Card className="p-4 mb-4">
                  <div className="font-semibold mb-1">Check-measurement coverage</div>
                  <Meter value={d.summary.check_percent} target={d.summary.target_percent} wide />
                  <div className="text-xs text-ink-muted mt-2 tnum">{d.summary.checked} of {d.summary.entries} entries checked
                    ({qty(d.summary.check_percent)}%); the aim is {d.summary.target_percent}%. A check is flagged when it differs from the measurement by more than {d.summary.tolerance_percent}%.</div>
                </Card>
                <CheckList title="Flagged variances" rows={entries.filter((e) => e.flagged)} empty="No check differs beyond the tolerance." canCheck={canCheck} onCheck={checkOf} onOpen={setOpen} />
                <CheckList title="Not yet checked" rows={entries.filter((e) => e.check_qty == null)} empty="Every entry in this period has been checked." canCheck={canCheck} onCheck={checkOf} onOpen={setOpen} />
              </>
            )}
            <p className="text-xs text-ink-muted mt-2">The approval chain governs each entry; a change takes a new line of the MB record. The portal prepares no bill.</p>
          </>
        )}
      </div>

      {d && <PrintSheet d={d} f={f} />}

      <Dialog open={rec} title="Record in MB" onClose={() => setRec(false)} actions={<>
        <Button variant="secondary" onClick={() => setRec(false)}>Cancel</Button>
        <Button loading={busy} disabled={!mbNo.trim() || !mbPage.trim()} onClick={record}>Record {sel.size} {sel.size === 1 ? 'entry' : 'entries'}</Button>
      </>}>
        <div className="grid gap-3">
          <p className="text-[13px] text-ink-muted">Enter where these {sel.size} {sel.size === 1 ? 'entry was' : 'entries were'} written in the Measurement Book. The reference is noted against them; the MB record keeps every version.</p>
          <Field label="MB number" required><input className={inputCls} value={mbNo} onChange={(e) => setMbNo(e.target.value)} /></Field>
          <Field label="Page" required><input className={inputCls} value={mbPage} onChange={(e) => setMbPage(e.target.value)} /></Field>
          {err && <ErrorState message={err} />}
        </div>
      </Dialog>
      <MeasureDialog mode={mode} onClose={() => setMode(null)} onDone={r.reload} />
      {open && <TicketPanel id={open} onClose={() => setOpen(null)} onChanged={r.reload} />}
    </>
  );
}

export default MbExtract;

function CheckCell({ e }: { e: any }) {
  if (e.check_qty == null) return <span className="text-ink-muted">Not checked</span>;
  return (
    <span className={'inline-flex items-center gap-1 ' + (e.flagged ? 'text-bad font-semibold' : '')}>
      {e.flagged && <AlertTriangle size={13} />}{qty(e.check_qty)} · {varianceText(e.variance_percent)}
    </span>
  );
}

/* A bar for the share checked, with the target marked on it. */
function Meter({ value, target, wide }: { value: number; target: number; wide?: boolean }) {
  const ok = value >= target;
  return (
    <div className={wide ? 'w-full' : 'w-full min-w-[96px]'} title={`${qty(value)}% checked, aim ${target}%`}>
      <div className="relative h-2 rounded-full bg-muted overflow-visible">
        <div className={'h-2 rounded-full ' + (ok ? 'bg-ok' : 'bg-risk')} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
        <div className="absolute -top-1 h-4 w-0.5 bg-ink" style={{ left: `${Math.min(100, target)}%` }} aria-hidden />
      </div>
      <div className="text-xs mt-1 tnum">{qty(value)}% of {target}% aim</div>
    </div>
  );
}

function CheckList({ title, rows, empty, canCheck, onCheck, onOpen }:
  { title: string; rows: any[]; empty: string; canCheck: boolean; onCheck: (e: any) => void; onOpen: (id: string) => void }) {
  return (
    <section className="mb-5">
      <div className="flex items-baseline gap-2 mb-2"><SectionLabel>{title}</SectionLabel><span className="text-xs text-ink-muted tnum">{rows.length}</span></div>
      <div className="bg-surface border border-line rounded-card overflow-auto">
        {rows.length === 0 ? <EmptyState title="Nothing here" body={empty} /> : (
          <table className="w-full text-[13px] min-w-[760px]">
            <thead className="bg-bg"><tr className="text-left">
              {['Complaint', 'Item', 'Description', 'Measured', 'Check', ...(canCheck ? [''] : [])].map((h, i) => <th key={h + i} className="label px-4 py-3">{h}</th>)}
            </tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id} className="border-t border-line h-[52px]">
                <td className="px-4"><button className="font-semibold tnum text-primary" onClick={() => onOpen(e.job.ticket_id)}>{e.job.ticket_no}</button></td>
                <td className="px-4 tnum">{e.seq}</td>
                <td className="px-4">{e.description}</td>
                <td className="px-4 tnum">{qty(e.qty)} {e.unit}</td>
                <td className="px-4 tnum"><CheckCell e={e} /></td>
                {canCheck && <td className="px-4"><Button size="sm" variant="ghost" icon={<Ruler size={14} />} onClick={() => onCheck(e)}>{e.check_qty == null ? 'Check' : 'Revise check'}</Button></td>}
              </tr>))}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ printable MB sheet (A4 landscape) */
function PrintSheet({ d, f }: { d: any; f: F }) {
  const rows = d.jobs.flatMap((j: any) => j.entries.map((e: any) => ({ ...e, job: j })));
  const period = d.period?.from || d.period?.to ? `${d.period.from ? shortDate(d.period.from) : 'start'} to ${d.period.to ? shortDate(d.period.to) : 'date'}` : 'All dates';
  return (
    <article className="hidden print:block print-sheet text-[11px] leading-snug">
      {/* the page is landscape only while this sheet is on screen, i.e. only for this page */}
      <style>{'@media print { @page { size: A4 landscape; margin: 12mm; } }'}</style>
      <div className="flex justify-between items-start border-b-2 border-ink pb-2">
        <div><div className="font-bold text-sm">Northern Coalfields Limited</div><div>Civil Department — Colony Maintenance</div></div>
        <div className="text-right"><div className="font-bold text-sm">MEASUREMENT BOOK EXTRACT</div><div>{period}{f.status !== 'all' ? ` · ${f.status === 'recorded' ? 'written in MB' : 'not yet in MB'}` : ''}</div></div>
      </div>
      <div className="my-2">Contract: <b>{d.contract ? `${d.contract.firm_name}${d.contract.agreement_no ? ` · Agreement ${d.contract.agreement_no}` : ''}` : 'All contracts'}</b></div>
      <table className="w-full border-collapse">
        <thead><tr className="text-left border-y border-ink">
          {['Complaint', 'Item', 'Description', 'Nos', 'L', 'B', 'D/H', 'Qty', 'Unit', 'MB ref', 'Check'].map((h) => <th key={h} className="py-1 pr-2">{h}</th>)}
        </tr></thead>
        <tbody>{rows.map((e: any) => (
          <tr key={e.id} className="border-b border-line break-inside-avoid">
            <td className="py-1 pr-2 tnum whitespace-nowrap">{e.job.ticket_no}</td><td className="pr-2 tnum">{e.seq}</td><td className="pr-2">{e.description}</td>
            {[e.nos, e.length, e.breadth, e.depth].map((v, k) => <td key={k} className="pr-2 tnum">{v == null ? '' : qty(v)}</td>)}
            <td className="pr-2 tnum font-semibold">{qty(e.qty)}</td><td className="pr-2">{e.unit}</td>
            <td className="pr-2 tnum whitespace-nowrap">{e.mb_no ? mbRef(e) : ''}</td>
            <td className="tnum">{e.check_qty == null ? '' : `${qty(e.check_qty)} (${varianceText(e.variance_percent)})`}</td>
          </tr>))}
        </tbody>
      </table>
      <p className="mt-2">Quantities only; no rates are recorded.</p>
      <footer className="grid grid-cols-3 gap-8 mt-14 text-center">
        {['Measured by (Civil Overseer)', 'Check-measured by (Area Civil Staff Officer)', 'Contractor’s representative'].map((r) => <div key={r} className="border-t border-ink pt-1">{r}<br />Signature and date</div>)}
      </footer>
    </article>
  );
}
