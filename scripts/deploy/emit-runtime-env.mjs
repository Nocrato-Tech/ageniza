const required = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'API_CORS_ORIGINS',
  'API_TRUSTED_PROXY_CIDRS',
  'GHCR_PULL_TOKEN'
];
const optional = ['SENTRY_DSN'];

const valueFor = (name) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required for the protected production deploy job.`);
  if (/[\r\n]/.test(value)) throw new Error(`${name} must be one line.`);
  return value;
};

try {
  // stdout is the encrypted SSH stdin stream. Never log configuration values.
  process.stdout.write('APP_ENV=production\nWORKER_SMOKE_JOB=false\n');
  for (const name of required) process.stdout.write(`${name}=${valueFor(name)}\n`);
  for (const name of optional) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) {
      if (/[\r\n]/.test(value)) throw new Error(`${name} must be one line.`);
      process.stdout.write(`${name}=${value}\n`);
    }
  }
} catch (error) {
  // Do not include a supplied value in errors.
  console.error(error.message);
  process.exitCode = 1;
}
