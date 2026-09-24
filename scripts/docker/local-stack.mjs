import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const command = process.argv[2];
const localStorageEnvFile = resolve('.local/storage.env');

const ensureLocalStorageEnvironment = () => {
  if (!existsSync(localStorageEnvFile)) {
    mkdirSync(dirname(localStorageEnvFile), { recursive: true });
    const accessKeyId = `local-${randomBytes(12).toString('hex')}`;
    // Hex, not base64url: its alphabet contains '-', and a secret starting with one is read as a
    // flag by every CLI that receives it as an argument (mc aborts with "flag provided but not
    // defined"), which made roughly one run in sixty fail.
    const secretAccessKey = randomBytes(32).toString('hex');
    writeFileSync(localStorageEnvFile, [
      `R2_ACCESS_KEY_ID=${accessKeyId}`,
      `R2_SECRET_ACCESS_KEY=${secretAccessKey}`,
      ''
    ].join('\n'), { mode: 0o600 });
  }
  const values = Object.fromEntries(readFileSync(localStorageEnvFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
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
const startStorage = () => runCompose(['up', '-d', '--wait', '--force-recreate', 'localstack']);
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
