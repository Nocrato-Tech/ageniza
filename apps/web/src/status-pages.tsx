import { createContext, useContext } from 'react';
import { Link } from 'react-router-dom';

import { LiveStatus } from '@ageniza/ui';

import type { AuthSessionSnapshot } from './auth.js';
import { useDocumentTitle } from './document-title.js';

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
  return <Landmark className="page-status" aria-labelledby="not-found-title">
    <h1 id="not-found-title">Página não encontrada</h1>
    <p>Este endereço não corresponde a uma página do Ageniza.</p>
    <Link to={home ?? areaHome}>Voltar ao início</Link>
  </Landmark>;
}

/**
 * Session gate shared by the protected trees. It never guesses: while the session is loading it
 * shows the loading page, and without a session it shows the same "unavailable" message every
 * protected area already used.
 */
export function SessionGate({ session, children }: { session: AuthSessionSnapshot; children: React.ReactNode }) {
  if (session.status === 'loading') return <LoadingPage />;
  if (!session.isAuthenticated) return <main className="page-status"><h1>Área indisponível</h1><p>Esta área exige uma sessão ativa.</p></main>;
  return <>{children}</>;
}
