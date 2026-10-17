import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Bell, ChevronLeft, ChevronRight, LayoutGrid, LogOut, Moon, Sun, ClipboardCheck, Award,
  BarChart3, Settings, UserPlus, Home as HomeIcon, List, User, Building2, Search, Users, Repeat, Check, FileSignature, ClipboardList, Package, Scale, Ruler, Fingerprint, Rows3, Rows2, Route as RouteIcon } from 'lucide-react';
import { session, switchRole, homeFor } from '../../lib/api';
import { ROLE_LABEL, areaFromScope, roleTitle } from '../../lib/domain';
import { initials } from '../../lib/format';
import { usePrefs } from '../../lib/prefs';
import { Avatar, IconButton, Logo, useToast } from '../ui';
import { CommandPalette, PaletteButton } from './Palette';
import { vtNavigate } from '../../lib/vt';
import { GovFooter, GovStrip } from './GovFrame';
import { SchemePicker } from './SchemePicker';

/* ------------------------------------------------------------ shared */
export function LangSwitch({ light }: { light?: boolean }) {
  const { lang, setLang } = usePrefs();
  return (
    <div className={clsx('inline-flex rounded-full p-1 border', light ? 'border-white/25' : 'border-line-strong bg-surface')} role="group" aria-label="Language">
      {(['en', 'hi'] as const).map((l) => (
        <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l}
          className={clsx('h-8 min-w-10 px-2.5 rounded-full text-[13px] font-semibold',
            lang === l ? 'bg-primary-btn text-on-primary' : light ? 'text-white/80' : 'text-ink-muted')}>
          {l === 'en' ? 'EN' : 'हिं'}
        </button>
      ))}
    </div>
  );
}
const COMPACT_ROLES = ['CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL', 'AREA_HR_ADMIN', 'AREA_SYS_ADMIN', 'ADMINISTRATOR'];
/** Compact or comfortable tables; the choice sits on <html> so every table follows it. */
function useDensity() {
  const { density, setDensity } = usePrefs();
  const role = session.get()?.role || '';
  const eff = density === 'auto' ? (COMPACT_ROLES.includes(role) ? 'compact' : 'comfortable') : density;
  useEffect(() => { document.documentElement.dataset.density = eff; return () => { delete document.documentElement.dataset.density; }; }, [eff]);
  return { eff, toggle: () => setDensity(eff === 'compact' ? 'comfortable' : 'compact') };
}

export function ThemeToggle({ light }: { light?: boolean }) {
  const { dark, toggleDark } = usePrefs();
  return (
    <IconButton label={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggleDark}
      className={clsx('border', light ? 'border-white/25 text-white hover:bg-white/10' : 'border-line-strong bg-surface')}>
      {dark ? <Sun size={19} /> : <Moon size={19} />}
    </IconButton>
  );
}

/* ------------------------------------------------------------ role switch */
/* One person, one phone, several roles (decision 2026-09-30): an Overseer
   switches between inspecting and their own quarter without signing out.
   Each switch is a fresh token for that role alone; the app asks for the
   PIN or biometric again before an official role. */
export function RoleSwitch({ light, children }: { light?: boolean; children: ReactNode }) {
  const s = session.get();
  const nav = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const pick = async (id: string) => {
    if (id === s?.actor_id) return setOpen(false);
    setBusy(id);
    try {
      const n = await switchRole(id);
      const a = n.assignments.find((x) => x.id === id);
      setOpen(false); nav(homeFor(n.role));
      toast({ text: `Now working as ${a ? roleTitle(a) : ROLE_LABEL[n.role]}`, tone: 'ok' });
    } catch (e: any) { toast({ text: e.message, tone: 'bad' }); }
    finally { setBusy(null); }
  };
  const out = () => { session.clear(); nav('/signin'); };
  return (
    <div className="relative" ref={box}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" title="Switch role or sign out"
        className={clsx('flex items-center gap-2.5 rounded-full', light && 'text-white')}>{children}</button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-2 w-[300px] max-h-[80vh] overflow-auto bg-surface text-ink border border-line rounded-card shadow-lg z-50 p-2">
          <div className="px-2.5 py-1.5 text-xs text-ink-muted">{s?.name}{s?.amr === 'password' ? ' · signed in with Employee ID' : s?.amr === 'passkey' ? ' · signed in with a passkey' : s?.amr === 'otp' ? ' · signed in with mobile and OTP' : ' · signed in with this phone'}</div>
          {(s?.assignments || []).map((a) => (
            <button key={a.id} role="menuitem" onClick={() => pick(a.id)} disabled={!!busy}
              className="w-full min-h-11 flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left text-sm hover:bg-row-hover">
              <span className="w-5 shrink-0">{a.id === s?.actor_id ? <Check size={18} className="text-primary" /> : <Repeat size={16} className="text-ink-muted" />}</span>
              <span className="flex-1 min-w-0"><span className={clsx('block truncate', a.id === s?.actor_id && 'font-semibold')}>{roleTitle(a)}</span>
                {a.designation && <span className="block text-xs text-ink-muted truncate">{a.designation}{a.acting ? ' (acting)' : ''}</span>}</span>
              {busy === a.id && <span className="text-xs text-ink-muted">…</span>}
            </button>
          ))}
          {homeFor(s?.role || '').startsWith('/w/') && s?.amr !== 'otp' && (
            <button role="menuitem" onClick={() => { setOpen(false); nav('/w/profile'); }} className="w-full min-h-11 flex items-center gap-2.5 px-2.5 rounded-xl text-sm hover:bg-row-hover border-t border-line mt-1">
              <Fingerprint size={16} className="ml-0.5" />Passkeys
            </button>
          )}
          {!light && <MenuSettings />}
          <button role="menuitem" onClick={out} className="w-full min-h-11 flex items-center gap-2.5 px-2.5 rounded-xl text-sm hover:bg-row-hover border-t border-line mt-1">
            <LogOut size={16} className="ml-0.5" />Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** Settings a person sets once (V2, F3): out of the header, into the person menu. */
function MenuSettings() {
  const { dark, toggleDark } = usePrefs();
  const d = useDensity();
  const row = 'w-full min-h-11 flex items-center gap-2.5 px-2.5 rounded-xl text-sm hover:bg-row-hover';
  return (
    <div className="border-t border-line mt-1 pt-1">
      <button role="menuitemcheckbox" aria-checked={dark} onClick={toggleDark} className={row}>
        {dark ? <Sun size={16} className="ml-0.5" /> : <Moon size={16} className="ml-0.5" />}<span className="flex-1 text-left">{dark ? 'Light theme' : 'Dark theme'}</span>
      </button>
      <button role="menuitemcheckbox" aria-checked={d.eff === 'compact'} onClick={d.toggle} className={row}>
        {d.eff === 'compact' ? <Rows2 size={16} className="ml-0.5" /> : <Rows3 size={16} className="ml-0.5" />}
        <span className="flex-1 text-left">{d.eff === 'compact' ? 'Comfortable rows' : 'Compact rows'}</span>
      </button>
      <div className="px-2.5 pt-2 pb-1 text-xs text-ink-muted">Colour scheme</div>
      <div className="px-1 pb-1"><SchemePicker compact /></div>
    </div>
  );
}

/* ------------------------------------------------------------ web shell */
type NavItem = { to: string; label: string; icon: ReactNode };
export function navFor(role: string): NavItem[] {
  const q = { to: '/w/queue', label: 'Inbox', icon: <ClipboardCheck size={20} /> };
  const today = { to: '/w/today', label: 'Today', icon: <RouteIcon size={20} /> };
  const area = { to: '/w/area', label: 'Area dashboard', icon: <LayoutGrid size={20} /> };
  const score = { to: '/w/scorecard', label: 'Contractor scorecard', icon: <Award size={20} /> };
  const search = { to: '/w/search', label: 'Search', icon: <Search size={20} /> };
  const hq = { to: '/w/hq', label: 'All-Areas overview', icon: <BarChart3 size={20} /> };
  const regs = { to: '/w/registrations', label: 'Registrations', icon: <UserPlus size={20} /> };
  const people = { to: '/w/people', label: 'People and roles', icon: <Users size={20} /> };
  const orders = { to: '/w/contracts', label: 'Work orders', icon: <FileSignature size={20} /> };
  const cards = { to: '/w/job-cards', label: 'Job cards', icon: <ClipboardList size={20} /> };
  const mats = { to: '/w/materials', label: 'Materials', icon: <Package size={20} /> };
  const mb = { to: '/w/mb', label: 'Measurement book', icon: <Ruler size={20} /> };
  const disputes = { to: '/w/disputes', label: 'Disputes', icon: <Scale size={20} /> };
  const admin = { to: '/w/admin', label: 'Administration', icon: <Settings size={20} /> };
  const jobs = { to: '/w/jobs', label: 'Our jobs', icon: <ClipboardList size={20} /> };
  switch (role) {
    case 'CIVIL_OVERSEER': return [today, q, disputes, cards, orders, mats, mb, search];
    case 'MAINTENANCE_INCHARGE': return [q, today, disputes, cards, orders, mats, mb, regs, area, search];
    case 'STAFF_OFFICER_CIVIL': return [disputes, area, cards, orders, mats, mb, score, q, search];
    case 'GM_CIVIL': return [hq, area, score, cards, orders, mats, mb, search];
    case 'HQ_EXECUTIVE': return [hq, score, cards, orders, mats, mb, search];
    case 'AREA_HR_ADMIN': case 'AREA_SYS_ADMIN': return [people, regs];
    case 'CONTRACTOR': return [jobs, score, orders];
    case 'CONTRACTOR_SUPERVISOR': return [{ ...jobs, label: 'My jobs' }];
    case 'ADMINISTRATOR': return [admin, people, regs, hq, cards, mats, mb, search];
    default: return [];
  }
}

export function WebShell({ title, crumb, children }: { title: string; crumb?: string; children: ReactNode }) {
  const s = session.get();
  useDensity(); // the table density applies on every page, set from the person menu
  const nav = useNavigate();
  const { t } = usePrefs();
  const [collapsed, setCollapsed] = useState(false);
  const area = areaFromScope(s?.scope_path);
  const out = () => { session.clear(); nav('/signin'); };
  return (
    <div className="flex min-h-full">
      <aside className={clsx('sidebar-glow shrink-0 bg-sidebar text-white flex flex-col sticky top-0 h-screen transition-[width] duration-300', collapsed ? 'w-[72px]' : 'w-[248px]')}>
        <div className="h-[72px] px-3.5 flex items-center justify-between border-b border-white/10">
          <Logo compact={collapsed} />
          <button aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setCollapsed(!collapsed)}
            className="w-8 h-8 grid place-items-center rounded-full hover:bg-white/10 text-white/80 shrink-0">
            {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>
        <nav className="p-2.5 flex flex-col gap-1 flex-1">
          {navFor(s?.role || '').map((n) => (
            <NavLink key={n.to} to={n.to} title={t(n.label)}
              className={({ isActive }) => clsx('h-11 rounded-xl flex items-center gap-3 px-3 text-sm font-medium transition-colors',
                isActive ? 'nav-active bg-white/10 text-white font-semibold [&_svg]:text-gold' : 'text-white/78 hover:bg-white/6 hover:translate-x-0.5')}>
              {({ isActive }) => (<>
                {n.icon}{!collapsed && <span className="flex-1 truncate">{t(n.label)}</span>}
                {isActive && !collapsed && <span className="w-1.5 h-1.5 rounded-full bg-gold" />}
              </>)}
            </NavLink>
          ))}
          <div className="h-11 rounded-xl flex items-center gap-3 px-3 text-sm font-medium text-white opacity-45 cursor-not-allowed" title="Allotment is not in Phase 1">
            <Building2 size={20} />{!collapsed && t('Allotment (coming soon)')}
          </div>
        </nav>
        <button onClick={out} className="m-2.5 h-11 rounded-xl flex items-center gap-3 px-3 text-sm text-white/78 hover:bg-white/6 border-t border-white/10">
          <LogOut size={20} />{!collapsed && t('Log out')}
        </button>
      </aside>
      <div className="flex-1 min-w-0 flex flex-col relative">
        <div className="ambient" aria-hidden />
        <GovStrip />
        <header className="h-16 bg-surface/70 backdrop-blur-xl backdrop-saturate-150 border-b border-line/70 flex items-center gap-3 px-5 sticky top-0 z-30">
          <div className="text-[13px] text-ink-muted truncate flex-1">
            NCL <span className="mx-1">/</span> {area.name} <span className="mx-1">/</span>
            <span className="font-semibold text-ink">{crumb || title}</span>
          </div>
          <PaletteButton />
          <LangSwitch />
          <IconButton label="Notifications" onClick={() => nav('/w/notifications')} className="relative"><Bell size={19} /></IconButton>
          <div className="pl-2 border-l border-line">
            <RoleSwitch>
              <Avatar text={initials(s?.name)} />
              <div className="text-left leading-tight hidden md:block">
                <div className="text-[13px] font-semibold">{s?.name}</div>
                <div className="text-xs text-ink-muted">{ROLE_LABEL[s?.role || '']}{(s?.assignments.length || 0) > 1 ? ' · switch role' : ''}</div>
              </div>
            </RoleSwitch>
          </div>
        </header>
        <CommandPalette pages={navFor(s?.role || '')} />
        <main id="main" tabIndex={-1} className="p-5 xl:p-7 flex-1 max-w-[1400px] w-full focus:outline-none">{children}</main>
        <GovFooter />
      </div>
    </div>
  );
}
export function PageHeader({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div className="parallax-head">
        <h1 className="text-[32px] leading-[1.1] text-primary">{title}</h1>
        {sub && <p className="text-ink-muted mt-1">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/* ------------------------------------------------------------ mobile shell */
/* On a desktop the phone screens sit in a centred 430px column, so the
   layout reviewed here is the one a handset will get. */
export function MobileShell({ title, sub, back, children, tabs = true, overlay }:
  { title: string; sub?: string; back?: string | (() => void); children: ReactNode; tabs?: boolean; overlay?: ReactNode }) {
  const s = session.get();
  const nav = useNavigate();
  const { t } = usePrefs();
  const contractor = s?.role === 'CONTRACTOR_SUPERVISOR';
  const items = contractor
    ? [{ to: '/m/jobs', label: "Today's jobs", icon: <List size={22} /> }, { to: '/m/alerts', label: 'Alerts', icon: <Bell size={22} /> },
       { to: '/m/profile', label: 'Profile', icon: <User size={22} /> }]
    : [{ to: '/m/home', label: 'Home', icon: <HomeIcon size={22} /> }, { to: '/m/complaints', label: 'Complaints', icon: <List size={22} /> },
       { to: '/m/alerts', label: 'Alerts', icon: <Bell size={22} /> }, { to: '/m/profile', label: 'Profile', icon: <User size={22} /> }];
  return (
    <div className="min-h-full bg-muted flex justify-center">
      <a href="#main" className="skip-link">Skip to content</a>
      <div className="relative w-full max-w-[430px] min-h-screen bg-bg flex flex-col shadow-[0_0_0_1px_var(--border)] overflow-x-clip isolate">
        <div className="ambient !absolute" aria-hidden />
        <header className="sidebar-glow bg-sidebar/90 backdrop-blur-xl text-white px-4 pt-4 pb-4 flex items-center gap-3 sticky top-0 z-20">
          {back && (
            <button aria-label="Back" onClick={() => typeof back === 'function' ? back() : vtNavigate(nav, back, true)}
              className="w-10 h-10 grid place-items-center rounded-full bg-white/10 shrink-0"><ChevronLeft size={20} /></button>
          )}
          <div className="flex-1 min-w-0">
            <div className="font-bold text-lg truncate">{title}</div>
            {sub && <div className="text-[13px] text-white/78 truncate">{sub}</div>}
          </div>
          <ThemeToggle light />
          <RoleSwitch light>
            <span className="w-10 h-10 grid place-items-center rounded-full bg-white/10" aria-label="Switch role or sign out">
              {(s?.assignments.length || 0) > 1 ? <Repeat size={18} /> : <User size={18} />}</span>
          </RoleSwitch>
        </header>
        <main id="main" tabIndex={-1} className="flex-1 p-4 pb-24 focus:outline-none">{children}</main>
        {tabs && (
          <nav className="fixed bottom-0 w-full max-w-[430px] h-16 bg-surface/75 backdrop-blur-xl backdrop-saturate-150 border-t border-line/70 flex z-20">
            {items.map((i) => (
              <NavLink key={i.to} to={i.to}
                className={({ isActive }) => clsx('flex-1 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium relative',
                  isActive ? 'text-primary' : 'text-ink-muted')}>
                {({ isActive }) => (<>{i.icon}{t(i.label)}{isActive && <span className="absolute top-1.5 w-1.5 h-1.5 rounded-full bg-gold" />}</>)}
              </NavLink>
            ))}
          </nav>
        )}
        {overlay}
      </div>
    </div>
  );
}
