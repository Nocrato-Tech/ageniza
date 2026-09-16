import { z } from 'zod';

/** Response body returned by the unauthenticated liveness endpoint. */
export const HealthResponseSchema = z.object({
  status: z.literal('ok')
}).strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
