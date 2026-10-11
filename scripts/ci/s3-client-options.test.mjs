import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// Issues #292, #306 and #509: an S3Client built without the checksum options of `s3ClientOptions` signs
// `x-amz-checksum-crc32` into presigned PUT URLs. LocalStack accepts that, so only this scan sees a new client.
const root = join(import.meta.dirname, '..', '..');
const skipped = new Set(['node_modules', 'dist', '.git', '.turbo', '.local', '.maestri']);

const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

const isProductionSource = (path) => /\.(ts|tsx|mjs|js)$/.test(path) && !/\.test\.(ts|tsx|mjs)$/.test(path) && !/(^|\/)test(-support)?\//.test(path);

const sources = ['apps', 'packages']
  .flatMap((directory) => walk(join(root, directory)))
  .map((path) => ({ name: relative(root, path).split(sep).join('/'), path }))
  .filter(({ name }) => isProductionSource(name));

const constructions = sources.flatMap(({ name, path }) => {
  const text = readFileSync(path, 'utf8');
  return [...text.matchAll(/new S3Client\((\{[^;]*\})\);/g)].map((match) => ({ name, argument: match[1] }));
});

// The argument is `{ ...clientOptions, endpoint: ... }` where `clientOptions = s3ClientOptions(config)`, or the call inline.
const spreadsTheOptions = (argument, text) => {
  const spread = /^\s*\{\s*\.\.\.(\w+|s3ClientOptions\([^)]*\))\s*,/.exec(argument);
  if (spread === null) return false;
  const [, source] = spread;
  return source.startsWith('s3ClientOptions(') || new RegExp(`const\\s+${source}\\s*=\\s*s3ClientOptions\\(`).test(text);
};

describe('every S3Client is built from s3ClientOptions (issue #509)', () => {
  it('finds the clients it is supposed to police', () => {
    const counts = new Map();
    for (const { name } of constructions) counts.set(name, (counts.get(name) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({
      'apps/api/src/modules/identity-storage/storage-client.ts': 2,
      'apps/api/src/modules/media/storage-client.ts': 2,
      'apps/worker/src/media-storage.ts': 1
    });
  });

  it.each(constructions.map((construction, index) => [`${construction.name} #${index}`, construction]))('%s spreads s3ClientOptions', (_label, { name, argument }) => {
    const text = readFileSync(join(root, name), 'utf8');
    expect(spreadsTheOptions(argument, text), `${name}: new S3Client(${argument})`).toBe(true);
  });

  it('rejects a client that does not spread the options', () => {
    expect(spreadsTheOptions('{ region: config.region, endpoint: config.endpoint }', '')).toBe(false);
    expect(spreadsTheOptions('{ ...clientOptions, endpoint: config.endpoint }', 'const clientOptions = { region: config.region };')).toBe(false);
    expect(spreadsTheOptions('{ ...clientOptions, endpoint: config.endpoint }', 'const clientOptions = s3ClientOptions(config);')).toBe(true);
    expect(spreadsTheOptions('{ ...s3ClientOptions(config), endpoint: config.endpoint }', '')).toBe(true);
  });
});
