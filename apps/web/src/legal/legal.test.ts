import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PENDING_MARKER, type LegalDocument } from './document.js';
import { privacyPolicy } from './privacy.js';
import { termsOfUse } from './terms.js';

const repositoryFile = (path: string): string => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8');

/** Every place that sets the versions the API records on acceptance. */
const versionSources = ['.env.example', 'compose.yml', 'infra/vps/runtime.env.example'];

const configuredVersion = (source: string, variable: string): string | undefined =>
  new RegExp(`${variable}\\s*[:=]\\s*'?(\\d{4}-\\d{2}-\\d{2})'?`).exec(source)?.[1];

const documentText = (document: LegalDocument): string =>
  [
    document.title,
    ...document.sections.flatMap((section) => [
      section.heading,
      ...section.blocks.flatMap((block) => (block.type === 'paragraph' ? [block.text] : block.items))
    ])
  ].join('\n');

describe('legal documents', () => {
  it.each([
    ['AUTH_TERMS_VERSION', termsOfUse],
    ['AUTH_PRIVACY_VERSION', privacyPolicy]
  ] as const)('carry the version that %s records on acceptance', (variable, document) => {
    for (const path of versionSources) {
      expect(configuredVersion(repositoryFile(path), variable), `${variable} in ${path}`).toBe(document.version);
    }
  });

  it.each([termsOfUse, privacyPolicy])('$title keeps the draft notice while any pending marker remains', (document) => {
    if (documentText(document).includes(PENDING_MARKER)) expect(document.draftNotice).toBeDefined();
    expect(document.sections.length).toBeGreaterThan(0);
    for (const section of document.sections) expect(section.blocks.length).toBeGreaterThan(0);
  });
});
