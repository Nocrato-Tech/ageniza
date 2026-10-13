# Media module (issue #21)

Direct-to-bucket media upload. The browser uploads straight to Cloudflare R2 (LocalStack locally);
neither the file nor a proxy passes through the VPS.

## Flow

1. `POST /agencies/:agencyId/media/uploads` -- validates tenant, capability (`midia.enviar`) and
   quota (including live pending reservations), inserts a `pending` `media_assets` row, and returns either one presigned `PUT` URL
   (small files) or a multipart `uploadId` (files at/above `MEDIA_MULTIPART_THRESHOLD_BYTES`).
2. For multipart, `POST .../uploads/:assetId/parts` returns presigned part URLs. It can be called
   again for a subset of part numbers to resume after a dropped connection -- a fresh URL replaces
   an expired or failed one; nothing about the upload has to restart from part 1.
3. The browser `PUT`s directly to a server-minted `staging/.../upload.<ext>` key in the bucket. That
   leading prefix lets production lifecycle rules target temporary objects only, and the key is
   distinct from the canonical `.../original.<ext>` key stored in `media_assets.object_key`.
4. `POST .../uploads/:assetId/complete` completes the multipart upload (if any), then calls
   `HeadObject` -- the only point where the real size and content type exist, because R2 does not
   support a presigned-POST size policy. If the object doesn't match the declared category's
   limits or the tenant's quota, the object is deleted from the bucket and the asset is marked
   `rejected`; otherwise the API copies the validated staging object to the canonical key and
   marks it `confirmed`. Reusing an unexpired upload URL can only mutate staging, never the
   confirmed original. Quota decisions take a transaction-scoped advisory lock keyed by
   `media-quota:<canonical agency UUID>`, so concurrent confirmations cannot consume the same
   remaining bytes/object slot. It is advisory rather than a row lock because `ageniza_app` has no
   UPDATE on `agencies`, and `SELECT ... FOR UPDATE` needs it (issue #296).
5. `GET /agencies/:agencyId/media/:assetId/download-url?variant=original|thumbnail|preview` issues
   a short-lived signed `GET`, meant to be requested only at the moment it is actually needed
   (a social network's API fetching the original, or the app displaying a preview). `variant`
   defaults to `original`; `thumbnail`/`preview` return 409 `VARIANT_NOT_READY` while processing
   and `VARIANT_PROCESSING_FAILED` with a stable failure reason after a terminal failure.

Every route requires `requireAgencyAccess` then a permission guard before any
signed URL is produced, so a caller from agency A can never obtain a URL for agency B's asset --
enforced at three independent layers: the route guard, the SQL scoping every asset lookup by both
`id` and `agency_id`, and `media_assets`' own row-level security policies.

## Video processing (issue #24)

When step 4 above confirms a **video** asset, the same transaction flips its
`video_processing_status` from `not_applicable` to `pending` and inserts the
`media.process-video` durable job (`job-dispatcher.ts`, a send-only pg-boss producer) carrying
only `assetId`/`agencyId`/`actorUserId` -- never a signed URL or file path. The job insertion uses
pg-boss's Knex adapter and the same transaction: confirmation and dispatch either both commit or
both roll back. Multipart completion is retry-safe if R2 completed it before a database rollback.
The worker
(`apps/worker/src/media-video-job.ts`) picks it up, re-derives the object key from the database
scoped to that tenant, downloads the original to a local temp directory, runs `ffmpeg`/`ffprobe`
(timeout-bounded, no network, output-size-capped) to produce a thumbnail and a 720p preview,
uploads both back under the asset's own key prefix, and records the outcome
(`thumbnail_object_key`, `preview_object_key`, `video_duration_seconds`, sizes, or a short
`video_processing_error`). The original is never transcoded.
See `apps/worker/src/media-video-job.ts` and its README/tests for the worker side in full.

## What the database holds (issues #295, #296, #371, #247)

`ageniza_app` inserts and updates `media_assets` only through column grants, and has no DELETE: the
identity columns (`id`, `agency_id`, `category`, the declared values, the object keys) are never
written by an UPDATE, and no row is inserted with a state. `created_by_user_id` is not written at
all: the database stamps it with the actor bound to the transaction. A `BEFORE UPDATE` trigger lets
`status` move only from `pending` to `confirmed` or `rejected`, stamps `confirmed_at` on the
confirmation, and writes the outcome (`confirmed_size_bytes`, `confirmed_content_type`,
`confirmed_at`, `rejected_reason`) once, with the status. It also holds the direction of
`video_processing_status` (`pending` -> `processing` -> `ready` or `failed`, retry back to
`pending`), the video results written once with `ready`, and `multipart_upload_id` set once while
the upload is pending. A new column is not writable until a migration grants it.
The API and the worker connect as `ageniza_app` for the user, so the database holds the shape of
the transition, not the proof that the content was validated; that proof stays in the `complete`
route.

A media may belong to a client and to one of that client's folders (`client_id`, `folder_id`,
`removed_at`, issue #247). A media with no client is read and written with `midia.enviar`, as
before; a media of a client is read with `conteudo.visualizar` and written with `conteudo.operar`.
`removed_at` has no write grant: a media leaves its folder only through
`app_private.remove_media_asset`, which refuses one that a content waiting for approval, approved or
published uses. The storage quota is `app_private.agency_media_usage`, summed over the whole agency
whatever the caller's RLS lets it read (issue #253; see the decisions of 2026-10-07).

### The retention of a removed media (issue #607)

A removed media keeps counting in the quota and keeps its files until the retention flow runs: **30 days after `removed_at`** the worker
deletes the original, the staging key and the thumbnail and preview of a video, and stamps `purged_at`; the row stays for the audit, and the quota
stops counting what was purged (decision of 2026-10-11, pending the owner). The database side is `app_private.media_due_for_purge(limit, after_removed_at, after_id)`
(what is due and not used by a content waiting for approval, approved or published, with the keys to delete, oldest first and after the cursor) and `app_private.mark_media_purged(asset)`
(the stamp, which asks the same again under the lock of the contents and writes `media.purged` to the audit); both refuse a request (an actor is
bound to its transaction) and answer only the worker. `purged_at` has no write grant: no route can set it. This module does not delete the
files itself: the flow lives in the worker (`apps/worker/src/media-purge-job.ts`).

## The client's media library (issue #253)

`folder-routes.ts` serves the folders and the media of a client under
`/agencies/:agencyId/clients/:clientId/media-folders`: list and create folders, list the media of a
folder (confirmed and not removed, newest first) and remove one. A client of another agency, a folder
of another client and a malformed id are the same 404. The writes need `conteudo.operar` **and**
`conteudo.visualizar`. `POST /agencies/:agencyId/media/uploads` takes an optional `clientId` and
`folderId`, both or neither; with them the route locks the folder (`app_private.lock_media_folder`),
checks the pair and the client, and demands the same two permissions instead of `midia.enviar`.
`parts` and `complete` accept either family, and RLS decides which media a role sees. The signed read URL
for a role that only holds `conteudo.visualizar` is the next section.

### The read URL of a client's media (issue #550)

`download-url` lets in `midia.enviar` **or** `conteudo.visualizar` (`MEDIA_READ_PERMISSIONS`), and the RLS of
`media_assets` picks what each role reads: a media with no client is `midia.enviar`, a media of a client is
`conteudo.visualizar`, and the other family's media is the same 404 as an absent one (a role with `midia.enviar` alone
never signs a client's media; Gestor and Produção never sign the agency's own). The lookup refuses a removed media
(`removed_at`), a pending or rejected one and one of another agency, all as 404, and writes `media.download_url_issued`
only when it signs the **original** (the thumbnail and the preview are not audited; the rate limit below is what bounds them). `variant=thumbnail` of an **image** is its original (no thumbnail is generated for it); of a **video**
it is the generated thumbnail, and `409 VARIANT_NOT_READY` (or `VARIANT_PROCESSING_FAILED`) until then, the code the screen
answers with a placeholder. The portal does not use this route (decision of 2026-10-11).

The route is limited **per user**: 600 requests in 5 minutes (`MEDIA_RATE_LIMITS.downloadUrlPerUser`), whatever the variant and the agency, and
the next one is `429 RATE_LIMITED` with `Retry-After` (seconds until the window ends). The key is the session user, not the IP and not the agency,
so a colleague behind the same address or in the same agency has a budget of their own, and a user in two agencies has one. The portal's read URL
(`GET /clients/:clientId/contents/:contentId/media/:assetId/url`) counts in the **same bucket**: the plugin makes a store per route, so
`sharedUserRateLimit` hands one handler to both routes, and a person of both sides does not get 600 on each. The limit runs after the
session and permission guards (a refused request counts for nobody) and before the lookup (a 429 audits and signs nothing). It lives in the
memory of the API process. The screens ask one URL per asset and keep it until it is about to expire, so 600 per window is a month of covers, the
folder page and the modal with room to spare; the numbers and what they do not stop are in the decision of 2026-10-11 on the download limit (#558).

The writes answer the race with the archive of the client in both of its windows: the archive still
running (`A0020` of the trigger) and the archive committed between the read of the client and the
`INSERT` (`42501` of the policy, read again as the client's state). Every write reads the client
after its locks, and `client-media-errors.ts` is the one place that maps what the database raises
(`A0080` to 404, `A0081`/`A0020` to 409 `CLIENT_ARCHIVED`, `A0082` to 409 `MEDIA_IN_USE`,
`40P01`/`40001` to 409 `TRY_AGAIN`). `remove_media_asset` answers whether this call removed the
media, and only then is `media.removed` audited. The route fails instead of reading a `null` as "not removed".

`complete` and `parts` are writes into a child of the client too: for a media of a client they read the client after the lock of
the media, and `complete` reads it again after the quota lock, the last wait before the write, because the calls to the bucket and
that lock can outlast an archive. An archived client is 409 `CLIENT_ARCHIVED`, the media staying `pending`, with no part URL issued
and no reservation renewed.
What the route cannot do is wait for an archive that is still running: the confirmation `UPDATE` has no lock on the client,
so that window belongs to a trigger of the database (issue #532, second half). A folder name refuses what renders as nothing
(`Default_Ignorable_Code_Point` and U+2800), except U+FE0F right after a pictograph. A page past the end of either list answers the
real total, counted on its own.

## Environment variables

See `.env.example` (local defaults) and `infra/vps/runtime.env.example` (production). Local
access keys are generated into ignored `.local/storage.env` by `pnpm storage:start`; no
storage credential is versioned. All
four of `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` are required
together and required in production; every other `R2_*`/`MEDIA_*`/`STORAGE_QUOTA_*` variable has a
sensible default. `R2_PUBLIC_ENDPOINT` only matters when the API itself runs inside the local
Compose network (its `endpoint` there is the internal `localstack:4566`, unreachable from a browser on
the host) -- see the `StorageConfig` doc comment in `packages/config/src/server.ts`.

## What must be configured by hand in production (cannot be expressed as a migration or Compose file)

- **Create the R2 bucket and an API token scoped to only that bucket.** Put the resulting
  endpoint/key/secret/bucket name into `runtime.env` on the VPS (`infra/vps/runtime.env.example`).
- **Bucket CORS**, allowing `PUT`/`GET` from the application's real origin and exposing the
  `ETag` response header (multipart completion needs it). Cloudflare's dashboard/API is the only
  way to set this for R2, which is why no code path here sets it. Locally the equivalent rule is
  applied by `infra/localstack/init-bucket.sh` through `PutBucketCors`, the same S3 call R2 does not
  expose -- so the local rule is shaped like the production one, but reaches the bucket differently.
- **Bucket lifecycle rules**: abort incomplete multipart uploads and expire objects under the
  `staging/` prefix after a short window (for example 1-2 days), and, if desired, expire objects still in this app's own `pending` state past
  that same window (their DB row stays as a rejected/expired record; nothing here auto-deletes a
  `pending` row, only a `complete` call's own validation does). Configure this in the R2 dashboard.
- **Never make the bucket or any object public.** Every object is fetched only through a signed
  URL issued by this module.

## What could not be verified locally

Everything in this module's automated tests (`media.integration.test.ts`,
`media-storage.integration.test.ts`) runs against the real local LocalStack started by
`pnpm storage:start`, including full single-part and multipart round trips,
quota/size/type rejection with real object deletion, and cross-tenant isolation. Two things are
genuinely specific to R2 and were not (and could not be) exercised locally:

- **R2's actual multipart minimum part size and any R2-specific quirks in presigned URL behavior**
  (LocalStack's S3 emulation is highly compatible but is not R2 itself). The client code follows the
  documented S3 multipart contract (5 MiB minimum per part except the last), which R2 also
  documents, but this was not run against a real R2 bucket in this environment.
- **R2 bucket CORS and lifecycle configuration**, since neither is expressible through code or
  Compose for R2 -- see the "configured by hand" section above. Locally the CORS rule is real and
  per-bucket, including the exposed `ETag`; there is still no local lifecycle rule at all.
- **Credential rejection.** LocalStack accepts any credential pair, so a wrong key fails nowhere
  locally. MinIO did enforce this before it left every public registry; that check moved to the
  list of things only a real R2 bucket can prove.
