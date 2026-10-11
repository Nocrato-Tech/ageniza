import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Issue #260: the worker sends the e-mail to the client, so it needs the transport (SMTP_URL, EMAIL_FROM) and the origin of the web
// app for the links (APP_PUBLIC_URL). The CI does not see an environment variable that one place forgot: the local stack, the
// deploy allowlist and its required list, and the example of the production file each get a look here.
const root = join(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const KEYS = ['APP_PUBLIC_URL', 'SMTP_URL', 'EMAIL_FROM'];

/** The text of one top-level service of the compose file, up to the next one. */
export const serviceBlock = (compose, name) => {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start === -1) throw new Error(`No ${name} service in the compose file.`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe('the e-mail of the worker needs three settings, and each place that lists settings has them (issue #260)', () => {
  it.each(KEYS)('gives the worker of the local stack %s', (key) => {
    expect(serviceBlock(read('compose.yml'), 'worker')).toMatch(new RegExp(`\\n {6}${key}: \\S`));
  });

  it.each(KEYS)('lets the deploy accept %s in the production file, refuse it blank, and require it', (key) => {
    const deploy = read('infra/vps/ageniza-deploy.sh');
    const blankRefused = deploy.split('\n').filter((line) => line.includes('"$key must not be blank"')).flatMap((line) => line.trim().split(')')[0].split('|'));
    expect(blankRefused).toContain(key);
    const required = /for required in ([^;]+); do/.exec(deploy)?.[1].split(/\s+/) ?? [];
    expect(required).toContain(key);
  });

  it.each(KEYS)('shows %s in the example of the production file', (key) => {
    expect(read('infra/vps/runtime.env.example')).toMatch(new RegExp(`^${key}=\\S`, 'm'));
  });

  it('reaches the worker of production through the same production file as the API', () => {
    const production = read('compose.production.yml');
    expect(serviceBlock(production, 'worker')).toContain('${AGENIZA_RUNTIME_ENV_FILE:?server runtime env file required}');
  });

  it('finds the service blocks it reads: a compose file without them would make every check above pass for the wrong reason', () => {
    const compose = read('compose.yml');
    expect(serviceBlock(compose, 'worker')).toContain('WORKER_HEALTH_PORT');
    expect(serviceBlock(compose, 'worker')).not.toContain('BETTER_AUTH_SECRET');
    expect(serviceBlock(compose, 'api')).toContain('BETTER_AUTH_SECRET');
  });
});
