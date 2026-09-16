# Observability baseline

API and worker emit Pino JSON logs. Every process log has `environment`, `service`, and `deployVersion`; API request completion logs also contain `requestId`, `correlationId`, `route`/`operation`, `statusCode`, and `durationMs`. Send `x-request-id` and, for a cross-step flow, `x-correlation-id`; API validates and returns both headers.

Use `debug` for local diagnosis, `info` for normal state transitions and request/probe completion, `warn` for handled degradation, and `error` for unexpected failures. Never add passwords, tokens, Authorization, cookies, service-role credentials, DSNs, secrets, request bodies, uploads, or business-sensitive payloads to a log context. The shared logger redacts common credential fields, but callers must still log minimal, named technical fields rather than payloads.

`/health` is liveness and `/ready` proves readiness/dependency availability; probe results are logged with latency and status, providing the MVP availability/error/latency evidence without a metrics platform. `APP_VERSION` identifies the deployed release in logs and Sentry.

Sentry initializes only in production when its DSN is configured, never in test, and does not enable tracing/APM or default PII. `SENTRY_DSN` is server-only; `VITE_SENTRY_DSN` may contain only Sentry's public browser DSN, never an auth token or `service_role` value.

Technical logs record runtime behavior. Future domain `AuditLog` work must be a typed API/domain boundary with explicit actor, action, target, and retention requirements approved by product/security; it is not a substitute for technical logs and this baseline intentionally creates no business audit actions or database schema.
