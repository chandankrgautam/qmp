import { useState } from 'react';
import { Lock, ShieldOff, Trash2 } from 'lucide-react';
import { Button, Card, Dialog, EmptyState, ErrorState, Field, Segmented, Skeleton, StatusChip, inputCls, useToast } from '../../components/ui';
import { PageHeader } from '../../components/shell/Shells';
import { api, idApi, session } from '../../lib/api';
import { ROLE_LABEL } from '../../lib/domain';
import { num, relTime, when } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

/* Admin console. Everything the design calls configurable, as the API
   exposes it. There are no user accounts to add: devices are registered
   and approved (see Registrations), so the design's "Add user" dialog
   becomes device management here. */

type Tab = 'settings' | 'sla' | 'cards' | 'devices' | 'photos';

export default function Admin() {
  const s = session.get()!;
  const [tab, setTab] = useState<Tab>(s.role === 'ADMINISTRATOR' ? 'settings' : 'sla');
  const tabs: { value: Tab; label: string }[] = s.role === 'ADMINISTRATOR'
    ? [{ value: 'settings', label: 'Settings' }, { value: 'sla', label: 'Categories & SLA' }, { value: 'cards', label: 'Dashboard cards' },
       { value: 'devices', label: 'Devices' }, { value: 'photos', label: 'Photo storage' }]
    : [{ value: 'sla', label: 'Categories & SLA' }];
  return (
    <>
      <PageHeader title="Administration" sub="Configuration without a code change. Every change is audit-logged." />
      <Segmented className="mb-4" value={tab} onChange={setTab} options={tabs} />
      {tab === 'settings' && <Settings />}
      {tab === 'sla' && <Sla />}
      {tab === 'cards' && <Cards />}
      {tab === 'devices' && <Devices />}
      {tab === 'photos' && <Photos />}
    </>
  );
}

function Settings() {
  const toast = useToast();
  const cfg = useLoad(() => api<any[]>('/admin/config'));
  const [edit, setEdit] = useState<any>(null);
  const [v, setV] = useState('');
  const save = async () => {
    try { await api(`/admin/config/${edit.key}`, { method: 'PUT', body: { value: v } }); toast({ text: 'Setting saved' }); setEdit(null); cfg.reload(); }
    catch (e: any) { toast({ text: e.message, tone: 'bad' }); }
  };
  if (cfg.error) return <ErrorState message={cfg.error} retry={cfg.reload} />;
  return (
    <Card className="overflow-auto">
      <table className="w-full text-[13px]">
        <thead className="bg-bg"><tr className="text-left">{['Setting', 'Value', ''].map((h) => <th key={h} className="label px-4 py-3">{h}</th>)}</tr></thead>
        <tbody>{(cfg.data || []).map((c) => (
          <tr key={c.key} className="border-t border-line h-[52px]">
            <td className="px-4"><div className="font-medium">{c.description}</div><div className="text-xs text-ink-muted">{c.key}</div></td>
            <td className="px-4 tnum font-semibold">{c.value}</td>
            <td className="px-4 text-right"><Button size="sm" variant="secondary" onClick={() => { setEdit(c); setV(c.value); }}>Edit</Button></td>
          </tr>))}</tbody>
      </table>
      <Dialog open={!!edit} title={edit?.description || ''} onClose={() => setEdit(null)}
        actions={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}>Save setting</Button></>}>
        <Field label={edit?.key || ''} help={`Type: ${edit?.data_type}`}><input className={inputCls} value={v} onChange={(e) => setV(e.target.value)} /></Field>
      </Dialog>
    </Card>
  );
}

function Sla() {
  const toast = useToast();
  const rows = useLoad(() => api<any[]>('/admin/sla'));
  const [edit, setEdit] = useState<any>(null);
  const [r, setR] = useState(''); const [c, setC] = useState('');
  const save = async () => {
    try {
      await api(`/admin/sla/${edit.sub_category_id}`, { method: 'PUT', body: { response_minutes: Math.round(Number(r) * 60), completion_minutes: Math.round(Number(c) * 60) } });
      toast({ text: 'SLA saved — applies to complaints verified from now on' }); setEdit(null); rows.reload();
    } catch (e: any) { toast({ text: e.message, tone: 'bad' }); }
  };
  if (rows.error) return <ErrorState message={rows.error} retry={rows.reload} />;
  return (
    <Card className="overflow-auto">
      <table className="w-full text-[13px] tnum">
        <thead className="bg-bg"><tr className="text-left">{['Category', 'Sub-category', 'Emergency', 'Response', 'Completion', ''].map((h) => <th key={h} className="label px-4 py-3">{h}</th>)}</tr></thead>
        <tbody>{(rows.data || []).map((x) => (
          <tr key={x.sub_category_id} className="border-t border-line h-[52px]">
            <td className="px-4 text-ink-muted">{x.category}</td><td className="px-4 font-medium">{x.name_en}<div className="text-xs text-ink-muted">{x.name_hi}</div></td>
            <td className="px-4">{x.emergency_eligible ? <StatusChip tone="bad">Eligible</StatusChip> : '—'}</td>
            <td className="px-4">{num((x.response_minutes || 0) / 60, 1)} h</td><td className="px-4">{num((x.completion_minutes || 0) / 60, 1)} h</td>
            <td className="px-4 text-right"><Button size="sm" variant="secondary" onClick={() => { setEdit(x); setR(String((x.response_minutes || 0) / 60)); setC(String((x.completion_minutes || 0) / 60)); }}>Edit</Button></td>
          </tr>))}</tbody>
      </table>
      <Dialog open={!!edit} title={`SLA · ${edit?.name_en}`} onClose={() => setEdit(null)}
        actions={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}>Save SLA</Button></>}>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Response (hours)" required><input className={inputCls + ' tnum'} type="number" min={0} step={0.5} value={r} onChange={(e) => setR(e.target.value)} /></Field>
          <Field label="Completion (hours)" required><input className={inputCls + ' tnum'} type="number" min={0} step={0.5} value={c} onChange={(e) => setC(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-ink-muted mt-3">Applies only to complaints verified after saving; open complaints keep the SLA they were given. The change and the old values are audit-logged.</p>
      </Dialog>
    </Card>
  );
}

function Cards() {
  const toast = useToast();
  const cards = useLoad(() => api<any[]>('/admin/dashboard-cards'));
  const save = async (c: any, patch: any) => {
    try { await api(`/admin/dashboard-cards/${c.id}`, { method: 'PUT', body: { warn_above: c.warn_above, critical_above: c.critical_above, active: c.active, display_order: c.display_order, ...patch } });
      toast({ text: 'Dashboard card saved' }); cards.reload(); }
    catch (e: any) { toast({ text: e.message, tone: 'bad' }); }
  };
  if (cards.error) return <ErrorState message={cards.error} retry={cards.reload} />;
  return (
    <Card className="overflow-auto">
      <table className="w-full text-[13px] tnum">
        <thead className="bg-bg"><tr className="text-left">{['Role', 'Card', 'Amber above', 'Red above', 'Shown'].map((h) => <th key={h} className="label px-4 py-3">{h}</th>)}</tr></thead>
        <tbody>{(cards.data || []).map((c) => (
          <tr key={c.id} className="border-t border-line h-[52px]">
            <td className="px-4 text-ink-muted">{ROLE_LABEL[c.role] || c.role}</td><td className="px-4 font-medium">{c.label_en}</td>
            {(['warn_above', 'critical_above'] as const).map((k) => (
              <td key={k} className="px-4"><input className={inputCls + ' !h-9 w-24'} type="number" defaultValue={c[k] ?? ''}
                onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== (c[k] === null ? null : Number(c[k]))) save(c, { [k]: v }); }} /></td>))}
            <td className="px-4"><input type="checkbox" className="w-4 h-4" checked={c.active} onChange={(e) => save(c, { active: e.target.checked })} /></td>
          </tr>))}</tbody>
      </table>
    </Card>
  );
}

function Devices() {
  const toast = useToast();
  const devs = useLoad(() => idApi<any[]>('/devices?status=ACTIVE'));
  const [rev, setRev] = useState<any>(null);
  const [reason, setReason] = useState('');
  const go = async () => {
    try { await idApi(`/devices/${rev.id}/revoke`, { body: { reason } }); toast({ text: `Device of ${rev.person_name} revoked` }); setRev(null); devs.reload(); }
    catch (e: any) { toast({ text: e.message, tone: 'bad' }); }
  };
  if (devs.error) return <ErrorState message={devs.error} retry={devs.reload} />;
  if (!devs.data) return <Skeleton className="h-60" />;
  return (
    <Card className="overflow-auto">
      <table className="w-full text-[13px]">
        <thead className="bg-bg"><tr className="text-left">{['Person', 'Roles', 'Scope', 'Registered', 'Last used', ''].map((h) => <th key={h} className="label px-4 py-3">{h}</th>)}</tr></thead>
        <tbody>{devs.data.map((d) => (
          <tr key={d.id} className="border-t border-line h-[52px]">
            <td className="px-4 font-medium">{d.person_name}</td><td className="px-4">{(d.roles || '').split(', ').filter(Boolean).map((x: string) => ROLE_LABEL[x] || x).join(', ') || '—'}</td>
            <td className="px-4 text-ink-muted">{d.scope_path}</td><td className="px-4 text-ink-muted">{d.created_at ? relTime(d.created_at) : '—'}</td>
            <td className="px-4 text-ink-muted">{d.last_seen_at ? relTime(d.last_seen_at) : 'never'}</td>
            <td className="px-4 text-right">{<Button size="sm" variant="secondary" icon={<ShieldOff size={15} />} onClick={() => { setRev(d); setReason(''); }}>Revoke</Button>}</td>
          </tr>))}</tbody>
      </table>
      {devs.data.length === 0 && <EmptyState title="No active devices" />}
      <Dialog open={!!rev} title={`Revoke the device of ${rev?.person_name}?`} onClose={() => setRev(null)}
        actions={<><Button variant="secondary" onClick={() => setRev(null)}>Cancel</Button><Button variant="destructive" disabled={!reason.trim()} onClick={go}>Revoke device</Button></>}>
        <p className="text-[13px] text-ink-muted mb-3">The device stops working at its next sign-in, within 15 minutes. This is recorded in the audit log with your reason.</p>
        <Field label="Reason" required><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Transferred to Nigahi" /></Field>
      </Dialog>
    </Card>
  );
}

function Photos() {
  const toast = useToast();
  const u = useLoad(() => api<any>('/admin/media/usage'));
  const purge = async () => {
    try { const r = await api('/admin/media/purge', { method: 'POST' }); toast({ text: `Purge done · ${r.bytes_removed} image${r.bytes_removed === 1 ? '' : 's'} past retention removed` }); u.reload(); }
    catch (e: any) { toast({ text: e.message, tone: 'bad' }); }
  };
  if (u.error) return <ErrorState message={u.error} retry={u.reload} />;
  if (!u.data) return <Skeleton className="h-40" />;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap justify-between gap-3 items-start">
        <div><div className="font-semibold">Store: {u.data.driver === 's3' ? 'Object storage (S3/MinIO)' : 'Local filesystem'}</div>
          <div className="text-[13px] text-ink-muted tnum">{num(u.data.store.objects)} images · {num(u.data.store.bytes / 1048576, 1)} MB</div></div>
        <Button variant="secondary" icon={<Trash2 size={16} />} onClick={purge}>Run retention purge</Button>
      </div>
      <table className="w-full text-[13px] mt-4 tnum"><thead><tr className="label text-left"><th className="py-2">Purpose</th><th>Stored</th><th>Pending</th><th>Failed</th><th>Purged</th></tr></thead>
        <tbody>{u.data.by_purpose.map((p: any) => (<tr key={p.purpose} className="border-t border-line h-10"><td>{p.purpose.toLowerCase()}</td><td>{p.stored}</td><td>{p.pending}</td><td>{p.failed}</td><td>{p.purged}</td></tr>))}</tbody></table>
      <p className="text-xs text-ink-muted mt-3 flex gap-1.5"><Lock size={13} />After two years the image is deleted but its record — hash, location and time — is kept. Estimated as of {when(new Date())}.</p>
    </Card>
  );
}
