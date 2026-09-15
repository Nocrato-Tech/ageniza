import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok' }));

const start = async (): Promise<void> => {
  await app.listen({ host: '0.0.0.0', port: 3001 });
};

if (process.env.NODE_ENV !== 'test') {
  void start();
}
