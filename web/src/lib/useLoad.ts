import { useCallback, useEffect, useRef, useState } from 'react';

/** Load once, reload on demand. Errors are shown, never swallowed. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await run()); setError(null); }
    catch (e: any) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [run]);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

/**
 * Keeps a page current without a push service: calls `tick` every
 * `seconds` while the tab is visible, and as soon as it comes back into
 * view. Paused while a form is open, so a reload never discards typing.
 * (User's finding, 2026-10-10: a status changed elsewhere did not show.)
 */
export function useAutoRefresh(tick: () => void, seconds = 30, paused = false) {
  const ref = useRef(tick);
  ref.current = tick;
  useEffect(() => {
    if (paused) return;
    const fire = () => { if (document.visibilityState === 'visible') ref.current(); };
    const timer = window.setInterval(fire, seconds * 1000);
    document.addEventListener('visibilitychange', fire);
    window.addEventListener('focus', fire);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', fire); window.removeEventListener('focus', fire); };
  }, [seconds, paused]);
}
