import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyze, countLines, isReviewed, THRESHOLD } from './file-size-report.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('countLines', () => {
  it('não conta a linha vazia depois da última quebra, como o contador do ESLint', () => {
    expect(countLines('a\nb\nc\n')).toBe(3);
    expect(countLines('a\r\nb\r\nc')).toBe(3);
    expect(countLines('a\n\n')).toBe(2);
  });
});

describe('isReviewed', () => {
  it('vale para código de src', () => {
    expect(isReviewed('apps/api/src/modules/clients/routes.ts')).toBe(true);
    expect(isReviewed('packages/email/src/index.ts')).toBe(true);
  });

  it('deixa de fora testes, pastas test, código gerado, dist e o que não é src', () => {
    expect(isReviewed('apps/web/src/contents.test.tsx')).toBe(false);
    expect(isReviewed('apps/web/src/test/fixtures.ts')).toBe(false);
    expect(isReviewed('packages/database/test/support/db.ts')).toBe(false);
    expect(isReviewed('apps/api/src/schema.gen.ts')).toBe(false);
    expect(isReviewed('apps/api/src/generated/types.ts')).toBe(false);
    expect(isReviewed('apps/web/dist/assets/index.js')).toBe(false);
    expect(isReviewed('packages/database/migrations/20261007001200_contents.mjs')).toBe(false);
    expect(isReviewed('docs/README.md')).toBe(false);
  });
});

describe('analyze', () => {
  const report = analyze({
    'apps/api/src/at-limit.ts': THRESHOLD,
    'apps/api/src/over-limit.ts': THRESHOLD + 1,
    'apps/api/src/huge.ts': 4000,
    'apps/web/src/screen.test.tsx': 3000,
    'apps/api/src/schema.gen.ts': 3000,
    'apps/web/dist/index.js': 3000
  });

  it('lista só o código de src acima do limite, do maior para o menor', () => {
    expect(report.threshold).toBe(800);
    expect(report.count).toBe(2);
    expect(report.files).toEqual([
      { path: 'apps/api/src/huge.ts', lines: 4000 },
      { path: 'apps/api/src/over-limit.ts', lines: 801 }
    ]);
  });
});

describe('pnpm quality:file-size', () => {
  it('sai com 0 mesmo quando há arquivos acima do limite', () => {
    expect(() => execFileSync(process.execPath, ['scripts/quality/file-size-report.mjs'], { cwd: repoRoot })).not.toThrow();
  });
});
