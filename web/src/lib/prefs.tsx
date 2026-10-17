import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/* Theme and language: per viewer, remembered in this browser. */
type Lang = 'en' | 'hi';
/* Density: 'auto' is compact tables for the office roles, the airy layout for
   residents and HQ; a viewer who picks one keeps it. */
export type Density = 'auto' | 'compact' | 'comfortable';
/* Colour scheme (2026-10-15): one of tokens/tokens.json's schemes; 'teal' is the default. */
export type Scheme = string;
type Prefs = { dark: boolean; toggleDark: () => void; lang: Lang; setLang: (l: Lang) => void; t: (k: string) => string;
  density: Density; setDensity: (d: Density) => void; scheme: Scheme; setScheme: (s: Scheme) => void };

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

/* Interface strings. A missing Hindi string falls back to English, never
   to the key — the residents who most need Hindi must never see a key. */
const HI: Record<string, string> = {
  'Report a problem': 'शिकायत दर्ज करें',
  'My quarter': 'मेरा क्वार्टर',
  'My open complaints': 'मेरी खुली शिकायतें',
  'Takes under a minute': 'एक मिनट से कम लगता है',
  'Home': 'होम', 'Complaints': 'शिकायतें', 'Alerts': 'सूचनाएँ', 'Profile': 'प्रोफ़ाइल',
  'Work queue': 'कार्य सूची', 'Inbox': 'इनबॉक्स', 'Area dashboard': 'क्षेत्र डैशबोर्ड', 'Contractor scorecard': 'ठेकेदार स्कोरकार्ड',
  'All-Areas overview': 'सभी क्षेत्र', 'Administration': 'प्रशासन', 'Registrations': 'पंजीकरण',
  'Search': 'खोज', 'Log out': 'लॉग आउट', 'Allotment (coming soon)': 'आवंटन (जल्द)',
  'Welcome back': 'स्वागत है', 'Choose your role and sign in': 'अपनी भूमिका चुनें और साइन इन करें',
  'Register this device': 'यह डिवाइस पंजीकृत करें', "Today's jobs": 'आज के कार्य',
  'Open': 'खुली', 'Due soon': 'समय कम', 'Overdue': 'विलंबित', 'Awaiting inspection': 'निरीक्षण लंबित',
  'Notifications': 'सूचनाएँ', 'Yes, it\'s fixed': 'हाँ, ठीक हो गया', 'Not fixed, reopen': 'ठीक नहीं, पुनः खोलें',
  // V2 (F5, try): the resident's statuses. Drafts — to be checked by NCL's Rajbhasha cell.
  'Waiting to be checked': 'जाँच की प्रतीक्षा', 'Checked — passed to the office': 'जाँच हुई — कार्यालय को भेजी गई',
  'Given to the contractor': 'ठेकेदार को सौंपी गई', 'Work under way': 'काम चल रहा है',
  'Contractor says done — inspection due': 'ठेकेदार ने काम पूरा बताया — निरीक्षण बाकी',
  'Inspected and accepted': 'निरीक्षण में स्वीकार', 'Closed': 'बंद', 'Not accepted': 'स्वीकार नहीं',
  'Sent back to the contractor': 'ठेकेदार को वापस भेजी गई', 'Referred for special repair': 'विशेष मरम्मत के लिए भेजी गई',
  'Reopened': 'फिर से खोली गई', 'My complaints': 'मेरी शिकायतें', 'Open and recent': 'खुली और हाल की',
  'No open complaints': 'कोई खुली शिकायत नहीं', 'Object to the work': 'काम पर आपत्ति करें',
  'Was it fixed properly?': 'क्या यह ठीक से ठीक हुआ?', 'Timeline': 'प्रगति'
};

const Ctx = createContext<Prefs>(null as unknown as Prefs);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const systemDark = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
  const [dark, setDark] = useState(() => (read('cp-theme') ?? (systemDark ? 'dark' : 'light')) === 'dark');
  const [lang, setLangState] = useState<Lang>(() => (read('cp-lang') === 'hi' ? 'hi' : 'en'));
  const [density, setDensityState] = useState<Density>(() => (read('cp-density') as Density) || 'auto');
  const [scheme, setSchemeState] = useState<Scheme>(() => read('cp-scheme') || 'teal');
  useEffect(() => { if (scheme === 'teal') delete document.documentElement.dataset.scheme; else document.documentElement.dataset.scheme = scheme; }, [scheme]);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, [dark]);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const value: Prefs = {
    dark, toggleDark: () => setDark((d) => { save('cp-theme', d ? 'light' : 'dark'); return !d; }),
    lang, setLang: (l) => { save('cp-lang', l); setLangState(l); },
    t: (k) => (lang === 'hi' ? HI[k] ?? k : k),
    density, setDensity: (d) => { save('cp-density', d); setDensityState(d); },
    scheme, setScheme: (x) => { save('cp-scheme', x); setSchemeState(x); }
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const usePrefs = () => useContext(Ctx);
