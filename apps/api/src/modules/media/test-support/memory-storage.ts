import type { HeadObjectResult, MediaStorageClient } from '../storage-client.js';

export interface MemoryObject {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
}

export interface MemoryStorage extends MediaStorageClient {
  readonly objects: Map<string, MemoryObject>;
  /** Every call that reached the bucket, in order, as `operation key`: what a test asserts a route did NOT do. */
  readonly calls: string[];
  /** What the browser does with a presigned PUT: the object lands at the key the URL was signed for. */
  put(key: string, bytes: Uint8Array, contentType?: string): void;
  keyOfUrl(url: string): string;
  /** Every call of the bucket waits this long (a macrotask), so two requests really overlap. */
  latencyMs: number;
  /** The keys whose deletion fails, as a bucket that is down for a moment does. */
  readonly refuseDeleteOf: Set<string>;
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

/** A bucket in memory behind the interface of the media module, for the tests that must not need a real one. Presigned URLs name the key they were signed for. */
export const createMemoryStorage = (): MemoryStorage => {
  const objects = new Map<string, MemoryObject>();
  const calls: string[] = [];
  const storage: MemoryStorage = {
    objects,
    calls,
    latencyMs: 0,
    refuseDeleteOf: new Set<string>(),
    put: (key, bytes, contentType) => { objects.set(key, { bytes, contentType }); },
    keyOfUrl: (url) => new URL(url).searchParams.get('key') ?? '',
    createMultipartUpload: async () => { throw new Error('The portal never opens a multipart upload.'); },
    presignUploadPart: async () => { throw new Error('The portal never signs a part.'); },
    completeMultipartUpload: async () => { throw new Error('The portal never completes a multipart upload.'); },
    abortMultipartUpload: async () => { throw new Error('The portal never aborts a multipart upload.'); },
    presignPutObject: async ({ key, contentType }) => `https://storage.test/put?key=${encodeURIComponent(key)}&type=${encodeURIComponent(contentType)}`,
    presignGetObject: async ({ key, responseContentDisposition }) =>
      `https://storage.test/get?key=${encodeURIComponent(key)}${responseContentDisposition === undefined ? '' : `&disposition=${encodeURIComponent(responseContentDisposition)}`}`,
    headObject: async ({ key }): Promise<HeadObjectResult | undefined> => {
      calls.push(`head ${key}`);
      await wait(storage.latencyMs);
      const found = objects.get(key);
      return found === undefined ? undefined : { sizeBytes: found.bytes.length, contentType: found.contentType };
    },
    deleteObject: async ({ key }) => {
      calls.push(`delete ${key}`);
      if (storage.refuseDeleteOf.has(key)) throw new Error('The bucket refused to delete this object.');
      objects.delete(key);
    },
    copyObject: async ({ sourceKey, destinationKey }) => {
      calls.push(`copy ${sourceKey} ${destinationKey}`);
      await wait(storage.latencyMs);
      const found = objects.get(sourceKey);
      if (found === undefined) throw new Error('The source of the copy is not there.');
      objects.set(destinationKey, found);
    },
    readObjectStart: async ({ key, length }) => {
      calls.push(`read ${key}`);
      const found = objects.get(key);
      if (found === undefined) throw new Error('The object to read is not there.');
      return found.bytes.slice(0, length);
    }
  };
  return storage;
};
