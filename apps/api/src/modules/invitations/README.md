# Convites

The invitation HTTP module owns the administrative and public invitation flows for AUTH-20B.
All request and response payloads are validated at the route boundary, and tenant mutations run
inside `withAuthenticatedUserTransaction`, which binds the transaction actor before the
RLS-protected query (see `@ageniza/database`). The `requireAgencyAccess` and `requirePermission` prehandlers are injected
from the tenancy module so the invitation module does not duplicate tenant guard SQL.

## Routes

- `POST /agencies/:agencyId/invitations/collaborators` creates a collaborator invitation and answers,
  this once, the link it e-mailed (`invitationUrl`, `no-store`), for the inviter to copy (issue #710).
- `POST /agencies/:agencyId/clients/:clientId/invitations` creates a client invitation. An archived
  client of the agency answers `409 CLIENT_ARCHIVED` (the invitation would be born dead); one of
  another agency, or a missing one, is still the same `404`. The pending ones are listed by
  `GET …/clients/:clientId/invitations`, in the `clients` module.
- `POST /agencies/:agencyId/invitations/:invitationId/resend` replaces a pending invitation; for a
  collaborator one it answers the new link the same way only to a caller who also holds
  `colaborador.convidar` (`null` otherwise, and for a portal one), and the old link dies.
- `DELETE /agencies/:agencyId/invitations/:invitationId` revokes a pending invitation.
- `GET /invitations/:token` previews a valid invitation.
- `POST /invitations/:token/accept-new-account` atomically creates the credential account and
  accepts the invitation. The account is born with `emailVerified = false`, since the inviter may hold
  the link too; the invitation's context is usable at once. The confirmation e-mail arrives with #706.
- `POST /invitations/:token/accept` accepts an invitation for the matching authenticated e-mail.

Handing out the `admin` role takes `colaborador.atribuir_admin`, which no preset holds and only the
Owner passes by ownership. The rule applies to creating a collaborator invitation and to resending one
that carries `admin`; both answer `403` before writing anything, and the `invitations_insert` policy
is the second barrier (issue #97, `specs/colaboradores.md` §5, rule 3).

Public token reads use `app_private.invitation_by_token_hash`, a `security definer` function that
returns only the invitation preview fields and a validity bit. Acceptance uses
`app_private.accept_invitation`, also `security definer`, which locks and revalidates the token,
creates the membership/owner and legal acceptances atomically, consumes the token, and writes its
audit events. PostgreSQL's private error codes are translated to one `410 INVALID_LINK` response;
the token itself is never logged or persisted (only its SHA-256 hash is stored). No response body is
ever logged (`disableRequestLogging`, and `onResponse` records only route, status and timing), which is
what keeps the copyable link out of the logs.

Administrative invitation rows and their audit event are committed before synchronous SMTP
delivery. A delivery failure therefore returns `502 EMAIL_DELIVERY_FAILED` while leaving the
invitation valid for a later resend.

`POST /auth/password/forgot` accepts an optional `inviteToken`. It is appended to the reset link only
when the token is valid for the requested e-mail; an invalid optional token keeps the ordinary
non-enumerating forgot response. The reset itself takes no invitation and creates no session: the
invitation continues through the `inviteToken` of the login that follows it.
