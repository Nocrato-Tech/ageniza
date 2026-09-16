import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertImmutableGhcrImage } from './validate-image-ref.mjs';

const image = (name, char) => `ghcr.io/nocrato-tech/ageniza-${name}@sha256:${char.repeat(64)}`;
const environment = {
  ...process.env,
  AGENIZA_API_IMAGE: image('api', 'a'),
  AGENIZA_WORKER_IMAGE: image('worker', 'b'),
  AGENIZA_WEB_IMAGE: image('web', 'c'),
  AGENIZA_CADDY_IMAGE: `caddy@sha256:${'d'.repeat(64)}`,
  AGENIZA_DOMAIN: 'app.example.test',
  AGENIZA_ACME_EMAIL: 'ops@example.test'
};
const directory = mkdtempSync(join(tmpdir(), 'ageniza-production-'));
const runtimeEnv = join(directory, 'runtime.env');

try {
  // Application images come from GHCR; the Caddy image is host-installed and checked by the VPS entrypoint.
  for (const name of ['AGENIZA_API_IMAGE', 'AGENIZA_WORKER_IMAGE', 'AGENIZA_WEB_IMAGE']) {
    assertImmutableGhcrImage(name, environment[name]);
  }
  writeFileSync(runtimeEnv, 'APP_ENV=production\nDATABASE_URL=postgresql://user:password@db.example.test:5432/ageniza\nSUPABASE_URL=https://project.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=test-only-server-secret\nAPI_CORS_ORIGINS=https://app.example.test\nAPI_TRUSTED_PROXY_CIDRS=172.20.0.0/16\n');
  environment.AGENIZA_RUNTIME_ENV_FILE = runtimeEnv;
  execFileSync('docker', ['compose', '-f', 'compose.yml', '-f', 'compose.production.yml', 'config', '--quiet'], { env: environment, stdio: 'inherit' });
  execFileSync('docker', ['compose', '-f', 'infra/vps/compose.caddy.yml', 'config', '--quiet'], { env: environment, stdio: 'inherit' });
  console.log('Production Compose and immutable image-reference validation passed.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
