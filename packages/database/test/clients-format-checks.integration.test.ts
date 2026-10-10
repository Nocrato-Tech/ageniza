import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  resolveIntegrationDatabaseUrls,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #468 (database half): the format and size CHECKs of `clients`, `client_thread_comments` and
// `client_personas` (specs/clientes.md §3). Each case writes as `ageniza_app` through a person who
// is allowed to write the row, so the only thing that can refuse is the CHECK itself, named by
// `constraint`; the row is then read back through the owner and must be exactly what it was.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const agency = randomUUID();
const admin = randomUUID();
const client = randomUUID();
const otherClient = randomUUID();
const thread = randomUUID();
const persona = randomUUID();

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const asAdmin = <TResult>(work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
  withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId: admin }), work);

const BASELINE = {
  legal_name: 'Padaria Central Ltda',
  tax_id: '12345678000190',
  segment: 'Alimentação',
  website: 'https://padariacentral.example.test',
  instagram_handle: 'padaria.central',
  contact_name: 'Maria Souza',
  contact_phone: '+55 11 90000-0000',
  contact_email: 'maria@padariacentral.example.test'
};

const clientRow = (): Promise<Record<string, unknown>> => getOwner().knex('clients').where({ id: client }).first();
const personaRow = (): Promise<Record<string, unknown>> => getOwner().knex('client_personas').where({ id: persona }).first();
const commentCount = async (): Promise<number> =>
  Number((await getOwner().knex('client_thread_comments').where({ thread_id: thread }).count({ total: '*' }).first())?.total);
const personaCount = async (): Promise<number> =>
  Number((await getOwner().knex('client_personas').where({ client_id: otherClient }).count({ total: '*' }).first())?.total);

const repeat = (text: string, times: number): string => text.repeat(times);

const CHECK_VIOLATION = '23514';

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  const role = await getOwner().knex('roles').whereNull('agency_id').where({ key: 'admin' }).first('id');
  await getOwner().transaction(async (transaction) => {
    await transaction('auth.user').insert({ id: admin, name: `Admin ${admin}`, email: `${admin}@example.test`, emailVerified: true });
    await transaction('agencies').insert({ id: agency, name: `Format checks ${agency}` });
    await transaction('agency_memberships').insert({ agency_id: agency, user_id: admin, role_id: role!.id });
    await transaction('clients').insert([
      { id: client, agency_id: agency, name: `Format checks ${client}`, ...BASELINE },
      { id: otherClient, agency_id: agency, name: `Format checks other ${otherClient}` }
    ]);
    await transaction('client_threads').insert({ id: thread, client_id: client, section_key: 'branding', opened_by: admin, opened_side: 'agency' });
    await transaction('client_personas').insert({
      id: persona,
      client_id: client,
      name: 'Persona base',
      description: 'Descrição base',
      pains: 'Dores base',
      desires: 'Desejos base',
      objections: 'Objeções base',
      updated_by: admin
    });
  });
});

afterAll(async () => {
  try {
    await getOwner().transaction(async (transaction) => {
      const clients = [client, otherClient];
      await transaction('client_thread_comments').whereIn('client_id', clients).delete();
      await transaction('client_threads').whereIn('client_id', clients).delete();
      await transaction('client_personas').whereIn('client_id', clients).delete();
      await transaction('audit.events').where({ agency_id: agency }).delete();
      await transaction('agency_memberships').where({ agency_id: agency }).delete();
      await transaction('clients').whereIn('id', clients).delete();
      await transaction('agencies').where({ id: agency }).delete();
      await transaction('auth.user').where({ id: admin }).delete();
    });
  } finally {
    await getApplication().close();
    await getOwner().close();
  }
});

describe('CLIENTS format and size CHECKs, written as ageniza_app (#468)', () => {
  describe('clients', () => {
    const refusals: readonly { readonly label: string; readonly constraint: string; readonly values: Record<string, string> }[] = [
      { label: 'a 12-digit tax id', constraint: 'clients_tax_id_check', values: { tax_id: '123456789012' } },
      { label: 'a 10-digit tax id', constraint: 'clients_tax_id_check', values: { tax_id: '1234567890' } },
      { label: 'an 11-character tax id with a letter', constraint: 'clients_tax_id_check', values: { tax_id: '1234567890A' } },
      { label: 'a masked tax id', constraint: 'clients_tax_id_check', values: { tax_id: '12.345.678/0001-90' } },
      { label: 'an instagram handle with a space', constraint: 'clients_instagram_handle_check', values: { instagram_handle: 'padaria central' } },
      { label: 'an instagram handle with the leading @', constraint: 'clients_instagram_handle_check', values: { instagram_handle: '@padaria' } },
      { label: 'an instagram handle of 31 characters', constraint: 'clients_instagram_handle_check', values: { instagram_handle: repeat('a', 31) } },
      { label: 'an empty instagram handle', constraint: 'clients_instagram_handle_check', values: { instagram_handle: '' } },
      { label: 'an instagram handle with an exclamation mark', constraint: 'clients_instagram_handle_check', values: { instagram_handle: 'padaria!' } },
      { label: 'an instagram handle with a hyphen', constraint: 'clients_instagram_handle_check', values: { instagram_handle: 'padaria-central' } },
      { label: 'an instagram handle with an accented letter', constraint: 'clients_instagram_handle_check', values: { instagram_handle: 'padariaé' } },
      { label: 'a contact e-mail without @', constraint: 'clients_contact_email_check', values: { contact_email: 'maria.padaria.example.test' } },
      { label: 'a contact e-mail of 321 bytes', constraint: 'clients_contact_email_check', values: { contact_email: `${repeat('a', 314)}@x.test` } },
      { label: 'a name of 257 bytes', constraint: 'clients_name_length', values: { name: repeat('a', 257) } },
      { label: 'a name of 129 two-byte characters', constraint: 'clients_name_length', values: { name: repeat('é', 129) } },
      { label: 'a blank name', constraint: 'clients_name_length', values: { name: '   ' } },
      { label: 'a legal name of 257 bytes', constraint: 'clients_legal_name_check', values: { legal_name: repeat('a', 257) } },
      { label: 'a legal name of 129 two-byte characters', constraint: 'clients_legal_name_check', values: { legal_name: repeat('é', 129) } },
      { label: 'a segment of 121 bytes', constraint: 'clients_segment_check', values: { segment: repeat('a', 121) } },
      { label: 'a segment of 61 two-byte characters', constraint: 'clients_segment_check', values: { segment: repeat('é', 61) } },
      { label: 'a contact name of 257 bytes', constraint: 'clients_contact_name_check', values: { contact_name: repeat('a', 257) } },
      { label: 'a contact name of 129 two-byte characters', constraint: 'clients_contact_name_check', values: { contact_name: repeat('é', 129) } },
      { label: 'a contact phone of 33 bytes', constraint: 'clients_contact_phone_check', values: { contact_phone: repeat('1', 33) } },
      { label: 'a contact phone of 17 two-byte characters', constraint: 'clients_contact_phone_check', values: { contact_phone: repeat('é', 17) } },
      { label: 'a website without scheme', constraint: 'clients_website_check', values: { website: 'padaria.example.test' } },
      { label: 'a website of 2049 bytes', constraint: 'clients_website_check', values: { website: `https://${repeat('a', 2041)}` } }
    ];

    it('refuses each value with the CHECK that owns the column and leaves the row exactly as it was', async () => {
      const before = await clientRow();
      for (const { label, constraint, values } of refusals) {
        await expect(
          asAdmin((transaction) => transaction('clients').where({ id: client }).update({ ...values, updated_by: admin })),
          label
        ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint });
        await expect(clientRow(), label).resolves.toEqual(before);
      }
    });

    it('accepts each column exactly at its limit, in bytes and not in characters', async () => {
      const atTheLimit = {
        name: `${repeat('é', 120)} ${repeat('n', 15)}`,
        legal_name: repeat('é', 128),
        tax_id: '12345678901',
        segment: repeat('é', 60),
        website: `https://${repeat('a', 2040)}`,
        instagram_handle: repeat('a', 30),
        contact_name: repeat('é', 128),
        contact_phone: repeat('1', 32),
        contact_email: `${repeat('a', 313)}@x.test`
      };
      await asAdmin((transaction) => transaction('clients').where({ id: client }).update({ ...atTheLimit, updated_by: admin }));
      const row = await clientRow();
      expect(row).toMatchObject({ ...atTheLimit });
      expect(Buffer.byteLength(row.segment as string)).toBe(120);
      expect(Buffer.byteLength(row.contact_email as string)).toBe(320);
      expect(Buffer.byteLength(row.name as string)).toBe(256);

      await asAdmin((transaction) => transaction('clients').where({ id: client }).update({ ...BASELINE, name: `Format checks ${client}`, updated_by: admin }));
      await expect(clientRow()).resolves.toMatchObject({ ...BASELINE });
    });
  });

  describe('client_thread_comments', () => {
    const insertComment = (body: string): Promise<unknown> =>
      asAdmin((transaction) =>
        transaction('client_thread_comments').insert({
          id: randomUUID(), thread_id: thread, client_id: client, author_user_id: admin, author_side: 'agency', body
        })
      );

    it('refuses an empty, blank or over-5000-byte body with 23514 and writes nothing', async () => {
      const before = await commentCount();
      const refused: readonly [string, string][] = [
        ['an empty body', ''],
        ['a body of spaces', '    '],
        ['a body of 5001 bytes', repeat('a', 5001)],
        ['a body of 2501 two-byte characters', repeat('é', 2501)]
      ];
      for (const [label, body] of refused) {
        await expect(insertComment(body), label).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'client_thread_comments_body_check' });
        await expect(commentCount(), label).resolves.toBe(before);
      }

      await insertComment(repeat('a', 5000));
      await insertComment(repeat('é', 2500));
      await expect(commentCount()).resolves.toBe(before + 2);
    });
  });

  describe('client_personas', () => {
    const insertPersona = (values: Record<string, string>): Promise<unknown> =>
      asAdmin((transaction) => transaction('client_personas').insert({ id: randomUUID(), client_id: otherClient, name: 'Persona', updated_by: admin, ...values }));

    const textColumns = [
      { column: 'description', constraint: 'client_personas_description_check' },
      { column: 'pains', constraint: 'client_personas_pains_check' },
      { column: 'desires', constraint: 'client_personas_desires_check' },
      { column: 'objections', constraint: 'client_personas_objections_check' }
    ] as const;

    it('refuses an empty, blank or over-120-byte name on insert and on update, and writes nothing', async () => {
      const before = await personaCount();
      const baseline = await personaRow();
      const refused: readonly [string, string][] = [
        ['an empty name', ''],
        ['a blank name', '   '],
        ['a name of 121 bytes', repeat('a', 121)],
        ['a name of 61 two-byte characters', repeat('é', 61)]
      ];
      for (const [label, name] of refused) {
        await expect(insertPersona({ name }), `insert: ${label}`).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'client_personas_name_check' });
        await expect(personaCount(), `insert: ${label}`).resolves.toBe(before);
        await expect(
          asAdmin((transaction) => transaction('client_personas').where({ id: persona }).update({ name })),
          `update: ${label}`
        ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'client_personas_name_check' });
        await expect(personaRow(), `update: ${label}`).resolves.toEqual(baseline);
      }

      await insertPersona({ name: repeat('a', 120) });
      await insertPersona({ name: repeat('é', 60) });
      await expect(personaCount()).resolves.toBe(before + 2);
    });

    it('refuses description, pains, desires and objections above 5000 bytes on insert and on update', async () => {
      const before = await personaCount();
      const baseline = await personaRow();
      let accepted = 0;
      for (const { column, constraint } of textColumns) {
        for (const [label, value] of [['5001 bytes', repeat('a', 5001)], ['2501 two-byte characters', repeat('é', 2501)]] as const) {
          await expect(insertPersona({ [column]: value }), `insert ${column}: ${label}`).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint });
          await expect(personaCount(), `insert ${column}: ${label}`).resolves.toBe(before + accepted);
          await expect(
            asAdmin((transaction) => transaction('client_personas').where({ id: persona }).update({ [column]: value })),
            `update ${column}: ${label}`
          ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint });
          await expect(personaRow(), `update ${column}: ${label}`).resolves.toEqual(baseline);
        }
        await insertPersona({ [column]: repeat('a', 5000) });
        await insertPersona({ [column]: repeat('é', 2500) });
        accepted += 2;
      }
      await expect(personaCount()).resolves.toBe(before + 8);
    });
  });
});
