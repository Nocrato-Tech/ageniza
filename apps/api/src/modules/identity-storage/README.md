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
  separate identity bucket: `uploadObject`, `deleteObject`, `presignGetObject`. Mirrors
  `apps/api/src/modules/media/storage-client.ts`.
- `policy.ts` -- the accepted content types (the same still-image allowlist media uses: PNG,
  JPEG, WebP, GIF; no video) and the two object-key shapes this storage must serve.

## Decisions made by this task (justified here, per issue #100)

**Transport: upload through the API server, not a presigned PUT.** Media uses presigned PUT plus
a `HeadObject` confirm step because files can be large and multipart; an identity image is capped
at `IDENTITY_MAX_IMAGE_BYTES` (5 MiB by default) and always a single `PutObject`. Routing the
bytes through the server lets the route that will call this client (#101, #126) validate the real
size and content type of what was actually sent *before* it is written -- no staging key, no
confirm round trip, no window where an unconfirmed object sits in the bucket. The trade-off is
that the request body passes through the API process instead of going straight from the browser to
the bucket; for an object this small, that cost is negligible next to the complexity it removes.

**Object key shape.** `users/<userId>/avatar.<ext>` and
`agencies/<agencyId>/clients/<clientId>/avatar.<ext>` (`policy.ts`'s `buildUserAvatarKey` /
`buildClientAvatarKey`). Deterministic per owner -- a re-upload overwrites the previous object at
the same key -- so the caller does not need a list-and-clean step, only a `deleteObject` of the old
key when an owner explicitly removes their photo. The prefix is the owner, never the agency alone:
an agency-first key (`agencies/<agencyId>/avatar.<ext>`) would have quietly rebuilt the same
per-tenant coupling this storage exists to avoid.

**Size and type limits.** Same still-image allowlist as media (`describeIdentityContentType`);
video is never accepted here. `IDENTITY_MAX_IMAGE_BYTES` defaults to 5 MiB -- generous for a
profile photo, small enough that a synchronous upload never risks blocking the API event loop for
long.

**Read access: signed URL, like media.** Never a public bucket or object. A short-lived signed
`GET` (`IDENTITY_DOWNLOAD_URL_EXPIRY_SECONDS`, 300s by default) is the only way anything reads an
identity object, matching the media module's own invariant.

## Environment variables

See `.env.example` (local defaults) and `infra/vps/runtime.env.example` (production). All four of
`IDENTITY_STORAGE_ENDPOINT`, `IDENTITY_STORAGE_ACCESS_KEY_ID`, `IDENTITY_STORAGE_SECRET_ACCESS_KEY`
and `IDENTITY_STORAGE_BUCKET` are required together and required in production, exactly like
media's `R2_*` variables -- see the `IdentityStorageConfig` doc comment in
`packages/config/src/server.ts`. Configuration also refuses to load if
`IDENTITY_STORAGE_BUCKET` is ever set to the same value as `R2_BUCKET`: the two buckets must stay
distinct, or the whole point of this module is undone. `IDENTITY_STORAGE_PUBLIC_ENDPOINT` only
matters when the API runs inside the local Compose network, exactly like `R2_PUBLIC_ENDPOINT`.

Local credentials come from the same `.local/storage.env` `pnpm storage:start` already generates
for media -- LocalStack accepts any credential pair for any bucket, so no second secret pair is
generated locally. Production uses a **separate R2 API token**, scoped only to the identity
bucket (see below).

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
  URL issued by this module.

## What could not be verified locally

Everything this module's own automated test exercises runs against the real local LocalStack
started by `pnpm storage:start` (upload, signed-URL read, delete, and the content-type/size
policy helpers). Three things are specific to R2 (or absent from LocalStack's emulation) and were
not, and could not be, exercised locally, for the same reasons the media module's README gives:

- **R2's own presigned-URL quirks.**
- **R2 bucket CORS**, not expressible through code or Compose for R2 -- see the "configured by
  hand" section above.
- **Anonymous access rejection.** LocalStack does not enforce the access control an unsigned
  request would hit on a real private R2 bucket, so "the bucket is not public" can only be
  verified by inspection here (the client never builds anything but a signed URL) and, ultimately,
  against the real bucket in production. The media module documents the same class of gap for
  credential rejection.
