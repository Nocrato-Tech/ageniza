import { describe, expect, it } from 'vitest';

import { s3ClientOptions } from './s3.js';

describe('s3ClientOptions', () => {
  it('asks the SDK for checksums only when the operation requires one', () => {
    const options = s3ClientOptions({ region: 'auto', forcePathStyle: true, accessKeyId: 'key-id', secretAccessKey: 'secret' });

    expect(options.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    expect(options.responseChecksumValidation).toBe('WHEN_REQUIRED');
  });

  it('carries the connection settings through, value by value', () => {
    const options = s3ClientOptions({ region: 'eu-west-1', forcePathStyle: false, accessKeyId: 'key-id', secretAccessKey: 'secret' });

    expect(options.region).toBe('eu-west-1');
    expect(options.forcePathStyle).toBe(false);
    expect(options.credentials).toEqual({ accessKeyId: 'key-id', secretAccessKey: 'secret' });
  });

  it('ignores extra fields of a bigger storage config instead of leaking them to the client', () => {
    const options = s3ClientOptions({
      region: 'auto',
      forcePathStyle: true,
      accessKeyId: 'key-id',
      secretAccessKey: 'secret',
      bucket: 'media',
      endpoint: 'https://r2.test'
    } as never);

    expect(Object.keys(options).sort()).toEqual(['credentials', 'forcePathStyle', 'region', 'requestChecksumCalculation', 'responseChecksumValidation']);
  });
});
