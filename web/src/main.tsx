import { StrictMode, lazy, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
// V2 (F4): Noto Sans and Noto Sans Devanagari were drawn as one system —
// matching heights and stroke weights — so English and Hindi sit together.
import '@fontsource/noto-sans/400.css';
import '@fontsource/noto-sans/500.css';
import '@fontsource/noto-sans/600.css';
import '@fontsource/noto-sans/700.css';
import '@fontsource/playfair-display/600-italic.css';
import '@fontsource/noto-sans-devanagari/400.css';
import '@fontsource/noto-sans-devanagari/500.css';
import '@fontsource/noto-sans-devanagari/600.css';
import '@fontsource/noto-serif-devanagari/600.css';
import './index.css';
import { PrefsProvider } from './lib/prefs';
import { BrandLoader, ToastProvider } from './components/ui';
import { session, homeFor } from './lib/api';
import Hero from './pages/Hero';
import SignIn, { Register, SetPassword } from './pages/SignIn';
import { AccessibilityPage } from './components/shell/GovFrame';

const Resident = lazy(() => import('./pages/Resident'));
const Contractor = lazy(() => import('./pages/Contractor'));
const Officer = lazy(() => import('./pages/Officer'));

/** A signed-in page; anyone else goes to sign in. */
function Guard({ roles, children }: { roles?: string[]; children: ReactNode }) {
  const s = session.get();
  if (!s) return <Navigate to="/signin" replace />;
  if (roles && !roles.includes(s.role)) return <Navigate to={homeFor(s.role)} replace />;
  return <>{children}</>;
}
const OCC = ['RESIDENT', 'CUSTODIAN'];

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="grain" aria-hidden />
    <PrefsProvider>
      <ToastProvider>
        <BrowserRouter>
          <Suspense fallback={<BrandLoader className="min-h-screen" />}>
            <Routes>
              <Route path="/" element={<Hero />} />
              <Route path="/signin" element={<SignIn />} />
              <Route path="/register" element={<Register />} />
              <Route path="/password" element={<SetPassword />} />
              <Route path="/accessibility" element={<AccessibilityPage />} />
              <Route path="/m/*" element={<Guard><MobileRoutes /></Guard>} />
              <Route path="/w/*" element={<Guard><Officer /></Guard>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </ToastProvider>
    </PrefsProvider>
  </StrictMode>
);

function MobileRoutes() {
  const s = session.get()!;
  return OCC.includes(s.role) ? <Resident /> : s.role === 'CONTRACTOR_SUPERVISOR' && s.amr !== 'otp' ? <Contractor /> : <Navigate to={homeFor(s.role)} replace />;
}
