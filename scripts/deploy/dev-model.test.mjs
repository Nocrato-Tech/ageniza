import { describe, expect, it } from 'vitest';

import { assertDevModel, DEV_BUDGET, parseBytes, parseEnvFile } from './dev-model.mjs';

const MiB = 1024 ** 2;
const limits = { DEV_MIGRATIONS_CPUS: '0.15', DEV_MIGRATIONS_MEM: '384m', DEV_MIGRATIONS_PIDS: '128' };

const service = (cpus, memoryMiB, extra = {}) => ({
  cpus,
  mem_limit: String(memoryMiB * MiB),
  memswap_limit: String(memoryMiB * MiB),
  pids_limit: 100,
  networks: { 'dev-private': null },
  ...extra
});

// What `docker compose config --format json` prints for compose.yml + compose.dev.yml, reduced to what the rules read.
const model = () => ({
  services: {
    api: service(0.2, 512, { environment: { SMTP_URL: 'smtp://mailpit:1025', DEPLOY_TARGET: 'dev', API_TRUSTED_PROXY_CIDRS: '172.30.250.0/24' }, networks: { 'dev-private': null, egress: null } }),
    worker: service(0.25, 768, { environment: { SMTP_URL: 'smtp://mailpit:1025', DEPLOY_TARGET: 'dev' } }),
    web: service(0.05, 64, { networks: { 'dev-proxy': null, 'dev-private': null } }),
    mailpit: service(0.05, 128, { networks: { 'dev-private': null, 'dev-proxy': null } }),
    postgres: service(0.25, 768, { volumes: [{ type: 'bind', source: '/opt/ageniza-dev/postgres/initdb' }, { type: 'volume', source: 'postgres-data' }] })
  },
  networks: {
    'dev-private': { name: 'ageniza-dev_dev-private', internal: true, ipam: { config: [{ subnet: '172.30.250.0/24' }] } },
    'dev-proxy': { name: 'ageniza-dev-proxy', external: true },
    egress: { name: 'ageniza-dev_egress' }
  }
});
const tunnel = () => ({ services: { cloudflared: service(0.05, 128, { networks: { 'dev-proxy': null } }) }, networks: { 'dev-proxy': { name: 'ageniza-dev-proxy', external: true } } });
const check = (change = () => {}, changeTunnel = () => {}, jobLimits = limits) => {
  const dev = model();
  const edge = tunnel();
  change(dev);
  changeTunnel(edge);
  return () => assertDevModel(dev, edge, jobLimits);
};

describe('the dev model of ADR 0013', () => {
  it('passes a model inside the budget and reports the sum, migration job included', () => {
    expect(check()()).toEqual({ cpus: 1, memoryBytes: (512 + 768 + 64 + 128 + 768 + 128 + 384) * MiB });
  });

  it('keeps the budget the owner decided: 1 vCPU and 3 GiB', () => {
    expect(DEV_BUDGET).toEqual({ cpus: 1, memoryBytes: 3 * 1024 ** 3 });
  });

  it('refuses a model whose CPU limits go past 1 vCPU', () => {
    expect(check((dev) => { dev.services.api.cpus = 0.25; })).toThrow('add up to 1.05 vCPU');
  });

  it('counts the migration job in the CPU budget', () => {
    expect(check(undefined, undefined, { ...limits, DEV_MIGRATIONS_CPUS: '0.2' })).toThrow('add up to 1.05 vCPU');
  });

  it('counts the tunnel in the CPU budget', () => {
    expect(check(undefined, (edge) => { edge.services.cloudflared.cpus = 0.1; })).toThrow('add up to 1.05 vCPU');
  });

  it('refuses a model whose memory limits go past 3 GiB', () => {
    expect(check((dev) => { dev.services.worker.mem_limit = String(1536 * MiB); dev.services.worker.memswap_limit = String(1536 * MiB); })).toThrow('GiB');
  });

  it('counts the migration job in the memory budget', () => {
    expect(check(undefined, undefined, { ...limits, DEV_MIGRATIONS_MEM: '1g' })).toThrow('GiB');
  });

  it.each(['cpus', 'mem_limit', 'pids_limit'])('refuses a service without %s', (key) => {
    expect(check((dev) => { delete dev.services.web[key]; })).toThrow(`web has no ${key} limit`);
  });

  it('refuses the tunnel without a limit', () => {
    expect(check(undefined, (edge) => { delete edge.services.cloudflared.mem_limit; })).toThrow('cloudflared has no mem_limit limit');
  });

  it('refuses a service that may swap', () => {
    expect(check((dev) => { dev.services.api.memswap_limit = String(1024 * MiB); })).toThrow('api may swap');
  });

  it.each(['api', 'postgres', 'mailpit'])('refuses %s publishing a port', (name) => {
    expect(check((dev) => { dev.services[name].ports = [{ target: 5432, published: '5432' }]; })).toThrow(`${name} publishes a port`);
  });

  it('refuses the tunnel publishing a port', () => {
    expect(check(undefined, (edge) => { edge.services.cloudflared.ports = [{ target: 80 }]; })).toThrow('cloudflared publishes a port');
  });

  it('refuses a service that is not part of the dev model', () => {
    expect(check((dev) => { dev.services.localstack = service(0.01, 64); })).toThrow('expected [api, mailpit, postgres, web, worker]');
    expect(check((dev) => { delete dev.services.mailpit; })).toThrow('expected [api, mailpit, postgres, web, worker]');
  });

  describe.each(['api', 'worker'])('the mail path of the %s', (name) => {
    it('refuses a real SMTP provider', () => {
      expect(check((dev) => { dev.services[name].environment.SMTP_URL = 'smtps://user:key@smtp.example.com:465'; })).toThrow(`${name} must send mail to smtp://mailpit:1025`);
    });

    it('refuses a model that leaves SMTP_URL to the runtime file', () => {
      expect(check((dev) => { delete dev.services[name].environment.SMTP_URL; })).toThrow(`${name} must send mail to`);
    });

    it('refuses a model without the dev deploy target', () => {
      expect(check((dev) => { delete dev.services[name].environment.DEPLOY_TARGET; })).toThrow(`${name} must set DEPLOY_TARGET=dev`);
    });
  });

  it('refuses a trusted proxy network that is not the subnet of dev-private', () => {
    expect(check((dev) => { dev.services.api.environment.API_TRUSTED_PROXY_CIDRS = '172.30.251.0/24'; })).toThrow('API_TRUSTED_PROXY_CIDRS');
  });

  it.each([['egress'], ['dev-proxy']])('refuses PostgreSQL on the %s network as well as dev-private', (extra) => {
    expect(check((dev) => { dev.services.postgres.networks[extra] = null; })).toThrow('postgres must be on the dev-private network only');
  });

  it('refuses PostgreSQL off the dev-private network', () => {
    expect(check((dev) => { dev.services.postgres.networks = { egress: null }; })).toThrow('postgres must be on the dev-private network only');
  });

  it('refuses a dev-private network that is not internal', () => {
    expect(check((dev) => { dev.networks['dev-private'].internal = false; })).toThrow('must be internal');
  });

  it.each([
    ['production proxy network', 'ageniza-production-proxy'],
    ['production private network', 'ageniza_production-private']
  ])('refuses a service attached to the %s', (_label, name) => {
    expect(check((dev) => {
      dev.networks.shared = { name };
      dev.services.web.networks.shared = null;
    })).toThrow(`attached to the production network ${name}`);
  });

  it.each(['/opt/ageniza/postgres/initdb', '/etc/ageniza/cloudflared', '/var/run/docker.sock'])('refuses a bind mount of %s', (source) => {
    expect(check((dev) => { dev.services.postgres.volumes.push({ type: 'bind', source }); })).toThrow('outside the dev directories');
  });
});

describe('dev limits file helpers', () => {
  it('reads memory sizes in the units compose accepts', () => {
    expect(parseBytes('768m')).toBe(768 * MiB);
    expect(parseBytes('3g')).toBe(3 * 1024 ** 3);
    expect(parseBytes('1024')).toBe(1024);
    expect(() => parseBytes('lots')).toThrow('not a memory size');
  });

  it('parses the committed limits and they fit the budget', () => {
    const committed = parseEnvFile(new URL('../../infra/vps/dev-limits.env', import.meta.url));
    expect(committed.DEV_MIGRATIONS_CPUS).toBe('0.15');
    expect(Object.keys(committed).filter((key) => key.endsWith('_CPUS')).reduce((sum, key) => sum + Number(committed[key]), 0)).toBeCloseTo(1, 9);
  });
});
