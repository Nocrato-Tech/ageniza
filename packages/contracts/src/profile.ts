import { z } from 'zod';

import { DisplayNameSchema, DISPLAY_NAME_MAX_LENGTH } from './display-name.js';

/**
 * `PATCH /me/profile` body. `.strict()` is load-bearing here, not stylistic: `auth."user"` has no
 * RLS, so the target is always the verified session user and an extra field such as `userId` must
 * never reach a handler that could be tempted to read it. The name itself goes through the shared
 * `DisplayNameSchema`, which rejects control/bidi/invisible characters before they can reach
 * PostgreSQL (a NUL byte is a 22021 and would otherwise be a 500).
 */
export const UpdateMyProfileRequestSchema = z.object({
  name: DisplayNameSchema
}).strict();

export const UpdateMyProfileResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH)
}).strict();

/**
 * The still-image content types the API accepts for an avatar, in the same terms a browser reports
 * them. The API decides the type by the magic bytes (`identity-storage/policy.ts`, the authority);
 * this list exists so the web can offer the right `accept` filter and refuse an obvious foreign
 * format before a byte travels. Extra types here would refuse files the API accepts, so the API's
 * own test asserts every value below is detected as the matching type.
 */
export const PROFILE_PHOTO_ACCEPTED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/**
 * Hard ceiling of the identity storage schema (10 MiB, the cap on `IDENTITY_MAX_IMAGE_BYTES`). A
 * deployment may configure a smaller limit; this is the largest an API can ever accept, so the web
 * refuses locally only what no deployment could take, and leaves the rest to the server's 413.
 */
export const PROFILE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Base64 of `PROFILE_PHOTO_MAX_BYTES`, plus room for the JSON envelope. The route's own `bodyLimit`
 * is computed from the configured, smaller limit, so an oversized body is refused by Fastify's
 * parser before this schema ever sees it.
 */
export const PROFILE_PHOTO_MAX_BASE64_LENGTH = Math.ceil(PROFILE_PHOTO_MAX_BYTES / 3) * 4 + 64;

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
