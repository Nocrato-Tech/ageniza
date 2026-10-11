import type { ReactNode } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { AuthSessionSnapshot } from './auth.js';
import { AccountMenu } from './account-menu.js';
import { AgencyAreaLayout, AgencyHomePage, AgencyPermissionRoute } from './agency.js';
import { LiveStatus } from '@ageniza/ui';
import { ClientBrandStudyTab } from './brand-study.js';
import { ClientDetailPage, ClientGeneralTab, ClientSkeletonTab } from './client-detail.js';
import { ClientsPage } from './clients.js';
import { CollaboratorsPage } from './collaborators.js';
import { ContentCreateRoute, ContentModalRoute } from './content-modal.js';
import { ContentsClientPage, ContentsPage } from './contents.js';
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
import { ClientAccessTab } from './portal-access.js';
import { PortalAreaLayout, PortalHomePage, PortalSkeletonPage } from './portal.js';
import { PortalContentsPage } from './portal-contents.js';
import { PortalBrandPage } from './portal-brand.js';
import { PortalContentPage } from './portal-content.js';
import { ResetPasswordPage } from './reset-password.js';
import { SessionWatch } from './session-watch.js';
import { LoadingPage, NotFoundPage, SessionGate } from './status-pages.js';

/** Contents and the roster behind its picker: both are needed to open the area. */
const CONTENT_AREA_PERMISSIONS = ['conteudo.visualizar', 'cliente.visualizar'] as const;

export function PublicLayout() {
  return <div className="app-shell"><a className="skip-link" href="#main-content">Pular para o conteúdo</a><header><Link to="/">Ageniza</Link></header><main id="main-content"><Outlet /></main></div>;
}

export function ProtectedLayout({ session, children }: { session: AuthSessionSnapshot; children?: ReactNode }) {
  return <SessionGate session={session}>
    <SessionWatch />
    <div className="app-shell"><a className="skip-link" href="#main-content">Pular para o conteúdo</a><header className="protected-header"><Link to="/">Ageniza</Link><AccountMenu user={session.user} /></header><main id="main-content">{children ?? <Outlet />}</main></div>
  </SessionGate>;
}

/** The portal's address from before it was Conteúdos: the e-mail to the client still points at it (#571). */
function PortalCalendarRedirect() {
  const { clienteId = '' } = useParams();
  const { search } = useLocation();
  return <Navigate to={{ pathname: `/portal/${encodeURIComponent(clienteId)}/conteudos`, search }} replace />;
}

function PublicHome() { return <section><h1>Ageniza</h1><p>Operações de agência, em um só lugar.</p><Link to="/status">Status do serviço</Link></section>; }
function ServiceStatus() {
  const httpClient = useApiClient();
  const health = useQuery({ queryKey: ['health'], queryFn: () => getHealth(httpClient) });
  if (health.isPending) return <LoadingPage />;
  if (health.isError) return <section><h1>Status do serviço</h1><p role="alert">O status está temporariamente indisponível.</p></section>;
  return <section><h1>Status do serviço</h1><LiveStatus>A API está {health.data.status}.</LiveStatus></section>;
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
    <Route path="agencia/:agenciaId" element={<SessionGate session={session}><SessionWatch /><AgencyAreaLayout /></SessionGate>}>
      <Route index element={<AgencyHomePage />} />
      <Route path="colaboradores" element={
        <AgencyPermissionRoute permission="colaborador.visualizar">
          <CollaboratorsPage />
        </AgencyPermissionRoute>
      } />
      <Route path="conteudos">
        <Route index element={
          <AgencyPermissionRoute permission={CONTENT_AREA_PERMISSIONS}>
            <ContentsPage />
          </AgencyPermissionRoute>
        } />
        <Route path=":clienteId" element={
          <AgencyPermissionRoute permission={CONTENT_AREA_PERMISSIONS}>
            <ContentsClientPage />
          </AgencyPermissionRoute>
        }>
          {/* The modal of a content is a route of its own, over the calendar: the address is shareable and survives a reload. */}
          <Route path="novo" element={<ContentCreateRoute />} />
          <Route path=":conteudoId" element={<ContentModalRoute />} />
        </Route>
      </Route>
      <Route path="clientes">
        <Route index element={
          <AgencyPermissionRoute permission="cliente.visualizar">
            <ClientsPage />
          </AgencyPermissionRoute>
        } />
        <Route path=":clienteId" element={
          <AgencyPermissionRoute permission="cliente.visualizar">
            <ClientDetailPage />
          </AgencyPermissionRoute>
        }>
          {/* The tab lives in the URL: a bare address goes to Geral (specs/clientes.md §7). */}
          <Route index element={<Navigate to="geral" replace />} />
          <Route path="geral" element={<ClientGeneralTab />} />
          {/* The same view of the client as the Conteúdos screen, with its modal over it; the permission gate is in ClientDetailPage. */}
          <Route path="conteudos" element={<ContentsClientPage pinned />}>
            <Route path="novo" element={<ContentCreateRoute />} />
            <Route path=":conteudoId" element={<ContentModalRoute />} />
          </Route>
          <Route path="tarefas" element={<ClientSkeletonTab title="Tarefas" description="Aqui vão ficar as tarefas deste cliente, com prazos e responsáveis." />} />
          <Route path="estudo-de-marca" element={<ClientBrandStudyTab />} />
          <Route path="relatorios" element={<ClientSkeletonTab title="Relatórios" description="Aqui vai ficar o relatório deste cliente, com os resultados do trabalho." />} />
          {/* The permission gate lives in ClientDetailPage: without it the whole address is the
              ordinary not-found, header included, not a not-found inside a visible client page. */}
          <Route path="acessos" element={<ClientAccessTab />} />
          <Route path="*" element={<NotFoundPage as="section" />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage as="section" />} />
    </Route>
    {/* The portal carries its own shell (header and bottom bar), like the agency area: the generic
        protected header never stacks above it (specs/clientes.md §7). */}
    <Route path="portal/:clienteId" element={<SessionGate session={session}><SessionWatch /><PortalAreaLayout /></SessionGate>}>
      <Route index element={<Navigate to="inicio" replace />} />
      <Route path="inicio" element={<PortalHomePage />} />
      <Route path="conteudos" element={<PortalContentsPage />} />
      <Route path="conteudos/:conteudoId" element={<PortalContentPage />} />
      <Route path="calendario" element={<PortalCalendarRedirect />} />
      <Route path="marca" element={<PortalBrandPage />} />
      <Route path="relatorios" element={<PortalSkeletonPage title="Relatórios" description="Aqui você vai ver os resultados do trabalho que sua agência faz para você." />} />
      <Route path="*" element={<NotFoundPage as="section" />} />
    </Route>
    <Route element={<ProtectedLayout session={session} />}>
      <Route path="contextos" element={<ContextSelectPage />} />
      {/* `/app` is not a destination anymore; the resolve decides where the person enters. */}
      <Route path="app" element={<Navigate to="/contextos" replace />} />
    </Route>
    <Route path="*" element={session.isAuthenticated
      ? <ProtectedLayout session={session}><NotFoundPage as="section" home="/contextos" /></ProtectedLayout>
      : <NotFoundPage />} />
  </Routes>;
}
