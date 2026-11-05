import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('real application dependency graph', () => {
  it('keeps the normal/native entry separate from the academic presentation and seeded data', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const visited = new Set<string>();
    function visit(file: string) {
      if (visited.has(file)) return;
      visited.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g)) {
        const target = resolve(dirname(file), match[2]);
        const candidate = [target, `${target}.ts`, `${target}.tsx`, resolve(target, 'index.ts'), resolve(target, 'index.tsx')].find((name) => /\.tsx?$/.test(name) && existsSync(name));
        if (candidate) visit(candidate);
      }
    }
    visit(resolve(root, 'index.ts'));
    expect([...visited].some((file) => /[/\\]product[/\\]demo\.ts$/.test(file))).toBe(false);
    expect([...visited].some((file) => /[/\\]product[/\\]learning\.ts$/.test(file))).toBe(false);
    expect([...visited].some((file) => /[/\\]presentation[/\\]/.test(file))).toBe(false);
    expect([...visited].some((file) => /[/\\]product[/\\]remote\.ts$/.test(file))).toBe(true);
  });
});
