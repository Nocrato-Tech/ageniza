import { z } from 'zod';

import { AuthEmailSchema } from './auth.js';

/**
 * `POST /me/email-change` body: the address the person wants and the current password, which is
 * what proves the session was not just left open. The target is always the session's account;
 * `.strict()` makes a `userId` a 400 instead of a silently ignored key. The password is only
 * bounded, never length-checked against the creation rule, so a refused value reveals nothing.
 */
export const EmailChangeRequestSchema = z.object({
  newEmail: AuthEmailSchema,
  currentPassword: z.string().min(1).max(128)
}).strict();

/** Empty on purpose: the answer is the same whether or not another account uses the address. */
export const EmailChangeRequestResponseSchema = z.object({}).strict();

export const EmailChangeConfirmRequestSchema = z.object({
  token: z.string().min(1).max(2_048)
}).strict();

export const EmailChangeConfirmResponseSchema = z.object({}).strict();

export type EmailChangeRequest = z.infer<typeof EmailChangeRequestSchema>;
export type EmailChangeConfirmRequest = z.infer<typeof EmailChangeConfirmRequestSchema>;
