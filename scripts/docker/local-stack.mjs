import { execFileSync } from 'node:child_process';

const command = process.argv[2];
const executionOptions = {
  stdio: 'inherit',
  shell: process.platform === 'win32'
};
const run = (file, args, options = {}) => execFileSync(file, args, { ...executionOptions, ...options });

const readLocalSupabaseKeys = () => {
  const output = execFileSync('pnpm', ['dlx', 'supabase@2.117.0', 'status', '-o', 'json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const status = JSON.parse(output);
  if (typeof status.ANON_KEY !== 'string' || typeof status.SERVICE_ROLE_KEY !== 'string') {
    throw new Error('Supabase status did not return the required local API keys');
  }
  return {
    LOCAL_SUPABASE_ANON_KEY: status.ANON_KEY,
    LOCAL_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY
  };
};

const attempt = (file, args, failures) => {
  try {
    run(file, args);
  } catch (error) {
    failures.push(error);
  }
};

const stopLocalStack = () => {
  const failures = [];
  attempt('docker', ['compose', 'down', '--remove-orphans'], failures);
  attempt('pnpm', ['dlx', 'supabase@2.117.0', 'stop', '--no-backup'], failures);
  if (failures.length > 0) throw new AggregateError(failures, 'Local stack cleanup failed');
};

if (command === 'up') {
  try {
    run('pnpm', ['dlx', 'supabase@2.117.0', 'start']);
    const localKeys = readLocalSupabaseKeys();
    run('docker', ['compose', 'up', '--build', '--wait'], { env: { ...process.env, ...localKeys } });
  } catch (error) {
    try {
      stopLocalStack();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Local stack startup and cleanup failed');
    }
    throw error;
  }
} else if (command === 'down') {
  stopLocalStack();
} else {
  throw new Error('Usage: pnpm docker:up | pnpm docker:down');
}
