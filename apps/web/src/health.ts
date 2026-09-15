import { HealthResponseSchema, type HealthResponse } from '@ageniza/contracts';

/** Validates the public health payload before browser code consumes it. */
export const parseHealthResponse = (payload: unknown): HealthResponse => HealthResponseSchema.parse(payload);
