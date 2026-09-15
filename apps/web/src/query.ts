import { QueryClient } from '@tanstack/react-query';

import { HttpClientError } from './http.js';

/** Query defaults favour explicit refreshes and do not retry client-side request failures. */
export const createQueryClient = (): QueryClient => new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: (failureCount, error) => !(error instanceof HttpClientError && error.status !== undefined && error.status < 500) && failureCount < 1
    },
    mutations: { retry: false }
  }
});
