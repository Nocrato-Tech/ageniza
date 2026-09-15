import { HealthResponseSchema } from '@ageniza/contracts';
import type { HealthResponse } from '@ageniza/contracts';

import type { HttpClient } from './http.js';

/** Validates the public health payload before browser code consumes it. */
export const parseHealthResponse = (payload: unknown): HealthResponse => HealthResponseSchema.parse(payload);

/** Retrieves the public liveness payload through the validated browser transport. */
export const getHealth = (client: HttpClient): Promise<HealthResponse> =>
  client.request({ path: '/health', response: HealthResponseSchema });
