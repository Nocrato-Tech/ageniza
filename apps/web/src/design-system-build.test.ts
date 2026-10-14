import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Strings only the design-system page and its route carry; neither is a word the rest of the app uses.
const PAGE_MARKER = 'ageniza-design-system-page';
const ROUTE_PATH = '"design-system"';

const bundle = async (mode: 'production' | 'development'): Promise<string> => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = mode;
  try {
    const result = await build({ root: ROOT, mode, logLevel: 'silent', build: { write: false, minify: false } });
    const outputs = (Array.isArray(result) ? result : [result as Rollup.RollupOutput]).flatMap((entry) => entry.output);
    return outputs.map((output) => (output.type === 'chunk' ? output.code : String(output.source))).join('\n');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
};

describe('the build and the /design-system page', () => {
  it('ships the page and its route in a development build', async () => {
    const code = await bundle('development');
    expect(code).toContain(PAGE_MARKER);
    expect(code).toContain(ROUTE_PATH);
    expect(code).toContain('.ds-page');
  }, 120_000);

  it('ships neither the page nor its route in the production build', async () => {
    const code = await bundle('production');
    expect(code).not.toContain(PAGE_MARKER);
    expect(code).not.toContain(ROUTE_PATH);
    expect(code).not.toContain('sobrescrito no escuro');
    expect(code).not.toContain('.ds-page');
  }, 120_000);
});
