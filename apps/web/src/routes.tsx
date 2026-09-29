import { Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { AuthSessionSnapshot } from './auth.js';
import { LiveStatus } from '@ageniza/ui';
import { ForgotPasswordPage } from './forgot-password.js';
import { getHealth } from './health.js';
import { useApiClient } from './http.js';
import { LegalDocumentPage } from './legal-pages.js';
import { privacyPolicy } from './legal/privacy.js';
import { termsOfUse } from './legal/terms.js';

export function LoadingPage() {
  return <main className="page-status"><LiveStatus>Loading your workspace…</LiveStatus></main>;
}

export function NotFoundPage() {
  return <main className="page-status"><h1>Page not found</h1><p>The address does not match an Ageniza page.</p><Link to="/">Return home</Link></main>;
}

export function PublicLayout() {
  return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to content</a><header><Link to="/">Ageniza</Link></header><main id="main-content"><Outlet /></main></div>;
}

export function ProtectedLayout({ session }: { session: AuthSessionSnapshot }) {
  if (session.status === 'loading') return <LoadingPage />;
  if (!session.isAuthenticated) return <main className="page-status"><h1>Workspace unavailable</h1><p>This area requires a current session.</p></main>;
  return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to content</a><header>Ageniza workspace</header><main id="main-content"><Outlet /></main></div>;
}

function PublicHome() { return <section><h1>Ageniza</h1><p>Agency operations, in one place.</p><Link to="/status">Service status</Link></section>; }
function ServiceStatus() {
  const httpClient = useApiClient();
  const health = useQuery({ queryKey: ['health'], queryFn: () => getHealth(httpClient) });
  if (health.isPending) return <LoadingPage />;
  if (health.isError) return <section><h1>Service status</h1><p role="alert">Status is temporarily unavailable.</p></section>;
  return <section><h1>Service status</h1><LiveStatus>API is {health.data.status}.</LiveStatus></section>;
}
function WorkspaceHome() { return <section><h1>Workspace</h1><p>Your protected workspace is ready for its first module.</p></section>; }

/** Explicit public and protected route trees; protected content is never rendered until a session exists. */
export function ApplicationRoutes({ session }: { session: AuthSessionSnapshot }) {
  return <Routes>
    <Route element={<PublicLayout />}>
      <Route index element={<PublicHome />} />
      <Route path="status" element={<ServiceStatus />} />
      <Route path="senha/esquecida" element={session.isAuthenticated ? <Navigate to="/app" replace /> : <ForgotPasswordPage />} />
      <Route path="termos" element={<LegalDocumentPage document={termsOfUse} sibling={{ title: 'Política de Privacidade', to: '/privacidade' }} />} />
      <Route path="privacidade" element={<LegalDocumentPage document={privacyPolicy} sibling={{ title: 'Termos de Uso', to: '/termos' }} />} />
    </Route>
    <Route element={<ProtectedLayout session={session} />}>
      <Route path="app" element={<WorkspaceHome />} />
    </Route>
    <Route path="*" element={<NotFoundPage />} />
  </Routes>;
}
