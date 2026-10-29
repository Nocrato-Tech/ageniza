import { cloneIntegrationDatabase } from '@ageniza/database';
import { afterAll, inject } from 'vitest';

// Runs before each test file's own imports, so the harness resolves the clone, never the shared database.
const clone = await cloneIntegrationDatabase(inject('integrationModel'));
process.env.DATABASE_URL = clone.applicationUrl;
process.env.MIGRATION_DATABASE_URL = clone.ownerUrl;

afterAll(() => clone.drop());
