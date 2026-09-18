# Convites

The invitation HTTP module owns the administrative and public invitation flows for AUTH-20B.
All request and response payloads are validated at the route boundary, and tenant mutations run
inside `withAuthenticatedUserTransaction`, which sets the transaction-local `app.user_id` before
the RLS-protected query. The `requireAgencyAccess` and `requirePermission` prehandlers are injected
from the tenancy module so the invitation module does not duplicate tenant guard SQL.

## Routes

- `POST /agencies/:agencyId/invitations/collaborators` creates a collaborator invitation.
- `POST /agencies/:agencyId/clients/:clientId/invitations` creates a client invitation.
- `POST /agencies/:agencyId/invitations/:invitationId/resend` replaces a pending invitation.
- `DELETE /agencies/:agencyId/invitations/:invitationId` revokes a pending invitation.
- `GET /invitations/:token` previews a valid invitation.
- `POST /invitations/:token/accept-new-account` atomically creates the credential account and
  accepts the invitation.
- `POST /invitations/:token/accept` accepts an invitation for the matching authenticated e-mail.

Public token reads use `app_private.invitation_by_token_hash`, a `security definer` function that
returns only the invitation preview fields and a validity bit. Acceptance uses
`app_private.accept_invitation`, also `security definer`, which locks and revalidates the token,
creates the membership/owner and legal acceptances atomically, consumes the token, and writes its
audit events. PostgreSQL's private error codes are translated to one `410 INVALID_LINK` response;
the token itself is never logged or persisted (only its SHA-256 hash is stored).

Administrative invitation rows and their audit event are committed before synchronous SMTP
delivery. A delivery failure therefore returns `502 EMAIL_DELIVERY_FAILED` while leaving the
invitation valid for a later resend.

The auth password recovery routes accept an optional `inviteToken`. It is appended to the reset
link only when the token is valid for the requested e-mail; a valid continuation signs the user in
after reset so the invitation can be accepted without a second login. Invalid optional tokens keep
the ordinary non-enumerating forgot/reset responses.
