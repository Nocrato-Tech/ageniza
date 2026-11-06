import { AsyncLocalStorage } from 'node:async_hooks';

interface AuditContext {
  readonly requestId: string;
  readonly passwordResetInviteToken?: string;
  readonly passwordResetMobileWeb?: boolean;
}

const storage = new AsyncLocalStorage<AuditContext>();

/**
 * Threads the Fastify request id through the Better Auth `resetPassword` call so the
 * `onPasswordReset` config callback (which Better Auth invokes with no Fastify request in scope)
 * can still record `auth.password_reset` with the originating `request_id`.
 */
export const runWithAuditRequestId = <T>(requestId: string, work: () => Promise<T>): Promise<T> =>
  storage.run({ ...storage.getStore(), requestId }, work);

export const currentAuditRequestId = (): string | undefined => storage.getStore()?.requestId;

/**
 * Carries an invitation token into Better Auth's password-reset callback. Better Auth invokes
 * that callback after the HTTP handler has returned to its own context, so a request-local
 * carrier is needed to add the invitation continuation to the outbound reset link without
 * changing Better Auth's endpoint contract.
 */
export const runWithPasswordResetInviteToken = <T>(inviteToken: string | undefined, work: () => Promise<T>): Promise<T> =>
  storage.run({ ...storage.getStore(), requestId: storage.getStore()?.requestId ?? '', ...(inviteToken === undefined ? {} : { passwordResetInviteToken: inviteToken }) }, work);

export const currentPasswordResetInviteToken = (): string | undefined => storage.getStore()?.passwordResetInviteToken;

export const runWithPasswordResetMobileWeb = <T>(mobileWeb: boolean, work: () => Promise<T>): Promise<T> =>
  storage.run({ ...storage.getStore(), requestId: storage.getStore()?.requestId ?? '', passwordResetMobileWeb: mobileWeb }, work);

export const currentPasswordResetMobileWeb = (): boolean => storage.getStore()?.passwordResetMobileWeb === true;
