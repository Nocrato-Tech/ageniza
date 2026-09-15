import Fastify from 'fastify';
import { createLogger, resolveRequestId, withLogContext } from '@ageniza/core';

const logger = createLogger();
const app = Fastify({ logger });

app.get('/health', async (request) => {
  const requestId = resolveRequestId(request.headers['x-request-id']);
  withLogContext(logger, { requestId, module: 'http', action: 'health' }).debug('Health check requested');
  return { status: 'ok' };
});

const start = async (): Promise<void> => {
  await app.listen({ host: '0.0.0.0', port: 3001 });
};

if (process.env.NODE_ENV !== 'test') {
  void start();
}
