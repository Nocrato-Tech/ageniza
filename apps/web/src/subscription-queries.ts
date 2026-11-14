import {
  SUBSCRIPTION_INVOICES_PAGE_SIZE,
  SubscriptionInvoiceListResponseSchema,
  SubscriptionOverviewResponseSchema,
  SubscriptionTestCardResponseSchema,
  type SubscriptionTestCard
} from '@ageniza/contracts';

import { apiPath } from './api-path.js';
import { HttpClientError, type HttpClient } from './http.js';

/** The one definition of the subscription read: the screen and the notices of the shell share the cache entry. */
export const subscriptionOverviewQuery = (httpClient: HttpClient, agencyId: string) => ({
  queryKey: ['agency', agencyId, 'subscription'] as const,
  queryFn: () => httpClient.request({ path: apiPath('/agencies/:agenciaId/subscription', { agenciaId: agencyId }), response: SubscriptionOverviewResponseSchema })
});

/**
 * The test card exists only where the API has the simulated provider: anywhere else the route answers 404, which is "this environment has
 * no test card", not a failure, and the card is simply not shown.
 */
export const testCardQuery = (httpClient: HttpClient, agencyId: string) => ({
  queryKey: ['agency', agencyId, 'subscription-test-card'] as const,
  retry: false,
  queryFn: async (): Promise<{ available: boolean; card: SubscriptionTestCard | null }> => {
    try {
      const answer = await httpClient.request({ path: apiPath('/agencies/:agenciaId/subscription/test-card', { agenciaId: agencyId }), response: SubscriptionTestCardResponseSchema });
      return { available: true, card: answer.card };
    } catch (error) {
      if (error instanceof HttpClientError && error.status === 404) return { available: false, card: null };
      throw error;
    }
  }
});

export const invoicesQuery = (httpClient: HttpClient, agencyId: string, page: number) => ({
  queryKey: ['agency', agencyId, 'subscription-invoices', page] as const,
  queryFn: () => httpClient.request({
    path: `${apiPath('/agencies/:agenciaId/subscription/invoices', { agenciaId: agencyId })}?page=${page}&pageSize=${SUBSCRIPTION_INVOICES_PAGE_SIZE}`,
    response: SubscriptionInvoiceListResponseSchema
  })
});
