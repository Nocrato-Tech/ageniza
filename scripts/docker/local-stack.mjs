import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const command = process.argv[2];
const localStorageEnvFile = resolve('.local/storage.env');

// Hex, not base64url: its alphabet contains '-', and a secret starting with one is read as a
// flag by every CLI that receives it as an argument (mc aborts with "flag provided but not
// defined"), which made roughly one run in sixty fail.
const generateCredentialPair = (prefix) => ({
  accessKeyId: `${prefix}-${randomBytes(12).toString('hex')}`,
  secretAccessKey: randomBytes(32).toString('hex')
});

const parseEnvFile = (content) => Object.fromEntries(content
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));

/**
 * Generates and persists local credentials for every storage destination this project needs:
 * the media bucket (`R2_*`) and, since issue #100, the separate identity bucket
 * (`IDENTITY_STORAGE_*`). Never touches a key that already exists -- a dev who ran
 * `pnpm storage:start` before issue #100 still has a file missing the `IDENTITY_STORAGE_*` pair,
 * and re-running this must fill only the gap, never rotate what is already there.
 */
const ensureLocalStorageEnvironment = () => {
  const existingValues = existsSync(localStorageEnvFile) ? parseEnvFile(readFileSync(localStorageEnvFile, 'utf8')) : {};
  const values = { ...existingValues };
  let changed = false;
  for (const [accessKeyIdKey, secretKey, accessKeyIdPrefix] of [
    ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'local'],
    ['IDENTITY_STORAGE_ACCESS_KEY_ID', 'IDENTITY_STORAGE_SECRET_ACCESS_KEY', 'local-identity']
  ]) {
    if (values[accessKeyIdKey] !== undefined && values[secretKey] !== undefined) continue;
    const pair = generateCredentialPair(accessKeyIdPrefix);
    values[accessKeyIdKey] = pair.accessKeyId;
    values[secretKey] = pair.secretAccessKey;
    changed = true;
  }
  if (changed) {
    mkdirSync(dirname(localStorageEnvFile), { recursive: true });
    writeFileSync(localStorageEnvFile, [...Object.entries(values).map(([key, value]) => `${key}=${value}`), ''].join('\n'), { mode: 0o600 });
  }
  return { ...process.env, ...values };
};

const localEnvironment = ensureLocalStorageEnvironment();
const composeArgs = ['compose', '--env-file', localStorageEnvFile];
const run = (file, args, options = {}) =>
  execFileSync(file, args, { stdio: 'inherit', shell: process.platform === 'win32', env: localEnvironment, ...options });
const runCompose = (args) => run('docker', [...composeArgs, ...args]);

const localOwnerUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';

/** Refuses to run local tooling against anything but the disposable Compose database. */
const migrationEnvironment = () => {
  const connectionString = process.env.MIGRATION_DATABASE_URL ?? localOwnerUrl;
  const hostname = new URL(connectionString).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error('MIGRATION_DATABASE_URL must point at the loopback development database.');
  }
  return { ...process.env, MIGRATION_DATABASE_URL: connectionString };
};

const startDatabase = () => runCompose(['up', '-d', '--wait', 'postgres']);
/**
 * LocalStack stands in for R2 locally and in CI. The bucket is created by a ready hook inside the
 * container, and the healthcheck waits on its marker -- so `--wait` returning means the bucket exists.
 */
const startStorage = () => {
  try {
    runCompose(['up', '-d', '--wait', '--force-recreate', 'localstack']);
  } catch (error) {
    // `--wait` fails with nothing but an exit code, so a container that never turned healthy looks
    // identical to one that crashed. Its own log is the only thing that tells them apart.
    console.error('Local object storage did not become healthy. Container log follows:');
    try { runCompose(['logs', '--no-color', '--tail', '80', 'localstack']); } catch { /* the log is best effort */ }
    throw error;
  }
};
const migrate = () => run('pnpm', ['--filter', '@ageniza/database', 'migrate'], { env: { ...localEnvironment, ...migrationEnvironment() } });

switch (command) {
  case 'db:start':
    startDatabase();
    break;
  case 'db:migrate':
    migrate();
    break;
  case 'storage:start':
    startStorage();
    break;
  case 'db:reset':
    // Removes only this project's database container and volume, then rebuilds from migrations.
    runCompose(['rm', '--stop', '--force', '--volumes', 'postgres']);
    run('docker', ['volume', 'rm', '--force', 'ageniza-local_postgres-data']);
    startDatabase();
    migrate();
    break;
  case 'up':
    startDatabase();
    migrate();
    runCompose(['up', '--build', '--wait']);
    break;
  case 'down':
    // Keeps the database volume; use db:reset to discard local data.
    runCompose(['down', '--remove-orphans']);
    break;
  default:
    throw new Error('Usage: node scripts/docker/local-stack.mjs db:start | db:migrate | db:reset | storage:start | up | down');
}
