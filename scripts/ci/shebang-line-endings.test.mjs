import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// A shebang followed by CRLF ("#!/usr/bin/env node\r") is rejected by the vitest transform. A Windows checkout with
// core.autocrlf=true writes CRLF, and the .gitattributes rule `scripts/**/*.mjs text eol=lf` is what keeps them LF
// (issue #535). The test checks the attribute, not the disk, so it also guards the rule on Linux CI.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

const trackedScripts = git(['ls-files']).split('\n').filter((path) => /\.(mjs|cjs|js)$/.test(path));
const withShebang = trackedScripts.filter((path) => readFileSync(join(root, path)).subarray(0, 2).toString() === '#!');

const eolOf = (path) => git(['check-attr', 'eol', '--', path]).trim().split(': ').at(-1);

describe('tracked scripts that start with a shebang', () => {
  it('finds the generator, so the check below is not empty', () => {
    expect(withShebang).toContain('scripts/generate-decisions-index.mjs');
  });

  it('have eol=lf in .gitattributes, so a Windows checkout does not write CRLF into them (issue #535)', () => {
    const without = withShebang.filter((path) => eolOf(path) !== 'lf');

    expect(
      without,
      `sem eol=lf: ${without.join(', ')}. Em checkout Windows que já existia o git não reescreve o arquivo: rode ` +
        `"rm <arquivo> && git checkout -- <arquivo>" e confira com "git ls-files --eol scripts" (docs/local-environment.md).`,
    ).toEqual([]);
  });
});
