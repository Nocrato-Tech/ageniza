import { createServer } from 'node:http';

const held = new Set();
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://api');
  if (url.pathname === '/__test/pending') {
    response.end(JSON.stringify({ count: held.size }));
    return;
  }
  if (url.pathname === '/__test/release') {
    for (const pending of held) pending.end('{}');
    held.clear();
    response.end('{}');
    return;
  }
  let bytes = 0;
  request.on('data', (chunk) => { bytes += chunk.length; });
  request.on('end', () => {
    if (url.searchParams.has('hold')) {
      held.add(response);
      response.on('close', () => held.delete(response));
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ path: url.pathname, bytes, connection: request.headers.connection ?? null, forwardedProto: request.headers['x-forwarded-proto'], forwardedFor: request.headers['x-forwarded-for'], requestId: request.headers['x-request-id'] }));
  });
});
server.listen(3001, '0.0.0.0');
