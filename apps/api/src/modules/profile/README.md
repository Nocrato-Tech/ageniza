# Profile module (issue #101)

The self-service profile: `PATCH /me/profile` (name) and `POST /me/photo` (photo), from
`specs/colaboradores.md` §§3, 5 and 6. Both are deliberately **unscoped by agency** and require
**no module permission**: name, e-mail and photo belong to the global `auth."user"`, and editing
your own profile is about yourself, resolved by identity.

## The trap this module exists to avoid

`auth."user"` has **no RLS** -- the schema is Better Auth's and the CI gate only enforces row level
security on `public`, so `ageniza_app` reads any user on the platform. There is no second barrier:
a route that accepted a user id from the client would edit *anyone*.

The target is therefore always the verified session user (`request.auth.userId`):

- the body schema is `.strict()`, so an extra `userId` field is a 400, not a silently ignored key;
- the query string is never read;
- there is no `/:userId` path segment.

`profile.integration.test.ts` attempts all three (body, query, path) against another account and
checks that account is unchanged.

## Name

`PATCH /me/profile` validates the name with the shared `DisplayNameSchema`
(`packages/contracts/src/display-name.ts`): it trims, caps at `DISPLAY_NAME_MAX_LENGTH` (120),
rejects control, bidi-override and invisible characters, and requires at least one letter or
number. `specs/colaboradores.md` requires a limit but fixes no number, so 120 is this module's
choice, recorded in `docs/business/decisions.md` (2026-09-30, **pending validation**). The update
runs as `update auth."user" set name = ?, "updatedAt" = now() where id = <session id>` -- the
primary key, so it affects exactly one row.

**E-mail is not editable by any route in this module.** A request that tries is rejected by
`.strict()`, and the column is never written.

## Photo

`POST /me/photo` takes the image **base64-encoded in a JSON body** and uploads it through
`identity-storage`'s `uploadIdentityImage`. Issue #100 chose server-side transport for identity
assets; base64 was chosen over multipart here because the API has no multipart parser and an avatar
is small. The route declares its **own** `bodyLimit` (`policy.ts`'s
`profilePhotoBodyLimitBytes`), sized for the base64 expansion (4/3) plus the JSON envelope, so an
oversized body is refused by Fastify's parser before any handler buffers it -- the global
`API_BODY_LIMIT_BYTES` is deliberately not raised for this.

- **Type is validated by the bytes**, never by a declared header or extension. There is no
  `contentType` field in the request at all: SVG or HTML wearing an `image/png` label is refused by
  `detectIdentityImageType`, and `.strict()` rejects the label outright.
- **The key comes only from server ids**: `buildUserAvatarKeyPrefix(sessionUserId, randomUUID())`.
  Nothing in the key is client-controlled.
- **The reference is `auth."user".image`**, which stores the object key. The new key is committed
  first (reading the previous one in the same transaction), then the previous object is deleted --
  issue #100's protocol, so a failed write can never leave a live, unreferenced avatar.
- **The response returns a short-lived signed GET** (`presignGetObject`), which forces a safe
  `Content-Type`/`Content-Disposition` regardless of what is stored.
- **No agency quota.** The object lives in the identity bucket; nothing is written to
  `media_assets` or `agency_storage_quotas`.
- **Concurrent uploads are serialized** by `select ... for update` on the user row
  (`service.ts`'s `loadOwnProfile`): without the lock, several transactions read the same previous
  key and all but one object is orphaned. The route also has a **per-user rate limit**
  (`policy.ts`'s `PROFILE_PHOTO_RATE_LIMIT`), because identity storage has no quota and the ceiling
  must follow the account.
- **A failed reference commit deletes the object it just wrote** (the `catch` around the commit),
  so a database failure cannot leave a live, unreferenced avatar.

## What this module does not do

- No `GET` of the profile: the frontend task (#108) and the collaborator listing (#95) read the
  name/photo through `agency_memberships`, per the SPEC's rule 2.
- No e-mail change, no password change.
- No orphan sweep: a crash between the commit and the old-object delete leaves an orphaned object
  that is never referenced or served (issue #100's README).
