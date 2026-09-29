/**
 * Magic-byte signatures for the still-image allowlist media already uses (`../media/policy.ts`),
 * minus video -- an avatar or portal logo is never a video. Detection reads the bytes themselves,
 * never the caller-declared `Content-Type` or a file name extension: either one is attacker-
 * controlled, and a mismatched pair (`image/png` header on an HTML payload) is exactly how a
 * signed URL ends up serving active content instead of a picture.
 */
interface ImageSignature {
  readonly contentType: string;
  readonly extension: string;
  readonly matches: (bytes: Uint8Array) => boolean;
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);

const IMAGE_SIGNATURES: readonly ImageSignature[] = [
  { contentType: 'image/png', extension: 'png', matches: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { contentType: 'image/jpeg', extension: 'jpg', matches: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  {
    contentType: 'image/gif',
    extension: 'gif',
    matches: (bytes) => startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  },
  {
    contentType: 'image/webp',
    extension: 'webp',
    // RIFF????WEBP: bytes 4-7 are the RIFF chunk size, which this signature does not care about.
    matches: (bytes) => bytes.length >= 12 && startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  }
];

export interface DetectedImageType {
  readonly contentType: string;
  readonly extension: string;
}

/** Returns `undefined` when the bytes do not open with a signature this deployment accepts --
 * this is the only content-type decision this module makes; nothing here trusts a header. */
export const detectIdentityImageType = (bytes: Uint8Array): DetectedImageType | undefined => {
  const signature = IMAGE_SIGNATURES.find((candidate) => candidate.matches(bytes));
  return signature === undefined ? undefined : { contentType: signature.contentType, extension: signature.extension };
};

/** The response `Content-Type` a signed read URL forces for a key ending in this extension --
 * `presignGetObject` never serves an object as anything but one of these, regardless of what
 * metadata is stored on the object itself. `undefined` for any extension this module did not
 * produce, which `presignGetObject` treats as a caller error, not a fallback to guess from. */
export const contentTypeForExtension = (extension: string): string | undefined =>
  IMAGE_SIGNATURES.find((signature) => signature.extension === extension)?.contentType;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every id segment in an identity storage key is validated as a UUID -- callers pass user,
 * agency and client ids straight from the database, and this is the single point that refuses
 * anything else, including a `../` path-traversal attempt, before it ever reaches an S3 key. */
const requireUuid = (value: string, label: string): string => {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID; refused "${value}"`);
  return value;
};

const requireKnownExtension = (extension: string): string => {
  if (contentTypeForExtension(extension) === undefined) throw new Error(`extension must be one produced by detectIdentityImageType; refused "${extension}"`);
  return extension;
};

/**
 * Object key builders for the two owners this storage already needs to serve (issue #100): a
 * global user's own avatar, and a client's avatar within its agency (issue #126) -- never an
 * agency's alone, which is what a bucket organized as "avatar storage" would collapse into.
 *
 * Each key carries a caller-supplied `versionId` (a fresh UUID per upload) rather than a fixed
 * name: overwriting the same key on every re-upload raced the old bytes against the new one and,
 * across a content-type change, left the previous extension's object orphaned forever. With a
 * versioned key, the protocol for #101/#126 is: upload the new version (`uploadIdentityImage` in
 * `storage-client.ts` returns the final key, extension included, since only the upload itself
 * knows the detected type), commit that key as the owner's current reference -- only once that
 * commit succeeds does anything treat it as current -- then delete the previous version's key.
 * See this module's README for the full protocol, including what happens if the delete step is
 * never reached.
 *
 * The `*KeyPrefix` builders below produce a key with no extension, because the extension is not
 * known until the bytes are sniffed; `uploadIdentityImage` appends it. The full `*Key` builders
 * exist for the rarer case of reconstructing a complete key from an already-known extension (for
 * example, validating a key already stored in the database).
 */
export const buildUserAvatarKeyPrefix = (userId: string, versionId: string): string =>
  `users/${requireUuid(userId, 'userId')}/avatar/${requireUuid(versionId, 'versionId')}`;

export const buildClientAvatarKeyPrefix = (agencyId: string, clientId: string, versionId: string): string =>
  `agencies/${requireUuid(agencyId, 'agencyId')}/clients/${requireUuid(clientId, 'clientId')}/avatar/${requireUuid(versionId, 'versionId')}`;

export const buildUserAvatarKey = (userId: string, versionId: string, extension: string): string =>
  `${buildUserAvatarKeyPrefix(userId, versionId)}.${requireKnownExtension(extension)}`;

export const buildClientAvatarKey = (agencyId: string, clientId: string, versionId: string, extension: string): string =>
  `${buildClientAvatarKeyPrefix(agencyId, clientId, versionId)}.${requireKnownExtension(extension)}`;
