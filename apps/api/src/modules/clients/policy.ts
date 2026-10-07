/**
 * Route-level `bodyLimit` for `PUT .../photo` (issue #100's README requires the route that calls
 * `uploadIdentityImage` to declare its own). The image arrives base64-encoded inside a JSON body
 * that Fastify's own parser buffers, so the limit covers the encoding overhead (4/3) plus the JSON
 * envelope, and an oversized body is refused before any handler reads it. The global
 * `API_BODY_LIMIT_BYTES` is deliberately not raised for this route.
 */
export const clientPhotoBodyLimitBytes = (maxImageBytes: number): number =>
  Math.ceil(maxImageBytes / 3) * 4 + 256;

/**
 * Per-user ceiling for `PUT .../photo`, the same as the profile photo's: identity storage has no
 * quota by decision, so without a ceiling one account could grow the bucket without bound. The
 * client's row lock keeps each upload from leaking objects; this keeps the total count sane.
 */
export const CLIENT_PHOTO_RATE_LIMIT = { max: 30, windowMs: 60_000 } as const;

/** specs/clientes.md section 6: threads of a subject list 20 at a time, comments 50. */
export const THREAD_DEFAULT_PAGE_SIZE = 20;
export const COMMENT_DEFAULT_PAGE_SIZE = 50;

/** A thread item previews its last comment; the full text is on the comments route. */
export const THREAD_EXCERPT_LENGTH = 140;
