import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { AgencyMeResponseSchema, type AgencyMeResponse } from '@ageniza/contracts';
import { AccountMenu } from './account-menu.js';
import { Button, Skeleton } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';
import { NotFoundPage } from './status-pages.js';

/**
 * The agency area shell (issue #181). The route carries the agency (`/agencia/:agenciaId/...`), so
 * two tabs with different agencies never share state: every query key includes the id and the menu
 * is built from the permissions of that specific context.
 *
 * `GET /agencies/:agencyId/me` is the guard: it answers 404 indistinctly for a nonexistent,
 * suspended or inaccessible agency, and that 404 becomes the product's ordinary "não encontrado",
 * never an "access denied" screen (specs/autorizacao.md section 7).
 */

const AgencyAreaContext = createContext<AgencyMeResponse | null>(null);

export const useAgencyContext = (): AgencyMeResponse => {
  const agency = useContext(AgencyAreaContext);
  if (agency === null) throw new Error('AgencyAreaContext is required.');
  return agency;
};

/** UX only: the backend validates every operation against the same source (specs/autorizacao.md 7). */
export const useCan = (permission: string): boolean => useAgencyContext().permissions.includes(permission);

const isNotFound = (error: unknown): boolean => error instanceof HttpClientError && error.status === 404;

/** Same shape the API guard accepts; a malformed id never becomes a request (security review #190). */
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The API is reachable but did not answer; the screen offers the one action it can: repeat. */
function AgencyUnavailable({ onRetry }: { onRetry: () => void }) {
  useDocumentTitle('Não foi possível abrir a agência — Ageniza');
  return <section className="page-status">
    <div role="alert">
      <h1>Não foi possível abrir a agência</h1>
      <p>Tente de novo em instantes.</p>
      <Button onClick={onRetry}>Tentar de novo</Button>
    </div>
  </section>;
}

/**
 * The agency shell before its context is known: a malformed or unreachable id, a failure to open, or
 * a load in progress. The person is authenticated and has no agency to show, so the header keeps the
 * account menu (the only way out of these screens) and nothing else.
 */
function AgencyContextlessShell({ children }: { children: ReactNode }) {
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Pular para o conteúdo</a>
    <header className="agency-header"><AccountMenu /></header>
    <div className="agency-layout">
      <main className="agency-content" id="main-content">{children}</main>
    </div>
  </div>;
}

function AgencyShellSkeleton() {
  return <div className="app-shell">
    <header className="agency-header"><Skeleton className="agency-header__skeleton" /><AccountMenu /></header>
    <div className="agency-layout">
      <nav className="agency-nav" aria-label="Navegação da agência"><Skeleton /></nav>
      <main className="agency-content" id="main-content"><Skeleton /><Skeleton /></main>
    </div>
  </div>;
}

function AgencyNav({ agenciaId }: { agenciaId: string }) {
  const canSeeCollaborators = useCan('colaborador.visualizar');
  const canSeeClients = useCan('cliente.visualizar');
  return <nav className="agency-nav" aria-label="Navegação da agência">
    <ul>
      <li><NavLink to={`/agencia/${agenciaId}`} end>Início</NavLink></li>
      {canSeeCollaborators && <li><NavLink to={`/agencia/${agenciaId}/colaboradores`}>Colaboradores</NavLink></li>}
      {canSeeClients && <li><NavLink to={`/agencia/${agenciaId}/clientes`}>Clientes</NavLink></li>}
    </ul>
  </nav>;
}

export function AgencyAreaLayout() {
  const { agenciaId = '' } = useParams();
  const httpClient = useApiClient();
  const location = useLocation();
  const validAgencyId = uuidPattern.test(agenciaId);
  const { data, error, refetch } = useQuery({
    queryKey: ['agency', agenciaId, 'me'],
    queryFn: () => httpClient.request({ path: apiPath('/agencies/:agenciaId/me', { agenciaId }), response: AgencyMeResponseSchema }),
    // A malformed id is a bad address, not a request: `apiPath` would refuse it anyway, and the
    // API would answer 400. No request leaves the browser.
    enabled: validAgencyId
  });

  // Revalidates on every navigation inside the area, so an agency suspended mid-use turns the very
  // next navigation into "não encontrado" instead of serving the cached shell. React Query dedupes
  // this with the in-flight first fetch, so the initial load is still one request. A malformed id
  // never reaches this: `refetch` would bypass `enabled` and make the request the shell must not.
  useEffect(() => {
    if (!validAgencyId) return;
    void refetch();
  }, [location.pathname, refetch, validAgencyId]);

  if (!validAgencyId) return <AgencyContextlessShell><NotFoundPage as="section" /></AgencyContextlessShell>;
  if (error !== null) {
    if (isNotFound(error)) return <AgencyContextlessShell><NotFoundPage as="section" /></AgencyContextlessShell>;
    return <AgencyContextlessShell><AgencyUnavailable onRetry={() => { void refetch(); }} /></AgencyContextlessShell>;
  }
  if (data === undefined) return <AgencyShellSkeleton />;
  // Defense in depth: the answer must belong to the agency in the route, or it is not shown at all.
  if (data.agencyId !== agenciaId) return <AgencyContextlessShell><NotFoundPage as="section" /></AgencyContextlessShell>;

  return <AgencyAreaContext.Provider value={data}>
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Pular para o conteúdo</a>
      <header className="agency-header">
        <div className="agency-header__context">
          <span className="agency-header__context-label">Contexto ativo</span>
          <Link className="agency-header__name" to={`/agencia/${agenciaId}`}>{data.agencyName}</Link>
        </div>
        {/* The account menu (#70) lives here. */}
        <AccountMenu activeContext={data.agencyName} />
      </header>
      <div className="agency-layout">
        <AgencyNav agenciaId={agenciaId} />
        <main className="agency-content" id="main-content"><Outlet /></main>
      </div>
    </div>
  </AgencyAreaContext.Provider>;
}

/**
 * A module the person cannot see is not a screen: the item is absent from the menu and the typed
 * URL lands on the same "não encontrado" as any unknown address.
 */
export function AgencyPermissionRoute({ permission, children }: { permission: string; children: ReactNode }) {
  const allowed = useCan(permission);
  if (!allowed) return <NotFoundPage as="section" />;
  return <>{children}</>;
}

export function AgencyHomePage() {
  const agency = useAgencyContext();
  const canSeeCollaborators = useCan('colaborador.visualizar');
  const canSeeClients = useCan('cliente.visualizar');
  useDocumentTitle(`${agency.agencyName} — Ageniza`);

  const shortcuts = [
    ...(canSeeCollaborators ? [{ to: 'colaboradores', label: 'Colaboradores', description: 'Equipe, papéis e convites.' }] : []),
    ...(canSeeClients ? [{ to: 'clientes', label: 'Clientes', description: 'Carteira, estudo de marca e conversas.' }] : [])
  ];

  return <section aria-labelledby="agency-home-title">
    <h1 id="agency-home-title">{agency.agencyName}</h1>
    {shortcuts.length === 0
      ? <p>Nenhum módulo disponível para o seu papel. Fale com quem administra a agência.</p>
      : <ul className="agency-shortcuts">
          {shortcuts.map((shortcut) => <li key={shortcut.to}>
            <Link className="agency-shortcut" to={shortcut.to}>
              <span className="agency-shortcut__label">{shortcut.label}</span>
              <span className="agency-shortcut__description">{shortcut.description}</span>
            </Link>
          </li>)}
        </ul>}
  </section>;
}

/**
 * Reserved screen for a module whose own task has not landed yet. It says exactly that: no fake
 * data, no control that does not work (docs/design-system.md section 23).
 */
export function AgencyModulePlaceholder({ title, description }: { title: string; description: string }) {
  useDocumentTitle(`${title} — Ageniza`);
  return <section aria-labelledby="agency-module-title">
    <h1 id="agency-module-title">{title}</h1>
    <p>{description}</p>
  </section>;
}
