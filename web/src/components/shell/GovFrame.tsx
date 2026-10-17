import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { usePrefs } from '../../lib/prefs';

/* The government frame (V2, blueprint G1): what GIGW 3.0 expects on every
   page of an Indian government website or app — who runs it, a skip link,
   text size, language — and a footer with the accessibility statement,
   help and contact, and when it was last updated. Built to the guideline;
   whether the portal seeks STQC certification is the department's call. */

export const LAST_UPDATED = '13 Oct 2026';
const SIZES = [['sm', 'A−', 'Smaller text'], ['md', 'A', 'Normal text'], ['lg', 'A+', 'Larger text']] as const;
type Size = typeof SIZES[number][0];
const read = (): Size => { try { const v = localStorage.getItem('cp-text') as Size; return v === 'sm' || v === 'lg' ? v : 'md'; } catch { return 'md'; } };

/** Text size, kept per viewer; applied as a zoom on <html>, so every px in the portal scales. */
export function useTextSize() {
  const [size, setSize] = useState<Size>(read);
  useEffect(() => {
    document.documentElement.dataset.text = size;
    try { localStorage.setItem('cp-text', size); } catch { /* private window */ }
  }, [size]);
  return { size, setSize };
}

export function GovStrip({ className }: { className?: string }) {
  const { lang, setLang } = usePrefs();
  const { size, setSize } = useTextSize();
  const hi = lang === 'hi';
  return (
    <div className={clsx('gov-strip bg-primary-dark text-[#E7EDEA] text-[12px]', className)}>
      <div className="max-w-[1400px] mx-auto px-4 min-h-8 py-1 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>{hi ? 'नॉर्दर्न कोलफील्ड्स लिमिटेड · कोल इंडिया लिमिटेड की अनुषंगी' : 'Northern Coalfields Limited · A Coal India Limited subsidiary'}</span>
        <span className="flex-1" />
        <a href="#main" className="underline-offset-2 hover:underline focus:underline">{hi ? 'मुख्य सामग्री पर जाएं' : 'Skip to main content'}</a>
        <span className="flex items-center gap-1" role="group" aria-label={hi ? 'अक्षर का आकार' : 'Text size'}>
          {SIZES.map(([v, l, label]) => (
            <button key={v} type="button" onClick={() => setSize(v)} aria-pressed={size === v} aria-label={label}
              className={clsx('min-w-6 h-6 px-1 rounded border text-[11.5px] font-semibold', size === v ? 'bg-[#E7EDEA] text-primary-dark border-[#E7EDEA]' : 'border-white/35')}>{l}</button>
          ))}
        </span>
        <span className="flex items-center gap-2" role="group" aria-label="Language">
          <button type="button" onClick={() => setLang('en')} aria-pressed={!hi} className={clsx(!hi && 'font-bold underline underline-offset-2')}>English</button>
          <button type="button" onClick={() => setLang('hi')} aria-pressed={hi} lang="hi" className={clsx(hi && 'font-bold underline underline-offset-2')}>हिन्दी</button>
        </span>
      </div>
    </div>
  );
}

export function GovFooter() {
  const { lang } = usePrefs();
  const hi = lang === 'hi';
  return (
    <footer className="border-t border-line mt-10 px-5 xl:px-7 py-4 text-[12px] text-ink-muted flex flex-wrap gap-x-5 gap-y-1">
      <Link to="/accessibility" className="hover:text-ink underline-offset-2 hover:underline">{hi ? 'सुगम्यता विवरण' : 'Accessibility statement'}</Link>
      <Link to="/accessibility#help" className="hover:text-ink underline-offset-2 hover:underline">{hi ? 'सहायता' : 'Help'}</Link>
      <span>{hi ? 'क्षेत्र सिविल कार्यालय हेल्पलाइन' : 'Area Civil Office helpline'} 07805-224000</span>
      <span className="flex-1" />
      <span>{hi ? 'अंतिम अद्यतन' : 'Last updated'} {LAST_UPDATED}</span>
    </footer>
  );
}

/** The accessibility statement: what the portal does, against what standard, and what it does not do yet. */
export function AccessibilityPage() {
  return (
    <div className="min-h-full bg-bg">
      <GovStrip />
      <main id="main" tabIndex={-1} className="max-w-[760px] mx-auto px-5 py-10 focus:outline-none">
        <Link to="/" className="text-primary text-sm">← Colony Maintenance Portal</Link>
        <h1 className="text-[32px] text-primary mt-4">Accessibility statement</h1>
        <p className="text-ink-muted mt-2">Northern Coalfields Limited, Civil Department · Colony Maintenance Portal · last updated {LAST_UPDATED}</p>
        <div className="grid gap-6 mt-8 text-[15px] leading-relaxed">
          <section><h2 className="text-lg font-semibold">The standard we work to</h2>
            <p className="mt-2">The portal is built to the Guidelines for Indian Government Websites and Apps (GIGW 3.0), which are based on the Web Content Accessibility Guidelines (WCAG 2.1) and the Rights of Persons with Disabilities Act, 2016. It has not yet been audited or certified against them.</p></section>
          <section><h2 className="text-lg font-semibold">What you can do</h2>
            <ul className="mt-2 list-disc pl-5 grid gap-1">
              <li>Read it in English or Hindi, chosen at the top of every page.</li>
              <li>Make text larger or smaller with A− A A+ at the top of every page; the choice is remembered in this browser.</li>
              <li>Skip to the main content from the top of every page, and use every action from the keyboard. In the officer's inbox, ↑ ↓ move between complaints, Enter opens one, and Ctrl K goes to any complaint by its number or quarter.</li>
              <li>Use a light or dark theme, and have movement switched off when your device asks for reduced motion.</li>
              <li>Read the status of a complaint as words and a symbol, never by colour alone.</li>
            </ul></section>
          <section><h2 className="text-lg font-semibold">Known gaps</h2>
            <ul className="mt-2 list-disc pl-5 grid gap-1">
              <li>Hindi covers the resident's screens; the officers' screens are still partly in English. The Hindi text is awaiting review by NCL's Rajbhasha cell.</li>
              <li>Charts on the HQ dashboard have text equivalents for their figures, but not yet a full table view for every chart.</li>
              <li>Inspection photographs have no text description beyond their place, time and complaint.</li>
            </ul></section>
          <section id="help"><h2 className="text-lg font-semibold">Help and contact</h2>
            <p className="mt-2">If something in the portal does not work for you, call the Area Civil Office helpline, 07805-224000 (24 hours), or write to your Area Civil Office. Tell us the page and what you were trying to do.</p></section>
        </div>
      </main>
    </div>
  );
}
