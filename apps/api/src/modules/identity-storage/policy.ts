/**
 * Content types accepted for identity images (issue #100): the same still-image allowlist the
 * media module uses (`../media/policy.ts`), minus video -- an avatar or portal logo is never a
 * video. The extension never comes from a client-supplied file name, for the same reason media
 * objects don't carry one: an object key must never carry anything resembling personal data.
 */
const IDENTITY_CONTENT_TYPE_TABLE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

/** Returns `undefined` for any content type this deployment does not accept as an identity image. */
export const describeIdentityContentType = (contentType: string): { readonly extension: string } | undefined => {
  const extension = IDENTITY_CONTENT_TYPE_TABLE[contentType.trim().toLowerCase()];
  return extension === undefined ? undefined : { extension };
};

/**
 * Object key builders for the two owners this storage already needs to serve (issue #100): a
 * global user's own avatar, and a client's avatar within its agency (issue #126) -- never an
 * agency's alone, which is what a bucket organized as "avatar storage" would collapse into.
 * Every key is deterministic per owner: a fresh upload overwrites the previous object at the same
 * key instead of accumulating orphans, and callers should delete the old key on removal rather
 * than rely on any lifecycle rule (identity storage keeps none, unlike the media bucket's
 * staging-prefix rule).
 */
export const buildUserAvatarKey = (userId: string, extension: string): string => `users/${userId}/avatar.${extension}`;

export const buildClientAvatarKey = (agencyId: string, clientId: string, extension: string): string =>
  `agencies/${agencyId}/clients/${clientId}/avatar.${extension}`;
