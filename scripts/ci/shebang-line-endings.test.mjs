import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The vitest transform rejects a shebang followed by CRLF ("#!/usr/bin/env node\r"), and a Windows checkout with
// core.autocrlf=true writes CRLF. The Linux CI checkout is LF, so this only shows up on Windows (issue #535).
const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const scriptFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return scriptFiles(path);
    return /\.(mjs|cjs|js)$/.test(entry.name) ? [path] : [];
  });

describe('scripts that start with a shebang', () => {
  it('keep LF line endings in the working tree, so the test runner can load them on Windows (issue #535)', () => {
    const withShebangAndCr = scriptFiles(scriptsDir)
      .filter((path) => readFileSync(path, 'utf8').startsWith('#!'))
      .filter((path) => readFileSync(path, 'utf8').includes('\r'));

    expect(withShebangAndCr).toEqual([]);
  });
});
