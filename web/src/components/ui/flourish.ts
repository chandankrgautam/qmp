/* A brief flourish for the two moments that end a complaint well: the
   Overseer closing it, and the occupant confirming the fix. Kept for those
   two only, so it keeps meaning something. Drawn straight into the page (no
   React state), gone in 1.6 s, never blocks a click; under reduced motion
   it shows still and leaves sooner. */

export function celebrate(text: string, sub?: string) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.className = 'flourish';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  const sparks = still ? '' : Array.from({ length: 10 }, (_, i) =>
    `<i style="--a:${i * 36}deg;--d:${(i % 3) * 40}ms"></i>`).join('');
  el.innerHTML = `
    <div class="flourish-card">
      <div class="flourish-mark">
        <svg viewBox="0 0 56 56" width="64" height="64" aria-hidden="true">
          <circle cx="28" cy="28" r="25" fill="none" stroke="currentColor" stroke-width="3" class="flourish-ring"/>
          <path d="M17 29l7 7 15-16" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" class="flourish-tick"/>
        </svg>
        <span class="flourish-sparks">${sparks}</span>
      </div>
      <div class="flourish-text"></div>
      <div class="flourish-sub"></div>
    </div>`;
  (el.querySelector('.flourish-text') as HTMLElement).textContent = text;
  (el.querySelector('.flourish-sub') as HTMLElement).textContent = sub || '';
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), still ? 900 : 1300);
  setTimeout(() => el.remove(), still ? 1200 : 1700);
}
