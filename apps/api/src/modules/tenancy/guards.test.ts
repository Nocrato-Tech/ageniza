import { describe, expect, it } from 'vitest';

import type { DatabaseClient } from '@ageniza/database';
import { createVerifiedUserClaims } from '@ageniza/database';

import { createRequireAgencyAccess, requireAnyPermission, requirePermission } from './guards.js';

const userId = '11111111-1111-4111-8111-111111111111';
const agencyId = '22222222-2222-4222-8222-222222222222';

interface FakeRequest {
  params: Record<string, unknown>;
  auth?: {
    userId: string;
    claims: ReturnType<typeof createVerifiedUserClaims>;
  };
  tenant?: unknown;
}

const createDatabase = (rows: readonly Record<string, unknown>[], statements: string[]): DatabaseClient => ({
  knex: {} as DatabaseClient['knex'],
  pool: { min: 0, max: 1, idleTimeoutMillis: 1, acquireTimeoutMillis: 1 },
  close: async () => undefined,
  transaction: async (work) => work({
    raw: async (statement: string) => {
      statements.push(statement);
      if (statement.includes('set_config')) return { rows: [] };
      return { rows };
    }
  } as never)
});

describe('tenant guards', () => {
  it('loads active access under an authenticated transaction and attaches typed tenant context', async () => {
    const statements: string[] = [];
    const database = createDatabase([{
      agency_id: agencyId,
      is_owner: false,
      role_key: 'production',
      permissions: ['content.read', 'content.publish']
    }], statements);
    const request: FakeRequest = {
      params: { agencyId },
      auth: { userId, claims: createVerifiedUserClaims({ userId }) }
    };

    await createRequireAgencyAccess({ database })(request as never);

    expect(request.tenant).toEqual({
      agencyId,
      isOwner: false,
      roleKey: 'production',
      permissions: new Set(['content.read', 'content.publish'])
    });
    expect(statements[0]).toContain("set_config('app.user_id'");
    expect(statements[1]).toContain('agency_memberships');
  });

  it('returns a non-enumerating 404 when the agency is inaccessible or suspended', async () => {
    const database = createDatabase([], []);
    const request: FakeRequest = {
      params: { agencyId },
      auth: { userId, claims: createVerifiedUserClaims({ userId }) }
    };

    await expect(createRequireAgencyAccess({ database })(request as never)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND'
    });
  });

  it('rejects malformed agency ids before opening a database transaction', async () => {
    let transactions = 0;
    const database = createDatabase([], []);
    const original = database.transaction;
    database.transaction = async (work) => {
      transactions += 1;
      return original(work);
    };
    const request: FakeRequest = {
      params: { agencyId: 'not-a-uuid' },
      auth: { userId, claims: createVerifiedUserClaims({ userId }) }
    };

    await expect(createRequireAgencyAccess({ database })(request as never)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR'
    });
    expect(transactions).toBe(0);
  });

  it('allows owners to pass every permission check and denies missing member permissions', async () => {
    const request = {
      tenant: { agencyId, isOwner: true, roleKey: 'admin', permissions: new Set<string>() }
    };
    await expect(requirePermission('anything')(request as never)).resolves.toBeUndefined();

    const memberRequest = {
      tenant: { agencyId, isOwner: false, roleKey: 'production', permissions: new Set<string>() }
    };
    await expect(requirePermission('anything')(memberRequest as never)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN'
    });
  });

  it('requires any one of the listed permissions, and keeps the owner pass by ownership', async () => {
    for (const permissions of [new Set(['colaborador.convidar']), new Set(['colaborador.alterar_papel'])]) {
      const request = { tenant: { agencyId, isOwner: false, roleKey: 'custom', permissions } };
      await expect(requireAnyPermission(['colaborador.convidar', 'colaborador.alterar_papel'])(request as never)).resolves.toBeUndefined();
    }
    const none = { tenant: { agencyId, isOwner: false, roleKey: 'custom', permissions: new Set<string>(['colaborador.visualizar']) } };
    await expect(requireAnyPermission(['colaborador.convidar', 'colaborador.alterar_papel'])(none as never)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN'
    });
    const owner = { tenant: { agencyId, isOwner: true, roleKey: 'admin', permissions: new Set<string>() } };
    await expect(requireAnyPermission(['colaborador.convidar', 'colaborador.alterar_papel'])(owner as never)).resolves.toBeUndefined();
  });
});
