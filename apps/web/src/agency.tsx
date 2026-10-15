import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useParams } from 'react-router-dom';
import { Briefcase, CalendarDays, ChevronRight, Users, type LucideIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { AgencyMeResponseSchema, type AgencyMeResponse } from '@ageniza/contracts';
import { AccountMenu } from './account-menu.js';
import { AgencySidebar, AgencySidebarSkeleton } from './agency-nav.js';
import { Button, ButtonLink, EmptyState, Logo, Skeleton } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';
import { InvitationNotice } from './invitation-notice.js';
import { LegalNotice } from './legal-notice.js';
import { StatusPanel } from './status-panel.js';
import { NotFoundHomeContext, NotFoundPage } from './status-pages.js';

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
  return <StatusPanel as="section" alert titleId="agency-unavailable-title" title="Não foi possível abrir a agência" action={<Button size="lg" onClick={onRetry}>Tentar de novo</Button>}>
    Tente de novo em instantes.
  </StatusPanel>;
}

/**
 * The agency shell before its context is known: a malformed or unreachable id, a failure to open, or
 * a load in progress. The person is authenticated and has no agency to show, so the header keeps the
 * account menu (the only way out of these screens) and nothing else.
 */
function AgencyContextlessShell({ children }: { children: ReactNode }) {
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Pular para o conteúdo</a>
    <header className="agency-header"><Link to="/contextos"><Logo variant="on-dark" height={30} /></Link><AccountMenu /></header>
    <div className="agency-layout">
      <main className="agency-content" id="main-content">{children}</main>
    </div>
  </div>;
}

function AgencyShellSkeleton() {
  return <div className="app-shell agency-shell">
    <AgencySidebarSkeleton />
    <div className="agency-body">
      <main className="agency-content" id="main-content"><Skeleton /><Skeleton /></main>
    </div>
  </div>;
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

  if (!validAgencyId) return <AgencyContextlessShell><NotFoundPage as="section" home="/contextos" /></AgencyContextlessShell>;
  if (error !== null) {
    if (isNotFound(error)) return <AgencyContextlessShell><NotFoundPage as="section" home="/contextos" /></AgencyContextlessShell>;
    return <AgencyContextlessShell><AgencyUnavailable onRetry={() => { void refetch(); }} /></AgencyContextlessShell>;
  }
  if (data === undefined) return <AgencyShellSkeleton />;
  // Defense in depth: the answer must belong to the agency in the route, or it is not shown at all.
  if (data.agencyId !== agenciaId) return <AgencyContextlessShell><NotFoundPage as="section" home="/contextos" /></AgencyContextlessShell>;

  return <AgencyAreaContext.Provider value={data}>
    <div className="app-shell agency-shell">
      <a className="skip-link" href="#main-content">Pular para o conteúdo</a>
      <AgencySidebar agenciaId={agenciaId} agencyName={data.agencyName} permissions={data.permissions} />
      <div className="agency-body">
        <LegalNotice />
        <main className="agency-content" id="main-content"><InvitationNotice /><NotFoundHomeContext.Provider value={`/agencia/${data.agencyId}`}><Outlet /></NotFoundHomeContext.Provider></main>
      </div>
    </div>
  </AgencyAreaContext.Provider>;
}

/**
 * A module the person cannot see is not a screen: the item is absent from the menu and the typed
 * URL lands on the same "não encontrado" as any unknown address.
 */
export function AgencyPermissionRoute({ permission, children }: { permission: string | readonly string[]; children: ReactNode }) {
  const { permissions } = useAgencyContext();
  const allowed = (typeof permission === 'string' ? [permission] : permission).every((required) => permissions.includes(required));
  if (!allowed) return <NotFoundPage as="section" />;
  return <>{children}</>;
}

interface Shortcut {
  to: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

export function AgencyHomePage() {
  const agency = useAgencyContext();
  const canSeeCollaborators = useCan('colaborador.visualizar');
  const canSeeClients = useCan('cliente.visualizar');
  // The same condition as the menu: Conteúdos needs the roster behind its picker.
  const canSeeContents = useCan('conteudo.visualizar') && canSeeClients;
  useDocumentTitle(`${agency.agencyName} — Ageniza`);

  const shortcuts: Shortcut[] = [
    ...(canSeeContents ? [{ to: 'conteudos', label: 'Conteúdos', description: 'Calendário do mês, aprovação e roteiros de stories.', icon: CalendarDays }] : []),
    ...(canSeeClients ? [{ to: 'clientes', label: 'Clientes', description: 'Carteira, estudo de marca e conversas.', icon: Briefcase }] : []),
    ...(canSeeCollaborators ? [{ to: 'colaboradores', label: 'Equipe', description: 'Colaboradores, papéis e convites.', icon: Users }] : [])
  ];

  return <section aria-labelledby="agency-home-title" className="agency-home">
    <h1 id="agency-home-title">{agency.agencyName}</h1>
    {shortcuts.length === 0
      ? <EmptyState
          className="agency-home__empty"
          title="Nenhum módulo disponível para o seu papel"
          description="Fale com quem administra a agência para liberar o acesso. Se você participa de outra agência, troque de contexto."
          action={<ButtonLink as={Link} to="/contextos" variant="secondary">Trocar de contexto</ButtonLink>}
        />
      : <ul className="agency-shortcuts">
          {shortcuts.map(({ to, label, description, icon: Icon }) => <li key={to}>
            <Link className="agency-shortcut" to={to}>
              <Icon className="agency-shortcut__icon" aria-hidden="true" />
              <span className="agency-shortcut__text">
                <span className="agency-shortcut__label">{label}</span>
                <span className="agency-shortcut__description">{description}</span>
              </span>
              <ChevronRight className="agency-shortcut__chevron" aria-hidden="true" />
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
