import { describe, expect, it } from 'vitest';

import { loadApiConfig } from '@ageniza/config/server';

import { buildApp } from '../../app.js';
import { buildOpenApiDocument } from './document.js';

const baseConfig = loadApiConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza',
  API_CORS_ORIGINS: 'http://127.0.0.1:5173',
  API_BODY_LIMIT_BYTES: '1024',
  BETTER_AUTH_SECRET: 'test-only-secret-value-not-real-32chars+',
  AUTH_TERMS_VERSION: '2026-01-01',
  AUTH_PRIVACY_VERSION: '2026-01-01',
  APP_PUBLIC_URL: 'http://127.0.0.1:5173'
});

describe('API reference route gating (issue #182)', () => {
  it('serves /docs and the OpenAPI document when the runtime is a local host', async () => {
    const app = await buildApp({ config: { ...baseConfig, environment: 'local' } });

    const reference = await app.inject('/docs/');
    expect(reference.statusCode).toBe(200);
    expect(reference.headers['content-type']).toContain('text/html');
    // The viewer is self-hosted: no third-party CDN script and no Scalar domain anywhere in the
    // page (telemetry and default fonts are off; the proxy is never configured).
    expect(reference.body).toContain('js/scalar.js');
    expect(reference.body).not.toContain('https://cdn');
    expect(reference.body).not.toMatch(/scalar\.com/);

    // The page will fetch exactly this spec, from its own origin.
    expect(reference.body).toContain('/docs/openapi.json');
    expect(reference.body).toContain('"telemetry": false');
    expect(reference.body).toContain('"withDefaultFonts": false');

    // The narrow CSP is what makes the page actually render: the inline initializer needs the
    // nonce, and the spec fetch needs connect-src 'self'. Both are asserted, not assumed.
    const csp = String(reference.headers['content-security-policy']);
    const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce, `nonce missing from CSP: ${csp}`).toBeDefined();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(reference.body).toContain(`nonce="${nonce}"`);
    expect(reference.body).toContain(`<meta property="csp-nonce" content="${nonce}" />`);

    const redirect = await app.inject('/docs');
    expect(redirect.statusCode).toBe(301);

    const document = await app.inject('/docs/openapi.json');
    expect(document.statusCode).toBe(200);
    expect(document.json()).toEqual(buildOpenApiDocument());

    // The API's global CSP is untouched.
    const health = await app.inject('/health');
    const healthCsp = String(health.headers['content-security-policy']);
    expect(healthCsp).toContain("default-src 'none'");
    expect(healthCsp).not.toContain('nonce-');
    expect(healthCsp).not.toContain("connect-src 'self'");

    await app.close();
  });

  it('does not register /docs inside the local Docker Compose stack, which runs the pruned image', async () => {
    // `compose.yml` runs the production image (no devDependencies) with APP_ENV=local and
    // APP_CONTAINER_LOCAL=true; registering /docs there would crash the process at boot.
    const app = await buildApp({ config: { ...baseConfig, environment: 'local', containerLocal: true } });

    for (const url of ['/docs', '/docs/', '/docs/openapi.json']) {
      const response = await app.inject(url);
      expect(response.statusCode, url).toBe(404);
    }

    await app.close();
  });

  it('does not register /docs in production', async () => {
    const app = await buildApp({ config: { ...baseConfig, environment: 'production' } });

    for (const url of ['/docs', '/docs/', '/docs/openapi.json']) {
      const response = await app.inject(url);
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }

    await app.close();
  });
});
