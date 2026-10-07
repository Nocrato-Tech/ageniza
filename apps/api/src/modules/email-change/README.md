# E-mail change module (issue #80)

`POST /me/email-change` and `POST /email-change/confirm`, plus the operation's CLI,
`cli:email-change` (`src/cli/email-change.ts`). Specification: `specs/auth.md` section 5, rules 12
to 17, and `docs/business/decisions.md`, 2026-10-07.

The person does not change their own e-mail: they **ask**, with the current password, and the
operation approves from the CLI, because `auth."user"` is global and the request belongs to no
agency. Approval mails a single-use link to the **new** address; following it swaps the address,
ends every session and every pending password-reset link of the account, and warns the old
address.

## Why not Better Auth's `changeEmail`

Evaluated on 1.7.5 and not used: it is self-service (no current password, no approval), its token
is a signed JWT that can be presented again until it expires, it records no request, and it does
not end sessions. The token here is the invitation's: 32 random bytes, only the SHA-256 in the
database, single use.

## Where things are written

`public.email_change_requests` is not readable or writable by `ageniza_app` at all (the default
privileges of `public` are revoked in the migration). The only paths are two `security definer`
functions:

- `app_private.request_email_change(new_email)`: the account comes from the actor bound to the
  transaction, never from an argument. Supersedes the open request and records the new one.
- `app_private.confirm_email_change(token_hash)`: locks the account, then the request, checks the
  request is approved, unexpired, and that the account still has the old address and nobody took
  the new one, then swaps, deletes sessions and verifications, and closes the request.

The CLI connects as the migration owner, like `cli:agency`, and does the listing, approval and
rejection in SQL of its own.

## One lock order

Every path that changes a request locks the **account first, then its requests**:
`request_email_change`, `confirm_email_change` (which reads the request unlocked to learn the account,
locks the account, then locks and re-reads the request) and the CLI's approve and reject. The
opposite order deadlocks (`40P01`) when two of them run on the same account. A deadlock or a
serialization failure (`40001`) that still happens is a lost race, not a bug: both routes answer
`409 TRY_AGAIN` with no detail, and the CLI says to run the command again. The race tests hold a
request's row lock in a real transaction to line the others up behind it.

## What the contract guarantees

- Wrong current password: `403 INVALID_PASSWORD`, no request, nothing sent. It is 403 and not 401
  because the web client reads 401 as "the session ended".
- The answer is the same `202 {}` when the new address already belongs to another account, and the
  notice to the current address goes out either way: the route is not an oracle. The operation sees
  the collision in `list` and `approve` refuses it; if the address is taken after the approval, the
  link dies like any other dead link.
- Every link that cannot swap (unknown, used, expired, superseded, rejected, address taken, account
  changed address) answers the same `400 INVALID_LINK`.
- A request needs no module permission, like `/me/profile`: it is about the account.
- Five requests per hour and per account, wrong passwords included. In memory, like the other
  authentication limits.

## Not covered

Rejecting a request does not warn the person; nothing notifies the operation of a new request (`list`
is how they are found); an account that lost both the old mailbox and the password has no path,
since account recovery is outside the MVP.
