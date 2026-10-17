import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, BadgeCheck, CheckCircle2, Clock, Hourglass, Megaphone, XCircle } from 'lucide-react';
import { Card } from '../components/ui';
import { api } from '../lib/api';
import { STATE, deadlineSla } from '../lib/domain';
import { absTime, shortDate } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { vtName } from '../lib/vt';

/* The resident's complaint page as a receipt (V2, blueprint R1). Its
   layout follows UX4G's Grievance Status Tracker (MeitY's design system):
   a status card with the time left, the details, the escalation path, and
   the journey — in the portal's own colours. Every figure is the server's:
   the deadline fixed at verification, the escalation path from the
   database's own rules (control 4). Officers are named by role, never by
   name: occupants read no officer's record. */

type Tone = 'track' | 'risk' | 'late' | 'done' | 'wait' | 'stop';
const CARD: Record<Tone, string> = {
  track: 'bg-info-bg border-info/25', risk: 'bg-risk-bg border-risk/30', late: 'bg-bad-bg border-bad/30',
  done: 'bg-ok-bg border-ok/30', wait: 'bg-tint border-primary/15', stop: 'bg-muted border-line-strong'
};
const BAR: Record<Tone, string> = { track: 'bg-info', risk: 'bg-risk', late: 'bg-bad', done: 'bg-ok', wait: 'bg-primary', stop: 'bg-ink-muted' };
const PILL: Record<Tone, string> = {
  track: 'bg-surface text-info', risk: 'bg-surface text-risk', late: 'bg-surface text-bad',
  done: 'bg-surface text-ok', wait: 'bg-surface text-primary', stop: 'bg-surface text-ink-muted'
};

const ROLE_EN: Record<string, string> = { CIVIL_OVERSEER: 'Civil Overseer', MAINTENANCE_INCHARGE: 'Civil Colony Incharge',
  STAFF_OFFICER_CIVIL: 'Area Civil Staff Officer', GM_CIVIL: 'GM (Civil), HQ' };
const ROLE_HI: Record<string, string> = { CIVIL_OVERSEER: 'सिविल ओवरसियर', MAINTENANCE_INCHARGE: 'सिविल कॉलोनी प्रभारी',
  STAFF_OFFICER_CIVIL: 'क्षेत्र सिविल स्टाफ अधिकारी', GM_CIVIL: 'महाप्रबंधक (सिविल), मुख्यालय' };

/** "3 days left", "5 hours left", "Late by 2 days" — and in Hindi. */
function timeWords(mins: number, hi: boolean) {
  const late = mins < 0, a = Math.abs(mins), h = a / 60;
  const n = h >= 48 ? Math.round(h / 24) : Math.max(1, Math.round(h));
  const unit = h >= 48 ? (hi ? 'दिन' : n === 1 ? 'day' : 'days') : (hi ? 'घंटे' : n === 1 ? 'hour' : 'hours');
  if (hi) return late ? `${n} ${unit} की देरी` : `${n} ${unit} बाकी`;
  return late ? `Late by ${n} ${unit}` : `${n} ${unit} left`;
}

/** Whose hands it is in now, and since when (README §3). */
function holder(t: any, hi: boolean): { who: string; since?: string | null } {
  const H = (en: string, h: string) => (hi ? h : en);
  switch (t.state) {
    case 'RAISED': return { who: H('Civil Overseer — to be checked', 'सिविल ओवरसियर — जाँच होनी है'), since: t.raised_at };
    case 'VERIFIED': return { who: H('Civil office — to be given to the contractor', 'सिविल कार्यालय — ठेकेदार को सौंपी जानी है'), since: t.verified_at };
    case 'REOPENED': return { who: H('Civil office — reopened, to be given back', 'सिविल कार्यालय — फिर से खोली गई'), since: null };
    case 'ASSIGNED': return { who: H('The contractor — work to start', 'ठेकेदार — काम शुरू होना है'), since: t.assigned_at };
    case 'IN_PROGRESS': return { who: H('The contractor — work under way', 'ठेकेदार — काम चल रहा है'), since: t.started_at };
    case 'REWORK': return { who: H('The contractor — sent back to redo', 'ठेकेदार — दोबारा करने के लिए'), since: t.inspected_at };
    case 'WORK_COMPLETED': return { who: H('Civil Overseer — to inspect on site', 'सिविल ओवरसियर — मौके पर निरीक्षण होना है'), since: t.completed_claim_at };
    case 'INSPECTED_ACCEPTED': return { who: H('You — confirm or say it is not fixed', 'आप — पुष्टि करें या बताएं कि ठीक नहीं हुआ'), since: t.inspected_at };
    case 'CLOSED': return { who: H('Closed', 'बंद'), since: t.closed_at };
    case 'REJECTED': return { who: H('Not accepted', 'स्वीकार नहीं'), since: null };
    default: return { who: STATE[t.state]?.resident || t.state };
  }
}

export function StatusCard({ t }: { t: any }) {
  const { lang, t: tr } = usePrefs();
  const hi = lang === 'hi';
  const sla = deadlineSla(t.completion_deadline_at, t.sla_completion_minutes, t.state);
  const done = ['INSPECTED_ACCEPTED', 'CLOSED'].includes(t.state);
  const tone: Tone = t.state === 'REJECTED' ? 'stop' : done ? 'done' : !sla ? 'wait'
    : sla.tone === 'bad' ? 'late' : sla.tone === 'risk' ? 'risk' : 'track';
  const Icon = tone === 'done' ? CheckCircle2 : tone === 'late' ? AlertTriangle : tone === 'stop' ? XCircle : tone === 'wait' ? Hourglass : Clock;
  const line = done ? (t.completion_met === false ? (hi ? 'समय सीमा के बाद ठीक हुई' : 'Fixed after the deadline') : (hi ? 'समय पर ठीक हुई' : 'Fixed in time'))
    : sla ? timeWords(sla.left, hi)
    : t.state === 'RAISED' ? (hi ? 'जाँच के बाद समय सीमा तय होगी' : 'The deadline is fixed once it is checked')
    : t.state === 'REJECTED' ? (hi ? 'यह शिकायत स्वीकार नहीं हुई' : 'This complaint was not accepted') : '';
  const fill = done ? 1 : sla ? (sla.left < 0 ? 1 : sla.fraction) : 0;
  return (
    <div className={clsx('rounded-[18px] border p-4', CARD[tone])} style={vtName('card', t.id)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-[17px] leading-snug">{t.sub_category}</div>
          <div className="text-[12.5px] text-ink-muted mt-0.5 tnum">{hi ? 'शिकायत संख्या' : 'Complaint'} · {t.ticket_no}</div>
        </div>
        <span className={clsx('inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-semibold shrink-0 border border-current/15', PILL[tone])}>
          <Icon size={14} aria-hidden />{tr(STATE[t.state]?.resident || t.state)}
        </span>
      </div>
      {line && <div className={clsx('mt-3 font-semibold', tone === 'late' && 'text-bad')}>{line}</div>}
      {(sla || done) && (
        <div className="mt-2 h-2 rounded-full bg-surface/80 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(fill * 100)} aria-label={hi ? 'समय सीमा में से बीता समय' : 'Share of the time allowed that has passed'} style={vtName('ring', t.id)}>
          <div className={clsx('h-full rounded-full', BAR[tone])} style={{ width: `${Math.max(4, fill * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

export function DetailsCard({ t }: { t: any }) {
  const { lang } = usePrefs();
  const hi = lang === 'hi';
  const h = holder(t, hi);
  const rows: [string, string | null | undefined][] = [
    [hi ? 'समस्या' : 'Problem', t.category],
    [hi ? 'क्वार्टर' : 'Quarter', `${t.identifier}${t.quarter_type ? ` · Type ${t.quarter_type}` : ''}`],
    [hi ? 'दर्ज की गई' : 'Reported on', absTime(t.raised_at)],
    [hi ? 'ठीक होने की तारीख' : 'Expected by', t.completion_deadline_at ? absTime(t.completion_deadline_at) : (hi ? 'जाँच के बाद तय होगी' : 'Set when it is checked')],
    [hi ? 'अभी किसके पास' : 'Who has it now', `${h.who}${h.since ? ` · ${hi ? 'से' : 'since'} ${shortDate(h.since)}` : ''}`],
    [hi ? 'कारीगर' : 'Workmen', t.workmen_assigned]
  ];
  return (
    <Card className="p-4">
      <div className="font-semibold">{hi ? 'शिकायत का विवरण' : 'Complaint details'}</div>
      <dl className="mt-2 divide-y divide-line">
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="grid grid-cols-[110px_1fr] gap-3 py-2 text-[13.5px]">
            <dt className="text-ink-muted">{k}</dt><dd className="font-medium m-0 text-right">{v}</dd>
          </div>
        ))}
      </dl>
      {t.description && <p className="text-[13.5px] mt-2 pt-2 border-t border-line">“{t.description}”</p>}
    </Card>
  );
}

export function EscalationCard({ t }: { t: any }) {
  const { lang } = usePrefs();
  const hi = lang === 'hi';
  const path: any[] = t.escalation_path || [];
  if (!path.length || ['CLOSED', 'REJECTED', 'INSPECTED_ACCEPTED'].includes(t.state)) return null;
  const top = Math.max(0, ...path.filter((x) => x.reached).map((x) => x.level));
  return (
    <Card className="p-4">
      <div className="font-semibold">{hi ? 'समय पर ठीक न होने पर' : 'If it is not fixed in time'}</div>
      <p className="text-[12.5px] text-ink-muted mt-0.5">{hi ? 'समय सीमा बीतने पर आपकी शिकायत अपने-आप ऊपर के अधिकारी तक जाती है।' : 'Your complaint goes up a level by itself when the time allowed passes.'}</p>
      <ol className="mt-3 grid gap-2">
        {path.map((x) => {
          const now = x.level === top;
          const role = (hi ? ROLE_HI : ROLE_EN)[x.role] || x.role;
          // a level whose time has passed but is not yet recorded is "due now":
          // the escalation sweep records it on its next run (README §5.4)
          const pastDue = !x.reached && x.due_at && Date.parse(x.due_at) <= Date.now();
          const sub = x.reached ? `${hi ? 'सूचित' : 'Alerted'} ${absTime(x.reached_at)}`
            : pastDue ? `${hi ? 'अब देय — समय' : 'Due now — time passed'} ${absTime(x.due_at)}`
            : x.due_at ? `${hi ? 'यदि ठीक न हो —' : 'If not fixed by'} ${absTime(x.due_at)}`
            : (hi ? 'जाँच के बाद समय तय होगा' : 'Timed once the complaint is checked');
          return (
            <li key={x.level} className={clsx('rounded-xl px-3 py-2.5 border text-[13px]',
              now ? 'bg-risk-bg border-risk/30' : pastDue ? 'bg-bad-bg border-bad/30' : x.reached ? 'bg-muted border-line' : 'bg-surface border-line')}>
              <div className="font-semibold">{hi ? 'स्तर' : 'Level'} {x.level} · {role}</div>
              <div className="text-ink-muted text-[12px]">{sub}</div>
            </li>
          );
        })}
      </ol>
      {top === 0 && path[0]?.due_at && Date.parse(path[0].due_at) > Date.now() &&
        <p className="text-[12px] text-ink-muted mt-2">{hi ? 'अभी तक इसकी ज़रूरत नहीं पड़ी — शिकायत समय सीमा के भीतर है।' : 'Not needed so far — the complaint is within its time.'}</p>}
    </Card>
  );
}

/** Every update, dated, oldest first; the expected one still to come. */
export function JourneyCard({ t, items }: { t: any; items: { title: string; who?: string; at?: string; current?: boolean }[] }) {
  const { lang } = usePrefs();
  const hi = lang === 'hi';
  const open = !['CLOSED', 'REJECTED'].includes(t.state);
  return (
    <Card className="p-4">
      <div className="font-semibold">{hi ? 'शिकायत की प्रगति' : 'Complaint journey'}</div>
      <p className="text-[12.5px] text-ink-muted mt-0.5">{hi ? 'दर्ज होने से बंद होने तक हर अपडेट' : 'Every update from reporting to closure'}</p>
      <ol className="relative mt-3 ml-2 border-l-2 border-line grid gap-2.5">
        {items.map((it, i) => (
          <li key={i} className="relative pl-5">
            <span className={clsx('absolute -left-[9px] top-3 w-4 h-4 rounded-full grid place-items-center',
              it.current && open ? 'bg-surface ring-2 ring-primary' : 'bg-primary-btn text-on-primary')}>
              {!(it.current && open) && <BadgeCheck size={11} />}</span>
            <div className={clsx('rounded-xl border px-3 py-2', it.current && open ? 'bg-tint border-primary/25' : 'bg-surface border-line')}>
              <div className="text-[11.5px] text-ink-muted tnum">{it.at}</div>
              <div className="font-semibold text-[13.5px]">{it.title}</div>
              {it.who && <div className="text-[12px] text-ink-muted">{it.who}</div>}
            </div>
          </li>
        ))}
        {open && t.completion_deadline_at && t.state !== 'INSPECTED_ACCEPTED' && (
          <li className="relative pl-5">
            <span className="absolute -left-[7px] top-3 w-3 h-3 rounded-full bg-surface border-2 border-line-strong" />
            <div className="rounded-xl border border-dashed border-line-strong px-3 py-2">
              <div className="text-[11.5px] text-ink-muted tnum">{hi ? 'अनुमानित' : 'Est.'} {absTime(t.completion_deadline_at)}</div>
              <div className="font-semibold text-[13.5px] text-ink-muted">{hi ? 'ठीक होकर निरीक्षण' : 'Fixed and inspected'}</div>
            </div>
          </li>
        )}
      </ol>
    </Card>
  );
}

/** Notices the civil office has posted for this colony (blueprint R4). */
export function ColonyNotices({ compact }: { compact?: boolean }) {
  const { lang } = usePrefs();
  const hi = lang === 'hi';
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => { api<{ items: any[] }>('/notices').then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  if (!items.length) return null;
  return (
    <div className="grid gap-2">
      {items.map((n) => (
        <div key={n.id} className="rounded-[14px] border border-risk/30 bg-risk-bg p-3.5 flex gap-3" role="note">
          <Megaphone size={18} className="text-risk shrink-0 mt-0.5" aria-hidden />
          <div className="min-w-0 text-[13.5px]">
            <div className="text-[11.5px] font-semibold text-risk">{hi ? 'सिविल कार्यालय की सूचना' : 'Notice from the civil office'}{n.ends_at ? ` · ${hi ? 'तक' : 'until'} ${absTime(n.ends_at)}` : ''}</div>
            <div className="font-semibold mt-0.5">{n.title}</div>
            {!compact && n.body && <p className="text-ink-muted mt-0.5">{n.body}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}
