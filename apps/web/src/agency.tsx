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

const AgencyAreaContext = createContext<AgencyMeResponse | null>(null);

export const useAgencyContext = (): AgencyMeResponse => {
  const agency = useContext(AgencyAreaContext);
  if (agency === null) throw new Error('AgencyAreaContext is required.');
  return agency;
};

export const useCan = (permission: string): boolean => useAgencyContext().permissions.includes(permission);

const isNotFound = (error: unknown): boolean => error instanceof HttpClientError && error.status === 404;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function AgencyUnavailable({ onRetry }: { onRetry: () => void }) {
  useDocumentTitle('Não foi possível abrir a agência — Ageniza');
  return <main className='page-status'>
    <div role='alert'>
      <h1>Não foi possível abrir a agência</h1>
      <p>Tente de novo em instantes.</p>
      <Button onClick={onRetry}>Tentar de novo</Button>
    </div>
  </main>;
}

function AgencyShellSkeleton() {
  return <div className='app-shell'>
    <header className='agency-header'><Skeleton className='agency-header__skeleton' /></header>
    <div className='agency-layout'>
      <nav className='agency-nav' aria-label='Navegação da agência'><Skeleton /></nav>
      <main className='agency-content' id='main-content'><Skeleton /><Skeleton /></main>
    </div>
  </div>;
}

function AgencyNav({ agenciaId }: { agenciaId: string }) {
  const canSeeCollaborators = useCan('colaborador.visualizar');
  const canSeeClients = useCan('cliente.visualizar');
  return <nav className='agency-nav' aria-label='Navegação da agência'>
    <ul>
      <li><NavLink to={'/agencia/' + agenciaId} end>Início</NavLink></li>
      {canSeeCollaborators && <li><NavLink to={'/agencia/' + agenciaId + '/colaboradores'}>Colaboradores</NavLink></li>}
      {canSeeClients && <li><NavLink to={'/agencia/' + agenciaId + '/clientes'}>Clientes</NavLink></li>}
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
    enabled: validAgencyId
  });

  useEffect(() => {
    if (!validAgencyId) return;
    void refetch();
  }, [location.pathname, refetch, validAgencyId]);

  if (!validAgencyId) return <NotFoundPage as='section' />;
  if (error !== null) {
    if (isNotFound(error)) return <NotFoundPage as='section' />;
    return <AgencyUnavailable onRetry={() => { void refetch(); }} />;
  }
  if (data === undefined) return <AgencyShellSkeleton />;
  if (data.agencyId !== agenciaId) return <NotFoundPage as='section' />;

  return <AgencyAreaContext.Provider value={data}>
    <div className='app-shell'>
      <a className='skip-link' href='#main-content'>Pular para o conteúdo</a>
      <header className='agency-header'>
        <div className='agency-header__context'>
          <span className='agency-header__context-label'>Contexto ativo</span>
          <Link className='agency-header__name' to={'/agencia/' + agenciaId}>{data.agencyName}</Link>
        </div>
        <AccountMenu activeContext={data.agencyName} />
      </header>
      <div className='agency-layout'>
        <AgencyNav agenciaId={agenciaId} />
        <main className='agency-content' id='main-content'><Outlet /></main>
      </div>
    </div>
  </AgencyAreaContext.Provider>;
}

export function AgencyPermissionRoute({ permission, children }: { permission: string; children: ReactNode }) {
  const allowed = useCan(permission);
  if (!allowed) return <NotFoundPage as='section' />;
  return <>{children}</>;
}

export function AgencyHomePage() {
  const agency = useAgencyContext();
  const canSeeCollaborators = useCan('colaborador.visualizar');
  const canSeeClients = useCan('cliente.visualizar');
  useDocumentTitle(agency.agencyName + ' — Ageniza');

  const shortcuts = [
    ...(canSeeCollaborators ? [{ to: 'colaboradores', label: 'Colaboradores', description: 'Equipe, papéis e convites.' }] : []),
    ...(canSeeClients ? [{ to: 'clientes', label: 'Clientes', description: 'Carteira, estudo de marca e conversas.' }] : [])
  ];

  return <section aria-labelledby='agency-home-title'>
    <h1 id='agency-home-title'>{agency.agencyName}</h1>
    {shortcuts.length === 0
      ? <p>Nenhum módulo disponível para o seu papel. Fale com quem administra a agência.</p>
      : <ul className='agency-shortcuts'>
          {shortcuts.map((shortcut) => <li key={shortcut.to}>
            <Link className='agency-shortcut' to={shortcut.to}>
              <span className='agency-shortcut__label'>{shortcut.label}</span>
              <span className='agency-shortcut__description'>{shortcut.description}</span>
            </Link>
          </li>)}
        </ul>}
  </section>;
}

export function AgencyModulePlaceholder({ title, description }: { title: string; description: string }) {
  useDocumentTitle(title + ' — Ageniza');
  return <section aria-labelledby='agency-module-title'>
    <h1 id='agency-module-title'>{title}</h1>
    <p>{description}</p>
  </section>;
}
