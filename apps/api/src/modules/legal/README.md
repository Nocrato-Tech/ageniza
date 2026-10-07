# Legal module (issue #81)

`GET /me/legal-acceptances` and `POST /me/legal-acceptances`: which version of the Terms and of the
Privacy Policy the account accepted, and the acceptance of one document at a time. Specification:
`specs/auth.md` section 10 and `docs/business/decisions.md`, 2026-10-07.

Like `profile`, the routes are unscoped by agency and need no module permission: the documents bind
the account, not a tenant.

## What the contract guarantees

- **Per document, per version.** Accepting the Privacy Policy never marks the Terms.
- **The version is the server's.** The body is `{ document }` and nothing else (`.strict()`); the
  version recorded is `AUTH_TERMS_VERSION` or `AUTH_PRIVACY_VERSION`, so a client cannot accept a
  version that is not in force.
- **Idempotent and forward-only.** Repeating it, or accepting a version the account already
  surpassed, records nothing and answers 200. The newest accepted version is what counts, and older
  rows stay as history.
- **Nothing is gated.** `pending` only feeds the notice in the web shell; no route reads it.
- **Signup is unchanged.** `app_private.accept_invitation` still records both documents.

## Where the write happens

`ageniza_app` can only read `public.legal_acceptances`: it is evidence of consent, so INSERT, UPDATE
and DELETE are revoked (migration `20261007000500`) and the forced RLS has no write policy either.
The only write paths are `app_private.accept_invitation` (signup) and
`app_private.accept_legal_document(document, version)`, a `security definer` function that takes the
user from the actor bound to the transaction, never from an argument. The reading of the account's
own rows goes through the existing `legal_acceptances_select` policy.

Not covered: the route filters by the session user *and* the policy filters by the actor, so a
mutation of the route's own filter is masked by the policy. That is the point of having both.
