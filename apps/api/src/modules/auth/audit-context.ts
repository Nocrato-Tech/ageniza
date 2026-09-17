import { AsyncLocalStorage } from 'node:async_hooks';

interface AuditContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<AuditContext>();

/**
 * Threads the Fastify request id through the Better Auth `resetPassword` call so the
 * `onPasswordReset` config callback (which Better Auth invokes with no Fastify request in scope)
 * can still record `auth.password_reset` with the originating `request_id`.
 */
export const runWithAuditRequestId = <T>(requestId: string, work: () => Promise<T>): Promise<T> =>
  storage.run({ requestId }, work);

export const currentAuditRequestId = (): string | undefined => storage.getStore()?.requestId;
