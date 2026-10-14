import { createContext, useContext } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { ButtonLink, LiveStatus } from '@ageniza/ui';

import type { AuthSessionSnapshot } from './auth.js';
import { useDocumentTitle } from './document-title.js';
import { loginNavigation } from './session-end.js';
import { StatusPanel } from './status-panel.js';

export function LoadingPage() {
  return <main className="page-status"><LiveStatus>Carregando…</LiveStatus></main>;
}

/** Where "Voltar ao início" leads: each verified area publishes its own start, so the link never crosses sides. */
export const NotFoundHomeContext = createContext('/');

/**
 * The single "não encontrado" of the product: unknown address, no permission, or 404 from the API.
 * `as="section"` is for the agency shell, which already renders the page `<main>`; a landmark must
 * not be nested inside another one.
 */
export function NotFoundPage({ as: Landmark = 'main', home }: { as?: 'main' | 'section'; home?: string } = {}) {
  useDocumentTitle('Página não encontrada — Ageniza');
  const areaHome = useContext(NotFoundHomeContext);
  return <StatusPanel as={Landmark} titleId="not-found-title" title="Página não encontrada" action={<ButtonLink as={Link} size="lg" to={home ?? areaHome}>Voltar ao início</ButtonLink>}>
    Este endereço não corresponde a uma página do Ageniza.
  </StatusPanel>;
}

/** The session is gone: say so, and offer the way back in. The login keeps the address for the return. */
function SessionEndedPage() {
  const location = useLocation();
  useDocumentTitle('Área indisponível — Ageniza');
  return <StatusPanel titleId="session-ended-title" title="Área indisponível" action={<ButtonLink as={Link} size="lg" {...loginNavigation(location)}>Entrar de novo</ButtonLink>}>
    Esta área exige uma sessão ativa.
  </StatusPanel>;
}

/**
 * Session gate shared by the protected trees. It never guesses: while the session is loading it
 * shows the loading page, and without a session it shows the same "unavailable" message every
 * protected area already used.
 */
export function SessionGate({ session, children }: { session: AuthSessionSnapshot; children: React.ReactNode }) {
  if (session.status === 'loading') return <LoadingPage />;
  if (!session.isAuthenticated) return <SessionEndedPage />;
  return <>{children}</>;
}
