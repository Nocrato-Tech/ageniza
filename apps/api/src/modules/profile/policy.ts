/**
 * Route-level `bodyLimit` for `POST /me/photo` (issue #100's README requires the route that calls
 * `uploadIdentityImage` to declare its own). The image arrives base64-encoded inside a JSON body
 * that Fastify's own parser buffers, so the limit must cover the encoding overhead (4/3) plus the
 * JSON envelope. It is deliberately per-route: raising the global `API_BODY_LIMIT_BYTES` would
 * widen every other route's exposure to large bodies for the benefit of this one.
 */
export const profilePhotoBodyLimitBytes = (maxImageBytes: number): number =>
  Math.ceil(maxImageBytes / 3) * 4 + 256;

/**
 * Per-user ceiling for `POST /me/photo`, applied through the route-level `@fastify/rate-limit`
 * (`plugins/infra/rate-limit.ts`) keyed by the session user id. Identity storage has no quota by
 * decision, so without a ceiling a single account could grow the identity bucket without bound;
 * this bounds uploads per person while still allowing a burst. The concurrency serialization in
 * `service.ts` keeps each upload from leaking objects; this keeps the total count sane.
 */
export const PROFILE_PHOTO_RATE_LIMIT = { max: 30, windowMs: 60_000 } as const;
