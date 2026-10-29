import {
  createIntegrationModel,
  dropIntegrationDatabases,
  resolveIntegrationDatabaseUrls,
  type IntegrationModel
} from '@ageniza/database';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    integrationModel: IntegrationModel;
  }
}

/** Once per run: a migrated model database that every test file clones (issue #792). */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const model = await createIntegrationModel(resolveIntegrationDatabaseUrls());
  project.provide('integrationModel', model);
  return () => dropIntegrationDatabases(model);
}
