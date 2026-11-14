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
   support a presigned-POST size policy -- and then reads the first bytes of the object
   (`upload-inspection.ts`, see "What a file is" below). If the object doesn't match the declared
   category's limits, isn't the type it declared or doesn't fit the tenant's quota, the object is
   deleted from the bucket and the asset is marked `rejected`; otherwise the API copies the validated staging object to the canonical key and
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

### The portal's upload (scope redesign-igual, W12-S1; decision 2026-11-11)

`portal-upload-routes.ts` serves the client's own people under `/clients/:clientId/material-requests/:threadId/uploads` (`requireSession` and
`requireClientAccess`; the client is the one the guard proved): `POST` starts (the database function reserves the file and the route signs the
single `PUT` to staging), `POST …/:assetId/complete` finishes, `GET` lists what the person sent. The announcement of a batch lives in the
clients module (`POST …/uploads/announce`), because it writes the comment of the portal; it is handed what it needs from here
(`portalUploadsForClients`) by `app.ts`, so neither module imports the other.

- **One reading of the bytes.** `copyAndInspectStagedObject` (`upload-inspection.ts`) is the agency's confirmation and the portal's: head the
  staging, copy to the final key, head and judge the copy with `judgeUploadedObject`. The portal gives it the limits of 25 MiB for every category
  and refuses a bigger staging object before copying it. An SVG is never accepted: the database refuses the declared type, and an object whose
  bytes are one is `content_type_mismatch`.
- **What happens to the objects.** A verdict that turns the file down (the bytes, or the database's `request_full`/`agency_unavailable`) is
  recorded and answered as `422 UPLOAD_REJECTED`, and **both objects are removed**: the one at the final key before the refusal is written (a
  failure to remove it rolls the refusal back), the one in staging after the commit, best effort (the bucket lifecycle takes what is left). A
  failure of the database or a refusal that records nothing (a resolved request, a read-only agency, a lost race) removes only the copy at the
  final key and leaves staging, so the person can finish the same file again.
- **One finish at a time per file.** The whole finish is one transaction, and a per-file advisory lock (`lockPortalUploadCompletion`) is
  taken once the file is proven the person's own and always before the locks of the database. Without it two finishes of one file copy two
  staging objects to the one final key between the verdict and the confirmation.
- **The keys.** The list of the person carries the final key only of a confirmed file and never the staging one, and the portal reads no
  table. The two keys of a pending file are derived from the agency of the client and the extension of the declared type with the agency's own
  functions (`objectKeyFor`, `uploadObjectKeyFor`, `policy.ts`); `portal-upload.integration.test.ts` compares them with what the database wrote.
  No answer carries a key: the read URLs of the list are signed with the final key and dropped.
- **Neutral answers.** `portal-upload-errors.ts` turns `A0130`…`A0136` and `A0090` into answers that say nothing of the plan, the quota, the
  storage or the billing: one 404 for everything that is not there for the person, and one sentence for the agency that cannot take the file
  and the one that is read-only. `A0090` never reaches the global handler, whose text is the trial's.
- **Audit.** `media.upload_initiated`, `media.upload_confirmed` and `media.upload_rejected`, with the person of the portal as the actor.
- **The agency's side.** `lockAssetForCompletion` takes only `uploaded_by_side = 'agency'`: the agency finishing the reservation of a client
  (`complete` or `parts`) is the same 404 as an absent file, so it cannot skip the checks of the portal. The library answers `uploadedBySide`.
- The tests use an in-memory bucket (`test-support/memory-storage.ts`) behind `wrapMediaStorage`, so they need no storage running.

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

## What a file is, and what a library can do with it (decisions of 2026-11-11)

The list of types is in code (`policy.ts`), never in the request: the five categories of `media_assets.category` are `image`
(PNG, JPEG, WebP, GIF), `video` (MP4, MOV, WebM), `pdf`, `audio` (MP3, M4A, WAV, WebM, Ogg) and `logo`. A logo is a PNG, JPEG or WebP the
agency marks with `asLogo: true`, or an SVG (accepted **only** as a logo); a GIF, a video, a PDF and an audio are never one. A PDF, an audio
and a logo belong to a client's library, so `clientId` and `folderId` are mandatory for them (415 without), and the content screens, which
pick only images and videos, never list them (`set_content_media` and the folder listing are restricted to those two).

**The confirmation reads the bytes.** After `HeadObject`, `upload-inspection.ts` refuses (reason on the row, object deleted, 422
`UPLOAD_REJECTED` with `details.reason`): `content_type_mismatch` (the stored type is not the declared one, or the first bytes are not
that type's signature: `content-sniff.ts`), `too_large` (above the category ceiling), `empty_object`, `invalid_dimensions` (an image
header giving 0 or more than 100000 pixels), `svg_rejected`, `object_not_found`, `quota_exceeded`. Image dimensions are read from the header
(`width`, `height`, written with the confirmation and never again; no EXIF orientation is applied to a photo), a video's by the worker with
`ffprobe` (as displayed, with the rotation applied), and a PDF, an audio and an SVG have none.

**An SVG is read whole and parsed strictly** (`svg-guard.ts`): at most 256 KiB, UTF-8, an `<svg>` root, no script, `foreignObject`,
iframe/embed/object/html, no `on*` attribute, no `xml:base`, no reference that is not a `#fragment` (no `href`, `src`, `url()` or `@import`
out), no entity declaration, no animation that sets a link or a handler. What it does not recognise it refuses. Defence in depth: **an SVG,
a PDF and an audio are never served inline.** `download-url` signs the GET with `response-content-type` (the type the server confirmed,
never the stored one) and `response-content-disposition: attachment; filename="..."` (name built to be unable to close its own quotes), both
part of what the URL signs: whoever holds the URL cannot drop or change either, and the browser downloads the file as the type the server
confirmed instead of guessing one and opening it. That signed pair is the whole compensation for `X-Content-Type-Options: nosniff`, which
cannot be added to a presigned S3/R2 GET and is not asked of the bucket's edge (decision 2026-11-11 on PDF, audio and SVG, rule 3).

**Defensive limits** that no decision gave a number for (so they are the code's, not a product rule): SVG 256 KiB; PDF up to the smaller of
100 MiB and the video ceiling; audio the smaller of 200 MiB and the video ceiling; dimensions 1 to 100000; a name is one line of at most 255
characters without `/`, `\`, control, bidi or invisible characters (the line and paragraph separators U+2028 and U+2029 and the Arabic letter
mark U+061C included, in the contract and in the CHECK of the column), and is a **label**: the object key is only the agency, the asset and the
fixed extension of the type; the alternative text is one line of at most 500 characters.

### The library routes (`library-routes.ts`)

Under `/agencies/:agencyId/clients/:clientId`, guarded like the folders (reads `conteudo.visualizar`, writes `conteudo.operar` **and**
`conteudo.visualizar`; a client, a file or a folder of someone else and a malformed id are the same 404; an archived client is 409
`CLIENT_ARCHIVED`, a read-only agency 409 `AGENCY_READ_ONLY`):

- `GET /media`: the client's confirmed files across folders, newest first (`q` by name ignoring case and accents with `%` and `_` as plain
  characters, `category`, `folderId`, page of 48).
- `GET /media/:assetId`, `PATCH /media/:assetId` (`name`, `altText`; one `media.renamed` / `media.alt_text_changed` event for each thing that
  changed) and `GET /media/:assetId/usage` (the contents that hold it as a media or as the cover, with their state).
- `POST /media/:assetId/move` into another folder of the same client (`app_private.move_media_asset`, `media.moved`). A file that **any**
  content holds (a draft too) is 409 `MEDIA_IN_USE`: the content is tied to the folder of its media by foreign keys.
- `GET /media-folders/summary`: each folder with the count by type, the total size, the last change (its creation, or a confirmed file written
  or removed in it), who uploaded the newest file and `inUseNow`; `PATCH /media-folders/:folderId` renames a folder the agency made (a default
  one is 409 `DEFAULT_FOLDER_IMMUTABLE`). The uploader is `null` for a person with no link to the agency (the portal).
- `DELETE /media-folders/:folderId` (204, `media.folder_deleted` with target type `media_folder`) deletes a folder that is not a default one and is
  empty, through `app_private.delete_media_folder`, which holds the rule and the locks (the client `for share`, then the folder `for update`, then
  the media of the folder `for update` in the order of their id, before they are counted; a move and an upload start lock the same folder, so
  neither can land in it while it goes). Refused with 409: a default folder (`A0086`,
  `DEFAULT_FOLDER_IMMUTABLE`), and a folder with files, subfolders or contents (`A0083`/`A0084`/`A0085`, `FOLDER_NOT_EMPTY`, each with its own
  message). A file counts when it is confirmed and not removed, or an upload still pending that was touched in the last 24 hours (a defensive limit, so an
  abandoned upload cannot keep a folder for ever); the removed, the rejected and the abandoned rows stay for the audit and are detached from the
  folder (`folder_id` null), the abandoned ones closed as rejected with the reason `folder_deleted`. The media lock is what makes the confirmation
  of an abandoned upload safe: one that is running keeps its file (the delete waits, reads it as confirmed and refuses), and one that comes after
  finds the upload rejected, so a confirmed file is never left with no folder. Each statement that lets a file go names its state (rejected or
  removed), and a file that is confirmed and not removed is never one of them: if one is left, the delete is refused with `A0083`.
- `inUseNow` is true for at most one folder of the client: the one that is not a default one whose confirmed, not removed file was filed last
  (`media_assets.filed_at`), within `MEDIA_FOLDER_IN_USE_WINDOW_DAYS` (30). A file is filed by the confirmation of its upload, its rename and its
  move into the folder, and by nothing else: the alternative text and the processing of a video write the row (`updated_at`) and do not file it.
  `filed_at` is stamped by a trigger of the database from the transition of the row, the way `confirmed_at` is, and the application has no grant on
  it. It is computed over all the folders of the client, not over the page asked for. Creating or renaming the folder does not count: no column
  keeps it.

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
  URL issued by this module. There is no public host to put a header rule on: the forced type and the
  `attachment` disposition signed into each URL are what keep a file from opening as a page.

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
