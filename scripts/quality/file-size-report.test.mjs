import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { analyze, countLines, isGatedSource } from './file-size-report.mjs';

const baseline = { max: 3, files: ['apps/api/src/big.ts', 'apps/api/src/shrunk.ts', 'apps/api/src/gone.ts'] };

describe('countLines', () => {
  it('não conta a linha vazia depois da última quebra, como o max-lines do ESLint', () => {
    expect(countLines('a\nb\nc\n')).toBe(3);
    expect(countLines('a\r\nb\r\nc')).toBe(3);
    expect(countLines('a\n\n')).toBe(2);
  });
});

describe('isGatedSource', () => {
  it('vale para código de src e deixa testes de fora', () => {
    expect(isGatedSource('apps/api/src/modules/clients/routes.ts')).toBe(true);
    expect(isGatedSource('apps/web/src/contents.test.tsx')).toBe(false);
    expect(isGatedSource('packages/database/test/clients.integration.test.ts')).toBe(false);
    expect(isGatedSource('packages/database/test/support/db.ts')).toBe(false);
    expect(isGatedSource('docs/README.md')).toBe(false);
  });
});

describe('analyze', () => {
  const report = analyze({
    baseline,
    sizes: {
      'apps/api/src/big.ts': 10,
      'apps/api/src/shrunk.ts': 3,
      'apps/api/src/new.ts': 5,
      'apps/web/src/screen.test.tsx': 9
    }
  });

  it('soma o excesso só do código sujeito à regra', () => {
    expect(report.overBudget).toBe(2);
    expect(report.excessLines).toBe(7 + 2);
    expect(report.testsOverBudget).toBe(1);
    expect(report.testExcessLines).toBe(6);
  });

  it('aponta arquivo acima do limite fora do baseline', () => {
    expect(report.notInBaseline).toEqual(['apps/api/src/new.ts']);
  });

  it('marca para sair do baseline o arquivo que voltou ao limite ou foi apagado', () => {
    expect(report.prunable).toEqual(['apps/api/src/shrunk.ts', 'apps/api/src/gone.ts']);
  });
});

describe('max-lines-baseline.json', () => {
  it('não repete arquivo e segue ordenado', () => {
    const { files } = JSON.parse(readFileSync(new URL('./max-lines-baseline.json', import.meta.url), 'utf8'));
    expect(new Set(files).size).toBe(files.length);
    expect([...files].sort()).toEqual(files);
  });
});
