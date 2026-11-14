import { z } from 'zod';

import { characterCount } from './display-name.js';

/** Emails are canonicalized before they are validated or used as identifiers. */
export const AuthEmailSchema = z.string().trim().toLowerCase().email().max(320);

/** Public user fields only; credentials, sessions, and tenant fields never belong here. */
export const AuthUserSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(256),
  email: AuthEmailSchema
}).strict();

/** A password being created (invitation, reset): the 10-character rule lives here, not on sign-in. */
export const AuthPasswordSchema = z.string().min(10).max(128);

/** A password being presented at sign-in: any non-empty value reaches the server, which answers 401 for a wrong one. */
export const AuthLoginPasswordSchema = z.string().min(1).max(128);

/** Optional invitation continuation; the token is opaque and is never echoed in a response. */
export const AuthInvitationTokenSchema = z.string().min(1).max(2_048);

export const AuthLoginRequestSchema = z.object({
  email: AuthEmailSchema,
  password: AuthLoginPasswordSchema,
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
  /** `false` for the account of an invitation that has not confirmed its e-mail: its session opens nothing until it does (decision 2026-10-27). */
  emailVerified: z.boolean().optional(),
  session: z.object({ expiresAt: z.string().datetime({ offset: true }) }).strict()
}).strict();

/**
 * The browsers and the systems the API names from the user agent of a session (specs/auth.md section 14). A closed list: what the
 * server cannot place is `null`, and no text of the header, the address or the token ever reaches a response.
 */
export const AUTH_SESSION_BROWSERS = ['Chrome', 'Edge', 'Firefox', 'Safari', 'Opera', 'Samsung Internet'] as const;
export const AUTH_SESSION_SYSTEMS = ['Windows', 'macOS', 'iOS', 'Android', 'Linux', 'ChromeOS'] as const;

/** The most sessions the list shows, the most recent ones: a defensive ceiling, far above what a person has. */
export const AUTH_SESSION_LIST_MAX = 100;

/** The city of a session has 1 to 80 characters, counted as the column counts them (migration 20261112000100): by code point, not by UTF-16 unit. */
export const AUTH_SESSION_CITY_MAX_CHARACTERS = 80;

/**
 * One active session of the account (`GET /auth/sessions`). `id` is the identifier of the session row, made to name it in
 * `DELETE /auth/sessions/:sessionId`; it is never the token. `lastUsedAt` is the last renewal of the session, at most once
 * a day of use, so it is only as exact as a day. `city` is the approximate place the session was created from, when the edge
 * said one; it is informative and nothing decides on it.
 */
export const AuthActiveSessionSchema = z.object({
  id: z.string().uuid(),
  current: z.boolean(),
  browser: z.enum(AUTH_SESSION_BROWSERS).nullable(),
  os: z.enum(AUTH_SESSION_SYSTEMS).nullable(),
  city: z.string().min(1)
    .refine((city) => characterCount(city) <= AUTH_SESSION_CITY_MAX_CHARACTERS, `must be at most ${AUTH_SESSION_CITY_MAX_CHARACTERS} characters`)
    .nullable(),
  lastUsedAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true })
}).strict();

/** The active sessions of the account, the most recently created first. */
export const AuthSessionListResponseSchema = z.object({
  sessions: z.array(AuthActiveSessionSchema).max(AUTH_SESSION_LIST_MAX)
}).strict();

/**
 * A plain string, not `.uuid()`: a malformed id answers the same 404 as one that is another account's or does not exist, never a
 * 400 that would tell them apart (the route checks the UUID itself).
 */
export const AuthSessionPathParamsSchema = z.object({ sessionId: z.string().min(1).max(100) }).strict();

export const AuthRevokeSessionRequestSchema = AuthNoBodySchema;
export const AuthRevokeOtherSessionsRequestSchema = AuthNoBodySchema;
/** How many sessions of the account, other than the current one, were ended. */
export const AuthRevokeOtherSessionsResponseSchema = z.object({ revoked: z.number().int().nonnegative() }).strict();

export const AuthPasswordForgotRequestSchema = z.object({
  email: AuthEmailSchema,
  inviteToken: AuthInvitationTokenSchema.optional()
}).strict();
export const AuthPasswordForgotResponseSchema = z.object({}).strict();

export const AuthPasswordResetRequestSchema = z.object({
  token: z.string().min(1).max(2_048),
  newPassword: AuthPasswordSchema
}).strict();

/** A reset only changes the password and ends every session: the person signs in again (2026-10-16). */
export const AuthPasswordResetResponseSchema = AuthNoContentResponseSchema;

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
export type AuthSessionBrowser = (typeof AUTH_SESSION_BROWSERS)[number];
export type AuthSessionSystem = (typeof AUTH_SESSION_SYSTEMS)[number];
export type AuthActiveSession = z.infer<typeof AuthActiveSessionSchema>;
export type AuthSessionListResponse = z.infer<typeof AuthSessionListResponseSchema>;
export type AuthSessionPathParams = z.infer<typeof AuthSessionPathParamsSchema>;
export type AuthRevokeOtherSessionsResponse = z.infer<typeof AuthRevokeOtherSessionsResponseSchema>;
export type AuthPasswordForgotRequest = z.infer<typeof AuthPasswordForgotRequestSchema>;
export type AuthPasswordForgotResponse = z.infer<typeof AuthPasswordForgotResponseSchema>;
export type AuthPasswordResetRequest = z.infer<typeof AuthPasswordResetRequestSchema>;
export type AuthPasswordResetResponse = z.infer<typeof AuthPasswordResetResponseSchema>;
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
