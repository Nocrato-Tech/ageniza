import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveIntegrationDatabaseUrls } from '../src/index.js';

// Scope redesign-igual, subtask A2: the deadline of a round was one day of São Paulo (`due_on`) and becomes an instant (`due_at`). The
// migration must carry what already exists, so the database is built with the migrations up to the one before this change, filled the way
// the old code filled it, and upgraded: a deadline that was a day is valid until the END of that day in São Paulo (23:59).
const { ownerUrl } = resolveIntegrationDatabaseUrls();
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const FIRST_OF_THIS_CHANGE = '20261111000200_approval_deadline_with_hour.mjs';

const databaseName = `ageniza_deadline_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
let admin: Knex;
let upgrade: Knex;
const workDir = mkdtempSync(join(tmpdir(), 'ageniza-deadline-'));

const ids = { agency: randomUUID(), readOnlyAgency: randomUUID(), client: randomUUID(), readOnlyClient: randomUUID(), sender: randomUUID(), collaborator: randomUUID() };
const rounds: Record<string, { id: string; content: string; dueOn: string | null; note: string | null; sentAt: Date; remindedDueSoonAt: Date | null }> = {};

const DAYS = {
  today: '2026-11-12',
  newYearsEve: '2026-12-31',
  leapDay: '2028-02-29',
  // Days of the last years of the daylight saving time of São Paulo, which the database still knows: its clocks were an hour ahead.
  dstStarts: '2018-11-03',
  dstFirstDay: '2018-11-04',
  dstEndsEve: '2019-02-16',
  dstLastDay: '2019-02-17',
  none: null
} as const;

beforeAll(async () => {
  const earlier = join(workDir, 'earlier');
  mkdirSync(earlier);
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.mjs') && name < FIRST_OF_THIS_CHANGE)) {
    cpSync(join(migrationsDir, file), join(earlier, file));
  }

  admin = knex({ client: 'pg', connection: { connectionString: ownerUrl }, pool: { min: 0, max: 1 } });
  await admin.raw(`create database "${databaseName}"`);
  const target = new URL(ownerUrl);
  target.pathname = `/${databaseName}`;
  upgrade = knex({ client: 'pg', connection: { connectionString: target.toString() }, pool: { min: 0, max: 2 } });
  await upgrade.migrate.latest({ directory: earlier, loadExtensions: ['.mjs'] });
  expect(await upgrade.schema.hasColumn('content_approval_rounds', 'due_at')).toBe(false);

  await upgrade('auth.user').insert([
    { id: ids.sender, name: 'Quem enviou', email: `${ids.sender}@deadline.test`, emailVerified: true },
    { id: ids.collaborator, name: 'Colaboradora', email: `${ids.collaborator}@deadline.test`, emailVerified: true }
  ]);
  await upgrade('agencies').insert([
    { id: ids.agency, name: `Prazo ${ids.agency}`, owner_user_id: null },
    // An agency whose trial ended: the trigger of the table refuses a write of a person for it, and the migration must still carry its rows.
    { id: ids.readOnlyAgency, name: `Prazo somente leitura ${ids.readOnlyAgency}`, owner_user_id: null, plan: 'trial', trial_ends_at: new Date('2026-01-01T00:00:00Z'), trial_owner_email_key: ids.readOnlyAgency }
  ]);
  const admin_role = (await upgrade('roles').whereNull('agency_id').where({ key: 'admin' }).first('id')).id;
  await upgrade('agency_memberships').insert([
    { agency_id: ids.agency, user_id: ids.collaborator, role_id: admin_role },
    { agency_id: ids.readOnlyAgency, user_id: ids.collaborator, role_id: admin_role }
  ]);
  await upgrade('clients').insert([
    { id: ids.client, agency_id: ids.agency, name: `Cliente ${ids.client}` },
    { id: ids.readOnlyClient, agency_id: ids.readOnlyAgency, name: `Cliente somente leitura ${ids.readOnlyClient}` }
  ]);

  const folder = async (clientId: string): Promise<string> => (await upgrade('media_folders').where({ client_id: clientId, is_default: true }).first('id')).id as string;
  const seed = async (key: string, clientId: string, dueOn: string | null, note: string | null): Promise<void> => {
    const content = randomUUID();
    await upgrade('contents').insert({
      id: content, client_id: clientId, title: key, platform: 'instagram', format: 'reels', publish_on: '2026-12-20',
      folder_id: await folder(clientId), owner_user_id: ids.collaborator, status: 'awaiting_approval'
    });
    const sentAt = new Date('2026-11-09T13:00:00.000Z');
    const row = { id: randomUUID(), batch_id: randomUUID(), client_id: clientId, content_id: content, sequence: 1, due_on: dueOn, note, sent_by: ids.sender, sent_at: sentAt, reminded_due_soon_at: dueOn === null ? null : new Date('2026-11-11T12:00:00.000Z') };
    await upgrade('content_approval_rounds').insert(row);
    rounds[key] = { id: row.id, content, dueOn, note, sentAt, remindedDueSoonAt: row.reminded_due_soon_at };
  };

  for (const [key, day] of Object.entries(DAYS)) await seed(key, ids.client, day, key === 'today' ? 'Recado do dia' : null);
  await seed('readOnly', ids.readOnlyClient, DAYS.today, 'Agência somente leitura');

  await upgrade.migrate.latest({ directory: migrationsDir, loadExtensions: ['.mjs'] });
}, 240_000);

afterAll(async () => {
  try {
    await upgrade?.destroy();
    await admin?.raw(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin?.destroy();
    rmSync(workDir, { recursive: true, force: true });
  }
});

const roundOf = async (key: string): Promise<Record<string, unknown>> =>
  (await upgrade('content_approval_rounds').where({ id: rounds[key]!.id }).select('*', upgrade.raw('due_on::text as due_on_text'), upgrade.raw("to_char(due_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI:SS') as due_local")))[0]!;

describe('the backfill of the deadline of the rounds that already exist', () => {
  it.each([
    ['an ordinary day', 'today', '2026-11-12 23:59:00'],
    ['the last day of the year', 'newYearsEve', '2026-12-31 23:59:00'],
    ['a leap day', 'leapDay', '2028-02-29 23:59:00'],
    ['the day before the daylight saving time started in 2018', 'dstStarts', '2018-11-03 23:59:00'],
    ['the first day of the daylight saving time of 2018, which had only 23 hours', 'dstFirstDay', '2018-11-04 23:59:00'],
    ['the day before the daylight saving time ended in 2019, which had 25 hours', 'dstEndsEve', '2019-02-16 23:59:00'],
    ['the last day of the daylight saving time of 2019', 'dstLastDay', '2019-02-17 23:59:00']
  ])('gives %s the end of that day in São Paulo, 23:59', async (_label, key, local) => {
    const row = await roundOf(key);
    expect(row.due_local).toBe(local);
    expect(row.due_on_text).toBe(rounds[key]!.dueOn);
  });

  it('gives the absolute instant of the end of the day: three hours after UTC midnight of the next day in 2026, when São Paulo is at -03:00', async () => {
    expect((await roundOf('today')).due_at).toEqual(new Date('2026-11-13T02:59:00.000Z'));
    expect((await roundOf('newYearsEve')).due_at).toEqual(new Date('2027-01-01T02:59:00.000Z'));
    // The 2018 deadline of the first day of the daylight saving time is an hour earlier in UTC than the one of an ordinary day.
    expect((await roundOf('dstFirstDay')).due_at).toEqual(new Date('2018-11-05T01:59:00.000Z'));
  });

  it('leaves a round with no deadline with no deadline', async () => {
    expect(await roundOf('none')).toMatchObject({ due_on_text: null, due_at: null });
  });

  it('carries the rounds of an agency whose trial has ended, which the trigger refuses to a person but not to the migration', async () => {
    expect(await roundOf('readOnly')).toMatchObject({ due_on_text: DAYS.today, due_local: '2026-11-12 23:59:00', note: 'Agência somente leitura' });
  });

  it('changes nothing else of any round: the day, the note, the sender, the date it was sent and the reminders stay as they were', async () => {
    for (const [key, before] of Object.entries(rounds)) {
      expect(await roundOf(key), key).toMatchObject({
        id: before.id, content_id: before.content, sequence: 1, note: before.note, sent_by: ids.sender, sent_at: before.sentAt,
        reminded_due_soon_at: before.remindedDueSoonAt, reminded_overdue_at: null, due_on_text: before.dueOn
      });
    }
  });

  it('keeps the day and the instant of every row in agreement, which the constraint of the table says', async () => {
    const { rows } = await upgrade.raw<{ rows: Array<{ disagreeing: string }> }>(
      'select count(*)::text as disagreeing from public.content_approval_rounds where due_on is distinct from app_private.sao_paulo_date(due_at)'
    );
    expect(rows[0]!.disagreeing).toBe('0');
    const { rows: constraints } = await upgrade.raw<{ rows: Array<{ conname: string }> }>(
      "select conname from pg_constraint where conrelid = 'public.content_approval_rounds'::regclass and conname = 'content_approval_rounds_due_check'"
    );
    expect(constraints).toHaveLength(1);
  });

  it('is read by the portal as the end of the day, and the reminders of the day still count it by its day', async () => {
    const { rows } = await upgrade.raw<{ rows: Array<{ due_at: Date; due_on: string }> }>(
      'select due_at, due_on::text as due_on from public.content_approval_rounds where id = ?::uuid', [rounds.today!.id]
    );
    expect(rows[0]).toEqual({ due_at: new Date('2026-11-13T02:59:00.000Z'), due_on: '2026-11-12' });
    // The reminder of "vence amanhã" is sent on the eve, the day before due_on, which is the day the end of the deadline falls on.
    const { rows: eve } = await upgrade.raw<{ rows: Array<{ eve: string }> }>(
      "select (round.due_on - 1)::text as eve from public.content_approval_rounds round where round.id = ?::uuid and app_private.sao_paulo_date(round.due_at) = round.due_on", [rounds.today!.id]
    );
    expect(eve[0]!.eve).toBe('2026-11-11');
  });
});
