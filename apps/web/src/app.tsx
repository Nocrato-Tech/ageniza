import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter } from 'react-router-dom';

import type { BrowserConfig } from '@ageniza/config/browser';
import { createAuthSessionStore, createSupabaseBrowserClient, useAuthSession } from './auth.js';
import { AppErrorBoundary } from './error-boundary.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

export function App({ config }: { config: BrowserConfig }) {
  const [queryClient] = useState(createQueryClient);
  const [authStore] = useState(() => createAuthSessionStore(createSupabaseBrowserClient(config)));
  const [httpClient] = useState(() => new HttpClient(config.apiBaseUrl, fetch, authStore.getAccessToken));
  const session = useAuthSession(authStore);

  return <AppErrorBoundary><QueryClientProvider client={queryClient}><ApiClientProvider client={httpClient}><BrowserRouter><ApplicationRoutes session={session} /></BrowserRouter></ApiClientProvider></QueryClientProvider></AppErrorBoundary>;
}
