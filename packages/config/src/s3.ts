export interface S3ConnectionSettings {
  readonly region: string;
  readonly forcePathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * Options every `S3Client` is built with (#292, #306, #509). Since SDK 3.729 the default puts `x-amz-checksum-crc32`
 * of an empty body in presigned PUT and UploadPart URLs and `x-amz-checksum-mode` in presigned GET URLs, so a store
 * that validates it would reject the browser's bytes. Seen in the generated URLs, not against a real R2 or S3.
 */
export const s3ClientOptions = (settings: S3ConnectionSettings) => ({
  region: settings.region,
  forcePathStyle: settings.forcePathStyle,
  credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
} as const);
