import { useState } from 'react';
import { Link, Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { Download, Search as SearchIcon } from 'lucide-react';
import { Button, Chip, EmptyState, ErrorState, Skeleton, StatusChip, inputCls, useToast } from '../components/ui';
import { PageHeader, WebShell } from '../components/shell/Shells';
import { NotificationList } from './MobileCommon';
import Queue from './officer/Queue';
import Today from './officer/Today';
import { AreaDashboard, Scorecard } from './officer/Area';
import Hq from './officer/Hq';
import HqWall from './officer/HqWall';
import Admin from './officer/Admin';
import Registrations from './officer/Registrations';
import People from './officer/People';
import ProfilePage from './Passkeys';
import WorkOrders from './officer/WorkOrders';
import JobCards, { JobCardPrint } from './officer/JobCard';
import Materials from './officer/Materials';
import { MbBook } from './officer/Measurements';
import MeasurementBook from './officer/MbWork';
import Disputes from './officer/Disputes';
import FirmJobs from './officer/FirmJobs';
import TicketPanel from './officer/TicketPanel';
import { api, downloadCsv, homeFor, session } from '../lib/api';
import { STATE } from '../lib/domain';
import { shortDate } from '../lib/format';
import { useLoad } from '../lib/useLoad';

/* The web portal for office roles. The sidebar shows only what each role
   uses; the server refuses anything else regardless. */

export default function Officer() {
  const s = session.get()!;
  const page = (title: string, el: React.ReactNode, roles?: string[]) =>
    roles && !roles.includes(s.role) ? <Navigate to={homeFor(s.role)} replace /> : <WebShell title={title}>{el}</WebShell>;
  const OFFICE = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL'];
  const JC = [...OFFICE, 'GM_CIVIL', 'HQ_EXECUTIVE', 'ADMINISTRATOR'];
  return (
    <Routes>
      <Route path="queue" element={page('Inbox', <Queue />, OFFICE)} />
      <Route path="today" element={page('Today', <Today />, ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE'])} />
      <Route path="registrations" element={page('Registrations', <Registrations />, ['MAINTENANCE_INCHARGE', 'AREA_HR_ADMIN', 'AREA_SYS_ADMIN', 'ADMINISTRATOR'])} />
      <Route path="disputes" element={page('Disputes', <Disputes />, JC)} />
      <Route path="job-cards" element={page('Job cards', <JobCards />, JC)} />
      <Route path="job-cards/:id" element={page('Job card', <JobCardPrint />, JC)} />
      <Route path="materials" element={page('Materials', <Materials />, JC)} />
      <Route path="mb" element={page('Measurement book', <MeasurementBook />, JC)} />
      <Route path="mb/book/:contractId" element={page('MB record', <MbBook />, JC)} />
      <Route path="contracts" element={page('Work orders', <WorkOrders />, ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL', 'GM_CIVIL', 'HQ_EXECUTIVE', 'CONTRACTOR', 'ADMINISTRATOR'])} />
      <Route path="people" element={page('People and roles', <People />, ['AREA_HR_ADMIN', 'AREA_SYS_ADMIN', 'ADMINISTRATOR'])} />
      <Route path="area" element={page('Area dashboard', <AreaDashboard />, [...OFFICE, 'GM_CIVIL'])} />
      <Route path="jobs" element={page(s.role === 'CONTRACTOR' ? 'Our jobs' : 'My jobs', <FirmJobs />, ['CONTRACTOR', 'CONTRACTOR_SUPERVISOR'])} />
      <Route path="scorecard" element={page('Contractor scorecard', <Scorecard />, ['MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL', 'GM_CIVIL', 'HQ_EXECUTIVE', 'CONTRACTOR', 'ADMINISTRATOR'])} />
      <Route path="hq" element={page('All-Areas overview', <Hq />, ['GM_CIVIL', 'HQ_EXECUTIVE', 'ADMINISTRATOR'])} />
      {/* the wall display stands alone: no sidebar, no header, read from across the room */}
      <Route path="hq/wall" element={['GM_CIVIL', 'HQ_EXECUTIVE', 'ADMINISTRATOR'].includes(s.role) ? <HqWall /> : <Navigate to={homeFor(s.role)} replace />} />
      <Route path="admin" element={page('Administration', <Admin />, ['ADMINISTRATOR', 'MAINTENANCE_INCHARGE'])} />
      <Route path="profile" element={page('Passkeys', <><PageHeader title="Passkeys" sub="Sign in on the web with your fingerprint, face or PIN." /><ProfilePage /></>)} />
      <Route path="search" element={page('Search', <Search />)} />
      <Route path="notifications" element={page('Notifications', <><PageHeader title="Notifications" /><div className="max-w-2xl"><NotificationList /></div></>)} />
      <Route path="*" element={<Navigate to={homeFor(s.role)} replace />} />
    </Routes>
  );
}

/* Search covers every complaint, archived included; drill-downs from the
   dashboards land here with their filter already applied. */
const FLAGS: [string, string][] = [['missed_sla', 'Missed SLA'], ['overdue', 'Overdue'], ['had_rework', 'Sent back'],
  ['was_reopened', 'Reopened'], ['had_objection', 'Objection raised'], ['is_emergency', 'Emergency']];

function Search() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const [q, setQ] = useState(params.get('q') || '');
  const [open, setOpen] = useState<string | null>(null);
  const qs = params.toString();
  const res = useLoad(() => api<{ items: any[]; total: number }>(`/search?page_size=100&${qs}`), [qs]);
  const set = (k: string, v: string | null) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); setParams(p); };
  const filtered = [...params.keys()].filter((k) => k !== 'q').length > 0;
  return (
    <>
      <PageHeader title="Search" sub="Every complaint in your scope, archived ones included"
        action={session.get()?.role !== 'CONTRACTOR' && <Button variant="secondary" icon={<Download size={17} />}
          onClick={() => downloadCsv(`/maintenance/v1/search.csv?${qs}`, 'search.csv').catch((e) => toast({ text: e.message, tone: 'bad' }))}>Download CSV</Button>} />
      <form className="flex gap-2 max-w-2xl" onSubmit={(e) => { e.preventDefault(); set('q', q || null); }}>
        <div className="relative flex-1">
          <SearchIcon size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input className={inputCls + ' pl-10'} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Complaint number or words from the description" />
        </div>
        <Button type="submit">Search</Button>
      </form>
      <div className="flex flex-wrap gap-2 mt-3">
        {FLAGS.map(([k, l]) => <Chip key={k} selected={params.get(k) === 'true'} onClick={() => set(k, params.get(k) === 'true' ? null : 'true')}>{l}</Chip>)}
        {/* the measurements' approval (2026-10-16) */}
        <Chip selected={params.get('mb') === 'approved'} onClick={() => set('mb', params.get('mb') === 'approved' ? null : 'approved')}>MB approved</Chip>
        <Chip selected={params.get('mb') === 'pending'} onClick={() => set('mb', params.get('mb') === 'pending' ? null : 'pending')}>MB pending</Chip>
        {params.get('contract_id') && <Chip selected onClick={() => set('contract_id', null)}>This contract ×</Chip>}
        {params.get('identifier') && <Chip selected onClick={() => set('identifier', null)}>Qtr {params.get('identifier')} ×</Chip>}
        {filtered && <Button size="sm" variant="ghost" onClick={() => setParams(new URLSearchParams(q ? { q } : {}))}>Clear filters</Button>}
      </div>
      {res.error && <div className="mt-4"><ErrorState message={res.error} retry={res.reload} /></div>}
      <div className="bg-surface border border-line rounded-card overflow-auto mt-4">
        {!res.data ? <Skeleton className="h-40 m-4" /> : res.data.items.length === 0 ? <EmptyState title="No complaints match" body="Clear a filter or search for different words." /> : (
          <table className="w-full text-[13px] min-w-[800px]">
            <thead className="bg-bg"><tr className="text-left">{['Complaint', 'Qtr / building', 'Problem', 'Status', 'Raised', 'Contractor', 'MB', 'Rating'].map((h) => <th key={h} className="label px-4 py-3">{h}</th>)}</tr></thead>
            <tbody>{res.data.items.map((t) => (
              <tr key={t.id} className="border-t border-line h-[52px] hover:bg-row-hover cursor-pointer" onClick={() => setOpen(t.id)}>
                <td className="px-4 font-semibold tnum">{t.ticket_no}{t.archived_at && <span className="text-xs text-ink-muted font-normal"> · archived</span>}</td>
                <td className="px-4">{t.identifier}</td><td className="px-4">{t.sub_category}</td>
                <td className="px-4"><StatusChip tone={STATE[t.state]?.tone || 'info'}>{STATE[t.state]?.label || t.state}</StatusChip></td>
                <td className="px-4 tnum text-ink-muted">{shortDate(t.raised_at)}</td><td className="px-4 text-ink-muted">{t.contractor_name || '—'}</td>
                <td className="px-4 tnum text-xs" onClick={(e) => e.stopPropagation()}>{t.mb_no && t.mb_pages?.length
                  ? <Link className="text-primary" to={`/w/mb/book/${t.contract_id}?page=${t.mb_pages[0]}&job=${t.id}`}>p. {t.mb_pages.join(', ')}</Link>
                  : <span className="text-ink-muted">—</span>}{t.mb_stage === 'APPROVED' && <span className="text-ok"> · approved</span>}</td>
                <td className="px-4 tnum">{t.rating ? `${t.rating}/5` : '—'}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      {res.data && <div className="text-xs text-ink-muted mt-2 tnum">{res.data.total} complaint{res.data.total === 1 ? '' : 's'}</div>}
      {open && <TicketPanel id={open} onClose={() => setOpen(null)} onChanged={res.reload} />}
    </>
  );
}
