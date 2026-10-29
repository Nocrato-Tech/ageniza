import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, type Rollup } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

const WEB_ROOT = join(__dirname, '../..');

/** Text that only exists because /mobile does: its page, a line of the guide, an API route summary, its styles and the diagram library. */
const MARKERS = {
  page: 'ageniza-mobile-docs-page',
  guide: 'Ageniza no celular — ponto de partida',
  apiReference: 'Cria uma conta com e-mail e senha',
  styles: '.mdocs-header',
  diagrams: 'mermaid'
} as const;

// The environment folder is empty on purpose: the build must not read a `.env` of the machine that runs the test.
const emptyEnvDir = mkdtempSync(join(tmpdir(), 'ageniza-web-env-'));
afterAll(() => rmSync(emptyEnvDir, { recursive: true, force: true }));

/** Builds the web app the way the Docker image does (mode production, the variable coming from the environment) and returns everything it emitted as text. */
async function productionBundle(devDocs: string | undefined): Promise<string> {
  const previous = { devDocs: process.env.VITE_DEV_DOCS, nodeEnv: process.env.NODE_ENV };
  if (devDocs === undefined) delete process.env.VITE_DEV_DOCS;
  else process.env.VITE_DEV_DOCS = devDocs;
  // Vitest runs with NODE_ENV=test, which Vite reads as a development build (`import.meta.env.DEV` stays true); a real build runs with production.
  process.env.NODE_ENV = 'production';
  try {
    const result = (await build({
      root: WEB_ROOT,
      configFile: join(WEB_ROOT, 'vite.config.ts'),
      mode: 'production',
      envDir: emptyEnvDir,
      logLevel: 'silent',
      build: { write: false, reportCompressedSize: false }
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    const outputs = Array.isArray(result) ? result : [result];
    return outputs.flatMap((output) => output.output).map((item) => (item.type === 'chunk' ? item.code : String(item.source))).join('\n');
  } finally {
    if (previous.devDocs === undefined) delete process.env.VITE_DEV_DOCS;
    else process.env.VITE_DEV_DOCS = previous.devDocs;
    process.env.NODE_ENV = previous.nodeEnv;
  }
}

describe('the production build', { timeout: 600_000 }, () => {
  it('does not carry the /mobile page, the guide, the API reference, the styles or mermaid when VITE_DEV_DOCS is not set', async () => {
    const bundle = await productionBundle(undefined);
    expect(bundle).toContain('Página não encontrada'); // the build is the app, not an empty bundle
    for (const [name, text] of Object.entries(MARKERS)) expect(bundle.includes(text), `${name} (${text}) is in the production bundle`).toBe(false);
  });

  it.each([''])('does not carry it when VITE_DEV_DOCS is %j, which is what the Docker image passes when the build argument is not given', async (value) => {
    const bundle = await productionBundle(value);
    for (const [name, text] of Object.entries(MARKERS)) expect(bundle.includes(text), `${name} (${text}) is in the production bundle`).toBe(false);
  });

  it('carries all of it when VITE_DEV_DOCS=true, which is how the markers above are known to find it', async () => {
    const bundle = await productionBundle('true');
    for (const [name, text] of Object.entries(MARKERS)) expect(bundle.includes(text), `${name} (${text}) is missing from the dev bundle`).toBe(true);
  });
});
