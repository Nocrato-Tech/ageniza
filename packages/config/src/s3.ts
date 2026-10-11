export interface S3ConnectionSettings {
  readonly region: string;
  readonly forcePathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * Options every `S3Client` in the repository is built with; a client created without them is a bug.
 * Since @aws-sdk/client-s3 3.729 the SDK adds a CRC32 checksum to every request and bakes
 * `x-amz-checksum-crc32` (computed for an empty body) into presigned PUT and UploadPart URLs, so a store
 * that validates it would reject the bytes the browser sends. This was seen in the generated URLs, not
 * against a real R2 or S3 bucket. `WHEN_REQUIRED` keeps the behavior this code was written and
 * reviewed with (#292, #306).
 */
export const s3ClientOptions = (settings: S3ConnectionSettings) => ({
  region: settings.region,
  forcePathStyle: settings.forcePathStyle,
  credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
} as const);
