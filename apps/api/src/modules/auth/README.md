# `apps/api/src/modules/auth`

Backend-only authentication core (issue #31, part 1 of 3 of #20). Better Auth 1.7.5 owns credential
storage and session lifecycle in a dedicated `auth` PostgreSQL schema; this module is the only code
that talks to it. There is no sign-up, invitation, agency, or role logic here — that is 20B and 20C.

## Routes

All routes are mounted under `/auth` (served publicly at `/api/auth/...` behind nginx). Request and
response bodies are validated against `packages/contracts/src/auth.ts` with the route helpers
(`routeBody`/`routeResponse`), which read the schema the route declares in its own `config`.
Origin/CSRF checking is global (see below); no route repeats it.

| Method and route | Body | Success | Errors |
| --- | --- | --- | --- |
| `POST /auth/login` | `{ email, password, inviteToken? }` | `200 { user: { id, name, email } }` + session cookie | `401 INVALID_CREDENTIALS`; `403 EMAIL_NOT_VERIFIED`; `429 RATE_LIMITED` |
| `POST /auth/sign-up` | `{ name, email, password, acceptTerms: true }` | always `202 {}`, no cookie | `400 VALIDATION_ERROR`; `429 RATE_LIMITED` |
| `POST /auth/email/verification/resend` | `{ email }` | always `202 {}` | `429 RATE_LIMITED` |
| `POST /auth/email/verify` | `{ token, password }` | `200 { user }` + session cookie | `400 INVALID_LINK_OR_PASSWORD`; `429 RATE_LIMITED` |
| `POST /auth/logout` | — (session cookie) | `204`, revokes only the current session | `401 UNAUTHENTICATED` |
| `POST /auth/logout-all` | — (session cookie) | `204`, revokes every session for the user; audits `auth.logout_all` | `401 UNAUTHENTICATED` |
| `GET /auth/session` | — (session cookie) | `200 { user: { id, name, email }, session: { expiresAt } }` | `401 UNAUTHENTICATED`; `401 SESSION_EXPIRED` |
| `GET /auth/session/check` | — (session cookie) | the same `200`, but the session is read with `disableRefresh`: no renewal, no cookie (#411) | `401 UNAUTHENTICATED`; `401 SESSION_EXPIRED` |
| `POST /auth/password/forgot` | `{ email }` | always `202 {}` | `429 RATE_LIMITED` |
| `POST /auth/password/reset` | `{ token, newPassword }` | `204`, no body and no cookie: the password changes, every session of the user is revoked and none is created; audits `auth.password_reset` | `400 INVALID_LINK`; `400 VALIDATION_ERROR` (a stray `inviteToken` too) |

Login failure (wrong password vs. unknown email) is byte-for-byte identical, so a client cannot
enumerate accounts. `password/reset` returns the same `INVALID_LINK` whether the token is unknown,
expired, already used, or belongs to a different purpose. Better Auth's own sign-up stays off
(`emailAndPassword.disableSignUp` is `true`): the public sign-up is `POST /auth/sign-up`, ours.

Every email is `trim()`ed and lower-cased before it is validated or handed to Better Auth
(`AuthEmailSchema` in contracts), matching the `auth.user.email` normalized-value constraint
enforced by the migration.

**Zero contexts (issue #706, replacing #68).** A confirmed account with zero contexts gets its
session and lands on `/comecar`; `GET /me/contexts/resolve` answers `none` and keeps the session.
`NO_CONTEXT_ACCESS` no longer exists. `inviteToken` on the login is still accepted (the reset link of
an invitation carries it) but no longer changes the outcome.

**Unconfirmed accounts (issue #706).** `requireEmailVerification: true` makes Better Auth refuse the
sign-in of an account whose `emailVerified` is false, after the password is checked: a wrong password
is still `401 INVALID_CREDENTIALS`, byte-for-byte, and only the right one gets
`403 EMAIL_NOT_VERIFIED`, with no cookie and no session row. `routes.ts` checks `emailVerified` again
on the response, and `session-guard.ts` revokes any session an unconfirmed account holds.

**Sign-up and the confirmation link (issue #706, finding A1 of the review of PR #720, security
review of PR #721).** `POST /auth/sign-up` creates the account unconfirmed, with the credential and
both legal acceptances, and issues the link; it hashes the password on every path and sends e-mail in
the background, so a taken address (confirmed or not) answers the same `202 {}` in the same time, and
gets a notice with no link. The link is not Better Auth's e-mail verification (a stateless JWT with
the address in it, replayable, not voided by a resend, confirming without the password): it is a
random 32-byte token whose SHA-256 lives in `public.email_confirmations`, reached only through the
`app_private` functions of migration `20261027010100`. `email-verification.ts` exposes
`issueEmailConfirmation(executor, userId)`, which voids the earlier links and returns the token to
send with `emailService.sendEmailVerification` (the invitation acceptance of #721 calls it too).
`POST /auth/email/verify` takes the token **and the account password**, spends the login's attempt
counters, and answers `400 INVALID_LINK_OR_PASSWORD` for a wrong password and for a dead link alike
(checking a decoy hash when the link is dead); only both right consume the link (while the credential
is still the one checked), confirm the e-mail and create the session. A password reset of an
unconfirmed account takes it over: `onPasswordReset` calls
`app_private.confirm_email_by_password_reset`, which voids the links, confirms the e-mail and revokes
the legal acceptances recorded at sign-up.

**`password/reset` creates no session (issue #699, 2026-10-16 decision "Redefinir a senha não entra
direto: volta ao login").** The reset ends every previous session (`revokeSessionsOnPasswordReset`)
and answers `204`, no body and no cookie, whether or not the account has a context: it never signs
the account in and takes no `inviteToken`. The person signs in again with the new password. An
invitation that started the recovery (`forgot` appends `invite=` to the link only for a valid invite
addressed to that e-mail) continues through that login. An invalid/expired/used reset token gets the
generic `400 INVALID_LINK`.

## Composition

- `better-auth.ts` (`createAuth`) builds an isolated Better Auth instance from injected
  dependencies (a `pg.Pool`, `ApiConfig`, an `EmailService`, a logger, an `AuthAuditRecorder`).
  Nothing is a module-level singleton.
- `bridge.ts` is the only place that turns a Fastify request into the `Headers` Better Auth reads
  (`cookie`, `origin`, `user-agent`, and `x-ageniza-client-ip` always set from `request.ip`,
  discarding anything the client sent under that name) and that copies `set-cookie` back onto the
  Fastify reply. It also converts a Better Auth `APIError` into the module's public error contract
  without ever leaking Better Auth's own message or code.
- `session-guard.ts` (`createRequireSession`) is the `preHandler` every module needing an
  authenticated request reuses (20B and 20C included). It calls `auth.api.getSession`, then enforces
  the 30-day absolute session lifetime described below, and attaches `request.auth`.
- `routes.ts` wires the six routes above to `auth.api.*`, the rate limiter, and the audit recorder.
- `server.ts` (the process entry point) owns the Better Auth pool's lifetime and closes it during
  shutdown; `app.ts` composes everything through `buildApp`, which never touches process state.

## Session policy

- Better Auth expires a session after **7 days without use** and renews it on use with a **1-day**
  update window (`session.expiresIn` / `session.updateAge` in `better-auth.ts`).
- Session state is never cached in the cookie (`cookieCache.enabled: false`): revocation takes
  effect immediately, at the cost of one DB round trip per authenticated request.
- The auth responses that carry session data (`GET /auth/session`, `GET /auth/session/check`,
  `POST /auth/login`) and `POST /auth/password/reset`, which carries the reset token and the new
  password, answer `Cache-Control: no-store`, set in `onRequest` so that a `401` from the guard carries it too (#423).
  The same hook (`plugins/infra/no-store.ts`) covers `GET /invitations/:token`,
  `POST /invitations/:token/accept-new-account` and `GET /me/contexts` (#432). It runs before the
  route's rate-limit hook, so a `429` carries it as well; a header set inside the handler would miss
  the `401` raised by `requireSession`.
- An **absolute 30-day limit since `createdAt`**, independent of activity, is enforced twice, not
  by Better Auth's own expiry: `session-guard.ts` revokes a session older than that on the next
  request that presents it (the caller gets `401 SESSION_EXPIRED`), and the `databaseHooks` entry in
  `better-auth.ts` clamps every renewal so `expiresAt` never passes `createdAt + 30 days`.
- The session cookie is `httpOnly`, `SameSite=Lax`, prefixed `ageniza`, `path=/`, and `Secure` only
  when `environment === 'production'`.

## Rate limiting

Three independent dimensions, matching issue #31 exactly. Every limit exceeded responds the same
`429 RATE_LIMITED`, without saying which dimension tripped.

| Route | Per IP | Per IP + e-mail | Per e-mail (any IP) |
| --- | --- | --- | --- |
| `POST /auth/login` | 100 / 15 min | 10 / 15 min | 50 / 1 h |
| `POST /auth/password/forgot` | 30 / 15 min | 3 / 15 min | 10 / 1 h |
| `POST /auth/sign-up` | 30 / 15 min | 3 / 15 min | 10 / 1 h |
| `POST /auth/email/verification/resend` | 30 / 15 min | 3 / 15 min | 10 / 1 h |
| `POST /auth/email/verify` | 100 / 15 min | the login's counters, keyed by the link's e-mail | the login's |
| `POST /auth/password/reset` | 30 / 15 min | — | — |

- **Per IP** uses the already-registered `@fastify/rate-limit` plugin (`config: { rateLimit: {...} }`
  on the route), keyed by `request.ip` (which is real once `API_TRUSTED_PROXY_CIDRS` is configured
  correctly — see the production runbook).
- **IP + e-mail** and **e-mail-global** are enforced by `auth-limiter.ts`'s `InMemoryAuthLimiter`, a
  fixed-window counter keyed by `sha256(ip)`/`sha256(normalized email)` (never plaintext). The
  IP + e-mail key always includes the IP: dropping it would turn this into a global per-email limit
  that lets an attacker lock out someone else's account by cycling IPs.
- **All numbers live in one place, `policy.ts` (`AUTH_RATE_LIMITS`).** No route has a number written
  directly in its code; changing a limit is a reviewed change to that file alone.
- **The counters are in-memory, single-instance, and reset on every deploy or restart.** This is an
  accepted MVP limitation: there is exactly one API instance in production today. It stops being
  acceptable the moment the API is horizontally scaled — at that point this needs a shared store
  (Redis or PostgreSQL-backed) instead of `auth-limiter.ts`'s `Map`.
- Better Auth's own rate limiting is explicitly disabled (`rateLimit: { enabled: false }`): the API's
  limiter is the only one in effect.

## Email

`email-service.ts` (`createEmailService`) is the **only** code in the repository that calls
`createEmailSender` or builds a reset-password link/template. A future outbox/queue-backed delivery
mechanism only changes this file's implementation, not any caller.

- `sendPasswordReset` builds the link as
  `${appPublicUrl}/reset-password?token=${encodeURIComponent(token)}`, using the raw `token` Better
  Auth's `sendResetPassword` hook receives — never the `url` Better Auth also generates — and renders
  it with `passwordResetEmail({ actionUrl, expiresInMinutes: 30 })` from `@ageniza/email`.
- **It never `await`s the transport.** The public response for `password/forgot` must not depend on
  SMTP latency (or on whether the account exists), so delivery is fire-and-forget: the promise is
  tracked in an internal `Set` (`pendingEmails`) and any rejection is caught, logged (without the
  token, link, or full email address), and reported to Sentry inside that `.catch`.
- On shutdown, `server.ts` calls `emailService.drain()` (aliased `shutdown()`), which waits for
  in-flight deliveries for **at most 10 seconds** before the process closes the SMTP transport.

## Reset tokens

The reset token is generated by Better Auth, sent to the user once, and never stored anywhere in
plaintext: `verification: { storeIdentifier: 'hashed' }` makes Better Auth hash the verification
row's identifier (which embeds the token) before it reaches PostgreSQL. Tokens are single-use
(`consumeVerificationValue`), expire after 30 minutes (`resetPasswordTokenExpiresIn`), and a
successful reset revokes every session for that user (`revokeSessionsOnPasswordReset: true`).

## Audit

`audit.ts` (`createAuthAuditRecorder`) appends to `audit.events`, which this slice's migration
creates. The pool it uses connects as `ageniza_app`, which the migration grants **insert only** on
that table — there is no read/update/delete path from application code, by design. This slice writes
two actions: `auth.logout_all` and `auth.password_reset`, both with `actor_user_id` and
`request_id`. Never pass a token, password, cookie, or full email address into an audit event.

## Origin/CSRF protection

Handled once, globally, by `apps/api/src/plugins/infra/origin.ts`, registered in `buildApp` before
any module. Every `POST`/`PUT`/`PATCH`/`DELETE` request needs an `Origin` header that matches
`new URL(config.appPublicUrl).origin` exactly, or it gets `403 CSRF_REJECTED`. `GET`/`HEAD`/`OPTIONS`
are exempt, which is why `/health` keeps working. No route in this module (or any other) repeats
this check.

## Updating Better Auth

The `auth` schema's construction SQL in
[`packages/database/migrations/20260918000000_auth_schema.mjs`](../../../../../packages/database/migrations/20260918000000_auth_schema.mjs)
is frozen, exactly like the worker's `pgboss` migration
([worker README](../../../worker/README.md#schema-and-upgrades)). **Never edit that migration.** To
upgrade Better Auth:

1. Bump the pinned `better-auth` version in `apps/api/package.json` (`--save-exact`).
2. Outside the repository, run `getMigrations(authOptions)` (from `better-auth/db/migration`) with
   the same database options as the runtime (`schemaName: 'auth'`, `casing: 'snake'`,
   `generateId: 'uuid'`) against a database already on the previous migration, and call
   `compileMigrations()` on the result to get the SQL delta.
3. Add a new, forward-only migration (`packages/database/migrations/<timestamp>_auth_schema_<version>.mjs`)
   that runs only that delta plus any new grants it needs. Do not regenerate or replace the frozen
   SQL in the existing migration.
4. `src/modules/auth/auth.integration.test.ts` includes a schema-drift check (`getMigrations` against
   the runtime options, run against the already-migrated database) that fails if the installed
   Better Auth version expects columns or tables the applied migrations do not yet provide.

## Tests

```sh
pnpm --filter @ageniza/api test               # unit tests, no database
pnpm db:migrate
pnpm --filter @ageniza/api test:integration    # against local PostgreSQL, as ageniza_app
```

The integration suite (`src/modules/auth/*.integration.test.ts`) covers every acceptance test in
issue #31: login, normalization, the absolute session limit, logout/logout-all and their audit
trail, the non-blocking password-reset flow (including a slow/failing transport), token hashing and
single use, all three rate-limit dimensions, the global CSRF/origin check, the absence of any
sign-up route, log redaction, and Better Auth schema drift. Every test creates its own randomly
suffixed user/session/token fixtures and removes them in `afterEach`/`afterAll`; nothing is asserted
against `audit.events` without filtering by this run's `request_id`/`actor_user_id`, since the table
is append-only and earlier runs' rows are never deleted.

## Future hardening (not implemented yet)

`ageniza_app` currently has full CRUD on the `auth` schema, which is more access than the
application actually needs day to day and widens the blast radius if application code is ever
compromised. The planned hardening (tracked for a later issue, not this one) is a dedicated
PostgreSQL role, `ageniza_auth`, scoped to the `auth` schema only, with its own connection pool in
`better-auth.ts`/`server.ts` — the rest of the application would keep using `ageniza_app` and would
have no access to `auth` at all.
