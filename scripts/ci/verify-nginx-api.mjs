import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/ci/verify-nginx-api.mjs <web-image> [--mutate]');
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = resolve(root, 'scripts/ci/fixtures/nginx-api-upstream.mjs');
const prefix = `ageniza-edge-${process.pid}-${Date.now()}`;
const directory = mkdtempSync(join(tmpdir(), 'ageniza-edge-'));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const endpoint = (container, port) => `http://${docker('port', container, `${port}/tcp`).split('\n')[0].trim()}`;
const pause = () => new Promise((done) => setTimeout(done, 100));
async function until(check, message) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) { if (await check()) return; await pause(); }
  throw new Error(message);
}
const clientA = '198.51.100.1';
const clientB = '203.0.113.99';
const as = (address, headers = {}) => ({ headers: { ...headers, 'CF-Connecting-IP': address } });
const clientPhoto = '/api/agencies/11111111-1111-4111-8111-111111111111/clients/22222222-2222-4222-8222-222222222222/photo';
const config = readFileSync(resolve(root, 'apps/web/nginx.conf'), 'utf8');
const include = readFileSync(resolve(root, 'apps/web/nginx-api-proxy.inc'), 'utf8');
const containers = new Set();
let control;
async function release() { if (control) await fetch(`${control}/__test/release`, { signal: AbortSignal.timeout(5000) }); }
async function scenario(label, changedConfig, changedInclude) {
  const name = `${prefix}-${label}`;
  const mount = [];
  if (changedConfig !== undefined) {
    const path = join(directory, `${label}.conf`); writeFileSync(path, changedConfig);
    mount.push('--mount', `type=bind,source=${path},target=/etc/nginx/conf.d/default.conf,readonly`);
  }
  if (changedInclude !== undefined) {
    const path = join(directory, `${label}.inc`); writeFileSync(path, changedInclude);
    mount.push('--mount', `type=bind,source=${path},target=/etc/nginx/ageniza-api-proxy.inc,readonly`);
  }
  containers.add(name);
  docker('run', '-d', '--name', name, '--network', prefix, '-p', '127.0.0.1::8080', ...mount, image);
  const base = endpoint(name, 8080);
  const send = (path, init = {}) => fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
  try {
    await until(async () => { try { return (await send('/health')).ok; } catch { return false; } }, 'Nginx did not start');
    const probe = await send('/api/probe', { headers: { 'CF-Connecting-IP': '198.51.100.7', 'X-Request-Id': 'edge-review' } });
    assert.equal(probe.status, 200);
    assert.deepEqual(await probe.json(), { path: '/probe', bytes: 0, connection: null, forwardedProto: 'https', forwardedFor: '198.51.100.7', requestId: 'edge-review', host: new URL(base).hostname });
    const body = JSON.stringify({ imageBase64: 'A'.repeat(Math.ceil(10 * 1024 * 1024 / 3) * 4) });
    for (const path of ['/api/me/photo', clientPhoto]) {
      const result = await send(path, { method: path === clientPhoto ? 'PUT' : 'POST', body });
      assert.equal(result.status, 200, `Allowed identity body rejected at ${path}`);
      assert.equal((await result.json()).bytes, Buffer.byteLength(body));
      assert.equal((await send(path, { method: 'POST', body: 'A'.repeat(14 * 1024 * 1024 + 1) })).status, 413);
    }
    for (const path of ['/api/probe', `${clientPhoto}/extra`, '/api/me/photo-extra']) {
      assert.equal((await send(path, { method: 'POST', body: 'A'.repeat(1024 * 1024 + 1) })).status, 413, `General body limit widened at ${path}`);
    }
    // The caps are per client: client A fills its own slots and is refused, client B (another CF-Connecting-IP) is still served.
    for (const [count, paths, rejected] of [[2, ['/api/me/photo', clientPhoto], '/api/me/photo'], [16, ['/api/probe'], clientPhoto]]) {
      const pending = Array.from({ length: count }, (_, index) => send(`${paths[index % paths.length]}?hold=1`, as(clientA)).then(async (response) => { await response.arrayBuffer(); return response.status; }));
      try {
        await until(async () => (await (await fetch(`${control}/__test/pending`)).json()).count === count, `Did not hold ${count} proxied requests`);
        assert.equal((await send(rejected, as(clientA))).status, 429, `Missing per-client connection cap (${count})`);
        if (count === 2) assert.equal((await send('/api/probe', as(clientA))).status, 200);
        else assert.equal((await send('/api/probe', as(clientA))).status, 429);
        assert.equal((await send('/api/probe', as(clientB))).status, 200, `Client A's ${count} requests took the API from client B`);
        assert.equal((await send('/api/me/photo', as(clientB))).status, 200, `Client A's ${count} requests took the photo route from client B`);
        assert.equal((await send('/health')).status, 200);
      } finally { await release(); await Promise.allSettled(pending); }
    }  } finally { await release(); docker('rm', '-f', name); containers.delete(name); }
}
try {
  docker('network', 'create', prefix);
  const api = `${prefix}-api`; containers.add(api);
  docker('run', '-d', '--name', api, '--network', prefix, '--network-alias', 'api', '-p', '127.0.0.1::3001', '--mount', `type=bind,source=${fixture},target=/fixture.mjs,readonly`, 'node:22-bookworm-slim', 'node', '/fixture.mjs');
  control = endpoint(api, 3001);
  await until(async () => { try { return (await fetch(`${control}/__test/pending`)).ok; } catch { return false; } }, 'Test upstream did not start');
  await scenario('baseline');
  console.log('Nginx identity upload, API limits, forwarding and per-client concurrency: passed');
  if (process.argv.includes('--mutate')) {
    const mutations = [
      ['photo-body', config.replace('client_max_body_size 14m;', 'client_max_body_size 1m;'), undefined],
      ['general-body', config.replace('client_max_body_size 1m;', 'client_max_body_size 14m;'), undefined],
      ['photo-cap', config.replace('limit_conn ageniza_photo_connections 2;', ''), undefined],
      ['api-cap', config.replace(/(location \/api\/ \{\r?\n)\s*limit_conn ageniza_api_connections 16;/, '$1'), undefined],
      ['shared-key-api', config.replace('limit_conn_zone $ageniza_client_ip zone=ageniza_api_connections', 'limit_conn_zone $server_name zone=ageniza_api_connections'), undefined],
      ['shared-key-photo', config.replace('limit_conn_zone $ageniza_client_ip zone=ageniza_photo_connections', 'limit_conn_zone $server_name zone=ageniza_photo_connections'), undefined],
      ['connection', undefined, include.replace('proxy_set_header Connection "";', '')],
      ['prefix', undefined, include.replace('rewrite ^/api/(.*)$ /$1 break;', '')],
      ['host', undefined, include.replace('proxy_set_header Host $host;', '')]
    ];
    for (const [label, changedConfig, changedInclude] of mutations) {
      let detected = false;
      try { await scenario(label, changedConfig, changedInclude); } catch (error) { if (error instanceof assert.AssertionError) detected = true; else throw error; }
      assert.equal(detected, true, `Mutation survived: ${label}`);
      console.log(`Detected and discarded mutation: ${label}`);
    }
  }
} finally {
  for (const name of containers) { try { docker('rm', '-f', name); } catch { /* The container may have exited during the failed probe. */ } }
  try { docker('network', 'rm', prefix); } finally {
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('ageniza-edge-'));
    rmSync(directory, { recursive: true, force: true });
  }
}
