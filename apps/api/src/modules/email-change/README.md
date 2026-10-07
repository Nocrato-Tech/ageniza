# E-mail change module (issue #80)

`POST /me/email-change` and `POST /email-change/confirm`, plus the operation's CLI,
`cli:email-change` (`src/cli/email-change.ts`). Specification: `specs/auth.md` section 5, rules 12
to 18, and `docs/business/decisions.md`, 2026-10-07.

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

- `app_private.request_email_change(new_email, verified_hash)`: the account comes from the actor bound to the
  transaction, never from an argument. `verified_hash` is the credential hash the route verified the password
  against; with the account locked, the function refuses (`A0042`) when it is no longer the account's, and
  records its fingerprint, not the one of whatever the account holds at insert time. Supersedes the open request
  and records the new one.
- `app_private.confirm_email_change(token_hash)`: locks the account, then the request, checks the
  request is approved, unexpired, and that the account still has the old address and nobody took
  the new one, then swaps, deletes sessions and verifications, and closes the request.

The CLI connects as the migration owner, like `cli:agency`, and does the listing, approval and
rejection in SQL of its own.

## The password is part of the request

The notice to the current address says "if it was not you, change the password", so changing the password has to undo the request
(security review of PR #325). `request_email_change` records a fingerprint of the credential the route verified the password against
(SHA-256 of the password hash, never the hash), and two barriers hold. The route reads the hash and checks the password in one
transaction and asks in another, so the fingerprint cannot be taken from the account at insert time: a reset landing in between would
be recorded as if the request had been made under the new password. The route hands the function the hash it verified; the
function compares it with the current one under the account lock and refuses (the route answers the wrong-password 403, nothing is
recorded or sent) when the reset got there first, and a reset that lands after finds a different fingerprint and closes the request
(second review round of PR #325).

1. The password reset (`onPasswordReset` in `better-auth.ts`) calls `app_private.supersede_email_change_requests(user_id)`, which
   locks the account and closes its open requests whose fingerprint is no longer the credential's (status `superseded`, link gone). It
   only closes what barrier 2 would refuse, so calling it without a credential change cancels nothing. If it fails, the reset still
   completes and the error is logged; barrier 2 covers it.
2. The CLI `approve` and `confirm_email_change` refuse a request whose fingerprint changed: `approve` closes it and says the password
   changed, the confirmation answers the same `INVALID_LINK` as any dead link.

The reset is the only way to change a password today: there is no authenticated change and Better Auth's route is not mounted. A new
path must call the same function; barrier 2 already protects the swap without it.

`confirm_email_change` also refuses an account that is an agency owner without `ownership_confirmed_at`: it may have become one between
the approval and the link (accepting an activation invitation).

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
