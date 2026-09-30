/**
 * Route-level `bodyLimit` for `POST /me/photo` (issue #100's README requires the route that calls
 * `uploadIdentityImage` to declare its own). The image arrives base64-encoded inside a JSON body
 * that Fastify's own parser buffers, so the limit must cover the encoding overhead (4/3) plus the
 * JSON envelope. It is deliberately per-route: raising the global `API_BODY_LIMIT_BYTES` would
 * widen every other route's exposure to large bodies for the benefit of this one.
 */
export const profilePhotoBodyLimitBytes = (maxImageBytes: number): number =>
  Math.ceil(maxImageBytes / 3) * 4 + 256;
