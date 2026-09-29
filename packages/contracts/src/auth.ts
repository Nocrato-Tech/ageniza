import { z } from 'zod';

/** Emails are canonicalized before they are validated or used as identifiers. */
export const AuthEmailSchema = z.string().trim().toLowerCase().email().max(320);

/** Public user fields only; credentials, sessions, and tenant fields never belong here. */
export const AuthUserSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(256),
  email: AuthEmailSchema
}).strict();

export const AuthPasswordSchema = z.string().min(10).max(128);

/** Optional invitation continuation; the token is opaque and is never echoed in a response. */
export const AuthInvitationTokenSchema = z.string().min(1).max(2_048);

export const AuthLoginRequestSchema = z.object({
  email: AuthEmailSchema,
  password: AuthPasswordSchema,
  inviteToken: AuthInvitationTokenSchema.optional()
}).strict();

export const AuthLoginResponseSchema = z.object({ user: AuthUserSchema }).strict();

export const AuthNoBodySchema = z.undefined();
export const AuthNoContentResponseSchema = z.undefined();

export const AuthLogoutRequestSchema = AuthNoBodySchema;
export const AuthLogoutAllRequestSchema = AuthNoBodySchema;
export const AuthLogoutResponseSchema = AuthNoContentResponseSchema;
export const AuthLogoutAllResponseSchema = AuthNoContentResponseSchema;

export const AuthSessionRequestSchema = AuthNoBodySchema;
export const AuthSessionResponseSchema = z.object({
  user: AuthUserSchema,
  session: z.object({ expiresAt: z.string().datetime({ offset: true }) }).strict()
}).strict();

export const AuthPasswordForgotRequestSchema = z.object({
  email: AuthEmailSchema,
  inviteToken: AuthInvitationTokenSchema.optional()
}).strict();
export const AuthPasswordForgotResponseSchema = z.object({}).strict();

export const AuthPasswordResetRequestSchema = z.object({
  token: z.string().min(1).max(2_048),
  newPassword: AuthPasswordSchema,
  inviteToken: AuthInvitationTokenSchema.optional()
}).strict();

/**
 * A reset always authenticates (issue #175, 2026-09-29 decision "O reset de senha sempre
 * autentica, exceto sem nenhum contexto"), with two distinct `signedIn: false` reasons — the
 * 2026-09-29 security review of PR #176 found that collapsing every no-session outcome into
 * `NO_CONTEXT_ACCESS` misidentified a real access problem for an account that actually has
 * contexts, whenever the post-reset sign-in itself failed for an unrelated reason (a transient
 * error, or two valid reset tokens for the same account racing each other):
 *
 * - `NO_CONTEXT_ACCESS` — the account was confirmed to have **zero** contexts (and no valid
 *   `inviteToken` continuation). The password changed; there is deliberately nothing to sign into.
 * - `SIGN_IN_REQUIRED` — the account's context count was never confirmed to be zero (it either has
 *   contexts, or that could not be determined) but the server could not create a session anyway.
 *   The password still changed; the client should route to `/entrar` instead of `/sem-acesso`.
 */
export const AuthPasswordResetSignedInResponseSchema = z.object({ signedIn: z.literal(true) }).strict();
export const AuthPasswordResetNoSessionResponseSchema = z.object({
  signedIn: z.literal(false),
  reason: z.enum(['NO_CONTEXT_ACCESS', 'SIGN_IN_REQUIRED'])
}).strict();
export const AuthPasswordResetResponseSchema = z.discriminatedUnion('signedIn', [
  AuthPasswordResetSignedInResponseSchema,
  AuthPasswordResetNoSessionResponseSchema
]);

// Endpoint-local aliases keep route code concise while the Auth-prefixed names
// remain unambiguous for consumers importing the package root.
export const LoginRequestSchema = AuthLoginRequestSchema;
export const LoginResponseSchema = AuthLoginResponseSchema;
export const LogoutRequestSchema = AuthLogoutRequestSchema;
export const LogoutAllRequestSchema = AuthLogoutAllRequestSchema;
export const LogoutResponseSchema = AuthLogoutResponseSchema;
export const LogoutAllResponseSchema = AuthLogoutAllResponseSchema;
export const SessionRequestSchema = AuthSessionRequestSchema;
export const SessionResponseSchema = AuthSessionResponseSchema;
export const PasswordForgotRequestSchema = AuthPasswordForgotRequestSchema;
export const PasswordForgotResponseSchema = AuthPasswordForgotResponseSchema;
export const PasswordResetRequestSchema = AuthPasswordResetRequestSchema;
export const PasswordResetResponseSchema = AuthPasswordResetResponseSchema;

export type AuthEmail = z.infer<typeof AuthEmailSchema>;
export type AuthUser = z.infer<typeof AuthUserSchema>;
export type AuthLoginRequest = z.infer<typeof AuthLoginRequestSchema>;
export type AuthLoginResponse = z.infer<typeof AuthLoginResponseSchema>;
export type AuthSessionRequest = z.infer<typeof AuthSessionRequestSchema>;
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;
export type AuthNoBody = z.infer<typeof AuthNoBodySchema>;
export type AuthNoContentResponse = z.infer<typeof AuthNoContentResponseSchema>;
export type AuthLogoutRequest = z.infer<typeof AuthLogoutRequestSchema>;
export type AuthLogoutAllRequest = z.infer<typeof AuthLogoutAllRequestSchema>;
export type AuthLogoutResponse = z.infer<typeof AuthLogoutResponseSchema>;
export type AuthLogoutAllResponse = z.infer<typeof AuthLogoutAllResponseSchema>;
export type AuthPasswordForgotRequest = z.infer<typeof AuthPasswordForgotRequestSchema>;
export type AuthPasswordForgotResponse = z.infer<typeof AuthPasswordForgotResponseSchema>;
export type AuthPasswordResetRequest = z.infer<typeof AuthPasswordResetRequestSchema>;
export type AuthPasswordResetResponse = z.infer<typeof AuthPasswordResetResponseSchema>;
export type AuthPasswordResetSignedInResponse = z.infer<typeof AuthPasswordResetSignedInResponseSchema>;
export type AuthPasswordResetNoSessionResponse = z.infer<typeof AuthPasswordResetNoSessionResponseSchema>;
export type LoginRequest = AuthLoginRequest;
export type LoginResponse = AuthLoginResponse;
export type LogoutRequest = AuthLogoutRequest;
export type LogoutAllRequest = AuthLogoutAllRequest;
export type LogoutResponse = AuthLogoutResponse;
export type LogoutAllResponse = AuthLogoutAllResponse;
export type SessionRequest = AuthSessionRequest;
export type SessionResponse = AuthSessionResponse;
export type PasswordForgotRequest = AuthPasswordForgotRequest;
export type PasswordForgotResponse = AuthPasswordForgotResponse;
export type PasswordResetRequest = AuthPasswordResetRequest;
export type PasswordResetResponse = AuthPasswordResetResponse;
