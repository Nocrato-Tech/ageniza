import { Link } from 'react-router-dom';

import { LiveStatus } from '@ageniza/ui';

import type { AuthSessionSnapshot } from './auth.js';

export function LoadingPage() {
  return <main className="page-status"><LiveStatus>Loading your workspace…</LiveStatus></main>;
}

/** The single "não encontrado" of the product: unknown address, no permission, or 404 from the API. */
export function NotFoundPage() {
  return <main className="page-status"><h1>Page not found</h1><p>The address does not match an Ageniza page.</p><Link to="/">Return home</Link></main>;
}

/**
 * Session gate shared by the protected trees. It never guesses: while the session is loading it
 * shows the loading page, and without a session it shows the same "unavailable" message every
 * protected area already used.
 */
export function SessionGate({ session, children }: { session: AuthSessionSnapshot; children: React.ReactNode }) {
  if (session.status === 'loading') return <LoadingPage />;
  if (!session.isAuthenticated) return <main className="page-status"><h1>Workspace unavailable</h1><p>This area requires a current session.</p></main>;
  return <>{children}</>;
}
