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

const production = read('.github/workflows/production.yml');
const dev = read('.github/workflows/dev.yml');

// The worker charges the renewals, so it carries the same package and the same switch.
const IMAGES = [
  ['API', 'apps/api/Dockerfile'],
  ['worker', 'apps/worker/Dockerfile']
];

const buildLines = (workflow, path) => workflow.split('\n').filter((line) => line.includes(path));

describe.each(IMAGES)('the %s image and the simulated payment provider (issue #772)', (_label, path) => {
  const dockerfile = read(path);

  it('keeps the simulated code by default and removes it only for exclude, refusing any other value', () => {
    expect(dockerfile).toContain('ARG PAYMENTS_SIMULATED=include');
    expect(dockerfile).toMatch(/if \[ "\$PAYMENTS_SIMULATED" = "exclude" \]; then[^]*rm -rf \/runtime\/node_modules\/@ageniza\/payments\/dist\/simulated/);
    expect(dockerfile).toMatch(/elif \[ "\$PAYMENTS_SIMULATED" != "include" \]; then[^]*exit 1/);
  });

  it('carries the payments package into the build, so the removal has something to remove', () => {
    expect(dockerfile).toContain('COPY packages/payments/package.json packages/payments/package.json');
  });

  it('checks that the removal happened, so a layout change in the package fails the build instead of shipping the code', () => {
    expect(dockerfile).toContain('test ! -e /runtime/node_modules/@ageniza/payments/dist/simulated');
  });

  // A `rm` in the final stage, after `COPY --from=build`, would leave the files in the layer of the copy, and a tar of the image would
  // still hold them. The removal is in the build stage, after the deploy that builds the tree and before the final stage copies it.
  it('removes it in the build stage, after the deploy, so that no layer of the final image holds it and the final stage does not mention it', () => {
    const boundary = dockerfile.lastIndexOf('FROM node:');
    const buildStage = dockerfile.slice(0, boundary);
    const finalStage = dockerfile.slice(boundary);
    expect(buildStage.indexOf('--prod deploy /runtime')).toBeGreaterThan(-1);
    expect(buildStage.indexOf('rm -rf /runtime/node_modules/@ageniza/payments/dist/simulated')).toBeGreaterThan(buildStage.indexOf('--prod deploy /runtime'));
    expect(buildStage.indexOf('ARG PAYMENTS_SIMULATED=include')).toBeLessThan(buildStage.indexOf('rm -rf /runtime'));
    expect(finalStage).toContain('COPY --from=build /runtime ./');
    expect(finalStage).not.toMatch(/simulated/i);
    // The worker's final stage may clean the apt cache; what it must not do is remove anything from the copied tree.
    expect(finalStage).not.toMatch(/rm -rf[^\n]*(payments|node_modules|\/app)/);
  });

  it('is built with exclude by the production workflow, in the validating build and in the publishing build', () => {
    const validating = buildLines(production, path).find((line) => line.trimStart().startsWith('run: docker build'));
    expect(validating).toContain('--build-arg PAYMENTS_SIMULATED=exclude');

    const publishing = production.slice(production.indexOf('file: ' + path));
    const buildArgs = publishing.slice(publishing.indexOf('build-args:'), publishing.indexOf('labels:'));
    expect(buildArgs).toContain('PAYMENTS_SIMULATED=exclude');
  });
});

describe('the images and the dev environment (issue #772)', () => {
  it('is not excluded by the dev workflow, whose environment simulates payments', () => {
    expect(dev).not.toContain('PAYMENTS_SIMULATED');
  });

  // The dev environment runs with APP_ENV=production, so the line between it and the real production is DEPLOY_TARGET=dev, set by
  // compose.dev.yml alone. The production deploy has to keep refusing both keys, or production could name itself dev.
  it('keeps PAYMENTS_PROVIDER, PAYMENTS_SIMULATED_RENEWAL and DEPLOY_TARGET out of what the production deploy accepts and what its compose file sets', () => {
    for (const key of ['PAYMENTS_PROVIDER', 'PAYMENTS_SIMULATED_RENEWAL', 'DEPLOY_TARGET']) {
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
