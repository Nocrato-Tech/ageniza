import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// Issues #292, #306 and #509: an S3Client built without the checksum options of `s3ClientOptions` signs
// `x-amz-checksum-crc32` into presigned PUT URLs. LocalStack accepts that, so only this census sees a new client.
// It does not look for one shape of call: every production file that mentions the SDK must be in `expected`, and
// inside it every use of the client must be a construction of exactly the allowed shape.
const root = join(import.meta.dirname, '..', '..');
const skipped = new Set(['node_modules', 'dist', '.git', '.turbo', '.local', '.maestri']);

const expected = {
  'apps/api/src/modules/identity-storage/storage-client.ts': 2,
  'apps/api/src/modules/media/storage-client.ts': 2,
  'apps/worker/src/media-storage.ts': 1
};

const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

const isProductionSource = (name) =>
  /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !/\.test\.[a-z]+$/.test(name) && !/(^|\/)test(-support)?\//.test(name);

const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

const mentionsTheSdk = (text) => /@aws-sdk\/client-s3|\bS3Client\b|\bnew\s+S3\s*\(/.test(withoutComments(text));

// The only allowed construction: the options spread first, `endpoint` the only other key, and the spread is
// `s3ClientOptions(...)` itself or a local that was assigned it.
const ALLOWED_CONSTRUCTION = /new\s+S3Client\(\s*\{\s*\.\.\.(\w+|s3ClientOptions\([^()]*\))\s*,\s*endpoint\s*:\s*[\w.]+\s*\}\s*\)/g;

/** What is wrong with the uses of the SDK client in one production file; empty when nothing is. */
export const censusProblems = (text, constructions) => {
  const code = withoutComments(text);
  const problems = [];
  if (/\bS3Client\s+as\s+\w+|\bS3\s+as\s+\w+|\*\s+as\s+\w+\s+from\s+['"]@aws-sdk\/client-s3/.test(code)) problems.push('imports the client under another name');
  if (/\bS3\b/.test(code)) problems.push('uses the aggregated S3 client');
  const constructed = [...code.matchAll(/\bnew\s+\(?\s*\w+/g)].filter(([match]) => /S3Client/.test(match));
  if (constructed.length !== constructions) problems.push(`constructs S3Client ${constructed.length} times, expected ${constructions}`);
  const allowed = [...code.matchAll(ALLOWED_CONSTRUCTION)];
  if (allowed.length !== constructed.length) problems.push('has a construction that is not `{ ...options, endpoint }`');
  for (const [, source] of allowed) {
    if (!source.startsWith('s3ClientOptions(') && !new RegExp(`const\\s+${source}\\s*=\\s*s3ClientOptions\\(`).test(code)) {
      problems.push(`spreads ${source}, which is not s3ClientOptions(...)`);
    }
  }
  if ([...code.matchAll(/\bS3Client\b/g)].length !== 1 + constructed.length) problems.push('uses S3Client outside its import and its constructions');
  return problems;
};

const sources = ['apps', 'packages', 'scripts', 'infra']
  .flatMap((directory) => {
    try {
      return walk(join(root, directory));
    } catch {
      return [];
    }
  })
  .map((path) => ({ name: relative(root, path).split(sep).join('/'), path }))
  .filter(({ name }) => isProductionSource(name))
  .map(({ name, path }) => ({ name, text: readFileSync(path, 'utf8') }))
  .filter(({ text }) => mentionsTheSdk(text));

const good = (count) => `import { S3Client } from '@aws-sdk/client-s3';
const clientOptions = s3ClientOptions(config);
${Array.from({ length: count }, (_, index) => `const client${index} = new S3Client({ ...clientOptions, endpoint: config.endpoint });`).join('\n')}`;

describe('every S3Client is built from s3ClientOptions (issue #509)', () => {
  it('knows exactly the production files that use the SDK client', () => {
    expect(sources.map(({ name }) => name).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s builds each client from s3ClientOptions and from nothing else', (name, constructions) => {
    expect(censusProblems(sources.find((source) => source.name === name).text, constructions)).toEqual([]);
  });

  it('accepts the shape the factories use', () => {
    expect(censusProblems(good(2), 2)).toEqual([]);
    expect(censusProblems("import { S3Client } from '@aws-sdk/client-s3';\nconst c = new S3Client({ ...s3ClientOptions(config), endpoint: config.endpoint });", 1)).toEqual([]);
  });

  it.each([
    ['a config handed over whole', "import { S3Client } from '@aws-sdk/client-s3';\nconst c = new S3Client(config);"],
    ['options built by a function', "import { S3Client } from '@aws-sdk/client-s3';\nconst c = new S3Client(buildOptions());"],
    ['an object without the spread and without a closing semicolon', "import { S3Client } from '@aws-sdk/client-s3';\nconst c = new S3Client({ region: 'x' })"],
    ['an object with a semicolon inside', "import { S3Client } from '@aws-sdk/client-s3';\nconst c = new S3Client({ credentials: async () => { const a = 1; return { accessKeyId: 'a' + a }; } });"],
    ['the aggregated client', "import { S3 } from '@aws-sdk/client-s3';\nconst c = new S3({ region: 'x' });"],
    ['the client under another name', "import { S3Client as Client } from '@aws-sdk/client-s3';\nconst c = new Client({ ...clientOptions, endpoint: config.endpoint });"],
    ['the namespace import', "import * as aws from '@aws-sdk/client-s3';\nconst c = new aws.S3Client({ region: 'x' });"],
    ['an override after the spread', "import { S3Client } from '@aws-sdk/client-s3';\nconst clientOptions = s3ClientOptions(config);\nconst c = new S3Client({ ...clientOptions, requestChecksumCalculation: 'WHEN_SUPPORTED', endpoint: config.endpoint });"],
    ['an endpoint then the options', "import { S3Client } from '@aws-sdk/client-s3';\nconst clientOptions = s3ClientOptions(config);\nconst c = new S3Client({ endpoint: config.endpoint, ...clientOptions });"],
    ['a spread of something that is not the helper', "import { S3Client } from '@aws-sdk/client-s3';\nconst clientOptions = { region: 'x' };\nconst c = new S3Client({ ...clientOptions, endpoint: config.endpoint });"],
    ['a client that is built and one more', `${good(1)}\nconst extra = new S3Client(other);`],
    ['the class held in a variable', "import { S3Client } from '@aws-sdk/client-s3';\nconst clientOptions = s3ClientOptions(config);\nconst Ctor = S3Client;\nconst c = new Ctor({ ...clientOptions, endpoint: config.endpoint });"],
    ['a client in parentheses', "import { S3Client } from '@aws-sdk/client-s3';\nconst c = new (S3Client)({ region: 'x' });"]
  ])('rejects %s', (_label, text) => {
    expect(censusProblems(text, 1), text).not.toEqual([]);
  });

  it('ignores a comment that mentions the client', () => {
    expect(censusProblems(`// new S3Client(config) and S3 as Client\n/* new S3({}) */\n${good(1)}`, 1)).toEqual([]);
  });
});
