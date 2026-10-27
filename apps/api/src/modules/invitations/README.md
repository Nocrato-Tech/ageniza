# Convites

The invitation HTTP module owns the administrative and public invitation flows for AUTH-20B.
All request and response payloads are validated at the route boundary, and tenant mutations run
inside `withAuthenticatedUserTransaction`, which binds the transaction actor before the
RLS-protected query (see `@ageniza/database`). The `requireAgencyAccess` and `requirePermission` prehandlers are injected
from the tenancy module so the invitation module does not duplicate tenant guard SQL.

## Routes

- `POST /agencies/:agencyId/invitations/collaborators` creates a collaborator invitation and answers,
  this once, the link it e-mailed (`invitationUrl`, `no-store`), for the inviter to copy (issue #710).
- A portal invitation is **no longer created** (issue #711, decision 2026-10-26): "Adicionar pessoa", in the
  `clients` module, gives the access to an e-mail address at once. The ones still pending are listed by
  `GET …/clients/:clientId/invitations`, can be cancelled, and are accepted until they expire; accepting one creates
  or links the access of its address in the same transaction (`app_private.accept_invitation`). Resending one answers
  `409 PORTAL_INVITATION_DISCONTINUED`.
- `POST /agencies/:agencyId/invitations/:invitationId/resend` replaces a pending collaborator invitation and answers the
  new link to copy the same way only to a caller who also holds `colaborador.convidar` (`null` otherwise), and both old
  tokens die with the old row.
- `DELETE /agencies/:agencyId/invitations/:invitationId` revokes a pending invitation.
- `GET /invitations/:token` previews a valid invitation.
- `POST /invitations/:token/accept-new-account` atomically creates the credential account and
  accepts the invitation. A collaborator invitation has **two single-use tokens** (decision 2026-10-27):
  the one in the e-mail, which no response, list, log or audit event ever carries, and the one the inviter
  copies (`invitationUrl`, once, `no-store`). Through the e-mail token the account is born with
  `emailVerified = true` (only the mailbox saw that token) and no confirmation e-mail goes out. Through
  the copied token, which the inviter holds too, it is born `emailVerified = false`: the confirmation link
  goes by e-mail and `/auth/email/verify` takes it with one click while the request carries that account's
  own session, or with the password chosen here. Either way the invitation's context is usable at once.
  The session guard keeps an unconfirmed account's session only while it has what the invitation gave it,
  and the password login stays closed to it until it confirms (`../auth/README.md`). The activation
  invitation (CLI) has only the e-mail token; the portal invitation keeps its single token and the
  unconfirmed account until #711 retires it. `token_hash` holds the copyable token and `email_token_hash`
  the e-mail one, which `ageniza_app` can write and never read; an invitation from before the migration
  has the first alone and stays the unconfirmed kind.
- `POST /invitations/:token/accept` accepts an invitation for the matching authenticated e-mail.

Handing out the `admin` role takes `colaborador.atribuir_admin`, which no preset holds and only the
Owner passes by ownership. The rule applies to creating a collaborator invitation and to resending one
that carries `admin`; both answer `403` before writing anything, and the `invitations_insert` policy
is the second barrier (issue #97, `specs/colaboradores.md` §5, rule 3).

Public token reads use `app_private.invitation_by_token_hash` (it finds the row by either hash), a `security definer` function that
returns only the invitation preview fields and a validity bit; `app_private.invitation_token_came_by_email` tells the route which kind it was given. Acceptance uses
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
