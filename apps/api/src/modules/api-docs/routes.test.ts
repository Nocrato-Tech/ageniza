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
  it('serves /docs and the OpenAPI document when the runtime is local', async () => {
    const app = await buildApp({ config: { ...baseConfig, environment: 'local' } });

    const reference = await app.inject('/docs/');
    expect(reference.statusCode).toBe(200);
    expect(reference.headers['content-type']).toContain('text/html');
    // The viewer is self-hosted: no third-party CDN script.
    expect(reference.body).toContain('js/scalar.js');
    expect(reference.body).not.toContain('https://cdn');

    const redirect = await app.inject('/docs');
    expect(redirect.statusCode).toBe(301);

    const document = await app.inject('/docs/openapi.json');
    expect(document.statusCode).toBe(200);
    expect(document.json()).toEqual(buildOpenApiDocument());

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
