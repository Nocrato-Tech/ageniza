import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The simulated payment provider approves any card (issue #772, owner decision 2026-10-29). The API refuses to start with it
// in production (packages/config, apps/api/src/server.test.ts), and the production release also leaves its code out of the
// image: the Dockerfile removes it when PAYMENTS_SIMULATED=exclude, and the production workflow passes that value in the build
// that validates a pull request and in the build that publishes. The dev and local environments run the same Dockerfile with
// the default, which keeps the simulated code, so a dev environment can still simulate a payment.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

const dockerfile = read('apps/api/Dockerfile');
const production = read('.github/workflows/production.yml');
const dev = read('.github/workflows/dev.yml');

const apiBuildLines = (workflow) => workflow.split('\n').filter((line) => line.includes('apps/api/Dockerfile'));

describe('the API image and the simulated payment provider (issue #772)', () => {
  it('keeps the simulated code by default and removes it only for exclude, refusing any other value', () => {
    expect(dockerfile).toContain('ARG PAYMENTS_SIMULATED=include');
    expect(dockerfile).toMatch(/if \[ "\$PAYMENTS_SIMULATED" = "exclude" \]; then[^]*rm -rf node_modules\/@ageniza\/payments\/dist\/simulated/);
    expect(dockerfile).toMatch(/elif \[ "\$PAYMENTS_SIMULATED" != "include" \]; then[^]*exit 1/);
  });

  it('checks that the removal happened, so a layout change in the package fails the build instead of shipping the code', () => {
    expect(dockerfile).toContain('test ! -e node_modules/@ageniza/payments/dist/simulated');
  });

  it('removes it before the image drops to the node user and in the final stage that ships', () => {
    const finalStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:'));
    expect(finalStage.indexOf('PAYMENTS_SIMULATED')).toBeGreaterThan(-1);
    expect(finalStage.indexOf('rm -rf node_modules/@ageniza/payments/dist/simulated')).toBeLessThan(finalStage.indexOf('USER node'));
    expect(finalStage.indexOf('COPY --from=build /runtime ./')).toBeLessThan(finalStage.indexOf('rm -rf node_modules/@ageniza/payments/dist/simulated'));
  });

  it('is built with exclude by the production workflow, in the validating build and in the publishing build', () => {
    const validating = apiBuildLines(production).find((line) => line.trimStart().startsWith('run: docker build'));
    expect(validating).toContain('--build-arg PAYMENTS_SIMULATED=exclude');

    const publishing = production.slice(production.indexOf('file: apps/api/Dockerfile'));
    const buildArgs = publishing.slice(publishing.indexOf('build-args:'), publishing.indexOf('labels:'));
    expect(buildArgs).toContain('PAYMENTS_SIMULATED=exclude');
  });

  it('is not excluded by the dev workflow, whose environment simulates payments', () => {
    expect(dev).not.toContain('PAYMENTS_SIMULATED');
  });

  // The dev environment runs with APP_ENV=production, so the line between it and the real production is DEPLOY_TARGET=dev, set by
  // compose.dev.yml alone. The production deploy has to keep refusing both keys, or production could name itself dev.
  it('keeps PAYMENTS_PROVIDER and DEPLOY_TARGET out of what the production deploy accepts and what its compose file sets', () => {
    for (const key of ['PAYMENTS_PROVIDER', 'DEPLOY_TARGET']) {
      expect(read('infra/vps/ageniza-deploy.sh'), key).not.toContain(key);
      expect(read('compose.production.yml'), key).not.toContain(key);
      expect(read('infra/vps/runtime.env.example'), key).not.toContain(key);
    }
    expect(read('infra/vps/ageniza-deploy.sh')).toContain('contains a key that is not allowed');
  });

  it('is told apart from production by the key that only compose.dev.yml sets', () => {
    expect(read('compose.dev.yml')).toMatch(/\n\s+DEPLOY_TARGET: dev\n/);
  });
});
