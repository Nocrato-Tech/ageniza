import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  resolveIntegrationDatabaseUrls,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../../src/index.js';

export const GIB = 1_073_741_824;

export interface SeedOptions {
  readonly extraClients?: number;
  readonly extraGib?: number;
  readonly startedDaysAgo?: number;
  readonly endsInDays?: number;
  readonly provider?: 'simulado' | 'asaas';
}

export interface Request {
  readonly charge_id: string | null;
  readonly effect: string;
  readonly monthly_cents: number;
  readonly amount_cents: number;
  readonly effective_at: Date;
}

export interface Harness {
  setup(): Promise<void>;
  teardown(): Promise<void>;
  owner(): Knex;
  asUser<TResult>(userId: string, work: (transaction: Knex.Transaction) => Promise<TResult>): Promise<TResult>;
  /** A transaction with nobody bound: the provider's webhook and the worker. */
  asNobody<TResult>(work: (transaction: Knex.Transaction) => Promise<TResult>): Promise<TResult>;
  openTransactionAs(userId: string, isolationLevel?: 'read committed' | 'repeatable read' | 'serializable'): Promise<Knex.Transaction>;
  openTransactionAsNobody(isolationLevel?: 'read committed' | 'repeatable read' | 'serializable'): Promise<Knex.Transaction>;
  person(): Promise<string>;
  /** An agency in trial created by the product's own function, its Owner by possession and Admin by membership. */
  trialAgency(): Promise<{ agencyId: string; ownerId: string }>;
  withRole(agencyId: string, roleKey: 'admin' | 'manager', userId?: string): Promise<string>;
  withPermissions(agencyId: string, ...permissions: string[]): Promise<string>;
  request(userId: string, agencyId: string, plan: string, extraClients?: number, extraGib?: number): Promise<Request>;
  confirm(chargeId: string, ref: string, cents: number, provider?: string): Promise<boolean>;
  /** Request and confirm: the Owner's subscription as the simulated provider would approve it. */
  subscribe(userId: string, agencyId: string, plan: string, extraClients?: number, extraGib?: number): Promise<Request>;
  /** A subscription as the schema owner would write it: the plan, the extras, and a period around the database clock. */
  seedSubscription(agencyId: string, plan: string, options?: SeedOptions): Promise<void>;
  /** A charge row as the schema owner would write it, to see how the application role reads it. */
  seedCharge(agencyId: string, requestedBy: string, status: 'pending' | 'confirmed' | 'expired'): Promise<string>;
  insertClient(userId: string, agencyId: string): Promise<string>;
  /** Moves the period by the database clock. */
  setPeriod(agencyId: string, startedDaysAgo: number, endsInDays: number): Promise<void>;
  /** Ends the period `endedSecondsAgo` seconds ago, a month after it started, by the database clock. */
  endPeriod(agencyId: string, endedSecondsAgo: number): Promise<void>;
  subscriptionOf(agencyId: string): Promise<Record<string, unknown> | undefined>;
  quotaOf(agencyId: string): Promise<string | undefined>;
  /** A confirmed upload of the agency, written as the schema owner, in `on` when the write has to stay uncommitted. */
  seedConfirmedBytes(agencyId: string, bytes: number, on?: Knex): Promise<void>;
  acceptsWrites(agencyId: string): Promise<boolean>;
}

export const createHarness = (label: string): Harness => {
  const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();
  let ownerClient: DatabaseClient | undefined;
  let applicationClient: DatabaseClient | undefined;
  const users: string[] = [];
  const agencies: string[] = [];
  const roles: string[] = [];

  const ownerKnex = (): Knex => {
    if (ownerClient === undefined) throw new Error('Owner client was not initialised.');
    return ownerClient.knex;
  };
  const application = (): DatabaseClient => {
    if (applicationClient === undefined) throw new Error('Application client was not initialised.');
    return applicationClient;
  };

  const asUser: Harness['asUser'] = (userId, work) =>
    withAuthenticatedUserTransaction(application(), createVerifiedUserClaims({ userId }), work);
  const asNobody: Harness['asNobody'] = (work) => application().knex.transaction(work);
  const openTransactionAs: Harness['openTransactionAs'] = async (userId, isolationLevel) => {
    const transaction = await application().knex.transaction(isolationLevel === undefined ? {} : { isolationLevel });
    await transaction.raw('select app_private.bind_actor(?::uuid)', [userId]);
    return transaction;
  };

  const openTransactionAsNobody: Harness['openTransactionAsNobody'] = (isolationLevel) =>
    application().knex.transaction(isolationLevel === undefined ? {} : { isolationLevel });

  const person: Harness['person'] = async () => {
    const id = randomUUID();
    users.push(id);
    await ownerKnex()('auth.user').insert({ id, name: `Pessoa ${id.slice(0, 8)}`, email: `${id}@${label}.test`, emailVerified: true });
    return id;
  };

  const presetRole = async (key: string): Promise<string> =>
    (await ownerKnex()('roles').whereNull('agency_id').where({ key }).first('id')).id as string;

  const trialAgency: Harness['trialAgency'] = async () => {
    const ownerId = await person();
    const agencyId = await asUser(ownerId, async (transaction) => {
      const { rows } = await transaction.raw<{ rows: Array<{ id: string }> }>('select app_private.create_trial_agency(?) as id', [`Agência ${randomUUID().slice(0, 8)}`]);
      return rows[0]!.id;
    });
    agencies.push(agencyId);
    return { agencyId, ownerId };
  };

  const withRole: Harness['withRole'] = async (agencyId, roleKey, userId) => {
    const id = userId ?? await person();
    await ownerKnex()('agency_memberships').insert({ agency_id: agencyId, user_id: id, role_id: await presetRole(roleKey) });
    return id;
  };

  const withPermissions: Harness['withPermissions'] = async (agencyId, ...permissions) => {
    const id = await person();
    const roleId = randomUUID();
    roles.push(roleId);
    await ownerKnex().transaction(async (transaction) => {
      await transaction('roles').insert({ id: roleId, agency_id: agencyId, key: `custom-${roleId.slice(0, 8)}`, name: `Só ${permissions.join(' e ')}`, is_system: false });
      await transaction('role_permissions').insert(permissions.map((permission) => ({ role_id: roleId, permission_key: permission })));
      await transaction('agency_memberships').insert({ agency_id: agencyId, user_id: id, role_id: roleId });
    });
    return id;
  };

  const request: Harness['request'] = (userId, agencyId, plan, extraClients = 0, extraGib = 0) =>
    asUser(userId, async (transaction) => {
      const { rows } = await transaction.raw<{ rows: Request[] }>(
        'select * from app_private.request_subscription_change(?::uuid, ?, ?::integer, ?::integer)', [agencyId, plan, extraClients, extraGib]
      );
      return rows[0]!;
    });

  const confirm: Harness['confirm'] = (chargeId, ref, cents, provider = 'simulado') =>
    asNobody(async (transaction) => {
      const { rows } = await transaction.raw<{ rows: Array<{ confirmed: boolean }> }>(
        'select app_private.confirm_subscription_charge(?::uuid, ?, ?, ?::integer) as confirmed', [chargeId, provider, ref, cents]
      );
      return rows[0]!.confirmed;
    });

  const subscribe: Harness['subscribe'] = async (userId, agencyId, plan, extraClients = 0, extraGib = 0) => {
    const requested = await request(userId, agencyId, plan, extraClients, extraGib);
    await confirm(requested.charge_id!, `ref-${randomUUID()}`, requested.amount_cents);
    return requested;
  };

  const seedSubscription: Harness['seedSubscription'] = async (agencyId, plan, options = {}) => {
    const { extraClients = 0, extraGib = 0, startedDaysAgo = 1, endsInDays = 29, provider = 'simulado' } = options;
    await ownerKnex().transaction(async (transaction) => {
      await transaction.raw(
        `insert into public.agency_subscriptions (agency_id, plan_key, extra_clients, extra_storage_gib, provider, current_period_start, current_period_end)
         values (?, ?, ?::integer, ?::integer, ?, now() - make_interval(days => ?::int), now() + make_interval(days => ?::int))
         on conflict (agency_id) do update set plan_key = excluded.plan_key, extra_clients = excluded.extra_clients, extra_storage_gib = excluded.extra_storage_gib,
           provider = excluded.provider, current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end`,
        [agencyId, plan, extraClients, extraGib, provider, startedDaysAgo, endsInDays]
      );
      await transaction.raw('select app_private.apply_subscription_terms(?::uuid, ?, ?::integer, ?::integer)', [agencyId, plan, extraClients, extraGib]);
    });
  };

  const seedCharge: Harness['seedCharge'] = async (agencyId, requestedBy, status) => {
    const [row] = await ownerKnex()('subscription_charges').insert({
      agency_id: agencyId, kind: 'subscribe', status, plan_key: 'essencial', extra_clients: 0, extra_storage_gib: 0, amount_cents: 9700,
      requested_by_user_id: requestedBy, provider: status === 'confirmed' ? 'simulado' : null, provider_ref: status === 'confirmed' ? `ref-${randomUUID()}` : null,
      expires_at: new Date(Date.now() + 1_800_000), period_start: status === 'confirmed' ? new Date() : null, period_end: status === 'confirmed' ? new Date(Date.now() + 86_400_000) : null,
      confirmed_at: status === 'confirmed' ? new Date() : null
    }).returning('id');
    return row.id as string;
  };

  const insertClient: Harness['insertClient'] = (userId, agencyId) =>
    asUser(userId, async (transaction) => {
      const [row] = await transaction('clients').insert({ agency_id: agencyId, name: `Cliente ${randomUUID().slice(0, 8)}` }).returning('id');
      return row.id as string;
    });

  const setPeriod: Harness['setPeriod'] = async (agencyId, startedDaysAgo, endsInDays) => {
    await ownerKnex().raw(
      "update public.agency_subscriptions set current_period_start = now() - make_interval(days => ?::int), current_period_end = now() + make_interval(days => ?::int) where agency_id = ?",
      [startedDaysAgo, endsInDays, agencyId]
    );
  };

  const endPeriod: Harness['endPeriod'] = async (agencyId, endedSecondsAgo) => {
    await ownerKnex().raw(
      "update public.agency_subscriptions set current_period_end = now() - make_interval(secs => ?::int), current_period_start = now() - make_interval(secs => ?::int) - interval '1 month' where agency_id = ?",
      [endedSecondsAgo, endedSecondsAgo, agencyId]
    );
  };

  const subscriptionOf: Harness['subscriptionOf'] = async (agencyId) =>
    await ownerKnex()('agency_subscriptions').where({ agency_id: agencyId }).first() as Record<string, unknown> | undefined;

  const quotaOf: Harness['quotaOf'] = async (agencyId) =>
    (await ownerKnex()('agency_storage_quotas').where({ agency_id: agencyId }).first('quota_bytes'))?.quota_bytes as string | undefined;

  const seedConfirmedBytes: Harness['seedConfirmedBytes'] = async (agencyId, bytes, on) => {
    const db = on ?? ownerKnex();
    const id = randomUUID();
    const clientId = (await db('clients').where({ agency_id: agencyId }).first('id'))?.id as string | undefined;
    const client = clientId ?? (await db('clients').insert({ agency_id: agencyId, name: 'Cliente de mídia' }).returning('id'))[0].id as string;
    const folder = await db('media_folders').where({ client_id: client, is_default: true }).first('id');
    await db('media_assets').insert({
      id, agency_id: agencyId, client_id: client, folder_id: folder.id, category: 'video', declared_content_type: 'video/mp4', extension: 'mp4',
      object_key: `${agencyId}/${id}/original.mp4`, upload_object_key: `staging/${agencyId}/${id}/upload.mp4`, declared_size_bytes: bytes,
      created_by_user_id: (await db('agencies').where({ id: agencyId }).first('owner_user_id')).owner_user_id as string,
      status: 'confirmed', confirmed_size_bytes: bytes, confirmed_content_type: 'video/mp4', confirmed_at: new Date()
    });
  };

  const acceptsWrites: Harness['acceptsWrites'] = async (agencyId) =>
    (await ownerKnex().raw<{ rows: Array<{ accepts: boolean }> }>('select app_private.agency_accepts_writes(?::uuid) as accepts', [agencyId])).rows[0]!.accepts;

  return {
    async setup() {
      ownerClient = createLocalTestDatabaseClient(ownerUrl);
      applicationClient = createLocalTestDatabaseClient(applicationUrl);
    },
    async teardown() {
      const knex = ownerKnex();
      if (agencies.length > 0) {
        const clientIds = (await knex('clients').whereIn('agency_id', agencies).select('id')).map((row) => row.id as string);
        await knex('media_assets').whereIn('agency_id', agencies).delete();
        await knex('media_folders').whereIn('client_id', clientIds).delete();
        await knex('clients').whereIn('id', clientIds).delete();
        await knex('subscription_renewal_refunds').whereIn('agency_id', agencies).delete();
        await knex('subscription_charges').whereIn('agency_id', agencies).delete();
        await knex('agency_subscriptions').whereIn('agency_id', agencies).delete();
        await knex('agency_storage_quotas').whereIn('agency_id', agencies).delete();
        await knex('invitations').whereIn('agency_id', agencies).delete();
        await knex('agency_memberships').whereIn('agency_id', agencies).delete();
        await knex('role_permissions').whereIn('role_id', roles).delete();
        await knex('roles').whereIn('id', roles).delete();
        await knex.raw('delete from audit.events where agency_id = any(?::uuid[])', [agencies]);
        await knex('agencies').whereIn('id', agencies).update({ owner_user_id: null });
        await knex('agencies').whereIn('id', agencies).delete();
      }
      await knex('legal_acceptances').whereIn('user_id', users).delete();
      await knex('auth.user').whereIn('id', users).delete();
      await application().close();
      await ownerClient?.close();
    },
    owner: ownerKnex,
    asUser,
    asNobody,
    openTransactionAs,
    openTransactionAsNobody,
    person,
    trialAgency,
    withRole,
    withPermissions,
    request,
    confirm,
    subscribe,
    seedSubscription,
    seedCharge,
    insertClient,
    setPeriod,
    endPeriod,
    subscriptionOf,
    quotaOf,
    seedConfirmedBytes,
    acceptsWrites
  };
};
