import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const browserSource = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return browserSource(path);
  return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx') ? [readFileSync(path, 'utf8')] : [];
});

describe('browser safety boundary', () => {
  it('does not import server configuration or contain server credential identifiers', () => {
    const source = browserSource(fileURLToPath(new URL('.', import.meta.url)));
    const forbidden = ['@ageniza/config/' + 'server', 'SUPABASE_' + 'SERVICE_ROLE_KEY', 'service' + '_role'];
    for (const value of forbidden) expect(source.join('\n')).not.toContain(value);
  });
});
