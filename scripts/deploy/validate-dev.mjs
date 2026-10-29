import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertDevModel, parseEnvFile } from './dev-model.mjs';
import { assertImmutableGhcrImage } from './validate-image-ref.mjs';

const image = (name, char) => `ghcr.io/nocrato-tech/ageniza-${name}@sha256:${char.repeat(64)}`;
const limitsFile = 'infra/vps/dev-limits.env';
const environment = {
  ...process.env,
  AGENIZA_API_IMAGE: image('api', 'a'),
  AGENIZA_WORKER_IMAGE: image('worker', 'b'),
  AGENIZA_WEB_IMAGE: image('web', 'c'),
  AGENIZA_MAILPIT_IMAGE: `axllent/mailpit@sha256:${'d'.repeat(64)}`,
  AGENIZA_POSTGRES_IMAGE: `postgres@sha256:${'e'.repeat(64)}`,
  AGENIZA_TUNNEL_IMAGE: `cloudflare/cloudflared@sha256:${'f'.repeat(64)}`,
  AGENIZA_TUNNEL_ID: '00000000-0000-4000-8000-000000000000'
};
const directory = mkdtempSync(join(tmpdir(), 'ageniza-dev-'));
const runtimeEnv = join(directory, 'runtime.env');
const postgresEnv = join(directory, 'postgres.env');

const render = (files) => JSON.parse(execFileSync('docker', ['compose', '--env-file', limitsFile, ...files.flatMap((file) => ['-f', file]), 'config', '--format', 'json'], { env: environment, encoding: 'utf8' }));

try {
  for (const name of ['AGENIZA_API_IMAGE', 'AGENIZA_WORKER_IMAGE', 'AGENIZA_WEB_IMAGE']) assertImmutableGhcrImage(name, environment[name]);
  writeFileSync(runtimeEnv, 'APP_ENV=production\n');
  writeFileSync(postgresEnv, 'POSTGRES_USER=postgres\nPOSTGRES_DB=ageniza\nPOSTGRES_PASSWORD=test-only\nAGENIZA_APP_DB_PASSWORD=test-only\n');
  environment.AGENIZA_RUNTIME_ENV_FILE = runtimeEnv;
  environment.AGENIZA_POSTGRES_ENV_FILE = postgresEnv;
  const total = assertDevModel(render(['compose.yml', 'compose.dev.yml']), render(['infra/vps/compose.dev-tunnel.yml']), parseEnvFile(limitsFile));
  console.log(`Dev Compose validation passed: ${total.cpus.toFixed(2)} vCPU and ${(total.memoryBytes / 1024 ** 3).toFixed(2)} GiB at most.`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
