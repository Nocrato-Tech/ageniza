import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOpenApiDocument } from '../modules/api-docs/document.js';
import { renderApiSummary } from '../modules/api-docs/readme.js';

/**
 * Writes the versioned artifacts (`docs/api/openapi.json` and `docs/api/README.md`). Run by
 * `pnpm api:docs`; CI regenerates them and fails when the committed copies differ (issue #182).
 */
export const writeApiDocs = (repositoryRoot: string): readonly string[] => {
  const outputDir = resolve(repositoryRoot, 'docs/api');
  mkdirSync(outputDir, { recursive: true });
  const openApiPath = resolve(outputDir, 'openapi.json');
  const summaryPath = resolve(outputDir, 'README.md');
  writeFileSync(openApiPath, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`, 'utf8');
  writeFileSync(summaryPath, renderApiSummary(), 'utf8');
  return [openApiPath, summaryPath];
};

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const written = writeApiDocs(repositoryRoot);
  process.stdout.write(`API documentation generated: ${written.map((path) => path.slice(repositoryRoot.length + 1)).join(', ')}\n`);
}
