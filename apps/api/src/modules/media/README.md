# Media module (issue #21)

Direct-to-bucket media upload. The browser uploads straight to Cloudflare R2 (MinIO locally);
neither the file nor a proxy passes through the VPS.

## Flow

1. `POST /agencies/:agencyId/media/uploads` -- validates tenant, capability (`midia.enviar`) and
   quota, inserts a `pending` `media_assets` row, and returns either one presigned `PUT` URL
   (small files) or a multipart `uploadId` (files at/above `MEDIA_MULTIPART_THRESHOLD_BYTES`).
2. For multipart, `POST .../uploads/:assetId/parts` returns presigned part URLs. It can be called
   again for a subset of part numbers to resume after a dropped connection -- a fresh URL replaces
   an expired or failed one; nothing about the upload has to restart from part 1.
3. The browser `PUT`s directly to R2/MinIO.
4. `POST .../uploads/:assetId/complete` completes the multipart upload (if any), then calls
   `HeadObject` -- the only point where the real size and content type exist, because R2 does not
   support a presigned-POST size policy. If the object doesn't match the declared category's
   limits or the tenant's quota, the object is deleted from the bucket and the asset is marked
   `rejected`; otherwise it is marked `confirmed`.
5. `GET /agencies/:agencyId/media/:assetId/download-url` issues a short-lived signed `GET`, meant
   to be requested only at the moment a social network's API needs to fetch the file.

Every route requires `requireAgencyAccess` then `requirePermission('midia.enviar')` before any
signed URL is produced, so a caller from agency A can never obtain a URL for agency B's asset --
enforced at three independent layers: the route guard, the SQL scoping every asset lookup by both
`id` and `agency_id`, and `media_assets`' own row-level security policies.

## Environment variables

See `.env.example` (local/MinIO defaults) and `infra/vps/runtime.env.example` (production). All
four of `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` are required
together and required in production; every other `R2_*`/`MEDIA_*`/`STORAGE_QUOTA_*` variable has a
sensible default. `R2_PUBLIC_ENDPOINT` only matters when the API itself runs inside the local
Compose network (its `endpoint` there is the internal `minio:9000`, unreachable from a browser on
the host) -- see the `StorageConfig` doc comment in `packages/config/src/server.ts`.

## What must be configured by hand in production (cannot be expressed as a migration or Compose file)

- **Create the R2 bucket and an API token scoped to only that bucket.** Put the resulting
  endpoint/key/secret/bucket name into `runtime.env` on the VPS (`infra/vps/runtime.env.example`).
- **Bucket CORS**, allowing `PUT`/`GET` from the application's real origin and exposing the
  `ETag` response header (multipart completion needs it). Cloudflare's dashboard/API is the only
  way to set this for R2; MinIO has no equivalent bucket-level CORS API at all -- locally, CORS is
  a MinIO *server* setting instead (`MINIO_API_CORS_ALLOW_ORIGIN` in `compose.yml`), which is why
  there is no code path that could set this for R2 either.
- **Bucket lifecycle rules**: abort incomplete multipart uploads after a short window (for
  example 1-2 days) and, if desired, expire objects still in this app's own `pending` state past
  that same window (their DB row stays as a rejected/expired record; nothing here auto-deletes a
  `pending` row, only a `complete` call's own validation does). Configure this in the R2 dashboard.
- **Never make the bucket or any object public.** Every object is fetched only through a signed
  URL issued by this module.

## What could not be verified against MinIO

Everything in this module's automated tests (`media.integration.test.ts`,
`media-storage.integration.test.ts`) runs against the real local MinIO started by
`docker compose up -d minio minio-init`, including full single-part and multipart round trips,
quota/size/type rejection with real object deletion, and cross-tenant isolation. Two things are
genuinely specific to R2 and were not (and could not be) exercised locally:

- **R2's actual multipart minimum part size and any R2-specific quirks in presigned URL behavior**
  (MinIO's S3 API is highly compatible but is not R2 itself). The client code follows the
  documented S3 multipart contract (5 MiB minimum per part except the last), which R2 also
  documents, but this was not run against a real R2 bucket in this environment.
- **R2 bucket CORS and lifecycle configuration**, since neither is expressible through code or
  Compose -- see the "configured by hand" section above. The local MinIO equivalents (a
  server-wide CORS origin, no lifecycle rule at all) are close but not identical mechanisms.
