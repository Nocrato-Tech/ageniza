import { z } from 'zod';

/**
 * Longest accepted display name. `specs/colaboradores.md` (§3, §5) requires a non-empty name with
 * a size limit but fixes no number; 120 is this module's choice, recorded in
 * `docs/business/decisions.md` (2026-09-30, pending validation).
 */
export const PROFILE_NAME_MAX_LENGTH = 120;

/**
 * `PATCH /me/profile` body. `.strict()` is load-bearing here, not stylistic: `auth."user"` has no
 * RLS, so the target is always the verified session user and an extra field such as `userId` must
 * never reach a handler that could be tempted to read it.
 */
export const UpdateMyProfileRequestSchema = z.object({
  name: z.string().trim().min(1).max(PROFILE_NAME_MAX_LENGTH)
}).strict();

export const UpdateMyProfileResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(PROFILE_NAME_MAX_LENGTH)
}).strict();

/**
 * Base64 of the largest image the identity storage schema itself permits (10 MiB, the cap on
 * `IDENTITY_MAX_IMAGE_BYTES`), plus room for the JSON envelope. The route's own `bodyLimit` is
 * computed from the configured, smaller limit, so an oversized body is refused by Fastify's parser
 * before this schema ever sees it.
 */
export const PROFILE_PHOTO_MAX_BASE64_LENGTH = Math.ceil((10 * 1024 * 1024) / 3) * 4 + 64;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * `POST /me/photo` body. The image travels through the API base64-encoded in JSON (the transport
 * issue #100 chose for identity assets), so the server can validate the real bytes before writing
 * anything. There is deliberately no declared content type: `uploadIdentityImage` sniffs the magic
 * bytes, and a caller-declared header or extension is never trusted.
 */
export const UploadMyPhotoRequestSchema = z.object({
  imageBase64: z.string().min(1).max(PROFILE_PHOTO_MAX_BASE64_LENGTH).regex(BASE64_PATTERN, 'must be a base64-encoded image')
}).strict();

export const UploadMyPhotoResponseSchema = z.object({
  imageUrl: z.string().url()
}).strict();

export type UpdateMyProfileRequest = z.infer<typeof UpdateMyProfileRequestSchema>;
export type UpdateMyProfileResponse = z.infer<typeof UpdateMyProfileResponseSchema>;
export type UploadMyPhotoRequest = z.infer<typeof UploadMyPhotoRequestSchema>;
export type UploadMyPhotoResponse = z.infer<typeof UploadMyPhotoResponseSchema>;
