import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(join(__dirname, '../../Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
const lines = dockerfile.split('\n');
const indexOf = (predicate: (line: string) => boolean) => lines.findIndex(predicate);

// The page reads docs/mobile and docs/api/openapi.json while Vite builds. The image build copies only what it names, and the
// "Docker images" job of CI builds without VITE_DEV_DOCS, so a missing COPY broke the dev deploy and CI did not see it (#798).
describe('the web image', () => {
  const build = indexOf((line) => line.startsWith('RUN pnpm --filter @ageniza/web... build'));

  it('copies, before the build, every repository file that the /mobile page reads', () => {
    expect(build).toBeGreaterThan(-1);
    for (const copy of ['COPY docs/mobile docs/mobile', 'COPY docs/api/openapi.json docs/api/openapi.json']) {
      const at = indexOf((line) => line === copy);
      expect(at, `${copy} is missing from apps/web/Dockerfile`).toBeGreaterThan(-1);
      expect(at, `${copy} must come before the build`).toBeLessThan(build);
    }
  });

  it('takes the variable that turns the page on, empty by default', () => {
    expect(lines).toContain('ARG VITE_DEV_DOCS');
    expect(dockerfile).toContain('VITE_DEV_DOCS=$VITE_DEV_DOCS');
  });
});
