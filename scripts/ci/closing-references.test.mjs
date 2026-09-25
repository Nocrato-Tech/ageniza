import { describe, expect, it } from 'vitest';

import { collectClosingReferences } from './closing-references.mjs';

describe('closing references in a pull request body', () => {
  it('reads the English keywords', () => {
    expect(collectClosingReferences('Closes #12 and fixes #34.')).toEqual([12, 34]);
    expect(collectClosingReferences('Resolved: #7')).toEqual([7]);
  });

  it('reads the Portuguese keywords, because pull request bodies are written in Portuguese here', () => {
    expect(collectClosingReferences('Fecha #85.')).toEqual([85]);
    expect(collectClosingReferences('Encerra #101 e fecha #102')).toEqual([101, 102]);
  });

  it('ignores a bare issue mention', () => {
    expect(collectClosingReferences('Relacionado a #9, mas não fecha nada.')).toEqual([]);
    expect(collectClosingReferences('Ver #9 e #10.')).toEqual([]);
  });

  it('ignores references inside code, where they are examples and not intent', () => {
    expect(collectClosingReferences('Escreva `Closes #1` no corpo.')).toEqual([]);
    expect(collectClosingReferences('```\nCloses #2\n```\nFecha #3')).toEqual([3]);
  });

  it('does not repeat a number mentioned twice', () => {
    expect(collectClosingReferences('Closes #5. Fecha #5 também.')).toEqual([5]);
  });

  it('survives an empty, missing or non-string body', () => {
    expect(collectClosingReferences('')).toEqual([]);
    expect(collectClosingReferences(undefined)).toEqual([]);
    expect(collectClosingReferences(null)).toEqual([]);
    expect(collectClosingReferences(42)).toEqual([]);
  });

  it('does not treat a word ending in a keyword as a keyword', () => {
    expect(collectClosingReferences('Disclosed #4')).toEqual([]);
  });
});
