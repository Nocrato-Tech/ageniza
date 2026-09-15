import Fastify from 'fastify';
import { isTestProcess, loadApiConfig } from '@ageniza/config/server';
import { createLogger, resolveRequestId, withLogContext } from '@ageniza/core';

const logger = createLogger();
const app = Fastify({ logger });

app.get('/health', async (request) => {
  const requestId = resolveRequestId(request.headers['x-request-id']);
  withLogContext(logger, { requestId, module: 'http', action: 'health' }).debug('Health check requested');
  return { status: 'ok' };
});

const start = async (): Promise<void> => {
  const config = loadApiConfig(process.env);
  await app.listen({ host: '0.0.0.0', port: config.port });
};

if (!isTestProcess(process.env)) {
  void start();
}
