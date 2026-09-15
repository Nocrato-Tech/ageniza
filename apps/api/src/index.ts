import { isTestProcess } from '@ageniza/config/server';

import { startApi } from './server.js';

if (!isTestProcess(process.env)) {
  void startApi().catch(() => { process.exitCode = 1; });
}
