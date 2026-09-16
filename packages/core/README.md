# @ageniza/core

Small, domain-free backend infrastructure shared by API processes, workers, and future adapters. It deliberately has no Fastify, database, queue, or React dependency.

## Usage

```ts
import {
  HttpError,
  createLogger,
  createReadiness,
  createRequestId,
  errorResponse,
  retry,
  withLogContext
} from '@ageniza/core';

const logger = withLogContext(createLogger(), {
  requestId: createRequestId(),
  module: 'billing',
  action: 'charge'
});

const readiness = createReadiness(false);
await retry(() => connectToService(), { maxAttempts: 4, baseDelayMs: 100 });
readiness.setReady(true);

throw new HttpError({ statusCode: 404, code: 'RESOURCE_NOT_FOUND', message: 'Resource not found' });
// An HTTP adapter can turn a caught error into: errorResponse(error)
```

`createLogger` returns a Pino logger with mandatory baseline redaction for passwords, authorization headers, cookies, tokens, and database connection strings. Custom redaction paths are additive. Use `withLogContext` at boundaries to attach `requestId`, `userId`, `agencyId`, `module`, and `action`. `resolveRequestId` preserves a supplied safe request/correlation ID, while generating one when absent or malformed.

`HttpError` and `OperationalError` expose stable codes, and `serializeError` intentionally omits stacks and unexpected error messages. `httpResponse`, `ok`, `created`, `noContent`, and `errorResponse` return plain values so Fastify or another adapter remains responsible for writing the response.

`retry` has bounded exponential backoff and accepts `sleep`, `shouldRetry`, and `onRetry` dependencies. `createShutdownManager` registers named LIFO cleanup handlers; `registerShutdownSignals` attaches only `SIGINT` and `SIGTERM` by default and returns an unsubscribe function. `checkHealth` runs named dependency checks, while `createReadiness` keeps explicit process-ready state.

## Anti-patterns

- Do not put tenant, authorization, persistence, API-route, or other domain rules in this package.
- Do not pass a `service_role` credential, secrets, or full request objects into log context or error details.
- Do not couple response helpers to Fastify reply objects; adapt the returned `HttpResponse` at the edge.
- Do not retry non-idempotent operations blindly. Supply `shouldRetry` when an operation needs error-specific retry policy.
- Do not call `process.exit()` inside a shutdown handler; let the process entrypoint decide exit policy after `run()` returns.
