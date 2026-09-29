# `apps/api/src/modules/auth`

Backend-only authentication core (issue #31, part 1 of 3 of #20). Better Auth 1.7.5 owns credential
storage and session lifecycle in a dedicated `auth` PostgreSQL schema; this module is the only code
that talks to it. There is no sign-up, invitation, agency, or role logic here — that is 20B and 20C.

## Routes

All routes are mounted under `/auth` (served publicly at `/api/auth/...` behind nginx). Request and
response bodies are validated against `packages/contracts/src/auth.ts` with `parseRequest`/
`parseResponse`. Origin/CSRF checking is global (see below); no route repeats it.

| Method and route | Body | Success | Errors |
| --- | --- | --- | --- |
| `POST /auth/login` | `{ email, password, inviteToken? }` | `200 { user: { id, name, email } }` + session cookie | `401 INVALID_CREDENTIALS`; `403 NO_CONTEXT_ACCESS`; `429 RATE_LIMITED` |
| `POST /auth/logout` | — (session cookie) | `204`, revokes only the current session | `401 UNAUTHENTICATED` |
| `POST /auth/logout-all` | — (session cookie) | `204`, revokes every session for the user; audits `auth.logout_all` | `401 UNAUTHENTICATED` |
| `GET /auth/session` | — (session cookie) | `200 { user: { id, name, email }, session: { expiresAt } }` | `401 UNAUTHENTICATED`; `401 SESSION_EXPIRED` |
| `POST /auth/password/forgot` | `{ email }` | always `202 {}` | `429 RATE_LIMITED` |
| `POST /auth/password/reset` | `{ token, newPassword }` | `204`, revokes every session for the user; audits `auth.password_reset` | `400 INVALID_LINK`; `400 VALIDATION_ERROR` |

Login failure (wrong password vs. unknown email) is byte-for-byte identical, so a client cannot
enumerate accounts. `password/reset` returns the same `INVALID_LINK` whether the token is unknown,
expired, already used, or belongs to a different purpose. There is no public sign-up endpoint:
`emailAndPassword.disableSignUp` is `true` and no sign-up route is mounted, so any sign-up request
gets the ordinary `404` route-not-found response.

Every email is `trim()`ed and lower-cased before it is validated or handed to Better Auth
(`AuthEmailSchema` in contracts), matching the `auth.user.email` normalized-value constraint
enforced by the migration.

**Zero contexts (issue #68).** A correct credential that resolves to zero agency/client contexts
never gets a session: `routes.ts` authenticates first, then counts contexts through
`countValidContexts` (injected from the `contexts` module, wired in `server.ts`/the test harness),
and revokes the session Better Auth just created before it ever reaches the client if that count is
zero. The response is `403 NO_CONTEXT_ACCESS`, a message distinct from `INVALID_CREDENTIALS`
because by this point the caller already proved they know the password — see the 2026-09-24
decision "Credencial correta sem nenhum contexto não cria sessão" in `docs/business/decisions.md`.
The same rule ends the session on `GET /me/contexts/resolve`'s `decision: 'none'` (see the
`contexts` module's README) — deliberately **not** in `session-guard.ts`: charging it on every
authenticated request would cost an extra query for no benefit, since `requireAgencyAccess`/
`requireClientAccess` already 404 anything a contextless session cannot reach.

**Re-invited zero-context account (issue #76, 2026-09-29 decision, pending validation).** An
account removed from every agency and then re-invited also has zero contexts, but the 2026-09-24
decision itself says that case must keep working through the existing-account accept flow, and
`POST /invitations/:token/accept` needs a session to run. `POST /auth/login` accepts an optional
`inviteToken` for exactly this: when the credential is correct, contexts are zero, and `inviteToken`
resolves (through the same `invitationTokenLookup`/`app_private.invitation_by_token_hash` validity
check the invitations module itself uses — not re-implemented here) to a **valid** invitation
addressed to the **same e-mail**, the session is kept instead of revoked. An invalid, expired,
revoked, mismatched-email, or absent token is indistinguishable from one another: every one of them
falls through to the ordinary `403 NO_CONTEXT_ACCESS`, byte-for-byte, so `inviteToken` can never be
used to probe whether an invitation or an account exists.

The session this creates is **still zero-context** until the invitation is actually accepted: the
invite screen (issue #76, "já tem conta" state) **must** call `POST /invitations/:token/accept` with
this same session **before** ever calling `GET /me/contexts/resolve`. Calling `resolve` first ends
the session on sight (`decision: 'none'`, same as any other zero-context session), and the person
would need to log in again with the token to retry. Once `accept` succeeds, the account has a real
context and an ordinary login (no `inviteToken` needed) works from then on.

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
- An **absolute 30-day limit since `createdAt`**, independent of activity, is enforced by
  `session-guard.ts`, not by Better Auth itself. A session older than that is revoked on the next
  request that presents it and the caller gets `401 SESSION_EXPIRED`.
- The session cookie is `httpOnly`, `SameSite=Lax`, prefixed `ageniza`, `path=/`, and `Secure` only
  when `environment === 'production'`.

## Rate limiting

Three independent dimensions, matching issue #31 exactly. Every limit exceeded responds the same
`429 RATE_LIMITED`, without saying which dimension tripped.

| Route | Per IP | Per IP + e-mail | Per e-mail (any IP) |
| --- | --- | --- | --- |
| `POST /auth/login` | 100 / 15 min | 10 / 15 min | 50 / 1 h |
| `POST /auth/password/forgot` | 30 / 15 min | 3 / 15 min | 10 / 1 h |
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
