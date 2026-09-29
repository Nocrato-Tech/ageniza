import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter } from 'react-router-dom';

import type { BrowserConfig } from '@ageniza/config/browser';
import { createAuthSessionStore, AuthSessionProvider, useAuthSession } from './auth.js';
import { AppErrorBoundary } from './error-boundary.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

export function App({ config }: { config: BrowserConfig }) {
  const [queryClient] = useState(createQueryClient);
  const [sessionEnd] = useState(createSessionEndSignal);
  const [httpClient] = useState(() => new HttpClient(config.apiBaseUrl, fetch, { onSessionEnded: sessionEnd.notify }));
  const [authStore] = useState(() => createAuthSessionStore(httpClient, { onSessionStarted: () => queryClient.clear() }));
  const session = useAuthSession(authStore);

  return <AppErrorBoundary><AuthSessionProvider store={authStore}><QueryClientProvider client={queryClient}><ApiClientProvider client={httpClient}><BrowserRouter><SessionEndRedirect signal={sessionEnd} authStore={authStore} /><ApplicationRoutes session={session} /></BrowserRouter></ApiClientProvider></QueryClientProvider></AuthSessionProvider></AppErrorBoundary>;
}
