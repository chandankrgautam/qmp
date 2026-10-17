import { flushSync } from 'react-dom';
import type { NavigateFunction, To } from 'react-router-dom';

/* Shared-element transitions on the phone screens: the complaint card on
   the home screen grows into the complaint page, and shrinks back into the
   list on Back. Uses the browser's View Transitions; elements that share a
   view-transition-name (card-<id>, ring-<id>) are morphed by the browser.
   Where the API is missing, or motion is reduced, it is a plain navigation.
   (The Android app does the same with Compose shared elements, where the
   system back gesture previews it — predictive back.) */

type VT = { startViewTransition?: (cb: () => void) => unknown };

export function vtNavigate(nav: NavigateFunction, to: To | number, back = false) {
  const go = () => (typeof to === 'number' ? nav(to) : nav(to));
  const doc = document as unknown as VT;
  if (!doc.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) { go(); return; }
  document.documentElement.dataset.vtDir = back ? 'back' : 'forward';
  doc.startViewTransition(() => flushSync(go));
}

export const vtName = (kind: 'card' | 'ring' | 'title', id: string) => ({ viewTransitionName: `${kind}-${id.replace(/[^a-z0-9-]/gi, '')}` });
