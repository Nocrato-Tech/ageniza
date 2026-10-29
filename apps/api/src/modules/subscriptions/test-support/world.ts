import { randomUUID } from 'node:crypto';

import type { DatabaseClient } from '@ageniza/database';
import type { LightMyRequestResponse } from 'fastify';

import { insertTestUser, ownerClient, TEST_APP_PUBLIC_URL, type TestApp, type TestUserFixture } from '../../auth/test-support/harness.js';

type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

const origin = { origin: TEST_APP_PUBLIC_URL };

/** A statement of billing: every function it calls carries one of these words, the clock of the simulated provider included. */
export const BILLING_STATEMENT = /subscription|simulated_period/i;

/** The statements one transaction ran, in order. */
export interface RecordedTransaction {
  readonly statements: string[];
}

/** Records, per transaction, the statements a module sends through the application client. */
export const createRecorder = () => {
  const transactions: RecordedTransaction[] = [];
  const recordingTransaction = (transaction: Transaction, entry: RecordedTransaction): Transaction => new Proxy(transaction, {
    get(target, property, receiver) {
      if (property === 'raw') {
        return (statement: string, bindings?: Parameters<Transaction['raw']>[1]) => {
          entry.statements.push(statement);
          return target.raw(statement, bindings ?? []);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
  const wrap = (database: DatabaseClient): DatabaseClient => new Proxy(database, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return (work: (transaction: Transaction) => Promise<unknown>) => target.transaction((transaction) => {
          const entry: RecordedTransaction = { statements: [] };
          transactions.push(entry);
          return work(recordingTransaction(transaction, entry));
        });
      }
      if (property === 'knex') return target.knex;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
  return {
    wrap,
    reset: (): void => { transactions.length = 0; },
    /** The transactions that ran a statement matching `pattern`. */
    running: (pattern: RegExp): RecordedTransaction[] => transactions.filter((entry) => entry.statements.some((statement) => pattern.test(statement))),
    /** Every statement of the recorded transactions that touches billing, whichever transaction ran it. */
    billingStatements: (): string[] => transactions.flatMap((entry) => entry.statements).filter((statement) => BILLING_STATEMENT.test(statement))
  };
};

export interface Person {
  readonly user: TestUserFixture;
  readonly cookie: string;
}

export interface World {
  readonly owner: ReturnType<typeof ownerClient>;
  person(label: string): Promise<Person>;
  /** An agency in trial, created by `who` through the product's own route (one trial per account). */
  agency(who: Person): Promise<string>;
  /** An agency of no plan (exempt), owned by `ownerUserId`, for a person who already has a trial. */
  plainAgency(ownerUserId: string): Promise<string>;
  withRole(agencyId: string, userId: string, roleKey: 'admin' | 'manager'): Promise<void>;
  /** A custom role of the agency that holds exactly `permissions`, given to `userId`. */
  withPermissions(agencyId: string, userId: string, ...permissions: string[]): Promise<void>;
  /** `count` active clients, written as the schema owner. */
  clients(agencyId: string, count: number): Promise<void>;
  /** Removes the clients and the uploads of the agency. */
  clearUsage(agencyId: string): Promise<void>;
  /** A confirmed upload of `bytes`, written as the schema owner. */
  usedBytes(agencyId: string, bytes: number): Promise<void>;
  /** Ends the paid period `endedSecondsAgo` seconds ago (negative: that long from now), by the database clock. */
  endPeriod(agencyId: string, endedSecondsAgo: number): Promise<void>;
  subscriptionOf(agencyId: string): Promise<Record<string, unknown> | undefined>;
  chargesOf(agencyId: string): Promise<Array<Record<string, unknown>>>;
  call(person: Person | undefined, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>): Promise<LightMyRequestResponse>;
  teardown(): Promise<void>;
}

export const createWorld = (getApp: () => TestApp): World => {
  const owner = ownerClient();
  const users: string[] = [];
  const agencies: string[] = [];
  const roles: string[] = [];

  const person: World['person'] = async (label) => {
    const app = getApp();
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: label });
    users.push(user.id);
    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
    if (response.statusCode !== 200) throw new Error(`The test account could not sign in: ${response.statusCode}.`);
    return { user, cookie: response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') };
  };

  const agency: World['agency'] = async (who) => {
    const response = await getApp().app.inject({ method: 'POST', url: '/agencies', headers: { ...origin, cookie: who.cookie }, payload: { name: `Agência ${randomUUID().slice(0, 8)}` } });
    if (response.statusCode !== 201) throw new Error(`The test agency could not be created: ${response.statusCode}.`);
    const id = response.json<{ context: { agencyId: string } }>().context.agencyId;
    agencies.push(id);
    return id;
  };

  const plainAgency: World['plainAgency'] = async (ownerUserId) => {
    const id = randomUUID();
    agencies.push(id);
    await owner.knex('agencies').insert({ id, name: `Agência ${id.slice(0, 8)}`, owner_user_id: ownerUserId });
    return id;
  };

  const presetRole = async (key: string): Promise<string> => {
    const row = await owner.knex('roles').where({ key }).whereNull('agency_id').first('id');
    if (row === undefined) throw new Error(`The preset role ${key} is missing.`);
    return row.id as string;
  };

  const withRole: World['withRole'] = async (agencyId, userId, roleKey) => {
    await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: await presetRole(roleKey) });
  };

  const withPermissions: World['withPermissions'] = async (agencyId, userId, ...permissions) => {
    const roleId = randomUUID();
    roles.push(roleId);
    await owner.knex('roles').insert({ id: roleId, agency_id: agencyId, key: `custom-${roleId.slice(0, 8)}`, name: `Só ${permissions.join(' e ')}`, is_system: false });
    await owner.knex('role_permissions').insert(permissions.map((permission_key) => ({ role_id: roleId, permission_key })));
    await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: roleId });
  };

  const clients: World['clients'] = async (agencyId, count) => {
    await owner.knex('clients').insert(Array.from({ length: count }, () => ({ agency_id: agencyId, name: `Cliente ${randomUUID().slice(0, 8)}` })));
  };

  const clearUsage: World['clearUsage'] = async (agencyId) => {
    await owner.knex('media_assets').where({ agency_id: agencyId }).delete();
    await owner.knex('media_folders').whereIn('client_id', owner.knex('clients').where({ agency_id: agencyId }).select('id')).delete();
    await owner.knex('clients').where({ agency_id: agencyId }).delete();
  };

  const usedBytes: World['usedBytes'] = async (agencyId, bytes) => {
    const id = randomUUID();
    const clientId = (await owner.knex('clients').where({ agency_id: agencyId }).first('id'))?.id as string | undefined
      ?? (await owner.knex('clients').insert({ agency_id: agencyId, name: 'Cliente de mídia' }).returning('id'))[0].id as string;
    const folder = await owner.knex('media_folders').where({ client_id: clientId, is_default: true }).first('id');
    await owner.knex('media_assets').insert({
      id, agency_id: agencyId, client_id: clientId, folder_id: folder.id, category: 'video', declared_content_type: 'video/mp4', extension: 'mp4',
      object_key: `${agencyId}/${id}/original.mp4`, upload_object_key: `staging/${agencyId}/${id}/upload.mp4`, declared_size_bytes: bytes,
      created_by_user_id: (await owner.knex('agencies').where({ id: agencyId }).first('owner_user_id')).owner_user_id as string,
      status: 'confirmed', confirmed_size_bytes: bytes, confirmed_content_type: 'video/mp4', confirmed_at: new Date()
    });
  };

  const endPeriod: World['endPeriod'] = async (agencyId, endedSecondsAgo) => {
    await owner.knex.raw(
      `update public.agency_subscriptions
       set current_period_end = now() - make_interval(secs => ?::int),
           current_period_start = now() - make_interval(secs => ?::int) - interval '1 month'
       where agency_id = ?`, [endedSecondsAgo, endedSecondsAgo, agencyId]);
  };

  const subscriptionOf: World['subscriptionOf'] = async (agencyId) =>
    (await owner.knex('agency_subscriptions').where({ agency_id: agencyId }).first()) as Record<string, unknown> | undefined;

  const chargesOf: World['chargesOf'] = async (agencyId) =>
    (await owner.knex('subscription_charges').where({ agency_id: agencyId }).orderBy('created_at')) as Array<Record<string, unknown>>;

  const call: World['call'] = (who, method, url, payload) => {
    const headers = who === undefined ? origin : { ...origin, cookie: who.cookie };
    return payload === undefined
      ? getApp().app.inject({ method, url, headers })
      : getApp().app.inject({ method, url, headers, payload });
  };

  const teardown: World['teardown'] = async () => {
    await owner.knex('subscription_charges').whereIn('agency_id', agencies).delete();
    await owner.knex('media_assets').whereIn('agency_id', agencies).delete();
    await owner.knex('media_folders').whereIn('client_id', owner.knex('clients').whereIn('agency_id', agencies).select('id')).delete();
    await owner.knex('clients').whereIn('agency_id', agencies).delete();
    await owner.knex('agency_subscriptions').whereIn('agency_id', agencies).delete();
    await owner.knex('agency_storage_quotas').whereIn('agency_id', agencies).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencies).delete();
    await owner.knex('role_permissions').whereIn('role_id', roles).delete();
    await owner.knex('roles').whereIn('id', roles).delete();
    await owner.knex.raw('delete from audit.events where agency_id = any(?::uuid[])', [agencies]);
    await owner.knex('agencies').whereIn('id', agencies).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencies).delete();
    await getApp().pool.query('delete from auth."user" where id = any($1::uuid[])', [users]);
    await owner.close();
  };

  return { owner, person, agency, plainAgency, withRole, withPermissions, clients, clearUsage, usedBytes, endPeriod, subscriptionOf, chargesOf, call, teardown };
};
