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
  AGENIZA_POSTGRES_IMAGE: `postgres@sha256:${'e'.repeat(64)}`,
  AGENIZA_TUNNEL_IMAGE: `cloudflare/cloudflared@sha256:${'f'.repeat(64)}`,
  AGENIZA_TUNNEL_ID: '00000000-0000-4000-8000-000000000000',
  AGENIZA_DOMAIN: 'app.example.test'
};
const directory = mkdtempSync(join(tmpdir(), 'ageniza-production-'));
const runtimeEnv = join(directory, 'runtime.env');
const postgresEnv = join(directory, 'postgres.env');

try {
  // Application images come from GHCR; PostgreSQL and cloudflared are host-configured and checked by the VPS entrypoint.
  for (const name of ['AGENIZA_API_IMAGE', 'AGENIZA_WORKER_IMAGE', 'AGENIZA_WEB_IMAGE']) {
    assertImmutableGhcrImage(name, environment[name]);
  }
  writeFileSync(runtimeEnv, 'APP_ENV=production\nBETTER_AUTH_SECRET=fixture-only-placeholder-secret-at-least-32-chars\nAPP_PUBLIC_URL=https://app.example.test\nAUTH_TERMS_VERSION=2026-01-01\nAUTH_PRIVACY_VERSION=2026-02-01\nDATABASE_URL=postgresql://ageniza_app:test-only@postgres:5432/ageniza\nAPI_CORS_ORIGINS=https://app.example.test\nAPI_TRUSTED_PROXY_CIDRS=172.20.0.0/16\nSMTP_URL=smtps://fixture:fixture@smtp.example.test:465\nEMAIL_FROM=Ageniza <no-reply@example.test>\n');
  writeFileSync(postgresEnv, 'POSTGRES_USER=postgres\nPOSTGRES_DB=ageniza\nPOSTGRES_PASSWORD=test-only\nAGENIZA_APP_DB_PASSWORD=test-only\n');
  environment.AGENIZA_RUNTIME_ENV_FILE = runtimeEnv;
  environment.AGENIZA_POSTGRES_ENV_FILE = postgresEnv;
  // Render the production model and assert its shape: local-only services must not leak into it,
  // and nothing may publish a port, because the tunnel is the only public entry point (ADR 0012).
  const rendered = execFileSync('docker', ['compose', '-f', 'compose.yml', '-f', 'compose.production.yml', 'config', '--format', 'json'], { env: environment, encoding: 'utf8' });
  const model = JSON.parse(rendered);
  const services = Object.keys(model.services ?? {}).sort();
  const expected = ['api', 'postgres', 'web', 'worker'];
  if (services.join(',') !== expected.join(',')) {
    throw new Error(`Production model has services [${services.join(', ')}]; expected [${expected.join(', ')}].`);
  }
  for (const [name, service] of Object.entries(model.services)) {
    if (Array.isArray(service.ports) && service.ports.length > 0) {
      throw new Error(`Service ${name} publishes a port in production; the Cloudflare Tunnel is the only entry point.`);
    }
  }
  execFileSync('docker', ['compose', '-f', 'infra/vps/compose.tunnel.yml', 'config', '--quiet'], { env: environment, stdio: 'inherit' });
  console.log('Production Compose and immutable image-reference validation passed.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
