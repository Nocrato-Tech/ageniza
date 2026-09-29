# Identity storage module (issue #100)

Object storage for identity assets -- a user's profile photo today (issue #101), a client's photo
(issue #126) and, once per-agency portal personalization exists, an agency's own visual identity.

## Why this is not the media module

Decision recorded in `docs/business/decisions.md` (2026-09-24, "Foto de perfil vive em
armazenamento de identidade, separado do módulo de mídia"). The **user is global**; **media**
(`apps/api/src/modules/media/`) is per-agency and quota-limited. A photo stored in the media
bucket would disappear from every other agency the moment its owner leaves the agency that
happened to hold it, or that agency is suspended -- the file belonged to the tenant, not to the
person. Keeping identity storage separate also means an avatar never competes with a client's
video for that agency's storage quota.

This module has no routes of its own: it is infrastructure that `colaboradores` (#101) and
`clientes` (#126) import, the same way `tenancy` exports guards without owning a route.

## What is here

- `storage-client.ts` -- `createIdentityStorageClient`, an S3-compatible client against the
  separate identity bucket, with exactly three operations: `uploadIdentityImage`,
  `deleteObject`, `presignGetObject`. Mirrors `apps/api/src/modules/media/storage-client.ts`.
- `policy.ts` -- `detectIdentityImageType` (magic-byte detection of the still-image allowlist
  media uses: PNG, JPEG, WebP, GIF; no video), `contentTypeForExtension` (the reverse lookup a
  signed read URL uses to force a safe response type), and the object-key builders for the two
  owners this storage must serve.

## Decisions made by this task (justified here, per issue #100)

**Transport: upload through the API server, not a presigned PUT.** Media uses presigned PUT plus
a `HeadObject` confirm step because files can be large and multipart; an identity image is capped
at `IDENTITY_MAX_IMAGE_BYTES` (default 5 MiB, schema maximum 10 MiB) and always a single
`PutObject`. Routing the bytes through the server lets `uploadIdentityImage` validate the real
size and detect the real content type of what was actually sent *before* it is written -- no
staging key, no confirm round trip, no window where an unconfirmed object sits in the bucket. The
trade-off is that the request body passes through the API process instead of going straight from
the browser to the bucket; for an object this small, that cost is negligible next to the
complexity it removes.

Because this body is read by Fastify's own parser (unlike media's direct-to-bucket presigned PUT,
which never touches it), **the route that calls `uploadIdentityImage` (#101, #126) must declare
its own Fastify `bodyLimit`, at least the configured `maxImageBytes` plus any transport overhead
(multipart form-data or base64 add their own).** The global
`API_BODY_LIMIT_BYTES` (1 MiB by default) is deliberately not raised to accommodate this: raising
it would widen every other route's exposure to large bodies, for the benefit of only this one.

**Type detection is by content, never by a declared header or file name.** `uploadIdentityImage`
ignores whatever `Content-Type` or extension a caller might have received from the browser and
sniffs the first bytes itself (`detectIdentityImageType`): PNG, JPEG, GIF and WebP each have a
fixed signature. Anything else -- including HTML or SVG wearing an `image/png` label, which is
exactly the shape of attack a signed URL later serving `text/html` would enable -- is rejected
before anything is written, via `IdentityImageTypeRejectedError`. `presignGetObject` then forces
`ResponseContentType` (from the key's own extension) and `ResponseContentDisposition: inline` on
every signed URL it issues, so what the browser receives can never be `text/html`, regardless of
what ended up stored as the object's own metadata.

**Size is validated by `uploadIdentityImage` itself**, against `IdentityStorageConfig.maxImageBytes`,
throwing `IdentityImageTooLargeError` and writing nothing when the body is too large.

**Object key shape: versioned, not deterministic.** `users/<userId>/avatar/<versionId>.<ext>` and
`agencies/<agencyId>/clients/<clientId>/avatar/<versionId>.<ext>` (`policy.ts`'s
`buildUserAvatarKeyPrefix`/`buildClientAvatarKeyPrefix`, which `uploadIdentityImage` appends the
detected extension to). `versionId` is a fresh UUID the caller generates per upload -- **not** a
fixed name like `avatar.<ext>`. A fixed name looked deterministic but had two real defects: an
upload that changes content type (PNG to JPEG) left the previous extension's object behind
forever, and even when the extension repeated, the object was overwritten *before* the caller's
own database commit, so a rolled-back transaction left a photo live that no reference in the
database ever pointed at.

The protocol #101 and #126 must both follow:

1. Call `uploadIdentityImage({ keyPrefix: buildUserAvatarKeyPrefix(userId, randomUUID()), body })`.
   It returns the final `key` (extension included).
2. Commit that `key` as the owner's current photo reference in the same database transaction the
   route already needs for its other writes. Only after this commits does anything treat the new
   key as current.
3. If the owner had a previous key, `deleteObject` it now that the commit succeeded.

If step 3 never runs (the process crashes between steps 2 and 3, for example), the previous
object is merely orphaned, never referenced by anything and never served -- not the accumulating
liability. This module does not (yet) sweep orphans; if that becomes worth doing, it is a
follow-up, not a blocker for #101/#126. When an account or a client is deleted, the identity
objects under its prefix should be removed too, once that deletion flow exists (out of scope
here).

Every id in a key is a UUID and every extension one of `detectIdentityImageType`'s own outputs
(`policy.ts`'s `requireUuid`/`requireKnownExtension`, private to that module): a builder call with
anything else -- including a `../` path segment -- throws rather than producing a key.

**Read access: signed URL, like media.** Never a public bucket or object. A short-lived signed
`GET` (`IDENTITY_DOWNLOAD_URL_EXPIRY_SECONDS`, 300s by default) is the only way anything reads an
identity object, matching the media module's own invariant.

**Credential separation is enforced, not just documented.** `packages/config/src/server.ts`
refuses to load if `IDENTITY_STORAGE_BUCKET` equals `R2_BUCKET`, or if
`IDENTITY_STORAGE_ACCESS_KEY_ID` equals `R2_ACCESS_KEY_ID`; `infra/vps/ageniza-deploy.sh` runs the
same two checks against the production `runtime.env` before a deploy is allowed to proceed.

## Environment variables

See `.env.example` (local defaults) and `infra/vps/runtime.env.example` (production). All four of
`IDENTITY_STORAGE_ENDPOINT`, `IDENTITY_STORAGE_ACCESS_KEY_ID`, `IDENTITY_STORAGE_SECRET_ACCESS_KEY`
and `IDENTITY_STORAGE_BUCKET` are required together and required in production, exactly like
media's `R2_*` variables -- see the `IdentityStorageConfig` doc comment in
`packages/config/src/server.ts`. Configuration also refuses to load if `IDENTITY_STORAGE_BUCKET` equals `R2_BUCKET`, or if
`IDENTITY_STORAGE_ACCESS_KEY_ID` equals `R2_ACCESS_KEY_ID`: bucket and credential must both stay
distinct from media's, or the whole point of this module is undone. `IDENTITY_STORAGE_PUBLIC_ENDPOINT`
only matters when the API runs inside the local Compose network, exactly like `R2_PUBLIC_ENDPOINT`
(and, like it, is not an allowed key in production's `runtime.env` -- see
`infra/vps/ageniza-deploy.sh`).

Local credentials come from the same `.local/storage.env` `pnpm storage:start` already generates
for media, but as their **own generated pair** (`scripts/docker/local-stack.mjs`): LocalStack does
not actually enforce any credential, but the two pairs are kept genuinely distinct locally too, so
nothing about the local setup hides a real bug the production separation exists to prevent.
Production uses a **separate R2 API token**, scoped only to the identity bucket (see below).

## Local environment: `pnpm storage:start`

`infra/localstack/init-identity-bucket.sh` runs as a second LocalStack ready hook alongside
media's `init-bucket.sh`, creating `ageniza-identity-local` and its CORS rule (`GET`/`HEAD` only --
uploads never hit this bucket directly from the browser, so no `PUT`/`POST` rule is needed here,
unlike media's). The Compose healthcheck waits on both hooks' marker files, so `pnpm storage:start`
prepares this destination with no manual step, same as media's bucket.

## What must be configured by hand in production (cannot be expressed as a migration or Compose file)

- **Create a second R2 bucket, distinct from the media bucket, and an API token scoped to only
  that bucket.** Put the resulting endpoint/key/secret/bucket name into `runtime.env` on the VPS
  (`infra/vps/runtime.env.example`). A separate token means a compromised media credential can
  never touch identity objects, and vice versa.
- **Bucket CORS**, allowing `GET` from the application's real origin (browsers fetch the signed
  read URL directly). No `PUT`/`POST` rule is needed: upload goes through the API server. Set this
  in the Cloudflare dashboard/API, the same way media's bucket CORS is set by hand -- see
  `apps/api/src/modules/media/README.md`.
- **No lifecycle rules are needed here.** Unlike media, there is no staging prefix and no
  multipart upload to clean up: every write is a single, already-validated `PutObject`.
- **Never make the bucket or any object public.** Every object is fetched only through a signed
  URL issued by this module. Confirm this by checking that an anonymous `GET` of an object and an
  anonymous `ListObjects` of the bucket are both refused -- see the note below on why this cannot
  be checked locally.

## What could not be verified locally

Everything this module's own automated test exercises runs against the real local LocalStack
started by `pnpm storage:start` (upload with size/type validation and rejection, signed-URL read
with forced response headers, delete, key-builder validation, and that an identity upload never
reaches the media bucket). Three things are specific to R2 (or absent from LocalStack's emulation)
and were not, and could not be, exercised locally, for the same reasons the media module's README
gives:

- **R2's own presigned-URL quirks.**
- **R2 bucket CORS**, not expressible through code or Compose for R2 -- see the "configured by
  hand" section above.
- **Anonymous access rejection.** LocalStack does not enforce the access control an unsigned
  request would hit on a real private R2 bucket, so "the bucket is not public" can only be
  verified by inspection here (the client never builds anything but a signed URL) and, ultimately,
  against the real bucket in production. The media module documents the same class of gap for
  credential rejection.
