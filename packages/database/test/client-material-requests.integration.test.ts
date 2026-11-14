import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, waitForBackendsBlockedBy } from '../src/index.js';

import { createApprovalFixtures } from './support/approval-fixtures.js';
import { createContentWorld } from './support/content-world.js';

// Scope telas-melhorias, subtask S2 (decision 2026-11-10, "pedido de material e assunto próprio da conversa do cliente"): a request for
// material is a conversation of the client with no content, no section and no persona, opened by the agency with an optional deadline,
// answered by the client in comments and resolved by the agency. RLS answers WHO may read or write, not through WHICH SIDE, so each rule
// is attacked with the people who only hold a link, with a collaborator who holds a link and a role that cannot open a conversation
// (`dualBare`, Sales; `dualFull`, Production), and with the Admin of another agency who holds a link here (`crossDual`).
const w = createContentWorld('material-requests');
const f = createApprovalFixtures(w);
const { ids } = w;

const rlsViolation = { code: '42501', message: expect.stringContaining('row-level security') };
const owner = () => w.getOwner().knex;

let onlyClienteOperar: string;
let onlyClienteVisualizar: string;
let onlyConteudo: string;

beforeAll(async () => {
  await w.setup();
  await f.waitForQuietClock();
  onlyClienteOperar = await w.personWith('cliente.operar', 'cliente.visualizar');
  onlyClienteVisualizar = await w.personWith('cliente.visualizar');
  onlyConteudo = await w.personWith('conteudo.operar', 'conteudo.visualizar');
});

afterAll(async () => {
  try {
    await f.cleanUp();
    await owner()('client_thread_comments').whereIn('client_id', [ids.clientA1]).delete();
    await owner()('client_threads').whereIn('persona_id', personas).delete();
    await owner()('client_personas').whereIn('id', personas).delete();
    await owner()('client_memberships').whereIn('user_id', extraUsers).delete();
    await owner()('auth.user').whereIn('id', extraUsers).delete();
  } finally {
    await w.teardown();
  }
});

const personas: string[] = [];
const extraUsers: string[] = [];
const seedPersona = async (): Promise<string> => {
  const id = randomUUID();
  personas.push(id);
  await owner()('client_personas').insert({ id, client_id: ids.clientA1, name: 'Persona' });
  return id;
};

// ---- helpers -------------------------------------------------------------------------------------------------------

const openRequest = (user: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID();
  return w.asUser(user, (transaction) => transaction('client_threads').insert({
    id, client_id: ids.clientA1, is_material_request: true, opened_by: user, opened_side: 'agency', ...extra
  })).then(() => id);
};

const seedRequest = async (extra: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID();
  await owner()('client_threads').insert({ id, client_id: ids.clientA1, is_material_request: true, opened_by: ids.adminA, opened_side: 'agency', ...extra });
  return id;
};

const seedComment = async (threadId: string, author: string, side: 'agency' | 'client', clientId = ids.clientA1, body = `Texto ${randomUUID().slice(0, 6)}`): Promise<string> => {
  const id = randomUUID();
  await owner()('client_thread_comments').insert({ id, thread_id: threadId, client_id: clientId, author_user_id: author, author_side: side, body });
  return id;
};

const writeComment = (user: string, threadId: string, side: 'agency' | 'client', clientId = ids.clientA1): Promise<string> => {
  const id = randomUUID();
  return w.asUser(user, (transaction) => transaction('client_thread_comments').insert({
    id, thread_id: threadId, client_id: clientId, author_user_id: user, author_side: side, body: 'Um comentário'
  })).then(() => id);
};

const threadRow = async (id: string): Promise<Record<string, unknown>> =>
  (await owner()('client_threads').where({ id }).first('*', owner().raw('due_on::text as due_on_text'))) as Record<string, unknown>;

const requestCount = async (clientId = ids.clientA1): Promise<number> =>
  Number((await owner()('client_threads').where({ client_id: clientId, is_material_request: true }).count<Array<{ count: string }>>('* as count'))[0]!.count);

const visible = async (user: string, table: 'client_threads' | 'client_thread_comments', column: string, among: readonly string[]): Promise<string[]> =>
  (await w.asUser(user, (transaction) => transaction(table).whereIn(column, among).select(column))).map((row) => row[column] as string).sort();

const whileReadOnly = async (work: () => Promise<void>): Promise<void> => {
  await owner()('agencies').where({ id: ids.agencyA }).update({
    plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)')
  });
  try { await work(); } finally {
    await owner()('agencies').where({ id: ids.agencyA }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });
  }
};

const PORTAL_OF_A1 = [
  ['a person of the portal', () => ids.portalA1],
  ['another person of the portal of the same client', () => ids.portalA1Second],
  ['a collaborator with a link to the client and the Sales role', () => ids.dualBare],
  ['a collaborator with a link to the client and the Production role', () => ids.dualFull],
  ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
] as const;

// Who has the link and no role in the agency of the client: what they read, they read by the link alone.
const LINK_ONLY = [PORTAL_OF_A1[0], PORTAL_OF_A1[1], PORTAL_OF_A1[4]] as const;

// ---- the shape ---------------------------------------------------------------------------------------------------------------

describe('the subject and the deadline in the table of conversations', () => {
  it('lets the application insert the two new columns and still change nothing but the resolution afterwards', async () => {
    expect(await w.columnsWithPrivilege('client_threads', 'insert')).toEqual([
      'client_id', 'content_id', 'due_on', 'id', 'is_material_request', 'opened_by', 'opened_side', 'persona_id', 'section_key', 'title'
    ]);
    expect(await w.columnsWithPrivilege('client_threads', 'update')).toEqual(['resolved_at', 'resolved_by']);
    expect(await w.tablePrivileges('client_threads')).toEqual({ can_select: true, table_insert: false, table_update: false, can_delete: false, can_truncate: false });
  });

  it('is born false and without a deadline for every other conversation', async () => {
    const id = randomUUID();
    await owner()('client_threads').insert({ id, client_id: ids.clientA1, section_key: 'branding', opened_by: ids.adminA, opened_side: 'agency' });

    expect(await threadRow(id)).toMatchObject({ is_material_request: false, due_on: null });
  });

  it('holds exactly one subject: the request together with a content, a section or a persona is refused, and so is a thread with none', async () => {
    const persona = await seedPersona();
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const subject = { constraint: 'client_threads_subject_check', code: '23514' };
    const base = { client_id: ids.clientA1, opened_by: ids.adminA, opened_side: 'agency' };

    await expect(owner()('client_threads').insert({ ...base, is_material_request: true, content_id: content })).rejects.toMatchObject(subject);
    await expect(owner()('client_threads').insert({ ...base, is_material_request: true, section_key: 'branding' })).rejects.toMatchObject(subject);
    await expect(owner()('client_threads').insert({ ...base, is_material_request: true, persona_id: persona })).rejects.toMatchObject(subject);
    await expect(owner()('client_threads').insert({ ...base, is_material_request: false })).rejects.toMatchObject(subject);
    await expect(owner()('client_threads').insert(base)).rejects.toMatchObject(subject);
    await owner()('client_threads').insert({ ...base, is_material_request: true });
  });

  it('keeps the other subjects as they were: a content, a section and a persona each still make a conversation', async () => {
    const persona = await seedPersona();
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const base = { client_id: ids.clientA1, opened_by: ids.adminA, opened_side: 'agency' };

    await owner()('client_threads').insert([{ ...base, content_id: content }, { ...base, section_key: 'colors' }, { ...base, persona_id: persona }]);
  });

  it('takes a deadline only with the request', async () => {
    const dueOn = await f.day(3);
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const base = { client_id: ids.clientA1, opened_by: ids.adminA, opened_side: 'agency', due_on: dueOn };
    const check = { constraint: 'client_threads_due_on_check', code: '23514' };

    await expect(owner()('client_threads').insert({ ...base, section_key: 'branding' })).rejects.toMatchObject(check);
    await expect(owner()('client_threads').insert({ ...base, content_id: content })).rejects.toMatchObject(check);
    await expect(w.asUser(ids.adminA, (t) => t('client_threads').insert({ ...base, section_key: 'branding' }))).rejects.toMatchObject(check);
  });

  it('is opened by the agency only: a row of the client side is refused for the portal and for the owner of the database alike', async () => {
    const check = { constraint: 'client_threads_material_request_agency_check', code: '23514' };
    const before = await requestCount();

    await expect(owner()('client_threads').insert({ client_id: ids.clientA1, is_material_request: true, opened_by: ids.portalA1, opened_side: 'client' })).rejects.toMatchObject(check);
    // The policy shows the row to the person of the portal, so what refuses it is the constraint and not the RLS.
    for (const [label, user] of PORTAL_OF_A1) {
      await expect(openRequest(user(), { opened_side: 'client' }), label).rejects.toMatchObject(check);
    }
    expect(await requestCount()).toBe(before);
  });
});

// ---- the title ---------------------------------------------------------------------------------------------------------------------

describe('the title of the request (decision 2026-11-11)', () => {
  const titleOf = async (id: string): Promise<string | null> => (await threadRow(id)).title as string | null;

  it('is born null, for a request opened without it and for every other conversation, and the application never changes it afterwards', async () => {
    const without = await openRequest(ids.adminA);
    const section = randomUUID();
    await owner()('client_threads').insert({ id: section, client_id: ids.clientA1, section_key: 'branding', opened_by: ids.adminA, opened_side: 'agency' });
    expect(await titleOf(without)).toBeNull();
    expect(await titleOf(section)).toBeNull();

    expect(await w.columnsWithPrivilege('client_threads', 'update')).not.toContain('title');
    await expect(w.asUser(ids.adminA, (t) => t('client_threads').where({ id: without }).update({ title: 'Mudou depois' }))).rejects.toMatchObject({ code: '42501' });
    expect(await titleOf(without)).toBeNull();
  });

  it.each([
    ['an Admin', () => ids.adminA],
    ['the Account Manager', () => ids.managerA],
    ['a role with only cliente.operar and cliente.visualizar', () => onlyClienteOperar]
  ] as const)('is written by %s with the request, up to 80 characters of one line, counted as characters', async (_label, user) => {
    for (const title of ['Fotos da equipe', 'a', 'a'.repeat(80), 'ç'.repeat(80), '😀'.repeat(80)]) {
      const id = await openRequest(user(), { title });
      expect(await titleOf(id), title.slice(0, 8)).toBe(title);
    }
  });

  it('is refused on any other subject, because only a request for material has one, for the application and for the owner alike', async () => {
    const persona = await seedPersona();
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const base = { client_id: ids.clientA1, opened_by: ids.adminA, opened_side: 'agency', title: 'Título solto' };
    const check = { constraint: 'client_threads_title_request_check', code: '23514' };

    for (const subject of [{ section_key: 'branding' }, { content_id: content }, { persona_id: persona }]) {
      await expect(owner()('client_threads').insert({ ...base, ...subject }), JSON.stringify(subject)).rejects.toMatchObject(check);
      await expect(w.asUser(ids.adminA, (t) => t('client_threads').insert({ ...base, ...subject })), JSON.stringify(subject)).rejects.toMatchObject(check);
    }
    await owner()('client_threads').insert({ ...base, is_material_request: true });
  });

  it('is refused when it is empty, blank, long, in several lines or with a control character, and leaves no request behind', async () => {
    const before = await requestCount();
    const check = { constraint: 'client_threads_title_check', code: '23514' };
    for (const title of ['', '   ', ' ', 'a'.repeat(81), 'Duas\nlinhas', 'Com\ttab', 'Sino\u0007', 'Next\u0085', 'Del\u007f']) {
      await expect(openRequest(ids.adminA, { title }), JSON.stringify(title)).rejects.toMatchObject(check);
      await expect(owner()('client_threads').insert({ client_id: ids.clientA1, is_material_request: true, opened_by: ids.adminA, opened_side: 'agency', title }), JSON.stringify(title)).rejects.toMatchObject(check);
    }
    expect(await requestCount()).toBe(before);
  });

  it('is read together with the request by the people who read it, and by nobody who does not', async () => {
    const request = await openRequest(ids.adminA, { title: 'Só de quem lê o pedido' });
    const readFor = (user: string) => w.asUser(user, (t) => t('client_threads').where({ id: request }).select('title'));

    for (const [label, user] of LINK_ONLY) expect(await readFor(user()), label).toEqual([{ title: 'Só de quem lê o pedido' }]);
    expect(await readFor(ids.adminA)).toEqual([{ title: 'Só de quem lê o pedido' }]);
    for (const user of [ids.portalA2, ids.portalB, ids.adminB]) expect(await readFor(user), user).toEqual([]);
  });
});

// ---- who opens -------------------------------------------------------------------------------------------------------------------

describe('who opens a request for material', () => {
  it.each([
    ['an Admin', () => ids.adminA],
    ['the Owner of the agency, by ownership', () => ids.ownerA],
    ['the Account Manager', () => ids.managerA],
    ['a role with only cliente.operar and cliente.visualizar', () => onlyClienteOperar]
  ] as const)('lets %s open it, with and without a deadline', async (_label, user) => {
    const before = await requestCount();
    const without = await openRequest(user());
    const withDeadline = await openRequest(user(), { due_on: await f.day(10) });

    expect(await threadRow(without)).toMatchObject({ is_material_request: true, due_on: null, opened_by: user(), opened_side: 'agency', resolved_at: null, resolved_by: null });
    expect(await threadRow(withDeadline)).toMatchObject({ is_material_request: true, due_on_text: await f.day(10) });
    expect(await requestCount()).toBe(before + 2);
  });

  it.each([
    ['Sales', () => ids.salesA],
    ['Finance', () => ids.financeA],
    ['Production', () => ids.productionA],
    ['a role with only cliente.visualizar', () => onlyClienteVisualizar],
    ['a role with conteudo.operar and conteudo.visualizar: a request is not a conversation of a content', () => onlyConteudo],
    ['the Admin of another agency', () => ids.adminB],
    ['the Admin of a suspended agency', () => ids.adminSuspended],
    ['a person of the portal of the client', () => ids.portalA1],
    ['a person of the portal of another client of the agency', () => ids.portalA2],
    ['a person of the portal of a client of another agency', () => ids.portalB],
    ['a collaborator with a link to the client and the Sales role, writing as the agency', () => ids.dualBare],
    ['a collaborator with a link to the client and the Production role, writing as the agency', () => ids.dualFull],
    ['an Admin of another agency who holds a link to the client, writing as the agency', () => ids.crossDual]
  ] as const)('refuses %s, leaving no row', async (_label, user) => {
    const before = await requestCount();

    await expect(openRequest(user())).rejects.toMatchObject(rlsViolation);
    await expect(openRequest(user(), { due_on: await f.day(10) })).rejects.toMatchObject(rlsViolation);

    expect(await requestCount()).toBe(before);
  });

  it('refuses a request in the name of someone else, and one in the portal of a client of another agency or of another client of the same one', async () => {
    const before = await requestCount();

    await expect(openRequest(ids.adminA, { opened_by: ids.managerA })).rejects.toMatchObject(rlsViolation);
    await expect(openRequest(ids.adminA, { client_id: ids.clientB })).rejects.toMatchObject(rlsViolation);
    await expect(openRequest(ids.adminB, { client_id: ids.clientA1 })).rejects.toMatchObject(rlsViolation);
    expect(await requestCount()).toBe(before);
    expect(await requestCount(ids.clientB)).toBe(0);
  });

  it('refuses the request of an archived client and of a read-only agency, like every conversation', async () => {
    const archived = await f.freshClient([]);
    await owner()('clients').where({ id: archived }).update({ status: 'archived', archived_at: new Date() });
    await expect(openRequest(ids.adminA, { client_id: archived })).rejects.toMatchObject(rlsViolation);
    expect(await requestCount(archived)).toBe(0);

    await whileReadOnly(async () => {
      await expect(openRequest(ids.adminA)).rejects.toMatchObject({ code: 'A0090' });
    });
  });

  it('waits for the archiving of the client that is in flight, then refuses with the code of the lock', async () => {
    const client = await f.freshClient([]);
    const archiving = await w.openTransactionAs(ids.adminA);
    const archivingPid = await backendPid(archiving);
    let outcome: Promise<unknown> | undefined;
    try {
      await archiving.raw('select app_private.archive_client(?::uuid)', [client]);
      outcome = openRequest(ids.adminA, { client_id: client }).then(() => 'opened', (error: unknown) => error);
      await waitForBackendsBlockedBy(owner(), archivingPid);
    } finally {
      await archiving.commit();
    }

    expect(await outcome).toMatchObject({ code: 'A0020' });
    expect(await requestCount(client)).toBe(0);
  });

  it('changes neither the subject nor the deadline afterwards: the application role has no UPDATE on them', async () => {
    const id = await openRequest(ids.adminA, { due_on: await f.day(5) });

    for (const change of [{ due_on: await f.day(6) }, { due_on: null }, { is_material_request: false }, { opened_side: 'client' }]) {
      await expect(w.asUser(ids.adminA, (t) => t('client_threads').where({ id }).update(change)), JSON.stringify(change))
        .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    }
    expect(await threadRow(id)).toMatchObject({ is_material_request: true, due_on_text: await f.day(5), opened_side: 'agency' });
  });
});

// ---- the deadline ----------------------------------------------------------------------------------------------------------------

describe('the deadline of a request: from today to 90 days ahead, in America/Sao_Paulo', () => {
  it.each([
    ['yesterday', -1, false],
    ['today', 0, true],
    ['90 days ahead', 90, true],
    ['91 days ahead', 91, false]
  ])('%s is %s', async (_label, offset, accepted) => {
    const before = await requestCount();
    const dueOn = await f.day(offset);

    if (accepted) {
      const id = await openRequest(ids.adminA, { due_on: dueOn });
      expect(await threadRow(id)).toMatchObject({ due_on_text: dueOn });
    } else {
      await expect(openRequest(ids.adminA, { due_on: dueOn })).rejects.toMatchObject({ code: 'A0120' });
      expect(await requestCount()).toBe(before);
    }
  });

  it('applies to whoever inserts, the owner of the database included, so a fixture cannot backdate a request', async () => {
    await expect(seedRequest({ due_on: await f.day(-1) })).rejects.toMatchObject({ code: 'A0120' });
  });

  // The trigger reads "today" at the start of its transaction, so a test through it lives with the hour it runs at: the check takes the
  // instant, and these tests fix it, at the hours where São Paulo and UTC are on another day. São Paulo is three hours behind UTC all year.
  const checkAt = (dueOn: string | null, instant: string | null): Promise<unknown> =>
    owner().raw('select app_private.check_material_request_due_on(?::date, ?::timestamptz)', [dueOn, instant]);
  const plusDays = (day: string, days: number): Promise<string> => f.sql('select (?::date + ?::integer)::text as value', [day, days]);

  it.each([
    ['12:00', '2026-11-10T15:00:00Z', '2026-11-10'],
    ['20:59:59, the last second the UTC date is still the same', '2026-11-10T23:59:59Z', '2026-11-10'],
    ['21:00:00, the first second the UTC date is the next day', '2026-11-11T00:00:00Z', '2026-11-10'],
    ['22:30', '2026-11-11T01:30:00Z', '2026-11-10'],
    ['23:59:59, the last second of the day', '2026-11-11T02:59:59Z', '2026-11-10'],
    ['00:00:00, the first second of the next day', '2026-11-11T03:00:00Z', '2026-11-11']
  ])('at %s of São Paulo, today is %s: accepted from today to 90 days ahead, refused yesterday and 91 days ahead (A0120)', async (_label, instant, today) => {
    for (const offset of [0, 90]) await expect(checkAt(await plusDays(today, offset), instant), `today + ${offset}`).resolves.toBeDefined();
    for (const offset of [-1, 91]) await expect(checkAt(await plusDays(today, offset), instant), `today + ${offset}`).rejects.toMatchObject({ code: 'A0120' });
    await expect(checkAt(null, instant)).resolves.toBeDefined();
  });

  it('refuses a missing instant, which would turn the range into a comparison with null that refuses nothing', async () => {
    await expect(checkAt('2031-01-01', null)).rejects.toMatchObject({ code: '22023' });
  });

  it('is asked at the instant of the transaction by the trigger, and the application role can neither set that instant nor reach the check', async () => {
    const source = await f.sql<string>(
      "select pg_get_functiondef(p.oid) as value from pg_proc p where p.pronamespace = 'app_private'::regnamespace and p.proname = 'refuse_material_request_due_on_out_of_range'"
    );
    expect(source).toContain('check_material_request_due_on(new.due_on, pg_catalog.now())');
    const wrapper = await f.sql<string>(
      "select pg_get_functiondef(p.oid) as value from pg_proc p where p.pronamespace = 'app_private'::regnamespace and p.proname = 'check_material_request_due_on'"
    );
    expect(wrapper).toContain('check_approval_round_input(p_due_on, null, p_at)');

    const privileges = async (signature: string) =>
      (await owner().raw<{ rows: Array<{ app: boolean; public_acl: boolean; config: string[] | null; definer: boolean }> }>(
        `select has_function_privilege('ageniza_app', p.oid, 'execute') as app,
                coalesce((select bool_or(acl.grantee = 0) from aclexplode(p.proacl) acl), true) as public_acl, p.proconfig as config, p.prosecdef as definer
         from pg_proc p where p.oid = ?::regprocedure`, [signature]
      )).rows[0];
    expect(await privileges('app_private.check_material_request_due_on(date, timestamptz)')).toEqual({ app: false, public_acl: false, config: ['search_path=""'], definer: false });
    expect(await privileges('app_private.refuse_material_request_due_on_out_of_range()')).toEqual({ app: false, public_acl: false, config: ['search_path=""'], definer: true });
    const today = await f.day(0);
    await expect(w.asUser(ids.adminA, (t) => t.raw('select app_private.check_material_request_due_on(?::date, ?::timestamptz)', [today, '2020-01-01T00:00:00Z'])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('lets a request with no deadline through the check, whoever opens it', async () => {
    await openRequest(ids.adminA);
    await expect(seedRequest()).resolves.toBeDefined();
  });
});

// ---- who reads -------------------------------------------------------------------------------------------------------------------

describe('who reads a request for material and its comments', () => {
  let open: string;
  let resolved: string;
  let openComment: string;
  let resolvedComment: string;
  let otherClient: string;
  let otherClientComment: string;

  beforeAll(async () => {
    open = await seedRequest();
    resolved = await seedRequest({ resolved_by: ids.adminA, resolved_at: new Date() });
    openComment = await seedComment(open, ids.adminA, 'agency');
    resolvedComment = await seedComment(resolved, ids.adminA, 'agency');
    otherClient = await seedRequest({ client_id: ids.clientA2 });
    otherClientComment = await seedComment(otherClient, ids.adminA, 'agency', ids.clientA2);
  });

  it.each(LINK_ONLY)('shows %s the requests of their client, open and resolved, with their comments, and none of another client', async (_label, user) => {
    expect(await visible(user(), 'client_threads', 'id', [open, resolved, otherClient])).toEqual([open, resolved].sort());
    expect(await visible(user(), 'client_thread_comments', 'id', [openComment, resolvedComment, otherClientComment])).toEqual([openComment, resolvedComment].sort());
  });

  it('shows a person of the portal of another client or of another agency only the requests of their own client', async () => {
    expect(await visible(ids.portalA2, 'client_threads', 'id', [open, resolved, otherClient])).toEqual([otherClient]);
    expect(await visible(ids.portalA2, 'client_thread_comments', 'id', [openComment, resolvedComment, otherClientComment])).toEqual([otherClientComment]);
    expect(await visible(ids.portalB, 'client_threads', 'id', [open, resolved, otherClient])).toEqual([]);
    expect(await visible(ids.portalB, 'client_thread_comments', 'id', [openComment, resolvedComment, otherClientComment])).toEqual([]);
  });

  it.each([
    ['an Admin', () => ids.adminA],
    ['the Owner of the agency, by ownership', () => ids.ownerA],
    ['Sales', () => ids.salesA],
    ['Finance', () => ids.financeA],
    ['Production', () => ids.productionA],
    ['a collaborator with the Sales role who also holds a link to the client, by the agency and not by the link', () => ids.dualBare],
    ['a collaborator with the Production role who also holds a link to the client, by the agency and not by the link', () => ids.dualFull]
  ] as const)('shows %s every request of the agency, as it shows the other conversations of the client', async (_label, user) => {
    expect(await visible(user(), 'client_threads', 'id', [open, resolved, otherClient])).toEqual([open, resolved, otherClient].sort());
    expect(await visible(user(), 'client_thread_comments', 'id', [openComment, resolvedComment, otherClientComment])).toEqual([openComment, resolvedComment, otherClientComment].sort());
  });

  it('shows the Admin of another agency nothing of it, and a person whose link was removed nothing through the portal', async () => {
    expect(await visible(ids.adminB, 'client_threads', 'id', [open, resolved, otherClient])).toEqual([]);
    expect(await visible(ids.adminB, 'client_thread_comments', 'id', [openComment, resolvedComment, otherClientComment])).toEqual([]);
    const outsider = randomUUID();
    extraUsers.push(outsider);
    await owner()('auth.user').insert({ id: outsider, name: 'Sem agência', email: `${outsider}@material-requests.test`, emailVerified: true });
    await owner()('client_memberships').insert({ client_id: ids.clientA1, user_id: outsider });
    expect(await visible(outsider, 'client_threads', 'id', [open, resolved])).toEqual([open, resolved].sort());
    await owner().transaction(async (transaction) => {
      await transaction('client_portal_accesses').where({ client_id: ids.clientA1, user_id: outsider }).update({ status: 'removed', generation: transaction.raw('generation + 1') });
      await transaction('client_memberships').where({ client_id: ids.clientA1, user_id: outsider }).update({ status: 'removed' });
    });
    expect(await visible(outsider, 'client_threads', 'id', [open, resolved])).toEqual([]);
    expect(await visible(outsider, 'client_thread_comments', 'id', [openComment, resolvedComment])).toEqual([]);
  });

  it('stops showing the portal a request of a client that is archived, and shows it again when the client comes back', async () => {
    const request = await seedRequest({ client_id: ids.clientArchived });
    await w.archiveClient(ids.clientArchived);
    try {
      expect(await visible(ids.portalArchived, 'client_threads', 'id', [request])).toEqual([]);
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }
    expect(await visible(ids.portalArchived, 'client_threads', 'id', [request])).toEqual([request]);
  });

  it('shows the authors of its comments to who reads it, and to nobody who does not', async () => {
    const thread = await seedRequest();
    await seedComment(thread, ids.adminA, 'agency');
    await seedComment(thread, ids.portalA1, 'client');
    const authors = async (user: string): Promise<string[]> =>
      (await w.asUser(user, async (t) => (await t.raw<{ rows: Array<{ author_user_id: string }> }>('select * from app_private.thread_comment_authors(?::uuid)', [thread])).rows))
        .map((row) => row.author_user_id).sort();

    for (const user of [ids.adminA, ids.portalA1, ids.dualBare, ids.crossDual]) expect(await authors(user), String(user)).toEqual([ids.adminA, ids.portalA1].sort());
    for (const user of [ids.portalA2, ids.portalB, ids.adminB]) expect(await authors(user), String(user)).toEqual([]);
  });

  it('is what the portal lists as open: the requests of the client with their first comment and deadline, and not the resolved ones nor those of another client', async () => {
    const client = await f.freshClient([ids.portalA1]);
    const late = await seedRequest({ client_id: client, due_on: await f.day(20) });
    const soon = await seedRequest({ client_id: client, due_on: await f.day(2) });
    const noDeadline = await seedRequest({ client_id: client });
    const done = await seedRequest({ client_id: client, resolved_by: ids.adminA, resolved_at: new Date() });
    for (const [thread, body] of [[late, 'Fotos da fachada'], [soon, 'Logo em vetor'], [noDeadline, 'Depoimento'], [done, 'Já enviado']] as const) {
      await seedComment(thread, ids.adminA, 'agency', client, body);
      await seedComment(thread, ids.adminA, 'agency', client, 'Segundo comentário');
    }

    const listed = await w.asUser(ids.portalA1, async (transaction) => (await transaction.raw<{ rows: Array<{ body: string; due_on: string | null; state: string }> }>(`
      select first_comment.body, thread.due_on::text as due_on, case when thread.resolved_at is null then 'open' else 'resolved' end as state
      from public.client_threads thread
      join lateral (
        select comment.body from public.client_thread_comments comment where comment.thread_id = thread.id order by comment.created_at, comment.id limit 1
      ) first_comment on true
      where thread.client_id = ?::uuid and thread.is_material_request and thread.resolved_at is null
      order by thread.due_on nulls last, thread.created_at
    `, [client])).rows);

    expect(listed).toEqual([
      { body: 'Logo em vetor', due_on: await f.day(2), state: 'open' },
      { body: 'Fotos da fachada', due_on: await f.day(20), state: 'open' },
      { body: 'Depoimento', due_on: null, state: 'open' }
    ]);
  });
});

// ---- who comments and who resolves ------------------------------------------------------------------------------------------------

describe('who comments on a request for material, and who resolves it', () => {
  it.each(PORTAL_OF_A1)('lets %s comment as the client, on an open request and on a resolved one', async (_label, user) => {
    const open = await seedRequest();
    const resolved = await seedRequest({ resolved_by: ids.adminA, resolved_at: new Date() });

    await writeComment(user(), open, 'client');
    await writeComment(user(), resolved, 'client');

    expect(await owner()('client_thread_comments').whereIn('thread_id', [open, resolved]).count<Array<{ count: string }>>('* as count')).toEqual([{ count: '2' }]);
  });

  it.each([
    ['the Admin of the agency, who has no link to the client', () => ids.adminA],
    ['the Owner of the agency, who has no link to the client', () => ids.ownerA],
    ['Production, who has no link to the client', () => ids.productionA],
    ['a person of the portal of another client of the same agency', () => ids.portalA2],
    ['a person of the portal of a client of another agency', () => ids.portalB],
    ['an Admin of another agency without a link to the client', () => ids.adminB]
  ] as const)('refuses %s a comment as the client, leaving no row', async (_label, user) => {
    const request = await seedRequest();

    await expect(writeComment(user(), request, 'client')).rejects.toMatchObject(rlsViolation);

    expect(await owner()('client_thread_comments').where({ thread_id: request }).select('id')).toHaveLength(0);
  });

  it('refuses a comment as the client with the client of another request, a forged author, or from a person whose link was removed', async () => {
    const request = await seedRequest();

    await expect(writeComment(ids.portalA1, request, 'client', ids.clientA2)).rejects.toMatchObject({ code: 'A0011' });
    await expect(writeComment(ids.adminA, request, 'agency', ids.clientA2)).rejects.toMatchObject({ code: 'A0011' });
    await expect(w.asUser(ids.portalA1, (t) => t('client_thread_comments').insert({
      thread_id: request, client_id: ids.clientA1, author_user_id: ids.portalA1Second, author_side: 'client', body: 'forjado'
    }))).rejects.toMatchObject(rlsViolation);
    await expect(writeComment(ids.dualRemoved, request, 'client')).rejects.toMatchObject(rlsViolation);
    expect(await owner()('client_thread_comments').where({ thread_id: request }).select('id')).toHaveLength(0);
  });

  it.each([
    ['an Admin', () => ids.adminA],
    ['the Owner of the agency, by ownership', () => ids.ownerA],
    ['a role with only cliente.operar', () => onlyClienteOperar]
  ] as const)('lets %s comment as the agency', async (_label, user) => {
    const request = await seedRequest();

    await writeComment(user(), request, 'agency');

    expect(await owner()('client_thread_comments').where({ thread_id: request }).select('id')).toHaveLength(1);
  });

  it.each([
    ['Sales', () => ids.salesA],
    ['a role with only cliente.visualizar', () => onlyClienteVisualizar],
    ['a role with conteudo.operar and conteudo.visualizar', () => onlyConteudo],
    ['a person of the portal, writing as the agency', () => ids.portalA1],
    ['a collaborator with a link to the client and the Sales role, writing as the agency', () => ids.dualBare],
    ['an Admin of another agency who holds a link to the client, writing as the agency', () => ids.crossDual]
  ] as const)('refuses %s a comment as the agency', async (_label, user) => {
    const request = await seedRequest();

    await expect(writeComment(user(), request, 'agency')).rejects.toMatchObject(rlsViolation);

    expect(await owner()('client_thread_comments').where({ thread_id: request }).select('id')).toHaveLength(0);
  });

  it('reopens a resolved request when the client comments, as in every conversation, and not when the agency does', async () => {
    const request = await seedRequest({ resolved_by: ids.adminA, resolved_at: new Date() });

    await writeComment(ids.adminA, request, 'agency');
    expect(await threadRow(request)).toMatchObject({ resolved_by: ids.adminA });
    await writeComment(ids.portalA1, request, 'client');
    expect(await threadRow(request)).toMatchObject({ resolved_by: null, resolved_at: null });
  });

  it.each([
    ['an Admin', () => ids.adminA],
    ['the Owner of the agency, by ownership', () => ids.ownerA],
    ['a role with only cliente.operar', () => onlyClienteOperar]
  ] as const)('lets %s resolve it, stamped by the database with who and when', async (_label, user) => {
    const request = await seedRequest();

    expect(await w.asUser(user(), (t) => t('client_threads').where({ id: request }).update({ resolved_by: user(), resolved_at: new Date('2020-01-01T00:00:00Z') }))).toBe(1);

    const row = await threadRow(request);
    expect(row).toMatchObject({ resolved_by: user() });
    expect((row.resolved_at as Date).getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime());
  });

  it.each([
    ['a person of the portal of the client', () => ids.portalA1],
    ['another person of the portal of the client', () => ids.portalA1Second],
    ['a collaborator with a link to the client and the Sales role', () => ids.dualBare],
    ['a collaborator with a link to the client and the Production role', () => ids.dualFull],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual],
    ['Sales', () => ids.salesA],
    ['a role with only cliente.visualizar', () => onlyClienteVisualizar],
    ['a role with conteudo.operar and conteudo.visualizar', () => onlyConteudo],
    ['the Admin of another agency', () => ids.adminB]
  ] as const)('does not let %s resolve it: the UPDATE reaches no row', async (_label, user) => {
    const request = await seedRequest();

    expect(await w.asUser(user(), (t) => t('client_threads').where({ id: request }).update({ resolved_by: user(), resolved_at: new Date() }))).toBe(0);

    expect(await threadRow(request)).toMatchObject({ resolved_by: null, resolved_at: null });
  });

  it('refuses the portal a comment while the agency is read-only, and the agency a resolution', async () => {
    const request = await seedRequest();
    await whileReadOnly(async () => {
      await expect(writeComment(ids.portalA1, request, 'client')).rejects.toMatchObject({ code: 'A0090' });
      await expect(w.asUser(ids.adminA, (t) => t('client_threads').where({ id: request }).update({ resolved_by: ids.adminA, resolved_at: new Date() }))).rejects.toMatchObject({ code: 'A0090' });
    });
    expect(await threadRow(request)).toMatchObject({ resolved_by: null });
  });

  it('refuses a comment on the request of an archived client, from the portal and from the agency, leaving no row', async () => {
    const client = await f.freshClient();
    const request = await seedRequest({ client_id: client });
    await owner()('clients').where({ id: client }).update({ status: 'archived', archived_at: new Date() });

    await expect(writeComment(ids.portalA1, request, 'client', client)).rejects.toMatchObject(rlsViolation);
    await expect(writeComment(ids.adminA, request, 'agency', client)).rejects.toMatchObject(rlsViolation);

    expect(await owner()('client_thread_comments').where({ thread_id: request }).select('id')).toHaveLength(0);
  });

  it('waits for the archiving of the client that is in flight before it takes a comment, then refuses with the code of the lock', async () => {
    const client = await f.freshClient();
    const request = await seedRequest({ client_id: client });
    const archiving = await w.openTransactionAs(ids.adminA);
    const archivingPid = await backendPid(archiving);
    let outcome: Promise<unknown> | undefined;
    try {
      await archiving.raw('select app_private.archive_client(?::uuid)', [client]);
      outcome = writeComment(ids.portalA1, request, 'client', client).then(() => 'commented', (error: unknown) => error);
      await waitForBackendsBlockedBy(owner(), archivingPid);
    } finally {
      await archiving.commit();
    }

    expect(await outcome).toMatchObject({ code: 'A0020' });
    expect(await owner()('client_thread_comments').where({ thread_id: request }).select('id')).toHaveLength(0);
  });
});

// ---- the decision of 2026-11-07 keeps holding ---------------------------------------------------------------------------------------

describe('the conversation of a content in production stays out of the portal (decision 2026-11-07)', () => {
  it('shows the portal the request and none of the conversation of a content in production or of its comments, to whoever reads it only as the client', async () => {
    const production = await w.seedContent(ids.clientA1, { status: 'in_production' });
    const contentThread = randomUUID();
    await owner()('client_threads').insert({ id: contentThread, client_id: ids.clientA1, content_id: production, opened_by: ids.adminA, opened_side: 'agency' });
    const contentComment = await seedComment(contentThread, ids.adminA, 'agency');
    const request = await seedRequest();
    const requestComment = await seedComment(request, ids.adminA, 'agency');

    for (const user of [ids.portalA1, ids.portalA1Second, ids.dualBare, ids.crossDual]) {
      expect(await visible(user, 'client_threads', 'id', [contentThread, request]), String(user)).toEqual([request]);
      expect(await visible(user, 'client_thread_comments', 'id', [contentComment, requestComment]), String(user)).toEqual([requestComment]);
    }
    await expect(w.asUser(ids.portalA1, (t) => t('client_threads').insert({
      client_id: ids.clientA1, content_id: production, opened_by: ids.portalA1, opened_side: 'client'
    }))).rejects.toMatchObject(rlsViolation);
  });

  it('refuses to put the request inside the conversation of a content: it is a subject of its own', async () => {
    const production = await w.seedContent(ids.clientA1, { status: 'in_production' });

    await expect(openRequest(ids.adminA, { content_id: production })).rejects.toMatchObject({ code: '23514', constraint: 'client_threads_subject_check' });
  });
});
