import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download, Scale } from 'lucide-react';
import { Button, Card, Chip, Dialog, EmptyState, ErrorState, KpiTile, SectionLabel, Skeleton, SlaRing, StatusChip, useToast } from '../../components/ui';
import { PageHeader } from '../../components/shell/Shells';
import { api, session } from '../../lib/api';
import { areaFromScope } from '../../lib/domain';
import { num, pct, shortDate, when } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

/* Area dashboard (07) and contractor scorecard (08). Evidence only: no
   penalty, damages or bill anywhere (control 9) — the design's
   "Deductions due ₹" is deliberately left out. Every figure drills down
   to the complaints behind it. */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m: string) => { const d = new Date(m); return `${MON[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`; };
const grade = (sla: number | null) => sla === null ? null : sla >= 90 ? 'A' : sla >= 75 ? 'B' : 'C';
const GRADE_BG: Record<string, string> = { A: '#7FD3A6', B: '#E8C77A', C: '#F0A08F' };

function useContracts() {
  return useLoad(() => api<any[]>('/contracts'));
}

async function downloadCsv(id: string, name: string, toast: ReturnType<typeof useToast>) {
  // fetched with the token, so the export works (the old link sent none)
  const s = session.get();
  const r = await fetch(`/maintenance/v1/contracts/${id}/performance.csv`, { headers: { authorization: `Bearer ${s?.token}` } });
  if (!r.ok) { toast({ text: r.status === 404 ? 'No closed months to export yet' : 'Export failed. Try again.', tone: 'bad' }); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob());
  a.download = `performance-${name.replace(/\W+/g, '-')}.csv`;
  a.click();
  toast({ text: 'Performance report downloaded' });
}

/* ---------------------------------------------------------------- dashboard */
export function AreaDashboard() {
  const s = session.get()!;
  const nav = useNavigate();
  const toast = useToast();
  const cs = useContracts();
  const contract = cs.data?.find((c) => c.active) || cs.data?.[0];
  const perf = useLoad(() => contract ? api(`/contracts/${contract.id}/performance`) : Promise.resolve(null), [contract?.id]);
  const dash = useLoad(() => api('/dashboard'));
  const tickets = useLoad(() => api<{ items: any[] }>('/search?page_size=200'));
  const breaches = useLoad(() => api<{ items: any[] }>('/breaches?unattributed=true'));
  // materials and measurements waiting too long at one step of the approval chain (2026-10-16)
  const waiting = useLoad(() => api<any>('/sheets/waiting').catch(() => null));
  const area = areaFromScope(s.scope_path);
  const p = perf.data;
  const months = (p?.by_month || []).map((m: any) => ({ ...m, label: monthLabel(m.month), sla: m.sla_compliance_pct === null ? null : Number(m.sla_compliance_pct) }));
  const byCat = useMemo(() => {
    const g: Record<string, number> = {};
    for (const t of tickets.data?.items || []) g[t.category] = (g[t.category] || 0) + 1;
    return Object.entries(g).map(([k, v]) => ({ k: k.split(' ')[0].replace(/,$/, ''), v })).sort((a, b) => b.v - a.v);
  }, [tickets.data]);
  const openCount = dash.data?.cards?.find((c: any) => c.key === 'open_complaints')?.value
    ?? (tickets.data?.items || []).filter((t) => !['CLOSED', 'REJECTED'].includes(t.state)).length;

  return (
    <>
      <PageHeader title="Area dashboard" sub={`${area.name} · ${contract ? contract.contractor_name : 'no live contract'}`}
        action={contract && <Button icon={<Download size={18} />} onClick={() => downloadCsv(contract.id, contract.contractor_name, toast)}>Download report</Button>} />
      {(cs.error || perf.error) && <ErrorState message={(cs.error || perf.error)!} retry={() => { cs.reload(); perf.reload(); }} />}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {!p ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[118px]" />) : (<>
          <KpiTile label="SLA compliance" value={pct(p.overall.sla_compliance_pct)} tone="ok" valueTone="ok"
            caption="Contractor’s own time, all rounds" spark={months.map((m: any) => m.sla ?? 0)} onClick={() => nav('/w/search?missed_sla=true')} />
          <KpiTile label="Open complaints" value={num(openCount)} tone="risk" valueTone="risk" caption="Not yet closed"
            spark={months.map((m: any) => Number(m.tickets_open))} onClick={() => nav('/w/search?archived=open')} />
          <KpiTile label="Avg. closure" value={p.overall.avg_closure_hours === null ? '—' : `${num(p.overall.avg_closure_hours, 1)} h`} tone="info"
            caption="Verification to closure" spark={months.map((m: any) => Number(m.avg_closure_hours || 0))} />
          <KpiTile label="Reopen rate" value={pct(p.overall.reopen_rate_pct)} tone="reopen" valueTone="reopen" caption="Share of complaints reopened"
            spark={months.map((m: any) => Number(m.reopen_rate_pct || 0))} onClick={() => nav('/w/search?was_reopened=true')} />
        </>)}
      </div>

      {waiting.data?.items?.length > 0 && (
        <Card className="p-4 mt-4 border-bad/40 bg-bad-bg" onClick={() => nav('/w/mb')}>
          <div className="text-bad font-semibold text-[14px]">{waiting.data.items.length} {waiting.data.items.length === 1 ? 'sheet has' : 'sheets have'} waited over {waiting.data.wait_days} days at one step of the approval chain</div>
          <div className="text-[13px] mt-1">{Object.entries(waiting.data.by_stage as Record<string, number>).map(([k, v]) =>
            `${v} with the ${({ SUPERVISOR: 'supervisor', OVERSEER: 'Civil Overseer', INCHARGE: 'Civil Incharge', STAFF_OFFICER: 'Staff Officer' } as Record<string, string>)[k] || k}`).join(' · ')}
            <span className="text-ink-muted"> — open the Measurement book worklist</span></div>
        </Card>
      )}
      <div className="grid xl:grid-cols-[1.4fr_1fr] gap-4 mt-4">
        <Card className="p-5">
          <SectionLabel>SLA compliance by month</SectionLabel>
          <div className="h-60 mt-3">
            {months.length ? (
              <ResponsiveContainer><LineChart data={months} margin={{ left: -18, right: 8, top: 8 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                {/* from the data, but a percentage never runs past 0–100 */}
                <YAxis domain={[(lo: number) => Math.max(0, Math.floor(lo - 5)), (hi: number) => Math.min(100, Math.ceil(hi + 2))]} allowDecimals={false}
                  tick={{ fontSize: 12, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} unit="%" />
                <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' }} />
                <Line dataKey="sla" name="SLA %" stroke="var(--primary)" strokeWidth={2.5} dot={{ r: 4 }} />
              </LineChart></ResponsiveContainer>
            ) : <EmptyState title="No months yet" body="Figures appear once complaints are inspected." />}
          </div>
        </Card>
        <Card className="p-5">
          <SectionLabel>Complaints by category</SectionLabel>
          <div className="h-60 mt-3">
            {byCat.length ? (
              <ResponsiveContainer><BarChart data={byCat} layout="vertical" margin={{ left: 8, right: 16 }}>
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="k" width={84} tick={{ fontSize: 12, fill: 'var(--text)' }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'var(--tint)' }} contentStyle={{ borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' }} />
                <Bar dataKey="v" name="Complaints" fill="var(--primary)" radius={[0, 6, 6, 0]} barSize={16} />
              </BarChart></ResponsiveContainer>
            ) : <EmptyState title="No complaints yet" />}
          </div>
        </Card>
      </div>

      <div className="grid xl:grid-cols-2 gap-4 mt-4">
        <Card className="p-5">
          <SectionLabel>Repeat complaints — same quarter, same fault (3 or more)</SectionLabel>
          {p?.repeat_complaints?.length ? (
            <table className="w-full text-[13px] mt-3"><tbody>
              {p.repeat_complaints.map((r: any) => (
                <tr key={r.identifier + r.sub_category} className="border-t border-line h-11 cursor-pointer hover:bg-row-hover"
                  onClick={() => nav(`/w/search?identifier=${encodeURIComponent(r.identifier)}`)}>
                  <td className="font-semibold">{r.identifier}</td><td>{r.sub_category}</td><td className="text-right">
                    {r.pending_staff_officer && <span className="mr-2"><StatusChip tone="await">Staff Officer decision pending</StatusChip></span>}
                    <span className="tnum font-semibold">{r.reports ?? r.complaints}</span>
                    <span className="text-xs text-ink-muted"> reported{r.reports != null && r.reports !== r.complaints ? ` · ${r.complaints} complaint${r.complaints === 1 ? '' : 's'}` : ''}</span></td>
                </tr>))}
            </tbody></table>
          ) : <p className="text-[13px] text-ink-muted mt-3">None. A quarter appears here when the same fault is reported three times — as separate complaints or reopenings of one.</p>}
        </Card>
        <DelaysToAttribute data={breaches} />
      </div>
    </>
  );
}

/* Every breach needs someone to say whose delay it was, or the report is
   an argument rather than evidence. Only departmental officers decide. */
function DelaysToAttribute({ data }: { data: ReturnType<typeof useLoad<{ items: any[] }>> }) {
  const s = session.get()!;
  const toast = useToast();
  const [pick, setPick] = useState<any>(null);
  const [attr, setAttr] = useState('CONTRACTOR');
  const [note, setNote] = useState('');
  const may = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL', 'ADMINISTRATOR'].includes(s.role);
  const save = async () => {
    try { await api(`/breaches/${pick.id}/attribute`, { body: { attribution: attr, note } }); toast({ text: `Delay attributed to ${attr.toLowerCase().replace('_', ' ')}` }); setPick(null); data.reload(); }
    catch (e: any) { toast({ text: e.message, tone: 'bad' }); }
  };
  return (
    <Card className="p-5">
      <SectionLabel>SLA breaches not yet attributed</SectionLabel>
      {data.data?.items.length ? (
        <table className="w-full text-[13px] mt-3"><tbody>
          {data.data.items.slice(0, 8).map((b) => (
            <tr key={b.id} className="border-t border-line h-11">
              <td className="font-semibold tnum">{b.ticket_no}</td><td>{b.identifier}</td><td className="text-ink-muted">{shortDate(b.breached_at)}</td>
              <td className="text-right">{may && <Button size="sm" variant="secondary" icon={<Scale size={15} />} onClick={() => { setPick(b); setNote(''); }}>Attribute</Button>}</td>
            </tr>))}
        </tbody></table>
      ) : <p className="text-[13px] text-ink-muted mt-3">None waiting. Each breach is attributed to the contractor, the department, the occupant or force majeure.</p>}
      <Dialog open={!!pick} title={`Whose delay was it? · ${pick?.ticket_no}`} onClose={() => setPick(null)}
        actions={<><Button variant="secondary" onClick={() => setPick(null)}>Cancel</Button><Button onClick={save}>Record attribution</Button></>}>
        <div className="grid grid-cols-2 gap-2">
          {[['CONTRACTOR', 'Contractor', 'Manpower, negligence, non-performance'], ['DEPARTMENT', 'Department', 'Verification, assignment or inspection pending'],
            ['OCCUPANT', 'Occupant', 'Premises locked, access refused'], ['FORCE_MAJEURE', 'Force majeure', 'Rain, shutdown, area-wide event']].map(([v, l, h]) => (
            <button key={v} onClick={() => setAttr(v)} className={'text-left p-3 rounded-input border ' + (attr === v ? 'border-primary bg-tint' : 'border-line')}>
              <div className="font-semibold text-sm">{l}</div><div className="text-xs text-ink-muted">{h}</div>
            </button>))}
        </div>
        <textarea className="w-full mt-3 rounded-input border-[1.5px] border-line-strong bg-surface p-2.5 text-sm min-h-[70px]" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      </Dialog>
    </Card>
  );
}

/* ---------------------------------------------------------------- scorecard */
export function Scorecard() {
  const nav = useNavigate();
  const toast = useToast();
  const cs = useContracts();
  const [id, setId] = useState<string | null>(null);
  useEffect(() => { if (!id && cs.data?.length) setId((cs.data.find((c) => c.active) || cs.data[0]).id); }, [cs.data]);
  const perf = useLoad(() => id ? api(`/contracts/${id}/performance`) : Promise.resolve(null), [id]);
  const s = session.get()!;
  const area = areaFromScope(s.scope_path);
  const p = perf.data;
  const o = p?.overall;
  const sla = o?.sla_compliance_pct === null || o?.sla_compliance_pct === undefined ? null : Number(o.sla_compliance_pct);
  const g = grade(sla);
  const drill = (q: string) => nav(`/w/search?contract_id=${id}${q}`);
  const Metric = ({ label, value, onClick, sub }: { label: string; value: string; onClick?: () => void; sub?: string }) => (
    <button onClick={onClick} disabled={!onClick} className="text-left p-4 border-t border-white/12 sm:border-t-0 sm:border-l first:border-l-0 hover:[&_b]:underline focus-visible:outline-gold disabled:cursor-default">
      <div className="text-[11px] font-semibold tracking-[.08em] uppercase text-white/70">{label}</div>
      <b className="block tnum text-[26px] font-bold mt-1">{value}</b>
      {sub && <div className="text-xs text-white/70">{sub}</div>}
    </button>
  );
  return (
    <>
      <PageHeader title="Contractor scorecard" sub={`${area.name} · click any number to see its complaints`}
        action={id && p && <Button icon={<Download size={18} />} onClick={() => downloadCsv(id, p.contract.contractor_name, toast)}>Download report</Button>} />
      {cs.error && <ErrorState message={cs.error} retry={cs.reload} />}
      <div className="flex flex-wrap gap-2 mb-4">
        {(cs.data || []).map((c) => <Chip key={c.id} selected={c.id === id} onClick={() => setId(c.id)}>{c.contractor_name}{!c.active && ' (ended)'}</Chip>)}
      </div>
      {!p ? <Skeleton className="h-[320px] rounded-dialog" /> : (
        <div className="rounded-dialog p-7 text-white shadow-[0_24px_64px_rgba(10,51,51,.28)]" style={{ background: 'linear-gradient(150deg,var(--primary-button),var(--primary-dark))' }}>
          <div className="flex flex-wrap items-center gap-7">
            <SlaRing size={150} fraction={(sla ?? 0) / 100} tone="ok" color="var(--gold)" track="rgba(255,255,255,.12)"
              label={sla === null ? '—' : `${num(sla, 1)}%`} sub="SLA compliance" />
            <div className="min-w-0">
              <div className="text-[11px] font-semibold tracking-[.08em] uppercase text-gold">Contractor</div>
              <div className="text-[26px] font-bold leading-tight">{p.contract.contractor_name}</div>
              <div className="text-white/78 mt-1 tnum">{p.contract.agreement_no} · {shortDate(p.contract.starts_on)} – {shortDate(p.contract.expires_on)}</div>
              <div className="flex gap-2 mt-3 items-center">
                {g && <span className="h-7 px-3.5 rounded-full text-[13px] font-bold grid place-items-center text-primary-dark" style={{ background: GRADE_BG[g] }}>Grade {g}</span>}
                {!p.contract.active && <StatusChip tone="neutral">Record frozen at handover</StatusChip>}
              </div>
            </div>
          </div>
          <div className="grid sm:grid-cols-3 xl:grid-cols-6 mt-7 rounded-card bg-white/5 border border-white/12 overflow-hidden">
            <Metric label="Complaints" value={num(o.tickets_received)} onClick={() => drill('')} sub={`${num(o.tickets_open)} open`} />
            <Metric label="Avg. closure" value={o.avg_closure_hours === null ? '—' : `${num(o.avg_closure_hours, 1)} h`} />
            <Metric label="Sent back" value={pct(o.rejection_rate_pct)} onClick={() => drill('&had_rework=true')} sub="of complaints" />
            <Metric label="Reopened" value={pct(o.reopen_rate_pct)} onClick={() => drill('&was_reopened=true')} sub="of complaints" />
            <Metric label="Objections" value={pct(o.objection_rate_pct)} onClick={() => drill('&had_objection=true')} sub="of complaints" />
            <Metric label="Resident rating" value={o.avg_rating === null ? '—' : `${num(o.avg_rating, 1)} / 5`} />
          </div>
          <div className="text-xs text-white/70 mt-4">Evidence only. Penalty and liquidated-damages decisions rest with the department.</div>
        </div>
      )}
      {p && (
        <div className="grid xl:grid-cols-2 gap-4 mt-4">
          <Card className="p-5">
            <SectionLabel>Whose delay — attributed SLA breaches</SectionLabel>
            {p.delay_attribution.length ? p.delay_attribution.map((a: any) => (
              <div key={a.attribution} className="flex justify-between border-t border-line h-11 items-center text-[13px]">
                <span>{a.attribution.charAt(0) + a.attribution.slice(1).toLowerCase().replace('_', ' ')}</span><b className="tnum">{a.breaches}</b>
              </div>)) : <p className="text-[13px] text-ink-muted mt-3">No SLA breaches recorded.</p>}
          </Card>
          <Card className="p-5 overflow-auto">
            <SectionLabel>By month</SectionLabel>
            <table className="w-full text-[13px] mt-2 tnum">
              <thead><tr className="label text-left"><th className="py-2">Month</th><th>Received</th><th>SLA</th><th>Sent back</th><th>Reopened</th><th>Rating</th></tr></thead>
              <tbody>{p.by_month.map((m: any) => (
                <tr key={m.month} className="border-t border-line h-10"><td>{monthLabel(m.month)}</td><td>{m.tickets_received}</td><td>{pct(m.sla_compliance_pct)}</td>
                  <td>{pct(m.rejection_rate_pct)}</td><td>{pct(m.reopen_rate_pct)}</td><td>{m.avg_rating ?? '—'}</td></tr>))}</tbody>
            </table>
          </Card>
        </div>
      )}
      {p && <p className="text-xs text-ink-muted mt-3">Figures as of {when(new Date())}. SLA counts only the contractor’s own time on each complaint, across every round.</p>}
    </>
  );
}
