import { afterEach, describe, expect, it } from 'vitest';

import { assertLocalDatabaseUrl } from './index.js';

const originalPGHost = process.env.PGHOST;

afterEach(() => {
  if (originalPGHost === undefined) delete process.env.PGHOST;
  else process.env.PGHOST = originalPGHost;
});

describe('assertLocalDatabaseUrl (issue #183 review)', () => {
  it('accepts loopback hosts on both spellings and the default port', () => {
    expect(() => assertLocalDatabaseUrl('postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza')).not.toThrow();
    expect(() => assertLocalDatabaseUrl('postgresql://ageniza_app:ageniza_app@localhost:54322/ageniza')).not.toThrow();
    expect(() => assertLocalDatabaseUrl('postgresql://ageniza_app:ageniza_app@127.0.0.1/ageniza')).not.toThrow();
  });

  it('rejects remote hosts, public IPs and lookalike names', () => {
    for (const url of [
      'postgresql://u:p@db.example.com:5432/ageniza',
      'postgresql://u:p@203.0.113.9:5432/ageniza',
      'postgresql://u:p@localhost.evil.com:5432/ageniza',
      'postgresql://u:p@0.0.0.0:5432/ageniza',
      'postgresql://u:p@[2001:4860:4860::8888]:5432/ageniza'
    ]) {
      expect(() => assertLocalDatabaseUrl(url), url).toThrow(/loopback/);
    }
  });

  it('validates the host the driver would actually connect to, not the URL hostname', () => {
    // `?host=` overrides the URL host in pg-connection-string; this was the bypass found in the
    // security review of PR #188.
    expect(() => assertLocalDatabaseUrl('postgresql://u:p@127.0.0.1:54322/ageniza?host=nao-local.invalid')).toThrow(/loopback/);
    expect(() => assertLocalDatabaseUrl('postgresql://u:p@127.0.0.1:54322/ageniza?host=127.0.0.1')).not.toThrow();
  });

  it('rejects a unix socket path', () => {
    expect(() => assertLocalDatabaseUrl('postgresql://u:p@127.0.0.1:54322/ageniza?host=/cloudsql/proj:reg:inst')).toThrow(/loopback/);
  });

  it('rejects a hostaddr parameter outright', () => {
    expect(() => assertLocalDatabaseUrl('postgresql://u:p@127.0.0.1:54322/ageniza?hostaddr=203.0.113.9')).toThrow(/hostaddr/);
  });

  it('rejects a PGHOST fallback that is not loopback', () => {
    process.env.PGHOST = '203.0.113.9';
    expect(() => assertLocalDatabaseUrl('postgresql:///ageniza')).toThrow(/loopback/);
    process.env.PGHOST = '127.0.0.1';
    expect(() => assertLocalDatabaseUrl('postgresql:///ageniza')).not.toThrow();
  });

  it('rejects invalid URLs and other protocols', () => {
    expect(() => assertLocalDatabaseUrl('not-a-url')).toThrow(/valid PostgreSQL URL/);
    expect(() => assertLocalDatabaseUrl('mysql://u:p@127.0.0.1:3306/ageniza')).toThrow(/loopback/);
  });
});
