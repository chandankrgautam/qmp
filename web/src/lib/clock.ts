import { slaText } from './domain';

/* Whose time it is (V2, blueprint O2). The portal judges the contractor on
   the contractor's own time and the department on the rest (README §3); a
   single "Due in 8h" hides that. Every figure here is the server's — the
   deadline fixed at verification, the contractor's minutes, the open
   pause; this only words it. Support-desk practice: name the clock, show
   time left in hours, keep counting after a breach, say why it is paused. */

export type Clock = { label: string; sub: string; fill: number; tone: 'ok' | 'risk' | 'bad' | 'muted' | 'info' };

const ATTR: Record<string, string> = { OCCUPANT: 'quarter locked (occupant)', FORCE_MAJEURE: 'force majeure' };
const ago = (iso?: string | null) => {
  if (!iso) return '';
  const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${Math.round(m)} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
const hrs = (m: number) => (m >= 2880 ? `${Math.round(m / 1440)} d` : m >= 60 ? `${Math.round(m / 60)} h` : `${Math.round(m)} min`);

export function clockFor(r: any, waitingHours?: number | null): Clock {
  if (r.paused) {
    return { label: `Paused ${ago(r.paused_since)}`, sub: ATTR[r.pause_attribution] || 'recorded pause', fill: 0.5, tone: 'muted' };
  }
  const deadline = r.completion_deadline_at ? Date.parse(r.completion_deadline_at) : null;
  const left = deadline ? (deadline - Date.now()) / 60000 : null;
  const window = Number(r.sla_completion_minutes) || 0;
  const overdue = left !== null && left < 0 && !['CLOSED', 'REJECTED', 'INSPECTED_ACCEPTED'].includes(r.state);

  switch (r.state) {
    case 'RAISED':
      return { label: `To verify · ${ago(r.raised_at)}`, sub: 'department · raised', fill: 0.15, tone: 'info' };
    case 'ASSIGNED': case 'IN_PROGRESS': case 'REWORK': {
      // the contractor's own clock: earlier rounds plus the round now open
      const used = (Number(r.contractor_minutes) || 0)
        + (r.contractor_window_started_at ? (Date.now() - Date.parse(r.contractor_window_started_at)) / 60000 : 0);
      if (!window) return { label: 'Contractor', sub: 'no SLA window', fill: 0, tone: 'muted' };
      const over = used - window;
      if (over > 0) return { label: `Contractor over by ${hrs(over)}`, sub: `${hrs(used)} used of ${hrs(window)} · counting`, fill: 1, tone: 'bad' };
      const f = used / window;
      return { label: `Contractor: ${hrs(used)} of ${hrs(window)}`, sub: `${hrs(window - used)} left on their clock`, fill: f, tone: f >= 0.75 ? 'risk' : 'ok' };
    }
    case 'WORK_COMPLETED':
      return { label: `Inspect · waiting ${waitingHours != null ? `${waitingHours} h` : ''}`.trim(),
        sub: overdue ? `deadline passed ${slaText(left!)} · department's delay` : 'department · claimed done', fill: overdue ? 1 : 0.6, tone: overdue || (waitingHours ?? 0) >= 48 ? 'bad' : 'info' };
    case 'INSPECTED_ACCEPTED':
      return { label: 'To close', sub: 'inspected · resident may confirm', fill: 0.9, tone: 'ok' };
    case 'CLOSED':
      // the contractor's own figure, judged on their time alone (README §3)
      return { label: `Closed ${ago(r.closed_at)}`, sub: r.completion_met === false ? 'contractor was late' : r.completion_met ? 'contractor on time' : 'no SLA judged',
        fill: 1, tone: r.completion_met === false ? 'bad' : 'ok' };
    default:
      if (overdue) return { label: `Overdue ${slaText(left!)}`, sub: 'department · counting', fill: 1, tone: 'bad' };
      if (left !== null && window) {
        const f = Math.min(1, Math.max(0, 1 - left / window));
        return { label: `Due in ${slaText(left)}`, sub: 'department · to assign', fill: f, tone: f >= 0.75 ? 'risk' : 'info' };
      }
      return { label: '—', sub: '', fill: 0, tone: 'muted' };
  }
}
