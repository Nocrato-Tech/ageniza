import { cloneIntegrationDatabase, watchConnections } from '@ageniza/database';
import { afterAll, inject } from 'vitest';

// Four files at once share the server's 97 connections for non-superusers (`max_connections=100`, three reserved):
// a file may hold a fifth of them, and one that holds more fails by itself instead of refusing the others with 53300.
const FILE_CONNECTION_BUDGET = 20;

// Runs before each test file's own imports, so the harness resolves the clone, never the shared database.
const model = inject('integrationModel');
const clone = await cloneIntegrationDatabase(model);
const connections = await watchConnections(model, clone);
process.env.DATABASE_URL = clone.applicationUrl;
process.env.MIGRATION_DATABASE_URL = clone.ownerUrl;

afterAll(async () => {
  const { peak } = await connections.stop();
  await clone.drop();
  if (peak > FILE_CONNECTION_BUDGET) {
    throw new Error(`This file held ${peak} connections at once; its share of the server is ${FILE_CONNECTION_BUDGET}. Close apps and pools it no longer uses (docs/local-environment.md).`);
  }
});
