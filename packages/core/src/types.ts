/** A function that may complete asynchronously. */
export type MaybePromise<T> = T | Promise<T>;

/** A record suitable for structured logging or JSON response metadata. */
export type StructuredData = Readonly<Record<string, unknown>>;
