/* The project's own lifecycle and SLA rules, as the screens present them.
   The design handover shows a different state machine; the project's
   decisions win (see design-decisions.md). */

export type Tone = 'ok' | 'risk' | 'bad' | 'info' | 'reopen' | 'await' | 'neutral';

/** What each state means to the person looking at it. */
export const STATE: Record<string, { label: string; resident: string; tone: Tone }> = {
  RAISED:                  { label: 'Awaiting check',     resident: 'Waiting to be checked',          tone: 'info' },
  VERIFIED:                { label: 'To assign',          resident: 'Checked — passed to the office', tone: 'info' },
  ASSIGNED:                { label: 'Assigned',           resident: 'Given to the contractor',        tone: 'info' },
  IN_PROGRESS:             { label: 'Work under way',     resident: 'Work under way',                 tone: 'info' },
  WORK_COMPLETED:          { label: 'Awaiting inspection', resident: 'Contractor says done — inspection due', tone: 'await' },
  INSPECTED_ACCEPTED:      { label: 'Inspected',          resident: 'Inspected and accepted',         tone: 'ok' },
  CLOSED:                  { label: 'Closed',             resident: 'Closed',                         tone: 'ok' },
  REJECTED:                { label: 'Rejected',           resident: 'Not accepted',                   tone: 'neutral' },
  REWORK:                  { label: 'Rework',             resident: 'Sent back to the contractor',    tone: 'bad' },
  REFERRED_SPECIAL_REPAIR: { label: 'Special repair',     resident: 'Referred for special repair',    tone: 'neutral' },
  REOPENED:                { label: 'Reopened',           resident: 'Reopened',                       tone: 'reopen' }
};
export const OPEN_STATES = ['RAISED', 'VERIFIED', 'ASSIGNED', 'IN_PROGRESS', 'WORK_COMPLETED', 'REWORK', 'REOPENED'];

export const ROLE_LABEL: Record<string, string> = {
  RESIDENT: 'Resident', CUSTODIAN: 'Custodian', CONTRACTOR: 'Contractor (firm)',
  CONTRACTOR_SUPERVISOR: 'Contractor supervisor', CIVIL_OVERSEER: 'Civil Colony Overseer',
  MAINTENANCE_INCHARGE: 'Civil Colony Incharge', STAFF_OFFICER_CIVIL: 'Area Civil Staff Officer',
  AREA_HR_ADMIN: 'Area HR Administrator', AREA_SYS_ADMIN: 'Area System Administrator',
  GM_CIVIL: 'HQ — Civil HOD', HQ_EXECUTIVE: 'HQ — Director / CMD', ADMINISTRATOR: 'HQ System Administrator'
};
export const OCCUPANT = ['RESIDENT', 'CUSTODIAN'];

/** How a role reads in the switcher: "My quarter — B-234" for one's own home. */
export function roleTitle(a: { role: string; premises?: string | null; area?: string | null; designation?: string | null; scope_path?: string }) {
  if (a.role === 'RESIDENT') return `My quarter${a.premises ? ` — ${a.premises}` : ''}`;
  if (a.role === 'CUSTODIAN') return `My building${a.premises ? ` — ${a.premises}` : ''}`;
  const where = a.area || areaFromScope(a.scope_path).name;
  return `${ROLE_LABEL[a.role] || a.role}${where && !['GM_CIVIL', 'HQ_EXECUTIVE', 'ADMINISTRATOR'].includes(a.role) ? ` · ${where}` : ''}`;
}

export const AREAS: Record<string, string> = {
  AML: 'Amlohri', NGH: 'Nigahi', JNT: 'Jayant', DCH: 'Dudhichua', KHD: 'Khadia', KSL: 'Krishnashila',
  BINA: 'Bina', KKR: 'Kakri', JRD: 'Jhingurda', BLB: 'Block-B', CWS: 'Central Workshop',
  NSC: 'Nehru Shatabdi Chikitsalaya', NHQ: 'NCL HQ Colony'
};
export const areaFromScope = (scope = '') => {
  const code = scope.split('.')[1] || '';
  const byScope: Record<string, string> = { amlohri: 'AML', nigahi: 'NGH', jayant: 'JNT', dudhichua: 'DCH',
    khadia: 'KHD', krishnashila: 'KSL', bina: 'BINA', kakri: 'KKR', jhingurda: 'JRD', blockb: 'BLB',
    cws: 'CWS', nsc: 'NSC', nclhq: 'NHQ' };
  const c = byScope[code];
  return c ? { code: c, name: AREAS[c] } : { code: 'NCL', name: 'All Areas' };
};

/**
 * The contractor's SLA position (departmental decision 2026-09-25): only
 * time in the contractor's hands counts, summed across rounds. Needs the
 * full ticket (contractor_minutes, contractor_window_started_at).
 */
export function contractorSla(t: any) {
  const window = Number(t.sla_completion_minutes) || 0;
  if (!window) return null;
  const running = t.contractor_window_started_at
    ? (Date.now() - new Date(t.contractor_window_started_at).getTime()) / 60000 : 0;
  const used = Number(t.contractor_minutes || 0) + running;
  const left = window - used;
  const done = !OPEN_STATES.includes(t.state) || t.state === 'WORK_COMPLETED';
  const tone: Tone = t.completion_met === true ? 'ok' : t.completion_met === false ? 'bad'
    : left < 0 ? 'bad' : left <= window * 0.25 ? 'risk' : 'ok';
  return { window, used, left, fraction: Math.min(1, used / window), tone, done, running: !!t.contractor_window_started_at };
}

/**
 * The complaint's SLA position against its deadline (verification + SLA),
 * for departmental queues where only list fields are available.
 */
export function deadlineSla(deadline: string | null, windowMins: number | null, state: string) {
  if (!deadline || !OPEN_STATES.includes(state)) return null;
  const left = (new Date(deadline).getTime() - Date.now()) / 60000;
  const w = windowMins || 0;
  const tone: Tone = left < 0 ? 'bad' : w && left <= w * 0.25 ? 'risk' : 'ok';
  return { left, window: w, tone, fraction: w ? Math.min(1, Math.max(0, 1 - left / w)) : left < 0 ? 1 : 0.5 };
}

export const slaText = (left: number) => {
  const h = Math.abs(left) / 60;
  const v = h >= 48 ? `${Math.round(h / 24)}d` : `${Math.max(1, Math.round(h))}h`;
  return left < 0 ? `+${v}` : v;
};

/** NCL's Employee ID is exactly 8 digits (decision 2026-09-30); the
    database refuses anything else, the forms just keep the input clean. */
export const EMP_ID_HELP = '8 digits, e.g. 90229456';
export const toEmpId = (v: string) => v.replace(/\D/g, '').slice(0, 8);
export const isEmpId = (v: string) => /^[0-9]{8}$/.test(v);
