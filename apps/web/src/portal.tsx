import { createContext, useContext, useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { PortalClientResponseSchema, type PortalClientResponse } from '@ageniza/contracts';
import { AccountMenu } from './account-menu.js';
import { Avatar, Button, Skeleton } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { useAuthSession, useAuthSessionStore } from './auth.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';
import { InvitationNotice } from './invitation-notice.js';
import { LegalNotice } from './legal-notice.js';
import { NotFoundPage } from './status-pages.js';

/**
 * The client portal shell (specs/clientes.md §7, issue #141): mobile-first, in the client's
 * language, with the four-item bottom bar a business owner already knows. The client is the one
 * the guard proves for the address; every screen below reads it from here.
 */

export const portalClientQueryKey = (clientId: string) => ['portal', clientId, 'client'] as const;

const PortalClientContext = createContext<PortalClientResponse | null>(null);

export const usePortalClient = (): PortalClientResponse => {
  const client = useContext(PortalClientContext);
  if (client === null) throw new Error('PortalClientContext is required.');
  return client;
};

/** Same shape the API guard accepts; a malformed id never becomes a request (security review #190). */
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PORTAL_TABS = [
  { slug: 'inicio', label: 'Início' },
  { slug: 'calendario', label: 'Calendário' },
  { slug: 'marca', label: 'Marca' },
  { slug: 'relatorios', label: 'Relatórios' }
] as const;

const isNotFound = (error: unknown): boolean => error instanceof HttpClientError && error.status === 404;

/** The API is reachable but did not answer; the screen offers the one action it can: repeat. */
function PortalUnavailable({ onRetry }: { onRetry: () => void }) {
  useDocumentTitle('Não foi possível abrir o portal — Ageniza');
  return <section className="page-status">
    <div role="alert">
      <h1>Não foi possível abrir o portal</h1>
      <p>Tente de novo em instantes.</p>
      <Button onClick={onRetry}>Tentar de novo</Button>
    </div>
  </section>;
}

/** The portal before its client is known: the account menu is the only way out of these screens. */
function PortalContextlessShell({ children }: { children: React.ReactNode }) {
  return <div className="app-shell portal-shell">
    <a className="skip-link" href="#main-content">Pular para o conteúdo</a>
    <header className="portal-header"><AccountMenu /></header>
    <main className="portal-content" id="main-content">{children}</main>
  </div>;
}

function PortalShellSkeleton() {
  // The Início skeleton: the header identity, the greeting block and the next action's card.
  return <div className="app-shell portal-shell">
    <header className="portal-header">
      <div className="portal-header__identity">
        <Skeleton className="portal-header__avatar-skeleton" />
        <div className="portal-header__labels"><Skeleton className="portal-header__name-skeleton" /><Skeleton /></div>
      </div>
      <AccountMenu />
    </header>
    <main className="portal-content" id="main-content">
      <Skeleton className="portal-home__title-skeleton" />
      <Skeleton className="portal-home__action-skeleton" />
    </main>
  </div>;
}

function PortalNav({ clienteId }: { clienteId: string }) {
  return <nav className="portal-nav" aria-label="Navegação do portal">
    <ul>
      {PORTAL_TABS.map((tab) => <li key={tab.slug}>
        <NavLink end to={`/portal/${clienteId}/${tab.slug}`}>{tab.label}</NavLink>
      </li>)}
    </ul>
  </nav>;
}

export function PortalAreaLayout() {
  const { clienteId = '' } = useParams();
  const httpClient = useApiClient();
  const location = useLocation();
  const validId = uuidPattern.test(clienteId);
  const { data, error, refetch } = useQuery({
    queryKey: portalClientQueryKey(clienteId),
    queryFn: () => httpClient.request({
      path: apiPath('/clients/:clientId', { clientId: clienteId }),
      response: PortalClientResponseSchema
    }),
    // A malformed id is a bad address, not a request: the API would answer 404 anyway.
    enabled: validId
  });

  // Revalidates on every navigation inside the portal, so a link removed mid-use turns the very
  // next navigation into "não encontrado" instead of serving the cached shell. React Query dedupes
  // this with the in-flight first fetch, so the initial load is still one request.
  useEffect(() => {
    if (!validId) return;
    void refetch();
  }, [location.pathname, refetch, validId]);

  if (!validId) return <PortalContextlessShell><NotFoundPage as="section" /></PortalContextlessShell>;
  if (error !== null) {
    if (isNotFound(error)) return <PortalContextlessShell><NotFoundPage as="section" /></PortalContextlessShell>;
    return <PortalContextlessShell><PortalUnavailable onRetry={() => { void refetch(); }} /></PortalContextlessShell>;
  }
  if (data === undefined) return <PortalShellSkeleton />;
  // Defense in depth: the answer must belong to the client in the address, or it is not shown.
  if (data.id !== clienteId) return <PortalContextlessShell><NotFoundPage as="section" /></PortalContextlessShell>;

  return <PortalClientContext.Provider value={data}>
    <div className="app-shell portal-shell">
      <a className="skip-link" href="#main-content">Pular para o conteúdo</a>
      <header className="portal-header">
        <div className="portal-header__identity">
          <Avatar name={data.name} photoUrl={data.photoUrl} size="md" />
          <div className="portal-header__labels">
            <p className="portal-header__name">{data.name}</p>
            <p className="portal-header__agency">por {data.agencyName}</p>
          </div>
        </div>
        {/* The account menu (#70) lives here; the active context is the client this portal is. */}
        <AccountMenu activeContext={data.name} />
      </header>
      <LegalNotice />
      <main className="portal-content" id="main-content"><InvitationNotice /><Outlet /></main>
      <PortalNav clienteId={clienteId} />
    </div>
  </PortalClientContext.Provider>;
}

/**
 * The Início (specs/clientes.md §7, issue #141): greeting by the person's name, one next action —
 * the agency's answer when there is one, the brand study otherwise — and the approval space
 * reserved, because it is what the portal will exist to do when Conteúdo lands.
 */
export function PortalHomePage() {
  const client = usePortalClient();
  const { clienteId = '' } = useParams();
  const session = useAuthSession(useAuthSessionStore());
  useDocumentTitle('Início — Portal do cliente — Ageniza');

  const answered = client.home.threadsAnsweredByAgency;
  const nextAction = answered > 0
    ? `A agência respondeu ${answered} ${answered === 1 ? 'sugestão sua' : 'sugestões suas'}`
    : 'Conheça o estudo da sua marca';

  return <section className="portal-home" aria-labelledby="portal-home-title">
    <h1 id="portal-home-title">Olá, {session.user?.name ?? ''}</h1>
    <Link className="portal-home__action" to={`/portal/${clienteId}/marca`}>
      <span className="portal-home__action-text">{nextAction}</span>
      <span className="portal-home__action-link">ver</span>
    </Link>
    <p className="portal-home__reserved">conteúdos para aprovar (em breve)</p>
  </section>;
}

/**
 * A reserved area of the portal shell (`docs/design-system.md` §23): it says what will come, in the
 * client's language, and offers no control and no fake data. Calendário and Relatórios wait for
 * Conteúdo; the Marca address is reserved here until #143 fills it.
 */
export function PortalSkeletonPage({ title, description }: { title: string; description: string }) {
  const titleId = `portal-${title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')}-title`;
  useDocumentTitle(`${title} — Portal do cliente — Ageniza`);
  return <section className="portal-skeleton" aria-labelledby={titleId}>
    <h1 id={titleId}>{title}</h1>
    <p>{description}</p>
  </section>;
}
