import { execFileSync } from 'node:child_process';

const command = process.argv[2];
const run = (file, args, options = {}) =>
  execFileSync(file, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });

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

const startDatabase = () => run('docker', ['compose', 'up', '-d', '--wait', 'postgres']);
const migrate = () => run('pnpm', ['--filter', '@ageniza/database', 'migrate'], { env: migrationEnvironment() });

switch (command) {
  case 'db:start':
    startDatabase();
    break;
  case 'db:migrate':
    migrate();
    break;
  case 'db:reset':
    // Removes only this project's database container and volume, then rebuilds from migrations.
    run('docker', ['compose', 'rm', '--stop', '--force', '--volumes', 'postgres']);
    run('docker', ['volume', 'rm', '--force', 'ageniza-local_postgres-data']);
    startDatabase();
    migrate();
    break;
  case 'up':
    startDatabase();
    migrate();
    run('docker', ['compose', 'up', '--build', '--wait']);
    break;
  case 'down':
    // Keeps the database volume; use db:reset to discard local data.
    run('docker', ['compose', 'down', '--remove-orphans']);
    break;
  default:
    throw new Error('Usage: node scripts/docker/local-stack.mjs db:start | db:migrate | db:reset | up | down');
}
