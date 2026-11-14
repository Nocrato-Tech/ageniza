import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  raw,
  resolveIntegrationDatabaseUrls,
  type DatabaseClient
} from '../src/index.js';

// Issue #893, specs/auth.md section 14: `auth."session"` keeps the approximate city a session was created from. It is
// written when the session is created and never changed; what reaches the row is short and printable.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient;
let application: DatabaseClient;
let userId: string;

const newSession = (city: string | null | undefined) => ({
  id: randomUUID(),
  token: `token-${randomUUID()}`,
  userId,
  expiresAt: new Date(Date.now() + 3_600_000),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...(city === undefined ? {} : { city })
});

/** The first error the statement raises as the application role, or 'ok'; always rolled back. */
const asApplication = async (statement: string, bindings: readonly unknown[] = []): Promise<unknown> => {
  const transaction = await application.knex.transaction();
  try {
    await transaction.raw(statement, [...bindings]);
    return 'ok';
  } catch (error) {
    return error;
  } finally {
    await transaction.rollback();
  }
};

const insertAsOwner = async (city: string | null | undefined): Promise<unknown> => {
  try {
    await owner.knex('auth.session').insert(newSession(city));
    return 'ok';
  } catch (error) {
    return error;
  }
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  userId = randomUUID();
  await owner.knex('auth.user').insert({ id: userId, name: 'Session city', email: `session-city-${userId}@example.test`, emailVerified: true });
});

afterAll(async () => {
  await owner.knex('auth.user').where({ id: userId }).delete();
  await application.close();
  await owner.close();
});

describe('the column', () => {
  it('is nullable text with no default, so a session that exists has no city and nothing is backfilled', async () => {
    const { rows } = await raw<{ rows: readonly { data_type: string; is_nullable: string; column_default: string | null }[] }>(owner.knex, `
      select data_type, is_nullable, column_default
      from information_schema.columns where table_schema = 'auth' and table_name = 'session' and column_name = 'city'
    `, []);
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);

    const stored = newSession(undefined);
    await owner.knex('auth.session').insert(stored);
    expect((await owner.knex('auth.session').where({ id: stored.id }).first('city'))?.city).toBeNull();
  });
});

describe('the CHECK (1 to 80 characters, no control character)', () => {
  const accepted: readonly [string, string | null][] = [
    ['no city', null],
    ['a name with accents', 'São Paulo'],
    ['one character', 'a'],
    ['80 characters', 'a'.repeat(80)],
    ['80 two-byte characters (counted as characters, not bytes)', 'ã'.repeat(80)],
    ['80 astral characters (counted as code points, not UTF-16 units)', '😀'.repeat(80)],
    ['the character just under the C0 range (space)', 'Rio Grande'],
    ['the character just under DEL (tilde)', 'Sao~Paulo'],
    ['the character just over the C1 range (NBSP)', `Sao${String.fromCodePoint(0xa0)}Paulo`]
  ];

  it.each(accepted)('accepts %s', async (_label, city) => {
    expect(await insertAsOwner(city)).toBe('ok');
  });

  const refusedLength: readonly [string, string][] = [
    ['an empty city', ''],
    ['81 characters', 'a'.repeat(81)],
    ['81 two-byte characters', 'ã'.repeat(81)],
    ['81 astral characters', '😀'.repeat(81)],
    ['10 000 characters', 'a'.repeat(10_000)]
  ];

  it.each(refusedLength)('refuses %s with the constraint of the city', async (_label, city) => {
    expect(await insertAsOwner(city)).toMatchObject({ code: '23514', constraint: 'session_city_clean' });
  });

  // Both extremes of each range, and a character inside it (checklist item 54): the first and last of C0 (U+0001 to U+001F),
  // DEL, and the first and last of C1 (U+0080 to U+009F). U+0085 (NEL) and the line feed are the ones that break a line.
  it.each([0x01, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f])('refuses the control character U+%s', async (code) => {
    expect(await insertAsOwner(`Sao${String.fromCodePoint(code)}Paulo`)).toMatchObject({ code: '23514', constraint: 'session_city_clean' });
    expect(await insertAsOwner(String.fromCodePoint(code))).toMatchObject({ code: '23514', constraint: 'session_city_clean' });
  });

  it('refuses a control character as the application role too, on INSERT', async () => {
    const error = await asApplication(
      `insert into auth.session (id, token, "userId", "expiresAt", "updatedAt", city) values (gen_random_uuid(), ?, ?::uuid, now() + interval '1 hour', now(), ?)`,
      [`token-${randomUUID()}`, userId, 'Sao\nPaulo']
    );
    expect(error).toMatchObject({ code: '23514', constraint: 'session_city_clean' });
  });
});

describe('the application role and the city', () => {
  const insertSql = `insert into auth.session (id, token, "userId", "expiresAt", "updatedAt", city) values (gen_random_uuid(), ?, ?::uuid, now() + interval '1 hour', now(), ?)`;

  it('writes the city when the session is created and reads it back', async () => {
    const transaction = await application.knex.transaction();
    try {
      await transaction.raw(insertSql, [`token-${randomUUID()}`, userId, 'Campinas']);
      const { rows } = await raw<{ rows: readonly { city: string }[] }>(transaction, 'select city from auth.session where "userId" = ?::uuid and city = ?', [userId, 'Campinas']);
      expect(rows).toEqual([{ city: 'Campinas' }]);
    } finally {
      await transaction.rollback();
    }
  });

  it('cannot change the city of a session afterwards: UPDATE of the column is refused by the privilege', async () => {
    const stored = newSession('Santos');
    await owner.knex('auth.session').insert(stored);

    expect(await asApplication('update auth.session set city = ? where id = ?::uuid', ['Outra', stored.id]))
      .toMatchObject({ code: '42501', message: expect.stringMatching(/permission denied for table session/) });
    expect(await asApplication('update auth.session set city = null where id = ?::uuid', [stored.id])).toMatchObject({ code: '42501' });
    expect((await owner.knex('auth.session').where({ id: stored.id }).first('city'))?.city).toBe('Santos');
  });

  it('keeps the UPDATE of every other column, by column: the renewal Better Auth makes still works', async () => {
    const stored = newSession('Santos');
    await owner.knex('auth.session').insert(stored);

    expect(await asApplication(`update auth.session set "expiresAt" = now() + interval '2 hours', "updatedAt" = now() where id = ?::uuid`, [stored.id])).toBe('ok');

    const { rows } = await raw<{ rows: readonly { column: string }[] }>(owner.knex, `
      select attribute.attname as column
      from pg_catalog.pg_attribute attribute
      where attribute.attrelid = 'auth.session'::regclass and attribute.attnum > 0 and not attribute.attisdropped
        and pg_catalog.has_column_privilege('ageniza_app', attribute.attrelid, attribute.attnum, 'update')
      order by 1
    `, []);
    expect(rows.map((row) => row.column)).toEqual(
      ['createdAt', 'expiresAt', 'id', 'ipAddress', 'token', 'updatedAt', 'userAgent', 'userId']
    );
  });

  it('has no UPDATE of the whole table, keeps SELECT, INSERT and DELETE, and can still take the row lock', async () => {
    const { rows } = await raw<{ rows: readonly { privilege: string; granted: boolean }[] }>(owner.knex, `
      select privilege, pg_catalog.has_table_privilege('ageniza_app', 'auth.session'::regclass, privilege) as granted
      from unnest(array['select', 'insert', 'update', 'delete']) as privilege order by 1
    `, []);
    expect(rows).toEqual([
      { privilege: 'delete', granted: true },
      { privilege: 'insert', granted: true },
      { privilege: 'select', granted: true },
      { privilege: 'update', granted: false }
    ]);

    const stored = newSession('Santos');
    await owner.knex('auth.session').insert(stored);
    expect(await asApplication('select id from auth.session where id = ?::uuid for update', [stored.id])).toBe('ok');
    expect(await asApplication('delete from auth.session where id = ?::uuid', [stored.id])).toBe('ok');
  });

  it('is gone with the account: the cascade of the user takes the session and its city', async () => {
    const other = randomUUID();
    await owner.knex('auth.user').insert({ id: other, name: 'Gone', email: `session-city-gone-${other}@example.test`, emailVerified: true });
    await owner.knex('auth.session').insert({ ...newSession('Recife'), userId: other });

    await owner.knex('auth.user').where({ id: other }).delete();

    expect(await owner.knex('auth.session').where({ userId: other })).toHaveLength(0);
  });
});
