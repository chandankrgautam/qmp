/* Numbers in Indian grouping, times in IST, always "relative · absolute". */

export const num = (n: number | string | null | undefined, digits = 0) =>
  n === null || n === undefined || n === '' ? '—'
    : Number(n).toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const pct = (n: number | string | null | undefined) =>
  n === null || n === undefined ? '—' : `${num(n, 1)}%`;

const IST = 'Asia/Kolkata';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* DD MMM YYYY, built by hand: en-GB writes "Sept", the standard is "Sep". */
const istParts = (d: string | Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: '2-digit', month: 'numeric', year: 'numeric' })
    .formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.day} ${MON[Number(p.month) - 1]} ${p.year}`;
};
export const shortDate = (d: string | Date | null | undefined) => (d ? istParts(d) : '—');
export const absTime = (d: string | Date | null | undefined) => {
  if (!d) return '—';
  const time = new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: IST });
  return `${istParts(d)}, ${time}`;
};

export const relTime = (d: string | Date | null | undefined) => {
  if (!d) return '';
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  const a = Math.abs(mins);
  const s = a < 1 ? 'just now' : a < 60 ? `${a} min` : a < 1440 ? `${Math.round(a / 60)} hrs` : `${Math.round(a / 1440)} days`;
  if (a < 1) return s;
  return mins >= 0 ? `${s} ago` : `in ${s}`;
};
export const when = (d: string | Date | null | undefined) => d ? `${relTime(d)} · ${absTime(d)}` : '—';

export const hours = (mins: number) => {
  const h = mins / 60;
  return h >= 48 ? `${Math.round(h / 24)}d` : h >= 10 ? `${Math.round(h)}h` : `${Math.round(h * 10) / 10}h`;
};

export const initials = (name = '') =>
  name.replace(/[^A-Za-z\s]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '·';
