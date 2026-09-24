import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter } from 'react-router-dom';

import type { BrowserConfig } from '@ageniza/config/browser';
import { createAuthSessionStore, useAuthSession } from './auth.js';
import { AppErrorBoundary } from './error-boundary.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

export function App({ config }: { config: BrowserConfig }) {
  const [queryClient] = useState(createQueryClient);
  const [httpClient] = useState(() => new HttpClient(config.apiBaseUrl, fetch));
  const [authStore] = useState(() => createAuthSessionStore(httpClient));
  const session = useAuthSession(authStore);

  return <AppErrorBoundary><QueryClientProvider client={queryClient}><ApiClientProvider client={httpClient}><BrowserRouter><ApplicationRoutes session={session} /></BrowserRouter></ApiClientProvider></QueryClientProvider></AppErrorBoundary>;
}
