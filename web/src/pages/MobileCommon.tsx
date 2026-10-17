import { useNavigate } from 'react-router-dom';
import { PasskeysCard } from './Passkeys';
import clsx from 'clsx';
import { Bell } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState, Skeleton } from '../components/ui';
import { LangSwitch, MobileShell, ThemeToggle } from '../components/shell/Shells';
import { api, idApi, session } from '../lib/api';
import { ROLE_LABEL, roleTitle } from '../lib/domain';
import { when } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { useLoad } from '../lib/useLoad';
import { SchemePicker } from '../components/shell/SchemePicker';

/* In-app notifications are authoritative (push is best-effort), so the
   inbox is the record of what the user was told. */
export function NotificationList() {
  const { lang } = usePrefs();
  const n = useLoad(() => api<{ items: any[]; unread_count: number }>('/notifications'));
  const markRead = async () => { await api('/notifications/read', { method: 'POST' }); n.reload(); };
  if (n.error) return <ErrorState message={n.error} retry={n.reload} />;
  if (!n.data) return <Skeleton className="h-32" />;
  return (
    <>
      {n.data.unread_count > 0 && <Button variant="secondary" size="sm" className="mb-3" onClick={markRead}>Mark all read ({n.data.unread_count})</Button>}
      {n.data.items.length === 0 && <EmptyState title="No notifications" body="Updates about your work will appear here." />}
      <div className="flex flex-col gap-2">
        {n.data.items.map((x) => (
          <Card key={x.id} className={clsx('p-3.5 flex gap-3', !x.read && 'border-l-[3px] border-l-primary')}>
            <Bell size={18} className={x.read ? 'text-ink-muted' : 'text-primary'} />
            <div className="min-w-0">
              <div className="font-semibold text-sm">{lang === 'hi' ? x.title_hi : x.title_en}</div>
              <div className="text-[13px] text-ink-muted">{lang === 'hi' ? x.body_hi : x.body_en}</div>
              <div className="text-xs text-ink-muted mt-1">{when(x.created_at)}</div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

export function Alerts() {
  return <MobileShell title="Alerts" sub="Everything you have been told"><NotificationList /></MobileShell>;
}

export function Profile() {
  const s = session.get()!;
  const me = useLoad(() => idApi('/me'));
  const nav = useNavigate();
  return (
    <MobileShell title="Profile" sub={ROLE_LABEL[s.role]}>
      <Card className="p-4">
        <div className="font-bold text-lg">{me.data?.person_name || s.name}</div>
        <div className="text-[13px] text-ink-muted">{ROLE_LABEL[s.role]}</div>
        {me.data?.identifier && <div className="text-sm mt-2">Qtr No. {me.data.identifier}, {me.data.colony}</div>}
        <div className="text-xs text-ink-muted mt-2">{s.amr === 'device' ? 'Signed in with this phone' : s.amr === 'passkey' ? 'Signed in with a passkey' : 'Signed in with Employee ID'}</div>
      </Card>
      {(me.data?.roles?.length || 0) > 1 && (
        <Card className="p-4 mt-3">
          <div className="font-medium mb-2">Your roles</div>
          {me.data.roles.map((r: any) => (
            <div key={r.id} className="text-sm py-1.5 border-t border-line first:border-0">
              {roleTitle({ ...r, premises: r.identifier })}{r.id === s.actor_id && <span className="text-xs text-primary font-semibold"> · now</span>}
            </div>))}
          <div className="text-xs text-ink-muted mt-2">Switch from the button at the top right.</div>
        </Card>
      )}
      {me.data?.resident_page && me.data.resident_page !== 'available' && me.data.resident_page !== 'none' &&
        <div className="mt-3 text-[13px] rounded-card bg-risk-bg text-risk p-3">Your own quarter: {me.data.resident_page}.</div>}
      {me.data?.personnel_no && <div className="mt-3"><PasskeysCard hasPassword={me.data.has_password} /></div>}
      <Card className="p-4 mt-3 flex items-center justify-between"><span className="font-medium">Language</span><LangSwitch /></Card>
      <Card className="p-4 mt-3">
        <div className="flex items-center justify-between"><span className="font-medium">Dark mode</span><ThemeToggle /></div>
        <div className="font-medium mt-4 mb-2">Colour scheme</div>
        <SchemePicker />
        <p className="text-xs text-ink-muted mt-2">Status colours stay the same in every scheme. Your choice is kept on this phone.</p>
      </Card>
      <Button variant="secondary" className="w-full mt-5" onClick={() => { session.clear(); nav('/signin'); }}>Sign out</Button>
    </MobileShell>
  );
}
