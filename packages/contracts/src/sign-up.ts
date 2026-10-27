import { z } from 'zod';

import { AuthEmailSchema, AuthLoginPasswordSchema, AuthPasswordSchema, AuthUserSchema } from './auth.js';
import { DisplayNameSchema } from './display-name.js';

/** `POST /auth/sign-up`: the same fields and the same single acceptance as the invitation's new account. */
export const AuthSignUpRequestSchema = z.object({
  name: DisplayNameSchema,
  email: AuthEmailSchema,
  password: AuthPasswordSchema,
  acceptTerms: z.literal(true)
}).strict();

/** Empty on purpose: a taken address gets exactly this answer too. */
export const AuthSignUpResponseSchema = z.object({}).strict();

export const AuthEmailVerificationResendRequestSchema = z.object({ email: AuthEmailSchema }).strict();

/** Empty on purpose: the answer does not depend on the account existing or being confirmed. */
export const AuthEmailVerificationResendResponseSchema = z.object({}).strict();

/**
 * `POST /auth/email/verify`: the link's token and the account's password (finding A1 of the review of
 * PR #720). The password is only bounded, like at sign-in: a wrong one is the server's answer.
 */
export const AuthEmailVerifyRequestSchema = z.object({
  token: z.string().min(1).max(2_048),
  password: AuthLoginPasswordSchema
}).strict();

/** Confirming signs the account in, so the answer is the login's. */
export const AuthEmailVerifyResponseSchema = z.object({ user: AuthUserSchema }).strict();

export type AuthSignUpRequest = z.infer<typeof AuthSignUpRequestSchema>;
export type AuthEmailVerificationResendRequest = z.infer<typeof AuthEmailVerificationResendRequestSchema>;
export type AuthEmailVerifyRequest = z.infer<typeof AuthEmailVerifyRequestSchema>;
export type AuthEmailVerifyResponse = z.infer<typeof AuthEmailVerifyResponseSchema>;
