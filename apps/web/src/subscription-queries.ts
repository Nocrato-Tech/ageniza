import { SubscriptionOverviewResponseSchema } from '@ageniza/contracts';

import { apiPath } from './api-path.js';
import type { HttpClient } from './http.js';

/** The one definition of the subscription read: the screen and the notices of the shell share the cache entry. */
export const subscriptionOverviewQuery = (httpClient: HttpClient, agencyId: string) => ({
  queryKey: ['agency', agencyId, 'subscription'] as const,
  queryFn: () => httpClient.request({ path: apiPath('/agencies/:agenciaId/subscription', { agenciaId: agencyId }), response: SubscriptionOverviewResponseSchema })
});
