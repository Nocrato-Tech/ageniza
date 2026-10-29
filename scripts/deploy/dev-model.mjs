import { readFileSync } from 'node:fs';

// The budget the dev environment may take from a VPS that will also run production (ADR 0013).
export const DEV_BUDGET = { cpus: 1, memoryBytes: 3 * 1024 ** 3 };
export const DEV_SERVICES = ['api', 'mailpit', 'postgres', 'web', 'worker'];
export const DEV_MAIL_SINK = 'smtp://mailpit:1025';

const UNITS = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

export function parseEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) continue;
    const separator = text.indexOf('=');
    values[text.slice(0, separator)] = text.slice(separator + 1);
  }
  return values;
}

export function parseBytes(value) {
  const match = /^(\d+)([bkmg]?)$/i.exec(String(value));
  if (match === null) throw new Error(`"${value}" is not a memory size`);
  return Number(match[1]) * UNITS[(match[2] || 'b').toLowerCase()];
}

const requireLimit = (name, value, label) => {
  if (value === undefined || value === null || Number(value) <= 0) throw new Error(`${name} has no ${label} limit; the dev environment must stay inside its budget.`);
};

/**
 * Checks the rendered dev model (compose.yml + compose.dev.yml) and the tunnel model against the rules of ADR 0013.
 * `limits` is the parsed infra/vps/dev-limits.env: it carries the one-shot migration job, which is not a service.
 */
export function assertDevModel(model, tunnelModel, limits) {
  const services = Object.keys(model.services ?? {}).sort();
  if (services.join(',') !== DEV_SERVICES.join(',')) {
    throw new Error(`Dev model has services [${services.join(', ')}]; expected [${DEV_SERVICES.join(', ')}].`);
  }
  const running = { ...model.services, ...tunnelModel.services };

  for (const [name, service] of Object.entries(running)) {
    if (Array.isArray(service.ports) && service.ports.length > 0) throw new Error(`Service ${name} publishes a port in dev; the Cloudflare Tunnel is the only entry point.`);
    requireLimit(name, service.cpus, 'cpus');
    requireLimit(name, service.mem_limit, 'mem_limit');
    requireLimit(name, service.pids_limit, 'pids_limit');
    if (String(service.memswap_limit) !== String(service.mem_limit)) throw new Error(`Service ${name} may swap: memswap_limit must equal mem_limit.`);
    for (const network of Object.keys(service.networks ?? {})) {
      const resolved = (model.networks?.[network] ?? tunnelModel.networks?.[network])?.name ?? network;
      if (resolved.startsWith('ageniza-production') || resolved.startsWith('ageniza_')) throw new Error(`Service ${name} is attached to the production network ${resolved}.`);
    }
    for (const volume of service.volumes ?? []) {
      if (volume.type === 'bind' && !/^\/(opt|etc)\/ageniza-dev\//.test(volume.source)) throw new Error(`Service ${name} mounts ${volume.source}, which is outside the dev directories.`);
    }
  }

  // The migration job runs while the stack is up, so its limits count against the same budget.
  const migrations = { cpus: Number(limits.DEV_MIGRATIONS_CPUS), memory: parseBytes(limits.DEV_MIGRATIONS_MEM) };
  requireLimit('migrations', migrations.cpus, 'cpus');
  requireLimit('migrations', limits.DEV_MIGRATIONS_PIDS, 'pids_limit');
  const cpus = Object.values(running).reduce((sum, service) => sum + Number(service.cpus), migrations.cpus);
  const memory = Object.values(running).reduce((sum, service) => sum + parseBytes(service.mem_limit), migrations.memory);
  if (cpus > DEV_BUDGET.cpus + 1e-9) throw new Error(`Dev limits add up to ${cpus.toFixed(2)} vCPU; the budget is ${DEV_BUDGET.cpus}.`);
  if (memory > DEV_BUDGET.memoryBytes) throw new Error(`Dev limits add up to ${(memory / 1024 ** 3).toFixed(2)} GiB; the budget is ${DEV_BUDGET.memoryBytes / 1024 ** 3}.`);

  // Mail goes to the sink and nowhere else: the value is fixed in the model, above the runtime file.
  for (const name of ['api', 'worker']) {
    const environment = model.services[name].environment ?? {};
    if (environment.SMTP_URL !== DEV_MAIL_SINK) throw new Error(`Service ${name} must send mail to ${DEV_MAIL_SINK} in dev.`);
    if (environment.DEPLOY_TARGET !== 'dev') throw new Error(`Service ${name} must set DEPLOY_TARGET=dev.`);
  }
  const subnet = model.networks?.['dev-private']?.ipam?.config?.[0]?.subnet;
  if (model.services.api.environment?.API_TRUSTED_PROXY_CIDRS !== subnet) {
    throw new Error('API_TRUSTED_PROXY_CIDRS must be the subnet of the dev-private network.');
  }
  // PostgreSQL has no route out and none in besides the internal network: the egress network would give it one.
  const postgresNetworks = Object.keys(model.services.postgres.networks ?? {});
  if (postgresNetworks.length !== 1 || postgresNetworks[0] !== 'dev-private') {
    throw new Error(`Service postgres must be on the dev-private network only; it is on [${postgresNetworks.join(', ')}].`);
  }
  if (model.networks?.['dev-private']?.internal !== true) throw new Error('The dev-private network must be internal.');
  return { cpus, memoryBytes: memory };
}
