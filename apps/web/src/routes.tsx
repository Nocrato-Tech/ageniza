import type { ReactNode } from 'react';
import { Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { AuthSessionSnapshot } from './auth.js';
import { AccountMenu } from './account-menu.js';
import { AgencyAreaLayout, AgencyHomePage, AgencyModulePlaceholder, AgencyPermissionRoute } from './agency.js';
import { LiveStatus } from '@ageniza/ui';
import { CollaboratorsPage } from './collaborators.js';
import { ContextSelectPage } from './contexts.js';
import { ConfirmEmailChangePage } from './email-change.js';
import { ForgotPasswordPage } from './forgot-password.js';
import { getHealth } from './health.js';
import { useApiClient } from './http.js';
import { InvitationPage } from './invite.js';
import { LegalDocumentPage } from './legal-pages.js';
import { privacyPolicy } from './legal/privacy.js';
import { termsOfUse } from './legal/terms.js';
import { LoginPage } from './login.js';
import { NoAccessPage } from './no-access.js';
import { PortalAreaLayout, PortalHomePage } from './portal.js';
import { ResetPasswordPage } from './reset-password.js';
import { LoadingPage, NotFoundPage, SessionGate } from './status-pages.js';

export function PublicLayout() {
  return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to content</a><header><Link to="/">Ageniza</Link></header><main id="main-content"><Outlet /></main></div>;
}

export function ProtectedLayout({ session, children }: { session: AuthSessionSnapshot; children?: ReactNode }) {
  return <SessionGate session={session}>
    <div className="app-shell"><a className="skip-link" href="#main-content">Skip to content</a><header className="protected-header"><Link to="/">Ageniza</Link><AccountMenu user={session.user} /></header><main id="main-content">{children ?? <Outlet />}</main></div>
  </SessionGate>;
}

function PublicHome() { return <section><h1>Ageniza</h1><p>Agency operations, in one place.</p><Link to="/status">Service status</Link></section>; }
function ServiceStatus() {
  const httpClient = useApiClient();
  const health = useQuery({ queryKey: ['health'], queryFn: () => getHealth(httpClient) });
  if (health.isPending) return <LoadingPage />;
  if (health.isError) return <section><h1>Service status</h1><p role="alert">Status is temporarily unavailable.</p></section>;
  return <section><h1>Service status</h1><LiveStatus>API is {health.data.status}.</LiveStatus></section>;
}

/**
 * Explicit public and protected route trees; protected content is never rendered until a session
 * exists. The agency area lives under `/agencia/:agenciaId/...` (docs/business/decisions.md,
 * 2026-09-29) and carries its own shell, because the agency name and the permission-built menu
 * depend on that context; `/app` is only a redirect into the resolve.
 */
export function ApplicationRoutes({ session }: { session: AuthSessionSnapshot }) {
  return <Routes>
    <Route element={<PublicLayout />}>
      <Route index element={<PublicHome />} />
      <Route path="status" element={<ServiceStatus />} />
      <Route path="entrar" element={<LoginPage />} />
      <Route path="sem-acesso" element={session.isAuthenticated ? <Navigate to="/app" replace /> : <NoAccessPage />} />
      <Route path="senha/esquecida" element={session.isAuthenticated ? <Navigate to="/app" replace /> : <ForgotPasswordPage />} />
      <Route path="senha/redefinir" element={<ResetPasswordPage />} />
      <Route path="convite/:token" element={<InvitationPage />} />
      <Route path="email/confirmar" element={<ConfirmEmailChangePage />} />
      <Route path="termos" element={<LegalDocumentPage document={termsOfUse} sibling={{ title: 'Política de Privacidade', to: '/privacidade' }} />} />
      <Route path="privacidade" element={<LegalDocumentPage document={privacyPolicy} sibling={{ title: 'Termos de Uso', to: '/termos' }} />} />
    </Route>
    <Route path="agencia/:agenciaId" element={<SessionGate session={session}><AgencyAreaLayout /></SessionGate>}>
      <Route index element={<AgencyHomePage />} />
      <Route path="colaboradores" element={
        <AgencyPermissionRoute permission="colaborador.visualizar">
          <CollaboratorsPage />
        </AgencyPermissionRoute>
      } />
      <Route path="clientes" element={
        <AgencyPermissionRoute permission="cliente.visualizar">
          <AgencyModulePlaceholder title="Clientes" description="Esta área recebe a carteira, o estudo de marca e as conversas nas próximas entregas." />
        </AgencyPermissionRoute>
      } />
      <Route path="*" element={<NotFoundPage as="section" />} />
    </Route>
    <Route element={<ProtectedLayout session={session} />}>
      <Route path="portal/:clienteId" element={<PortalAreaLayout />}>
        <Route index element={<PortalHomePage />} />
      </Route>
      <Route path="contextos" element={<ContextSelectPage />} />
      {/* `/app` is not a destination anymore; the resolve decides where the person enters. */}
      <Route path="app" element={<Navigate to="/contextos" replace />} />
    </Route>
    <Route path="*" element={session.isAuthenticated
      ? <ProtectedLayout session={session}><NotFoundPage as="section" /></ProtectedLayout>
      : <NotFoundPage />} />
  </Routes>;
}
